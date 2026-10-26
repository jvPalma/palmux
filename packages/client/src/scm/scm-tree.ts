// ── Source Control: the changed files as a tree ───────────────────────────────
//
// A group's entries arrive in the order the review walks them (sorted by path on
// the server), and the tree must list the files in that same order, so "next
// file" in a review follows the rows on screen. Two rules keep that true:
//
//  - The tree is built FROM that list, in that order. A folder is created when its
//    first file is met and sits where that file sat; its children keep the order in
//    which they were met. Nothing sorts, and folders do NOT come first.
//  - A chain of folders that holds a single folder is one row (`a/b/c`), VS Code's
//    "compact folders". A folder that also holds a file is not part of a chain.
//
// The server sorts each group by path, in code-unit order (`toEntries` in
// `scm-status.ts`, pinned by its test 'puts each group in path order'); git itself
// prints every tracked change before the untracked files, so this order is the
// server's, not git's. A folder's files are therefore contiguous and the tree's
// order IS the entries' order. For a list that is not sorted the tree gathers a
// folder's files under its first one, and `treeOrder` is that gathered order.
//
// Which folders are collapsed is per DEVICE, per project and per group
// (`palmux-scm-collapsed`): a view preference, never sent to the server. The stored
// set is never pruned against the current tree, because no listing is proof that a
// folder is gone (the next commit or a branch switch brings it back, collapsed as
// the user left it). It is bounded by a cap per group instead.

import type { ScmEntry } from '@palmux/shared';

export interface FileNode {
  kind: 'file';
  entry: ScmEntry;
  name: string;
}

export interface FolderNode {
  kind: 'folder';
  /** The project-relative path of the DEEPEST folder in the row: the collapse key. */
  path: string;
  /** What the row says: one segment, or a chain of them (`packages/client/src`). */
  name: string;
  /** Files at any depth below. */
  files: number;
  children: TreeNode[];
}

export type TreeNode = FileNode | FolderNode;

/** A row of the flattened tree: what is drawn, top to bottom. */
export type TreeRow =
  | {
      kind: 'folder';
      key: string;
      node: FolderNode;
      depth: number;
      open: boolean;
      /** The folder holding this one, or null at the top. */
      parent: string | null;
    }
  | {
      kind: 'file';
      key: string;
      entry: ScmEntry;
      name: string;
      depth: number;
      parent: string | null;
    };

/**
 * The name and the directory of a path. A nested repository is listed as a
 * directory (`vendor/inner/`); its trailing slash stays on the name so the row
 * still reads as one, and does not make the name empty.
 */
export function splitPath(path: string): { name: string; dir: string } {
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path;
  const cut = trimmed.lastIndexOf('/');
  const name = path.slice(cut + 1);
  return { name, dir: cut < 0 ? '' : trimmed.slice(0, cut) };
}

/** The tree of a group's entries, in the entries' own order. A repeated path is listed once. */
export function buildTree(entries: readonly ScmEntry[]): TreeNode[] {
  const root: FolderNode = { kind: 'folder', path: '', name: '', files: 0, children: [] };
  const folders = new Map<string, FolderNode>();
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.path)) continue;
    seen.add(entry.path);
    const segments = entry.path.split('/').filter((s) => s !== '');
    segments.pop();
    let parent = root;
    for (const segment of segments) {
      const path = parent.path === '' ? segment : `${parent.path}/${segment}`;
      let folder = folders.get(path);
      if (!folder) {
        folder = { kind: 'folder', path, name: segment, files: 0, children: [] };
        folders.set(path, folder);
        parent.children.push(folder);
      }
      folder.files += 1;
      parent = folder;
    }
    parent.children.push({ kind: 'file', entry, name: splitPath(entry.path).name });
  }
  return root.children.map(compact);
}

function compact(node: TreeNode): TreeNode {
  if (node.kind === 'file') return node;
  let folder = node;
  while (folder.children.length === 1 && folder.children[0]?.kind === 'folder') {
    const only: FolderNode = folder.children[0];
    folder = { ...only, name: `${folder.name}/${only.name}` };
  }
  folder.children = folder.children.map(compact);
  return folder;
}

