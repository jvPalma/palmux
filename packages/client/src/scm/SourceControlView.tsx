// ── Source Control (the dock / drawer body) ───────────────────────────────────
//
// What changed in the project the user picked, grouped the way VS Code groups it:
// Merge Changes (conflicted), Staged Changes and Changes. This is the VIEW only.
// It lists and it hands a choice to its host (`onOpenFile`); the diff itself is a
// `review` tab in the content area, never something drawn in here.
//
// It starts with NO project. A project is a path the user typed, validated by the
// server (`/scm/repo`) and stored by its canonical work-tree top: nothing is
// inferred from the server's cwd, a terminal or an open file. The list is a synced
// setting (the paths are on the server); which project this device reads is local.
// The host owns both settings, so this component takes them as props and reports a
// change. The one setting it follows itself is `scmTree`, how THIS screen reads a
// group (a tree or a flat list): a display choice the editor pane follows the same
// way, through the settings pub/sub, and written back through `onChange`.
//
// Copy comments puts every comment of the project on the clipboard as one markdown
// document (the review's own exporter, with the outdated ones marked); the host
// shows the result as a toast through `onNotice`.
//
// Rows live in a scroller, so they activate on pointer UP (`pressMove`): a finger
// that arrives to pan must not open a file. A group over LONG_GROUP_ROWS rows is a
// `VirtualList` of its own (it is its own scroll container, with a capped height);
// shorter ones are plain rows, which keeps the common case free of measuring.
//
// Each group is a folder tree by default (`scm-tree.ts`: the model, the order and
// the per-device collapse store) or one flat list. Both are the same rows in the
// same component, in the dock and in the drawer. The limit is on the group's FILES,
// not on the rows a tree shows, so collapsing a folder never swaps the list for
// another kind under the user's focus.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { ScmEntry, ScmGroup } from '@palmux/shared';
import {
  Button,
  Collapsible,
  IconButton,
  Input,
  ScrollArea,
  Select,
  VirtualList,
  useDynamicRowHeight,
  useListRef,
  type RowComponentProps,
} from '../ui';
import { Icon } from '../ui/icons';
import { hasLineBreak, LINE_BREAK_MESSAGE } from '../panes/DashboardBody';
import { normalizePin, rootLabel } from '../panes/explorer-pins';
import { entryIconUrl, iconIndex, loadIconIndex, type IconIndex } from '../panes/file-icons';
import { pressMove } from '../panes/press';
import { useComments } from '../review/use-comments';
import { loadSettings, onSettingsChange, type ClientSettings } from '../settings/settings';
import { commentsMarkdown, copyPendingText } from './copy-comments';
import { fetchScmRepo } from './scm-api';
import {
  buildTree,
  flattenTree,
  listRows,
  readCollapsed,
  setFolderCollapsed,
  splitPath,
  type TreeRow,
} from './scm-tree';
import { scmStatusStore, useScmStatus } from './status-store';
import './scm.css';

/** A group longer than this is drawn through `VirtualList` instead of as plain rows. */
export const LONG_GROUP_ROWS = 200;

/** What a row activation hands the host: the review to open, and the file in it. */
export interface ScmOpenTarget {
  /** The review the file belongs to. A conflicted file opens the Changes review. */
  group: ScmGroup;
  path: string;
  oldPath?: string;
}

export type ScmProjectChange = Partial<
  Pick<ClientSettings, 'scmRepos' | 'scmActiveRepo' | 'scmTree'>
>;

export interface SourceControlViewProps {
  /** The synced project list (canonical work-tree tops). */
  repos: string[];
  /** The project this device reads, one of `repos`; '' when there is none. */
  activeRepo: string;
  /** On screen. The store counts only visible subscribers, so a hidden view reads nothing. */
  visible: boolean;
  /** A change to the project list and/or to this device's selection. */
  onChange: (change: ScmProjectChange) => void;
  onOpenFile: (target: ScmOpenTarget) => void;
  /** Where the view says what happened (Copy comments); a toast in the app. */
  onNotice?: ((message: string) => void) | undefined;
}

type ViewGroup = 'merge' | 'staged' | 'changes';

