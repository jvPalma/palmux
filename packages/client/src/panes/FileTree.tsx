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
import type { CSSProperties, ReactNode } from 'react';
import { Button } from '../ui';
import { ContextMenu, type ContextMenuItemSpec } from '../ui/ContextMenu';
import { Icon } from '../ui/icons';
import { useLeavingItems } from '../ui/useLeavingItems';
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
  forgetDeletedDirs,
  readExpandedDirs,
  readOpenRoots,
  subscribeDeletedDirs,
  withoutDeleted,
  writeExpandedDir,
  writeOpenRoots,
} from './explorer-open';
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

/**
 * The listings the screen needs right now: every live open root, and each
 * expanded folder that is really ON SCREEN.
 *
 * A folder is on screen when its parent is (a live open root, or itself on screen),
 * the parent's listing is `ready` and shows it as a DIRECTORY entry, and the user
 * has it expanded. The listing is the proof of existence, not the stored path: a
 * record for a folder that was deleted (by another window's write resurrecting it),
 * renamed, or spelled in a form no listing produces is never fetched and never
 * polled. It stays dormant in storage, bounded by the 200 cap, and wakes if a listing
 * ever shows it again. The price is that a restore loads one level per round trip.
 *
 * It is a gate, not a filter on what is remembered: a folder under a collapsed
 * root, a dormant root or a collapsed ancestor stays stored and costs no request
 * until it can be seen.
 *
 * Walks the Set while growing it — a Set iteration visits what is added during it —
 * so the cost is one pass over the visible listings, the same as drawing their rows.
 */
function neededDirs(
  openRoots: ReadonlySet<string>,
  expanded: ReadonlySet<string>,
  dirs: Readonly<Record<string, DirState>>,
): string[] {
  const out = new Set(openRoots);
  for (const parent of out) {
    const state = dirs[parent];
    if (state?.status !== 'ready') continue;
    for (const entry of state.entries) {
      if (!entry.dir) continue;
      const child = childPath(parent, entry.name);
      if (expanded.has(child)) out.add(child);
    }
  }
  return [...out];
}

const depthStyle = (depth: number): CSSProperties => ({ '--ft-depth': depth }) as CSSProperties;

const rowKey = (row: Row): string => row.key;

interface RootRowsProps {
  rows: Row[];
  renderRow: (row: Row) => ReactNode;
}

/**
 * One root's rows, each inside a wrapper that animates its OWN space (files.css
 * `.ft-leaf`). A deleted file, a collapsed folder or a replaced "Loading…" note
 * is dropped from `rows` the instant its data goes, so without this the node is
 * unmounted before it can fade and every row below jumps by its height.
 *
 * A component of its own because the hook is per list and the tree has one list
 * per root, a count that changes — hooks cannot be called in `roots.map`.
 */
const RootRows = ({ rows, renderRow }: RootRowsProps) => {
  const tracked = useLeavingItems(rows, rowKey);
  return (
    <>
      {tracked.map(({ key, item, phase, enter }, index) => (
        <div
          key={key}
          className="ft-leaf"
          data-phase={phase}
          data-enter={enter}
          // The first fill staggers by position (files.css caps how far).
          style={{ '--ft-i': index } as CSSProperties}
          // A row on its way out must take no click and no focus. `inert` is not
          // in React 18's typings, but the attribute reaches the DOM from a
          // spread, and it also drops the focus a keyboard delete leaves on the
          // row being deleted, which `aria-hidden` would warn about.
          {...(phase === 'leaving' ? { inert: '' } : {})}
        >
          <div className="ft-leaf-inner">{renderRow(item)}</div>
        </div>
      ))}
    </>
  );
};

