// ── File tree (the dock view) ─────────────────────────────────────────────────
//
// The dock tree: expandable folders as .tn rows (caret · kind glyph · name),
// the current path in the header, and a file click that hands the path to the
// host — navigating and reading are separate jobs, so this view never renders
// content itself.
//
// Backed by GET /files/list?dir=<absolute> (server/files.ts), which lists ONE
// directory. Every directory therefore has its own load state, and a failure is
// rendered IN PLACE as a readable line with a retry — an empty box is the one
// outcome indistinguishable from a broken feature, which is the same reasoning
// the route itself is written with.
//
// The root is the user's HOME, discovered by calling /files/list with NO `dir`
// — the client cannot know a home directory, only the server can. Opening at '/'
// meant four expands before reaching anything anyone edits.
//
// This is the dock's VIEW, not the dock: DockPanel already draws the panel
// chrome (the FILES title, ✕, background, slide-in), so the only
// header here is the current path, which that title cannot carry.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Button } from '../ui';
import { ContextMenu, type ContextMenuItemSpec } from '../ui/ContextMenu';
import { downloadFromServer } from '../terminal/download';
import { entryIconUrl, iconIndex, loadIconIndex, type IconIndex } from './file-icons';
import {
  addPin,
  explorerRoots,
  isPinned,
  removePin,
  rootLabel,
  rootParent,
} from './explorer-pins';
import {
  affectedDirs,
  deleteConfirmMessage,
  deletePaths,
  deleteSummary,
  type DeleteTarget,
} from './explorer-actions';
import './files.css';

/** One entry of a listing — the client-side shape of the route's contract. */
interface FileEntry {
  name: string;
  dir: boolean;
  size: number;
  mtime: number;
  symlink: boolean;
}

interface DirListing {
  path: string;
  parent: string | null;
  entries: FileEntry[];
}

type DirState =
  | { status: 'loading' }
  | { status: 'ready'; entries: FileEntry[] }
  | { status: 'error'; message: string };

type Kind = 'dir' | 'md' | 'code' | 'file';

type Row =
  | {
      type: 'entry';
      key: string;
      path: string;
      name: string;
      depth: number;
      kind: Kind;
      open: boolean;
      /** Material icon URL, or null until the index lands (fallback glyph). */
      icon: string | null;
    }
  | {
      type: 'note';
      key: string;
      dir: string;
      depth: number;
      text: string;
      tone: 'dim' | 'error';
    };

export interface FileTreeProps {
  onOpenFile: (path: string) => void;
  /** Pinned roots (a synced setting). Omit to run with HOME as the only root. */
  pins?: string[] | undefined;
  onPinsChange?: ((next: string[]) => void) | undefined;
  /** Surface a one-line outcome; the host owns the toast. */
  onNotice?: ((message: string) => void) | undefined;
}

/**
 * How often a visible listing is re-read.
 *
 * A poll, not a watcher. An inotify watch per expanded directory is a file
 * descriptor per directory and a socket message per write — on a tree pointed at
 * a build output or a node_modules that is a firehose for information nobody is
 * reading. Two minutes is slow enough to cost nothing and fast enough that a
 * file you created in the terminal a moment ago is there when you look; the ⟳ on
 * each root is for when it is not.
 */
export const POLL_INTERVAL_MS = 120_000;

/** Fallback only: used for path joining before the root listing lands, and if
 *  the server ever answers without a path. */
const FS_ROOT = '/';

/** .md is coloured one way and code another; everything else is dim. */
const KIND_BY_EXT: Record<string, Kind> = {
  md: 'md',
  markdown: 'md',
  ts: 'code',
  tsx: 'code',
  js: 'code',
  jsx: 'code',
  mjs: 'code',
  cjs: 'code',
  json: 'code',
  css: 'code',
  html: 'code',
  sh: 'code',
  py: 'code',
  rs: 'code',
  go: 'code',
  toml: 'code',
  yml: 'code',
  yaml: 'code',
};

const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
};

const kindOf = (entry: FileEntry): Kind =>
  entry.dir ? 'dir' : (KIND_BY_EXT[extensionOf(entry.name)] ?? 'file');

const childPath = (dir: string, name: string): string =>
  dir === FS_ROOT ? `${FS_ROOT}${name}` : `${dir}/${name}`;

/** Split for the header's dim-directory + bright-name rendering. */
const splitPath = (path: string): { dir: string; name: string } => {
  const cut = path.lastIndexOf('/');
  return cut < 0
    ? { dir: '', name: path }
    : { dir: path.slice(0, cut + 1), name: path.slice(cut + 1) };
};

