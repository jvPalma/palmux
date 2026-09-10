// ── File pane (content) ───────────────────────────────────────────────────────
//
// The file pane's main area: one header carrying the path and the Read / Edit
// segmented control, and the file itself using the whole pane. It composes the
// two panes that already exist rather than rendering content of its own —
// MarkdownPane for Read, EditorPane for Edit.
//
// BOTH stay mounted, stacked, with the inactive one hidden in CSS: unmounting
// the editor on a toggle would throw away unsaved text, which is the one thing
// a Read/Edit switch must never do.
//
// Read is only offered for a file with a rendered form — .md/.markdown — so the
// option is DISABLED, not hidden, for anything else; a control that vanishes
// per-file reads as a bug.

import { useCallback, useMemo, useState } from 'react';
import type { TabMeta } from '@palmux/shared';
import { IconButton, Segmented } from '../ui';
import { EditorPane } from './EditorPane';
import { MarkdownPane } from './MarkdownPane';
import './files.css';

export type FileMode = 'read' | 'edit';

export interface FilePaneProps {
  path: string;
  mode: FileMode;
  onMode: (mode: FileMode) => void;
  /** Follow a relative .md link the Read view resolved; `path` is controlled. */
  onChangePath?: ((path: string) => void) | undefined;
  /**
   * Dismiss the pane. It belongs to the HEADER FLOW, not over it: floated in the
   * top-right corner it sat on top of the Read/Edit control at every width the
   * path was short enough to leave the segments there, and swallowed its clicks.
   */
  onClose?: (() => void) | undefined;
  /**
   * Forward the buffer's dirty state to a host that draws it — the tab strip's
   * ● . FilePane already tracks it for its own header; a host mounting this as a
   * TAB has no other way to know, and an unsaved file whose tab looks identical
   * to a saved one is the close-confirm's whole reason to exist.
   */
  onDirtyChange?: ((dirty: boolean) => void) | undefined;
}

const READABLE_EXT = new Set(['md', 'markdown']);

const isReadable = (path: string): boolean => {
  const dot = path.lastIndexOf('.');
  return dot > 0 && READABLE_EXT.has(path.slice(dot + 1).toLowerCase());
};

const splitPath = (path: string): { dir: string; name: string } => {
  const cut = path.lastIndexOf('/');
  return cut < 0
    ? { dir: '', name: path }
    : { dir: path.slice(0, cut + 1), name: path.slice(cut + 1) };
};

const NOOP_PATH = (): void => {};

export const FilePane = ({
  path,
  mode,
  onMode,
  onChangePath,
  onClose,
  onDirtyChange,
}: FilePaneProps) => {
  const [dirty, setDirty] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const readable = isReadable(path);
  // A non-markdown file has no rendered form, so Read cannot be honoured even
  // if the host asks for it.
  const active: FileMode = readable ? mode : 'edit';
  const { dir, name } = splitPath(path);

  const tab = useMemo<TabMeta>(() => ({ id: path, kind: 'markdown', url: path }), [path]);

  const onDirty = useCallback(
    (_id: string, next: boolean) => {
      setDirty(next);
      onDirtyChange?.(next);
    },
    [onDirtyChange],
  );

  return (
    <div className="pane-frame fp-frame" data-testid="file-pane">
      <div className="pane-header fp-head">
        <span className="fp-path" data-testid="file-pane-path" title={path}>
          {dir}
          <b className="fp-path-name">{name}</b>
        </span>
        {active === 'edit' && (
          <span
            className="fp-state"
            data-tone={saveError ? 'error' : undefined}
            data-testid="file-pane-save-state"
            title={saveError ?? undefined}
          >
            {saveError ? `⚠ ${saveError}` : dirty ? '● unsaved' : '✓ saved'}
          </span>
        )}
        <Segmented
          label="File view"
          value={active}
          onValueChange={onMode}
          options={[
            { value: 'read', label: 'Read', disabled: !readable },
            { value: 'edit', label: 'Edit' },
          ]}
          data-testid="file-pane-mode"
        />
        {onClose && (
          <IconButton
            label="Close file"
            size="sm"
            className="fp-close"
            data-testid="file-overlay-close"
            onClick={onClose}
          >
            ✕
          </IconButton>
        )}
      </div>

      <div className="fp-body">
        {readable && (
          <div className="fp-view" data-active={active === 'read'} data-testid="file-pane-read">
            <MarkdownPane tab={tab} onChangePath={onChangePath ?? NOOP_PATH} />
          </div>
        )}
        <div className="fp-view" data-active={active === 'edit'} data-testid="file-pane-edit">
          <EditorPane
            tabId={path}
            filePath={path}
            active={active === 'edit'}
            onDirtyChange={onDirty}
            onSaveError={setSaveError}
          />
        </div>
      </div>
    </div>
  );
};