const GROUPS: readonly { id: ViewGroup; title: string }[] = [
  { id: 'merge', title: 'Merge Changes' },
  { id: 'staged', title: 'Staged Changes' },
  { id: 'changes', title: 'Changes' },
];

const STATUS_LABEL: Record<ScmEntry['status'], string> = {
  M: 'Modified',
  A: 'Added',
  D: 'Deleted',
  R: 'Renamed',
  T: 'Type changed',
  U: 'Conflicted',
  '?': 'Untracked',
};

const BLANK_PATH_MESSAGE = 'Enter the absolute path of a folder inside a git repository';

/** A project's name in the selector: its folder, or the whole path when two share a folder name. */
function projectLabel(repo: string, repos: readonly string[]): string {
  const name = rootLabel(repo);
  return repos.filter((r) => rootLabel(r) === name).length > 1 ? repo : name;
}

/** The display choice of this screen, followed live (see the header). */
function useScmTree(): boolean {
  const [tree, setTree] = useState(() => loadSettings().scmTree);
  useEffect(() => onSettingsChange((settings) => setTree(settings.scmTree)), []);
  return tree;
}

/** What every row of a group needs besides the row itself. */
interface RowContext {
  group: ViewGroup;
  icons: IconIndex | null;
  /** In the tree a file row leaves its directory out: the folders above it say it. */
  tree: boolean;
  /** The row to move focus onto once it is drawn; null when none is wanted. */
  focusKey: string | null;
  onFocused: () => void;
  onOpen: (group: ViewGroup, entry: ScmEntry) => void;
  onToggle: (path: string, collapse: boolean) => void;
  onKey: (e: ReactKeyboardEvent, row: TreeRow) => void;
}

/**
 * Focus the row's button when the group asks for it, then say it was done. A row
 * the virtual list has not drawn yet gets its focus when it is: the request waits.
 */
function useFocusRequest(requested: boolean, done: () => void) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!requested) return;
    ref.current?.focus();
    done();
  }, [requested, done]);
  return ref;
}

/** One level of a tree is one step of the scale; the stylesheet multiplies it by the depth. */
const depthStyle = (depth: number): Record<string, string> => ({ '--depth': String(depth) });

/** How many rows the virtual list holds, for the stylesheet's height cap. */
const rowCountStyle = (count: number): Record<string, string> => ({ '--scm-rows': String(count) });

const FileRow = ({
  row,
  context,
}: {
  row: Extract<TreeRow, { kind: 'file' }>;
  context: RowContext;
}) => {
  const { group, icons, tree, focusKey, onFocused, onOpen, onKey } = context;
  const { entry } = row;
  const ref = useFocusRequest(focusKey === row.key, onFocused);
  const icon = entryIconUrl(icons, row.name, false);
  const label = STATUS_LABEL[entry.status];
  // A rename names where it came from: the old path is part of what the row says,
  // in the tree as well, where the directory is not.
  const origin = entry.oldPath ? `← ${entry.oldPath}` : '';
  const { dir } = splitPath(entry.path);
  const where = tree ? origin : [dir || (origin ? '.' : ''), origin].filter(Boolean).join(' ');
  return (
    <button
      ref={ref}
      type="button"
      className="scm-row"
      style={tree ? depthStyle(row.depth) : undefined}
      data-testid={`scm-row-${group}:${entry.path}`}
      data-status={entry.status}
      data-conflicted={group === 'merge' ? 'true' : undefined}
      title={entry.oldPath ? `${entry.path} (renamed from ${entry.oldPath})` : entry.path}
      onKeyDown={tree ? (e) => onKey(e, row) : undefined}
      {...pressMove(() => onOpen(group, entry))}
    >
      {tree && <span className="scm-twisty" aria-hidden="true" />}
      {icon ? (
        <img className="scm-glyph" src={icon} alt="" aria-hidden="true" loading="lazy" />
      ) : (
        <span className="scm-glyph scm-glyph-fallback" aria-hidden="true">
          <Icon name="file" size={14} />
        </span>
      )}
      <span className="scm-name">{row.name}</span>
      {where && <span className="scm-dir">{where}</span>}
      <span
        className="scm-letter"
        data-status={entry.status}
        role="img"
        aria-label={label}
        title={label}
      >
        {entry.status}
      </span>
    </button>
  );
};