const depthStyle = (depth: number): CSSProperties => ({ '--ft-depth': depth }) as CSSProperties;

export const FileTree = ({ onOpenFile, pins, onPinsChange, onNotice }: FileTreeProps) => {
  const [dirs, setDirs] = useState<Record<string, DirState>>({});
  // Null until the server tells us where home is; the tree renders its loading
  // note until then rather than flashing the filesystem root.
  const [root, setRoot] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set<string>());
  // Which ROOT sections are open. Several may be, unlike a strict accordion —
  // the exclusivity the design asks for applies when a pin is ADDED, not as a
  // permanent restriction on what you can look at.
  const [openRoots, setOpenRoots] = useState<ReadonlySet<string>>(() => new Set<string>());
  /**
   * Selected paths for a bulk action, or null when not selecting.
   *
   * Null rather than an empty Set: "no selection mode" and "selection mode with
   * nothing picked" are different states, and only the second shows the action
   * bar.
   */
  const [picked, setPicked] = useState<ReadonlySet<string> | null>(null);
  const [busy, setBusy] = useState(false);
  // The selection is a FILE, never a folder: expanding must not move it, and
  // the header path is "what is open", not "what was last clicked".
  const [selected, setSelected] = useState<string | null>(null);

  /** `dir: null` asks the server for the home directory and adopts it as root. */
  const load = useCallback(async (dir: string | null): Promise<void> => {
    const key = dir ?? '';
    setDirs((prev) => ({ ...prev, [key]: { status: 'loading' } }));
    try {
      // An ABSENT dir asks the server for home. Passing '' would be an error —
      // the route distinguishes "no dir given" from "a broken dir given".
      const res = await fetch(
        dir === null ? '/files/list' : `/files/list?dir=${encodeURIComponent(dir)}`,
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      const listing = (await res.json()) as DirListing;
      // Key the state by the path the SERVER reports, so the root's listing is
      // filed under its real path and every child lookup finds it.
      const at = listing.path;
      setDirs((prev) => {
        const next = { ...prev, [at]: { status: 'ready' as const, entries: listing.entries } };
        if (key !== at) delete next[key];
        return next;
      });
      if (dir === null) {
        setRoot(at);
        setExpanded((prev) => new Set(prev).add(at));
        // HOME opens on arrival. A tree whose only root started collapsed would
        // present an empty panel with one word in it.
        setOpenRoots((prev) => (prev.has(at) ? prev : new Set([...prev, at])));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setDirs((prev) => ({ ...prev, [key]: { status: 'error', message } }));
    }
  }, []);

  // Ask for home once, on mount. Everything else is expansion-driven below.
  useEffect(() => {
    void load(null);
  }, [load]);

  const pinList = useMemo(() => pins ?? [], [pins]);
  const roots = useMemo(() => explorerRoots(root, pinList), [root, pinList]);

  // A newly pinned root opens and the others close, so the thing just pinned is
  // what is on screen. A root that disappears (unpinned elsewhere, or a settings
  // sync) must not leave its open flag behind to reopen if it comes back.
  useEffect(() => {
    setOpenRoots((prev) => {
      const live = new Set(roots);
      const next = new Set([...prev].filter((r) => live.has(r)));
      return next.size === prev.size ? prev : next;
    });
  }, [roots]);

  // Held in refs so the poll below does not restart on every listing change —
  // a 2-minute interval that resets whenever a folder expands never fires.
  const dirsRef = useRef(dirs);
  dirsRef.current = dirs;
  const openRootsRef = useRef(openRoots);
  openRootsRef.current = openRoots;

  /** Re-read every directory already loaded under `rootPath` (its subtree). */
  const refreshRoot = useCallback(
    (rootPath: string): void => {
      const prefix = rootPath === '/' ? '/' : `${rootPath}/`;
      for (const dir of Object.keys(dirsRef.current)) {
        if (dir === rootPath || dir.startsWith(prefix)) void load(dir);
      }
    },
    [load],
  );

  useEffect(() => {
    const timer = setInterval(() => {
      // Only what is on screen. A collapsed root's subtree is still in `dirs`
      // (so reopening it is instant), and re-reading it would be work nobody
      // asked for on a tree the user cannot see.
      for (const r of openRootsRef.current) {
        const prefix = r === '/' ? '/' : `${r}/`;
        for (const dir of Object.keys(dirsRef.current)) {
          if (dir === r || dir.startsWith(prefix)) void load(dir);
        }
      }
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [load]);

  // The Material icon index is a 213 KB lookup table, so it is fetched rather
  // than bundled and the tree never waits on it: rows render the fallback glyph
  // and swap to real icons when it lands. Held in state, not read from the
  // module, so it is an honest dependency of the row memo below. Seeded from the
  // cache so a second tree (or a re-open of this one) paints icons on frame one.
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

  // Load on demand: any expanded directory with no state yet. Declarative
  // rather than fired from the click handler, so the root's first load and an
  // expansion take exactly the same path.
  useEffect(() => {
    for (const dir of expanded) if (!dirs[dir]) void load(dir);
  }, [expanded, dirs, load]);

  const toggle = useCallback((dir: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(dir)) next.add(dir);
      return next;
    });
  }, []);

  const openFile = useCallback(
    (path: string): void => {
      setSelected(path);
      onOpenFile(path);
    },
    [onOpenFile],
  );

  // ── Context-menu actions ───────────────────────────────────────────────────

  const togglePick = useCallback((path: string): void => {
    setPicked((prev) => {
      const next = new Set(prev ?? []);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  }, []);

  /** Enter selection mode with `path` already picked. */
  const startPicking = useCallback((path: string): void => {
    setPicked((prev) => new Set([...(prev ?? []), path]));
  }, []);

  const download = useCallback(
    (paths: string[]): void => {
      if (paths.length === 0) return;
      setBusy(true);
      // One request per path. The /download route takes ONE pattern, and a glob
      // that happened to cover a selection would also cover things that were not
      // selected — so the browser gets one file (or one zip per folder) each,
      // which is also what a file manager does.
      void (async () => {
        let failed = 0;
        for (const p of paths) {
          const err = await downloadFromServer(p);
          if (err) failed++;
        }
        setBusy(false);
        if (failed) onNotice?.(`${failed} of ${paths.length} download(s) failed`);
      })();
    },
    [onNotice],
  );

  const remove = useCallback(
    (targets: DeleteTarget[]): void => {
      const message = deleteConfirmMessage(targets);
      if (!message || !window.confirm(message)) return;
      const paths = targets.map((t) => t.path);
      setBusy(true);
      void (async () => {
        try {
          const results = await deletePaths(paths);
          onNotice?.(deleteSummary(results));
          // Refresh the PARENTS, not the deleted paths: the listing that showed
          // them is what is now wrong.
          for (const dir of affectedDirs(paths)) {
            if (dirsRef.current[dir]) void load(dir);
          }
          setPicked((prev) => {
            if (!prev) return prev;
            const next = new Set(prev);
            for (const r of results) if (r.ok) next.delete(r.path);
            return next;
          });
          // A deleted file that was open in the pane stays open on purpose —
          // the buffer is the last copy of it the user has.
        } catch (err) {
          onNotice?.(err instanceof Error ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      })();
    },
    [load, onNotice],
  );

  const pin = useCallback(
    (path: string): void => {
      if (!onPinsChange) return;
      onPinsChange(addPin(pinList, path));
      // Collapse everything else and open the new root: pinning is immediately
      // followed by working in the thing you just pinned.
      setOpenRoots(new Set([path]));
      setExpanded((prev) => new Set(prev).add(path));
    },
    [onPinsChange, pinList],
  );

  const unpin = useCallback(
    (path: string): void => onPinsChange?.(removePin(pinList, path)),
    [onPinsChange, pinList],
  );

  /** The menu for one entry. Folders can be pinned; files can be opened. */
  const menuFor = useCallback(
    (path: string, dir: boolean): ContextMenuItemSpec[] => {
      const items: ContextMenuItemSpec[] = [];
      if (dir) {
        if (onPinsChange) {
          items.push(
            isPinned(pinList, path)
              ? { id: 'unpin', label: 'Unpin from Explorer', icon: '📌', onSelect: () => unpin(path) }
              : { id: 'pin', label: 'Pin as a root', icon: '📌', onSelect: () => pin(path) },
          );
        }
      } else {
        items.push({ id: 'open', label: 'Open', icon: '↗', onSelect: () => openFile(path) });
      }
      items.push({
        id: 'download',
        label: dir ? 'Download as zip' : 'Download',
        icon: '⬇',
        onSelect: () => download([path]),
      });
      items.push({ id: 'select', label: 'Select', icon: '☑', onSelect: () => startPicking(path) });
      items.push({
        id: 'delete',
        label: 'Delete',
        icon: '✕',
        danger: true,
        separatorBefore: true,
        onSelect: () => remove([{ path, dir }]),
      });
      return items;
    },
    [download, openFile, pin, pinList, remove, startPicking, unpin, onPinsChange],
  );

  // One flat row list PER ROOT: expanding only INSERTS rows below the folder, so
  // the scroller keeps its scrollTop and React keeps every other row mounted.
  // Built inside a memo keyed on everything it reads, so switching a root open
  // or closed does not rebuild the others.
  const rowsByRoot = useMemo(() => {
    const build = (from: string): Row[] => {
    const out: Row[] = [];
    const walk = (dir: string, depth: number): void => {
      const state = dirs[dir];
      if (!state) return;
      if (state.status === 'loading') {
        out.push({ type: 'note', key: `${dir} load`, dir, depth, text: 'Loading…', tone: 'dim' });
        return;
      }
      if (state.status === 'error') {
        out.push({
          type: 'note',
          key: `${dir} err`,
          dir,
          depth,
          text: state.message,
          tone: 'error',
        });
        return;
      }
      if (state.entries.length === 0) {
        out.push({ type: 'note', key: `${dir} empty`, dir, depth, text: 'empty', tone: 'dim' });
        return;
      }
      for (const entry of state.entries) {
        const path = childPath(dir, entry.name);
        const open = entry.dir && expanded.has(path);
        out.push({
          type: 'entry',
          key: path,
          path,
          name: entry.name,
          depth,
          kind: kindOf(entry),
          open,
          icon: entryIconUrl(icons, entry.name, entry.dir, open),
        });
        if (open) walk(path, depth + 1);
      }
    };
      // Before the root listing lands there is no path to walk from, but the
      // request still has a state: showing nothing would make a failed "where is
      // home?" call look like an empty filesystem.
      walk(from, 0);
      return out;
    };
    const map = new Map<string, Row[]>();
    for (const r of roots) map.set(r, build(r));
    return map;
  }, [dirs, expanded, icons, roots]);

  const current = splitPath(selected ?? root ?? FS_ROOT);
  const pickedSet = picked;
  const pickedTargets: DeleteTarget[] = useMemo(() => {
    if (!pickedSet) return [];
    const dirSet = new Set<string>();
    for (const rows of rowsByRoot.values()) {
      for (const r of rows) if (r.type === 'entry' && r.kind === 'dir') dirSet.add(r.path);
    }
    return [...pickedSet].map((path) => ({ path, dir: dirSet.has(path) }));
  }, [pickedSet, rowsByRoot]);

  /** The pending/failed root request as a note row. */
  const rootRequestRow = (state: DirState): Row => ({
    type: 'note',
    key: 'root-request',
    dir: '',
    depth: 0,
    text: state.status === 'error' ? state.message : 'Loading…',
    tone: state.status === 'error' ? 'error' : 'dim',
  });

  const renderRow = (row: Row) => {
    if (row.type !== 'entry') {
      return (
        <div
          key={row.key}
          className="ft-note"
          style={depthStyle(row.depth)}
          data-tone={row.tone}
          data-testid={row.tone === 'error' ? `ft-error-${row.dir}` : `ft-note-${row.dir}`}
        >
          <span className="ft-note-text">{row.text}</span>
          {row.tone === 'error' && (
            <Button
              size="sm"
              variant="ghost"
              data-testid={`ft-retry-${row.dir}`}
              // An empty dir key is the ROOT request, which carries no `dir` at
              // all — retrying it with '' would ask the server for a broken path
              // instead of asking again where home is.
              onClick={() => void load(row.dir === '' ? null : row.dir)}
            >
              Retry
            </Button>
          )}
        </div>
      );
    }
    const isDir = row.kind === 'dir';
    const isPicked = pickedSet?.has(row.path) ?? false;
    return (
      <ContextMenu
        key={row.key}
        items={menuFor(row.path, isDir)}
        testidPrefix={`ft-menu-${row.path}`}
      >
        <button
          type="button"
          className="ft-row"
          style={depthStyle(row.depth)}
          data-testid={`ft-row-${row.path}`}
          data-kind={row.kind}
          data-selected={row.path === selected}
          data-picked={isPicked}
          aria-level={row.depth + 1}
          {...(isDir ? { 'aria-expanded': row.open } : {})}
          // While selecting, a plain click PICKS instead of navigating: a mode
          // whose rows still did their normal thing would make every attempt to
          // build a selection also open a file or expand a folder.
          onClick={() => {
            if (pickedSet) togglePick(row.path);
            else if (isDir) toggle(row.path);
            else openFile(row.path);
          }}
        >
          {pickedSet && (
            <span className="ft-pick" data-checked={isPicked} aria-hidden="true">
              {isPicked ? '☑' : '☐'}
            </span>
          )}
          <span className="ft-caret" aria-hidden="true">
            {isDir ? (row.open ? '▾' : '▸') : ''}
          </span>
          {row.icon ? (
            <img className="ft-glyph" src={row.icon} alt="" aria-hidden="true" loading="lazy" />
          ) : (
            <span className="ft-glyph ft-glyph-fallback" aria-hidden="true">
              {isDir ? '▸' : '◆'}
            </span>
          )}
          <span className="ft-name">{row.name}</span>
        </button>
      </ContextMenu>
    );
  };

  return (
    <div className="ft-root" data-testid="file-tree">
      <div className="ft-head">
        <span className="ft-path" data-testid="file-tree-path" title={selected ?? root ?? FS_ROOT}>
          {current.dir}
          <span className="ft-path-name">{current.name}</span>
        </span>
      </div>

      <div className="ft-body" data-testid="file-tree-body">
        {/* The root REQUEST's own state, before there is a root to hang it on.
            Without this a failed "where is home?" call renders an empty panel —
            indistinguishable from an empty filesystem, which is the one outcome
            this view must never produce. */}
        {root === null && dirs[''] && renderRow(rootRequestRow(dirs['']))}
        {/* One collapsible section per root: HOME first, then each pinned
            folder. The root's own row is the section header, so a pinned folder
            is reachable in one click instead of five expands. */}
        {roots.map((r) => {
          const open = openRoots.has(r);
          const pinned = r !== root;
          return (
            <section className="ft-sect" key={r} data-testid={`ft-sect-${r}`} data-open={open}>
              <div className="ft-sect-head">
                <button
                  type="button"
                  className="ft-sect-trigger"
                  data-testid={`ft-sect-toggle-${r}`}
                  aria-expanded={open}
                  title={r}
                  onClick={() => {
                    setOpenRoots((prev) => {
                      const next = new Set(prev);
                      if (!next.delete(r)) {
                        next.add(r);
                        setExpanded((e) => new Set(e).add(r));
                      }
                      return next;
                    });
                  }}
                >
                  <span className="ft-sect-caret" aria-hidden="true">
                    {open ? '▾' : '▸'}
                  </span>
                  <span className="ft-sect-name">{rootLabel(r)}</span>
                  {pinned && (
                    <span className="ft-sect-path" title={r}>
                      {rootParent(r)}
                    </span>
                  )}
                </button>
                {/* Always visible, never only on hover: this is the ONLY way to
                    see a change before the two-minute poll, and a control you
                    have to discover by hovering is not that. */}
                <button
                  type="button"
                  className="ft-sect-btn"
                  data-testid={`ft-refresh-${r}`}
                  aria-label={`Refresh ${rootLabel(r)}`}
                  title="Refresh this root"
                  onClick={() => refreshRoot(r)}
                >
                  ⟳
                </button>
                {pinned && (
                  <button
                    type="button"
                    className="ft-sect-btn"
                    data-testid={`ft-unpin-${r}`}
                    aria-label={`Unpin ${rootLabel(r)}`}
                    title="Unpin this root"
                    onClick={() => unpin(r)}
                  >
                    ✕
                  </button>
                )}
              </div>
              {open && (
                <div className="ft-sect-body">{(rowsByRoot.get(r) ?? []).map(renderRow)}</div>
              )}
            </section>
          );
        })}
      </div>

      {/* Bulk bar: only while selecting, and it always offers a way OUT — a mode
          with no exit is how a file tree stops responding to clicks. */}
      {pickedSet && (
        <div className="ft-bulk" data-testid="ft-bulk">
          <span className="ft-bulk-count">
            {pickedSet.size} selected
          </span>
          <Button
            size="sm"
            variant="ghost"
            data-testid="ft-bulk-download"
            disabled={pickedSet.size === 0 || busy}
            onClick={() => download([...pickedSet])}
          >
            ⬇ Download
          </Button>
          <Button
            size="sm"
            variant="danger"
            data-testid="ft-bulk-delete"
            disabled={pickedSet.size === 0 || busy}
            onClick={() => remove(pickedTargets)}
          >
            ✕ Delete
          </Button>
          <Button size="sm" variant="ghost" data-testid="ft-bulk-cancel" onClick={() => setPicked(null)}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
};