/** The rows of a tree, top to bottom. The files of a collapsed folder are not rows. */
export function flattenTree(nodes: readonly TreeNode[], collapsed: ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (list: readonly TreeNode[], depth: number, parent: string | null): void => {
    for (const node of list) {
      if (node.kind === 'file') {
        rows.push({
          kind: 'file',
          key: `f:${node.entry.path}`,
          entry: node.entry,
          name: node.name,
          depth,
          parent,
        });
        continue;
      }
      const open = !collapsed.has(node.path);
      rows.push({ kind: 'folder', key: `d:${node.path}`, node, depth, open, parent });
      if (open) walk(node.children, depth + 1, node.path);
    }
  };
  walk(nodes, 0, null);
  return rows;
}

/** The rows of the flat list: every file at depth 0, in the entries' order. */
export function listRows(entries: readonly ScmEntry[]): TreeRow[] {
  const seen = new Set<string>();
  const rows: TreeRow[] = [];
  for (const entry of entries) {
    if (seen.has(entry.path)) continue;
    seen.add(entry.path);
    rows.push({
      kind: 'file',
      key: `f:${entry.path}`,
      entry,
      name: splitPath(entry.path).name,
      depth: 0,
      parent: null,
    });
  }
  return rows;
}

/** The files in the order the tree lists them, with every folder open. */
export function treeOrder(entries: readonly ScmEntry[]): ScmEntry[] {
  const out: ScmEntry[] = [];
  for (const row of flattenTree(buildTree(entries), new Set())) {
    if (row.kind === 'file') out.push(row.entry);
  }
  return out;
}

// ── Collapse store ────────────────────────────────────────────────────────────

export const COLLAPSED_KEY = 'palmux-scm-collapsed';
/** Per project and group. A collapse is only added by a click, so this is rarely met. */
export const MAX_COLLAPSED = 500;

type Collapsed = Record<string, Record<string, string[]>>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `{v:1, byRepo:{[top]:{[group]: paths}}}`; anything else, or a malformed part of it, reads as empty. */
function readStore(): Collapsed {
  const out: Collapsed = {};
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    if (!raw) return out;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed['v'] !== 1 || !isRecord(parsed['byRepo'])) return out;
    for (const [repo, groups] of Object.entries(parsed['byRepo'])) {
      if (!isRecord(groups)) continue;
      const kept: Record<string, string[]> = {};
      for (const [group, paths] of Object.entries(groups)) {
        if (!Array.isArray(paths)) continue;
        const list = [...new Set(paths.filter((p): p is string => typeof p === 'string'))];
        if (list.length > 0) kept[group] = list;
      }
      if (Object.keys(kept).length > 0) out[repo] = kept;
    }
  } catch {
    // Storage can be unavailable or hold anything at all: the tree renders either way.
  }
  return out;
}

function writeStore(store: Collapsed): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify({ v: 1, byRepo: store }));
  } catch {
    // View state is not worth surfacing an error for.
  }
}

/** The folder paths collapsed in a project's group, oldest first. */
export function readCollapsed(repo: string, group: string): string[] {
  const groups = readStore()[repo];
  return groups?.[group] ?? [];
}

/**
 * Collapse or expand one folder. The change is applied to what is stored NOW, not
 * to a mount's copy: a dock and a drawer, or two windows of this device, each hold
 * their own, and storing one of them whole would erase what another changed.
 */
export function setFolderCollapsed(
  repo: string,
  group: string,
  path: string,
  collapsed: boolean,
): void {
  const store = readStore();
  const groups = { ...store[repo] };
  const list = (groups[group] ?? []).filter((p) => p !== path);
  if (collapsed) list.push(path);
  if (list.length > 0) groups[group] = list.slice(-MAX_COLLAPSED);
  else delete groups[group];
  if (Object.keys(groups).length > 0) store[repo] = groups;
  else delete store[repo];
  writeStore(store);
}