const FolderRow = ({
  row,
  context,
}: {
  row: Extract<TreeRow, { kind: 'folder' }>;
  context: RowContext;
}) => {
  const { group, icons, focusKey, onFocused, onToggle, onKey } = context;
  const { node, open } = row;
  const ref = useFocusRequest(focusKey === row.key, onFocused);
  // A chain is named by its deepest folder, as VS Code does for a compact folder.
  const icon = entryIconUrl(icons, node.path.slice(node.path.lastIndexOf('/') + 1), true, open);
  const files = `${node.files} ${node.files === 1 ? 'file' : 'files'}`;
  // A long chain gives way at the front: the folder the row is about is its last one.
  const cut = node.name.lastIndexOf('/') + 1;
  const head = node.name.slice(0, cut);
  const tail = node.name.slice(cut);
  return (
    <button
      ref={ref}
      type="button"
      className="scm-folder"
      style={depthStyle(row.depth)}
      data-testid={`scm-folder-${group}:${node.path}`}
      aria-expanded={open}
      aria-label={`${node.name}, ${files}`}
      title={node.path}
      onKeyDown={(e) => onKey(e, row)}
      {...pressMove(() => onToggle(node.path, open))}
    >
      <span className="scm-twisty" aria-hidden="true">
        <Icon name="chevron-right" size={14} />
      </span>
      {icon ? (
        <img className="scm-glyph" src={icon} alt="" aria-hidden="true" loading="lazy" />
      ) : (
        <span className="scm-glyph scm-glyph-fallback" aria-hidden="true">
          <Icon name={open ? 'folder-open' : 'folder'} size={14} />
        </span>
      )}
      <span className="scm-name scm-chain">
        {head && <span className="scm-chain-head">{head}</span>}
        <span className="scm-chain-tail">{tail}</span>
      </span>
      <span
        className="scm-folder-count"
        data-testid={`scm-folder-count-${group}:${node.path}`}
        aria-hidden="true"
      >
        {node.files}
      </span>
    </button>
  );
};

const ListRow = ({ row, context }: { row: TreeRow; context: RowContext }) =>
  row.kind === 'folder' ? (
    <FolderRow row={row} context={context} />
  ) : (
    <FileRow row={row} context={context} />
  );

interface VirtualRowProps {
  rows: readonly TreeRow[];
  context: RowContext;
}

// The row component sits at module level so its identity is stable: react-window
// would remount every row if it changed on a render.
const VirtualListRow = ({
  index,
  style,
  ariaAttributes,
  rows,
  context,
}: RowComponentProps<VirtualRowProps>) => {
  const row = rows[index];
  if (!row) return null;
  return (
    <div style={style} {...ariaAttributes}>
      <ListRow row={row} context={context} />
    </div>
  );
};

interface GroupSectionProps {
  id: ViewGroup;
  title: string;
  /** The project: the collapse store is keyed by it, and a switch remounts the group. */
  repo: string;
  entries: ScmEntry[];
  icons: IconIndex | null;
  tree: boolean;
  onOpen: (group: ViewGroup, entry: ScmEntry) => void;
}