export const FileTree = ({ onOpenFile, pins, onPinsChange, onNotice }: FileTreeProps) => {
  const [dirs, setDirs] = useState<Record<string, DirState>>({});
  // Null until the server tells us where home is; the tree renders its loading
  // note until then rather than flashing the filesystem root.
  const [root, setRoot] = useState<string | null>(null);
  // The folders the USER opened, and nothing else: a root's section is open or
  // closed by `openRoots` below and lists from `dirs[root]` directly, so a root is
  // never put in here. When it was, the same set drove the folder row of a pin
  // nested in HOME, and a folder collapsed there came back open on every relaunch.
  // Restored from storage (palmux-explorer-expanded) and then changed only by a
  // folder toggle or by the Explorer's own delete — see `showExpanded`.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set<string>(readExpandedDirs()),
  );
  // Mirrors `expanded` for the callbacks that run outside a render (a delete heard
  // from any tree) or twice in one tick (two quick toggles). Written only by
  // `showExpanded`, the one place that changes the set, so it cannot lag the state.
  const expandedRef = useRef(expanded);
  // The root sections this device has open, as last stored (palmux-explorer-open).
  // Null means nothing is stored — a first run — which is not the same as an
  // empty set: that is someone who collapsed everything. It is a SUPERSET of what
  // is shown: an entry for a path that is not a root right now stays here, and in
  // storage, until a user action replaces the set. See `openRoots` below. While
  // HOME's first-run default is owed (`homeOwed`) a toggle lands here and not yet
  // in storage.
  const [storedOpen, setStoredOpen] = useState<ReadonlySet<string> | null>(() => {
    const stored = readOpenRoots();
    return stored ? new Set(stored) : null;
  });
  // A first run owes HOME its default ("open") until HOME is KNOWN, and that can
  // take a failed request and a retry. Tracked apart from `storedOpen` because a
  // toggle of another root in the meantime makes `storedOpen` non-null, and "is
  // something stored?" must not be what settles the default. Holds the roots
  // toggled while it is owed — a pin can be HOME's own path, and choosing it
  // before HOME lands is a choice about HOME — or null once nothing is owed.
  // Read once at mount: `storedOpen` is its initial value here.
  const [homeOwed, setHomeOwed] = useState<ReadonlySet<string> | null>(() =>
    storedOpen === null ? new Set<string>() : null,
  );
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
    // A listing that is already on screen stays there while it is re-read. Swapping
    // it for "Loading…" would drop EVERY row of the directory and bring them back,
    // so a delete (which re-reads the parent) could not fade the one row that went,
    // and the 2-minute poll would collapse the list under the user's scroll offset.
    setDirs((prev) =>
      prev[key]?.status === 'ready' ? prev : { ...prev, [key]: { status: 'loading' } },
    );
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
        // HOME was asked for with no path, so its '' key is a pending REQUEST that
        // nothing looks up: drop it.
        if (dir === null) delete next[key];
        // A request answered under another path did NOT get its own listing, and must
        // never be shown one: rows take their paths from the key they are drawn under,
        // so another directory's entries would name paths that listing never described.
        // The route used to trim, so `report ` was answered as `report`, and a file shown
        // that way could be a directory on disk whose Delete is recursive; a server that
        // has not restarted onto the untrimmed route still does. The requested key
        // gets an error, and it is TERMINAL: the load effect asks only for a key with no
        // state, so an empty one would be asked for after every answer (B9-INSPECT2-02).
        // Every root, pin and stored path is canonical, so this is reached only by a
        // path the server alters on the way in (an older, trimming server).
        else if (at !== dir) {
          next[key] = { status: 'error', message: `the server listed a different path: ${at}` };
        }
        return next;
      });
      // Home is a root, not a folder row: it is shown from `dirs[at]`, so there is
      // nothing to expand — only the path to remember.
      if (dir === null) setRoot(at);
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

  // What is open: the stored set restricted to the roots that exist right now.
  // On a first run HOME opens as it arrives, beside whatever else was toggled
  // before it — a tree whose only root started collapsed would be an empty panel
  // with one word in it.
  //
  // The stored set is never pruned against `roots`, because `roots` is incomplete
  // twice over at boot: HOME is unknown until its request lands, and nothing says
  // when the synced pins are authoritative. A prune keyed to it erases a
  // remembered pinned root whichever of the two arrives second, and stores the
  // loss. So an entry for a path that is not a root today simply stays dormant,
  // costs nothing, and reopens if the root comes back. Every reader of "open" —
  // rendering, the restore-load below and the poll — goes through this
  // intersection, never the stored set.
  const remembered = useMemo(() => {
    const base = storedOpen ?? new Set<string>();
    if (homeOwed === null || root === null || homeOwed.has(root) || base.has(root)) return base;
    return new Set(base).add(root);
  }, [storedOpen, homeOwed, root]);
  const openRoots = useMemo(
    () => new Set(roots.filter((r) => remembered.has(r))),
    [roots, remembered],
  );

  /** Replace the open set and remember it. Only user actions (and the first-run
   *  default) call this, so a dormant entry is never lost to a render. */
  const commitOpen = useCallback((next: ReadonlySet<string>): void => {
    setStoredOpen(next);
    writeOpenRoots(next);
  }, []);

  // A first run stores its default the moment HOME is known, together with any
  // toggle held back while it was owed, so the next mount reads a state rather
  // than guessing again. `remembered` already shows it, so nothing moves on screen.
  useEffect(() => {
    if (homeOwed === null || root === null) return;
    setHomeOwed(null);
    commitOpen(remembered);
  }, [homeOwed, root, remembered, commitOpen]);

  /** The ONE place `expanded` changes: state and the mirror together. Storage is
   *  NOT written from here: this set is one mount's copy and may be stale, so each
   *  action stores its own change against what is stored now (`explorer-open.ts`). */
  const showExpanded = useCallback((next: ReadonlySet<string>): void => {
    expandedRef.current = next;
    setExpanded(next);
  }, []);

  // The listings the screen needs right now (see `neededDirs`): what the load
  // effect fetches and what the poll re-reads.
  const needed = useMemo(() => neededDirs(openRoots, expanded, dirs), [openRoots, expanded, dirs]);

  // Held in refs so the poll below does not restart on every listing change —
  // a 2-minute interval that resets whenever a folder expands never fires.
  const dirsRef = useRef(dirs);
  dirsRef.current = dirs;
  // The visible set, not the listings cached under an open root: the cache keeps
  // everything ever shown there (so reopening is instant), including a subtree
  // that is now hidden behind a collapsed folder or section.
  const neededRef = useRef(needed);
  neededRef.current = needed;

  /** Re-read every directory already loaded under `rootPath` (its subtree). A user's
   *  explicit request, so it also freshens hidden cached listings for a later open. */
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
      // Only what is on screen. A hidden listing is still in `dirs` (so reopening
      // it is instant), and re-reading it would be work nobody asked for on a tree
      // the user cannot see.
      for (const dir of neededRef.current) void load(dir);
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

  // Load on demand: every open root and every expanded folder that is on screen —
  // one its parent's listing shows (see `neededDirs`) — and that has no state yet.
  // Declarative rather than fired from the click handler, so a restored section, a
  // restored folder and a fresh click all take exactly the same path. A root is
  // fetched here as a root; it is not expanded. That is also what loads a remembered
  // pin the moment the pins arrive (or HOME the moment it does), before and after
  // each other alike. A restored folder waits for its parent's listing, so a nested
  // restore is one round trip per depth.
  useEffect(() => {
    for (const dir of needed) if (!dirs[dir]) void load(dir);
  }, [needed, dirs, load]);

  const toggle = useCallback(
    (dir: string): void => {
      const next = new Set(expandedRef.current);
      // Collapse forgets this folder only; its stored descendants stay, so opening
      // the parent again brings its open children back. A fresh open goes last,
      // which is what makes the 200-entry cap drop the OLDEST.
      const open = !next.delete(dir);
      if (open) next.add(dir);
      showExpanded(next);
      writeExpandedDir(dir, open);
    },
    [showExpanded],
  );

  // A delete is the one signal that a folder is gone — no listing is proof of
  // absence (the route answers a transient failure as 404 and drops an entry it
  // could not `lstat`), so a listing never gets to forget anything. It is heard
  // from EVERY tree, not only this one: a tree that mounted while another's delete
  // was in flight read the deleted folder from storage and would show it open.
  useEffect(
    () =>
      subscribeDeletedDirs((gone) => {
        const current = expandedRef.current;
        const kept = withoutDeleted(current, gone);
        if (kept.length !== current.size) showExpanded(new Set(kept));
      }),
    [showExpanded],
  );

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
          // Only what the server reports as deleted: a refused path still exists.
          // Module-level, not this tree's: it may have unmounted while waiting.
          forgetDeletedDirs(results.filter((r) => r.ok).map((r) => r.path));
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
      // followed by working in the thing you just pinned. Replacing the set is
      // the point, so it also clears any dormant entries — and settles an owed
      // HOME default, which would otherwise reopen HOME beside the new root.
      commitOpen(new Set([path]));
      setHomeOwed(null);
      // `path` is loaded as a root once the host hands the new pins back. It is
      // deliberately NOT added to `expanded`: the folder row it may also be inside
      // HOME is the user's to open, and pinning is not that.
    },
    [commitOpen, onPinsChange, pinList],
  );

  const toggleRoot = useCallback(
    (r: string): void => {
      const next = new Set(remembered);
      if (!next.delete(r)) next.add(r);
      if (homeOwed === null) {
        commitOpen(next);
        return;
      }
      // Held, not written, until HOME lands and is stored with it: a set written
      // without HOME would make a remount or a reload in the meantime read "HOME
      // collapsed" instead of "first run", and lose the default for good.
      setStoredOpen(next);
      setHomeOwed(new Set(homeOwed).add(r));
    },
    [commitOpen, homeOwed, remembered],
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
              ? {
                  id: 'unpin',
                  label: 'Unpin from Explorer',
                  icon: <Icon name="pin" size={14} />,
                  onSelect: () => unpin(path),
                }
              : {
                  id: 'pin',
                  label: 'Pin as a root',
                  icon: <Icon name="pin" size={14} />,
                  onSelect: () => pin(path),
                },
          );
        }
      } else {
        items.push({
          id: 'open',
          label: 'Open',
          icon: <Icon name="external" size={14} />,
          onSelect: () => openFile(path),
        });
      }
      items.push({
        id: 'download',
        label: dir ? 'Download as zip' : 'Download',
        icon: <Icon name="download" size={14} />,
        onSelect: () => download([path]),
      });
      items.push({
        id: 'select',
        label: 'Select',
        icon: <Icon name="checkbox-on" size={14} />,
        onSelect: () => startPicking(path),
      });
      items.push({
        id: 'delete',
        label: 'Delete',
        icon: <Icon name="close" size={14} />,
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
              <Icon name={isPicked ? 'checkbox-on' : 'checkbox-off'} size={12} />
            </span>
          )}
          {/* 12px like every other chevron, so it overhangs the 8px `.ft-caret` box,
              ink included for the open chevron; the overhang ends inside the row's
              gap, short of the glyph. Shrunk to fit, the 1.75 stroke goes sub-pixel
              and all but vanishes at 1x (measured), so the box is what has to give. */}
          <span className="ft-caret" aria-hidden="true">
            {isDir && <Icon name={row.open ? 'chevron-down' : 'chevron-right'} size={12} />}
          </span>
          {row.icon ? (
            <img className="ft-glyph" src={row.icon} alt="" aria-hidden="true" loading="lazy" />
          ) : (
            <span className="ft-glyph ft-glyph-fallback" aria-hidden="true">
              <Icon name={isDir ? 'folder' : 'file'} size={14} />
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
                  onClick={() => toggleRoot(r)}
                >
                  <span className="ft-sect-caret" aria-hidden="true">
                    <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
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
                  <Icon name="reload" size={12} />
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
                    <Icon name="close" size={12} />
                  </button>
                )}
              </div>
              {open && (
                <div className="ft-sect-body">
                  <RootRows rows={rowsByRoot.get(r) ?? []} renderRow={renderRow} />
                </div>
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
            <Icon name="download" size={14} />
            Download
          </Button>
          <Button
            size="sm"
            variant="danger"
            data-testid="ft-bulk-delete"
            disabled={pickedSet.size === 0 || busy}
            onClick={() => remove(pickedTargets)}
          >
            <Icon name="close" size={14} />
            Delete
          </Button>
          <Button size="sm" variant="ghost" data-testid="ft-bulk-cancel" onClick={() => setPicked(null)}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
};
