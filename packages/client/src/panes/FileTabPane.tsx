// ── A file, as a TAB ──────────────────────────────────────────────────────────
//
// The Explorer used to open a file into a full-width overlay across the content
// area. That made a file modal: it covered whatever terminal was running, and
// the only way back was to close it. Reported from real use: with a terminal
// tab focused, opening a file drew it ON TOP of that terminal.
//
// A file is now an `editor` tab carrying the absolute path in `url`, so it sits
// in the strip beside the terminals, several can be open at once, and switching
// away and back costs nothing. That is the VS Code shape the file browser was
// always reaching for.
//
// This component exists for one reason: the Read/Edit toggle is per-file view
// state with nowhere else to live. It is not worth a synced setting (it is a
// glance, not a preference) and it must not be global (two open files would
// share one toggle), so it lives here, per mounted tab — which also means it
// survives switching tabs, because PaneHost keeps every pane mounted.

import { useCallback, useState } from 'react';
import { FilePane, type FileMode } from './FilePane';

export interface FileTabPaneProps {
  /** Absolute path on the server. */
  path: string;
  /** Follow a relative .md link the Read view resolved. */
  onChangePath: (path: string) => void;
  /** Report the buffer's dirty state so the strip can draw its ● . */
  onDirtyChange: (dirty: boolean) => void;
}

export function FileTabPane({ path, onChangePath, onDirtyChange }: FileTabPaneProps) {
  // Read first for anything with a rendered form; FilePane downgrades to Edit
  // by itself for a file that has none, so this is a preference, not a claim.
  const [mode, setMode] = useState<FileMode>('read');
  const onMode = useCallback((next: FileMode) => setMode(next), []);
  return (
    <FilePane
      path={path}
      mode={mode}
      onMode={onMode}
      onChangePath={onChangePath}
      onDirtyChange={onDirtyChange}
      // No onClose: the TAB's ✕ closes it. A second close control inside the
      // pane would leave the tab behind with nothing in it.
    />
  );
}