const GroupSection = ({ id, title, repo, entries, icons, tree, onOpen }: GroupSectionProps) => {
  // Rows are `--ctl-h` tall (28px, 36px on a phone), so they are measured rather
  // than assumed; the default only sizes the scrollbar until they are.
  const rowHeight = useDynamicRowHeight({ defaultRowHeight: 28 });
  const listRef = useListRef(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set(readCollapsed(repo, id)),
  );
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const clearFocus = useCallback(() => setFocusKey(null), []);

  const nodes = useMemo(() => (tree ? buildTree(entries) : []), [tree, entries]);
  const rows = useMemo(
    () => (tree ? flattenTree(nodes, collapsed) : listRows(entries)),
    [tree, nodes, collapsed, entries],
  );

  const toggle = useCallback(
    (path: string, collapse: boolean) => {
      setFolderCollapsed(repo, id, path, collapse);
      setCollapsed((prev) => {
        const next = new Set(prev);
        if (collapse) next.add(path);
        else next.delete(path);
        return next;
      });
    },
    [repo, id],
  );

  const focusRow = useCallback(
    (key: string) => {
      const index = rows.findIndex((row) => row.key === key);
      if (index < 0) return;
      // A long group draws only the rows near the view: bring the target in so it can take focus.
      listRef.current?.scrollToRow({ index, align: 'auto' });
      setFocusKey(key);
    },
    [rows, listRef],
  );

  const onKey = useCallback(
    (e: ReactKeyboardEvent, row: TreeRow) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      // Enter and Space are the button's own click, which toggles or opens.
      if (e.key === 'ArrowRight') {
        if (row.kind !== 'folder' || row.open) return;
        e.preventDefault();
        toggle(row.node.path, false);
      } else if (e.key === 'ArrowLeft') {
        if (row.kind === 'folder' && row.open) {
          e.preventDefault();
          toggle(row.node.path, true);
        } else if (row.parent !== null) {
          e.preventDefault();
          focusRow(`d:${row.parent}`);
        }
      }
    },
    [toggle, focusRow],
  );

  const context = useMemo<RowContext>(
    () => ({
      group: id,
      icons,
      tree,
      focusKey,
      onFocused: clearFocus,
      onOpen,
      onToggle: toggle,
      onKey,
    }),
    [id, icons, tree, focusKey, clearFocus, onOpen, toggle, onKey],
  );
  const rowProps = useMemo<VirtualRowProps>(() => ({ rows, context }), [rows, context]);

  return (
    <Collapsible
      title={
        <>
          <span className="scm-group-title">{title}</span>
          <span className="scm-count" data-testid={`scm-count-${id}`}>
            {entries.length}
          </span>
        </>
      }
      storageKey={`palmux-scm-group-${id}`}
      data-testid={`scm-group-${id}`}
    >
      {entries.length > LONG_GROUP_ROWS ? (
        <VirtualList
          className="scm-vlist"
          data-testid={`scm-vlist-${id}`}
          // The class sets the height, up to a cap; the row count it needs is the
          // one thing a stylesheet cannot know. The first paint uses defaultHeight.
          style={rowCountStyle(rows.length)}
          defaultHeight={400}
          listRef={listRef}
          rowCount={rows.length}
          rowHeight={rowHeight}
          rowComponent={VirtualListRow}
          rowProps={rowProps}
        />
      ) : (
        <div className="scm-rows">
          {rows.map((row) => (
            <ListRow key={row.key} row={row} context={context} />
          ))}
        </div>
      )}
    </Collapsible>
  );
};

interface AddFormProps {
  checking: boolean;
  note: string | null;
  draft: string;
  onDraft: (value: string) => void;
  onNote: (note: string | null) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

const AddForm = ({ checking, note, draft, onDraft, onNote, onSubmit, onCancel }: AddFormProps) => {
  return (
    <div className="scm-add" data-testid="scm-add-form">
      <div className="scm-add-row">
        <Input
          autoFocus
          value={draft}
          placeholder="/absolute/path/to/project"
          aria-label="Project path"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          disabled={checking}
          data-testid="scm-add-input"
          onChange={(e) => {
            onDraft(e.target.value);
            onNote(null);
          }}
          // A text input removes CR/LF from a paste before `onChange` runs, so a path
          // pasted from a terminal with its newline would arrive without it and name
          // a different folder. The raw clipboard text is the last place it shows.
          onPaste={(e) => {
            if (!hasLineBreak(e.clipboardData.getData('text'))) return;
            e.preventDefault();
            onNote(LINE_BREAK_MESSAGE);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSubmit();
            else if (e.key === 'Escape') onCancel();
          }}
        />
        <Button
          variant="primary"
          size="sm"
          disabled={checking}
          data-testid="scm-add-submit"
          {...pressMove(onSubmit)}
        >
          {checking ? 'Checking…' : 'Add'}
        </Button>
        <Button size="sm" data-testid="scm-add-cancel" {...pressMove(onCancel)}>
          Cancel
        </Button>
      </div>
      {note !== null && (
        <div className="scm-note" data-tone="error" role="alert" data-testid="scm-add-note">
          {note}
        </div>
      )}
    </div>
  );
};

export const SourceControlView = ({
  repos,
  activeRepo,
  visible,
  onChange,
  onOpenFile,
  onNotice,
}: SourceControlViewProps) => {
  const { status, error } = useScmStatus(activeRepo, visible);
  const { comments } = useComments(activeRepo, visible);
  const tree = useScmTree();
  const [copying, setCopying] = useState(false);
  // A second tap before the first has re-rendered must not start a second copy.
  const copyingRef = useRef(false);

  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  // The Material icon index is fetched, not bundled, and the list never waits on
  // it: rows draw a fallback glyph and swap when it lands (the Explorer's rule).
  const [icons, setIcons] = useState<IconIndex | null>(iconIndex);
  useEffect(() => {
    if (icons) return;
    let live = true;
    void loadIconIndex().then((idx) => {
      if (live && idx) setIcons(idx);
    });
    return () => {
      live = false;
    };
  }, [icons]);

  // The server's answer arrives after the list may have moved on (another window
  // synced a change), so the project is added to the list as it is THEN.
  const latest = useRef({ repos, activeRepo });
  latest.current = { repos, activeRepo };

  const closeForm = useCallback(() => {
    setAdding(false);
    setDraft('');
    setNote(null);
  }, []);

  const submit = useCallback(async () => {
    if (checking) return;
    // The path is sent exactly as typed: `app ` and `app` are two folders, so
    // `trim()` only DETECTS a blank entry. (A line break never reaches here: the
    // field strips it before `onChange`, and `AddForm` refuses it at the paste.)
    if (draft.trim() === '') {
      setNote(BLANK_PATH_MESSAGE);
      return;
    }
    setChecking(true);
    setNote(null);
    const result = await fetchScmRepo(draft);
    setChecking(false);
    if (!result.ok) {
      setNote(result.message);
      return;
    }
    const top = normalizePin(result.value.top);
    if (!top) {
      setNote('The server did not name a work tree');
      return;
    }
    // The same project twice is not a second entry: it only becomes the active one.
    onChange(
      latest.current.repos.includes(top)
        ? { scmActiveRepo: top }
        : { scmRepos: [...latest.current.repos, top], scmActiveRepo: top },
    );
    closeForm();
  }, [checking, draft, onChange, closeForm]);

  const removeActive = useCallback(() => {
    const at = repos.indexOf(activeRepo);
    if (at < 0) return;
    const rest = repos.filter((r) => r !== activeRepo);
    // The project that followed it takes over; the last one hands over to the one before.
    onChange({ scmRepos: rest, scmActiveRepo: rest[Math.min(at, rest.length - 1)] ?? '' });
  }, [repos, activeRepo, onChange]);

  const open = useCallback(
    (group: ViewGroup, entry: ScmEntry) => {
      onOpenFile({
        group: group === 'staged' ? 'staged' : 'changes',
        path: entry.path,
        ...(entry.oldPath ? { oldPath: entry.oldPath } : {}),
      });
    },
    [onOpenFile],
  );

  const copyComments = useCallback(async () => {
    if (copyingRef.current || comments.length === 0) return;
    copyingRef.current = true;
    setCopying(true);
    try {
      // Not awaited here: the clipboard has to be asked inside the tap, so it takes
      // the document while the file reads are still running.
      const copied = await copyPendingText(commentsMarkdown(activeRepo, status, comments));
      const count = `${comments.length} ${comments.length === 1 ? 'comment' : 'comments'}`;
      onNotice?.(copied ? `Copied ${count}` : 'Could not copy the comments');
    } finally {
      copyingRef.current = false;
      setCopying(false);
    }
  }, [comments, activeRepo, status, onNotice]);

  const form = (
    <AddForm
      checking={checking}
      note={note}
      draft={draft}
      onDraft={setDraft}
      onNote={setNote}
      onSubmit={() => void submit()}
      onCancel={closeForm}
    />
  );

  const options = repos.map((repo) => ({ value: repo, label: projectLabel(repo, repos) }));
  const activeLabel = activeRepo ? projectLabel(activeRepo, repos) : '';
  const lists = status
    ? { merge: status.merge, staged: status.staged, changes: status.changes }
    : null;
  const clean = lists !== null && GROUPS.every((g) => lists[g.id].length === 0);
  const branch = status ? (status.branch ?? status.head?.slice(0, 7) ?? '') : '';

  return (
    <div className="scm-view" data-testid="scm-view">
      {repos.length === 0 ? (
        <div className="scm-empty" data-testid="scm-empty">
          <Icon name="git-branch" size={20} />
          <p className="scm-empty-text">No project yet</p>
          <p className="scm-empty-hint">
            Add a folder inside a git repository to see its changes here.
          </p>
          {adding ? (
            form
          ) : (
            <Button
              variant="primary"
              data-testid="scm-add-project"
              {...pressMove(() => setAdding(true))}
            >
              Add project
            </Button>
          )}
        </div>
      ) : (
        <>
          <div className="scm-bar" data-testid="scm-bar">
            <div className="scm-select">
              <Select
                value={activeRepo}
                onChange={(repo) => onChange({ scmActiveRepo: repo })}
                options={options}
                aria-label="Project"
                data-testid="scm-project-select"
              />
            </div>
            <IconButton
              label="Add project"
              data-testid="scm-add"
              {...pressMove(() => setAdding((v) => !v))}
            >
              <Icon name="plus" size={14} />
            </IconButton>
            <IconButton
              label={`Remove ${activeLabel}`}
              data-testid="scm-remove"
              {...pressMove(removeActive)}
            >
              <Icon name="close" size={14} />
            </IconButton>
            <IconButton
              label="Copy comments"
              title={
                comments.length === 0
                  ? 'No comments to copy'
                  : `Copy ${comments.length} ${comments.length === 1 ? 'comment' : 'comments'} as markdown`
              }
              disabled={comments.length === 0 || copying}
              data-testid="scm-copy-comments"
              {...pressMove(() => void copyComments())}
            >
              <Icon name="comment" size={14} />
            </IconButton>
            <IconButton
              label={tree ? 'View as list' : 'View as tree'}
              data-testid="scm-view-toggle"
              {...pressMove(() => onChange({ scmTree: !tree }))}
            >
              <Icon name={tree ? 'sessions' : 'folder'} size={14} />
            </IconButton>
          </div>
          {adding && form}
          {status && (
            <div className="scm-meta" data-testid="scm-branch" title={activeRepo}>
              <Icon name="git-branch" size={12} />
              <span className="scm-branch-name">{branch}</span>
              {status.unborn && <span className="scm-dim">no commits yet</span>}
            </div>
          )}
          <ScrollArea fill className="scm-scroll" data-testid="scm-scroll">
            {!status && error === null && (
              <div className="scm-note" data-testid="scm-loading">
                Loading changes…
              </div>
            )}
            {error !== null && (
              <div className="scm-note" data-tone="error" role="alert" data-testid="scm-error">
                <span className="scm-note-text">
                  {status ? `Could not refresh: ${error}` : error}
                </span>
                <Button
                  size="sm"
                  data-testid="scm-retry"
                  {...pressMove(() => scmStatusStore.refresh())}
                >
                  Retry
                </Button>
              </div>
            )}
            {status?.truncated && (
              <div className="scm-note" data-testid="scm-truncated">
                This project has more changes than palmux lists, so the list is cut short.
              </div>
            )}
            {clean && (
              <div className="scm-note" data-testid="scm-clean">
                No changes
              </div>
            )}
            {lists &&
              GROUPS.map(
                (g) =>
                  lists[g.id].length > 0 && (
                    <GroupSection
                      key={`${activeRepo}:${g.id}`}
                      id={g.id}
                      title={g.title}
                      repo={activeRepo}
                      entries={lists[g.id]}
                      icons={icons}
                      tree={tree}
                      onOpen={open}
                    />
                  ),
              )}
          </ScrollArea>
        </>
      )}
    </div>
  );
};
