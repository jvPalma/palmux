// ── The pane grid: a layout tree, and the rules that change it ────────────────
//
// The desktop content area is a tree. A BRANCH lays its children out in a row
// (side by side) or a column (stacked); a LEAF is one pane holding tabs and
// showing one of them. Everything here is pure: no React, no DOM, no storage.
// Every operation takes a layout and returns a new one, never mutating, and
// returns the SAME object when nothing changed so a caller's `===` is a real
// "did anything happen" (a title broadcast arrives every 300 ms and must not
// re-render or re-persist the strips).
//
// `size` is a node's fraction of its parent's main axis, and siblings sum to 1.
//
// Leaf ids are minted `p` + a base-36 counter kept in the layout (`nextId`), and
// never derived from a tab id: the earlier split keyed itself by its first tab's
// id, which a swap of sides renamed, and a renamed key remounts what it keys. A
// leaf id is also what a terminal pane is KEYED by, so it stays the same across
// every operation except `removeLeaf` of that leaf.
//
// Only two pieces of VS Code's grid logic are copied (the side → sibling-or-wrap
// decision of `splitPane` and the sibling collapse of `removeLeaf`); each carries
// its own attribution. Sizing modes, snapping, hidden views and layout priority
// are not ported.

import { isTabKind, type TabKind, type TabMeta } from '@palmux/shared';
import { neighborAfterClose } from './tab-meta';

/** `row` = children side by side, `column` = children stacked. */
export type Orientation = 'row' | 'column';

export interface TabRef {
  id: string;
  kind: TabKind;
}

export interface PaneLeaf {
  type: 'leaf';
  id: string;
  tabs: TabRef[];
  /**
   * The tab this pane shows. Null for a pane with no tabs, for a window's one pane on the New-tab
   * page (tabs other windows made join it and do not take over), or for one a reconcile has yet to
   * repair.
   */
  active: string | null;
  size: number;
}

export interface PaneBranch {
  type: 'branch';
  orientation: Orientation;
  children: PaneNode[];
  size: number;
}

export type PaneNode = PaneLeaf | PaneBranch;

export interface PaneLayout {
  v: 3;
  root: PaneNode;
  /** A leaf id. */
  focused: string;
  /** The counter the next leaf id is minted from. */
  nextId: number;
}

export type Side = 'left' | 'right' | 'top' | 'bottom';

/** A rectangle in percent (0–100) of the content area. */
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Sash {
  /** Child indices from the root to the branch this sash belongs to (`[]` = the root). */
  path: number[];
  /** The sash sits between children `index` and `index + 1` of that branch. */
  index: number;
  orientation: Orientation;
  /** The zero-thickness boundary between the two children. */
  rect: Rect;
  /** The parent branch's rect, so a component can turn pointer pixels into a branch fraction. */
  branch: Rect;
}

/** No sash drag shrinks a pane below this fraction of its branch (today's divider clamp). */
export const MIN_FRACTION = 0.15;

/** Siblings that sum to less than this far from 1 are a corrupt layout, not rounding. */
const SUM_TOLERANCE = 1e-6;

/**
 * CSS for a rect. With `bodyOffset` the rect is a pane's and the body starts below its strip:
 * the strip height is a token (`--group-strip-h`), so the maths stays percentage-only.
 */
export function rectCss(
  r: Rect,
  bodyOffset = false,
): { left: string; top: string; width: string; height: string } {
  return {
    left: `${r.left}%`,
    top: bodyOffset ? `calc(${r.top}% + var(--group-strip-h))` : `${r.top}%`,
    width: `${r.width}%`,
    height: bodyOffset ? `calc(${r.height}% - var(--group-strip-h))` : `${r.height}%`,
  };
}

// ── Reading ───────────────────────────────────────────────────────────────────

const leafNumber = (id: string): number => {
  const n = parseInt(id.slice(1), 36);
  return Number.isFinite(n) ? n : 0;
};

/** One pane holding every given tab. `active` naming no tab appends it as a terminal. */
export function singleLeaf(tabs: TabRef[], active: string | null, leafId = 'p0'): PaneLayout {
  const shown = active === '' ? null : active;
  const held = tabs.map((t) => ({ id: t.id, kind: t.kind }));
  // The spawn-on-attach fallback: an id the server has not broadcast yet is a terminal, and only
  // its pane's attach creates it (a phone that just created one selects exactly such an id).
  if (shown !== null && !held.some((t) => t.id === shown)) {
    held.push({ id: shown, kind: 'terminal' });
  }
  return {
    v: 3,
    root: { type: 'leaf', id: leafId, tabs: held, active: shown, size: 1 },
    focused: leafId,
    nextId: leafNumber(leafId) + 1,
  };
}

function collectLeaves(node: PaneNode, out: PaneLeaf[]): PaneLeaf[] {
  if (node.type === 'leaf') out.push(node);
  else for (const c of node.children) collectLeaves(c, out);
  return out;
}

/** Every leaf, depth first, left/top first. */
export function leaves(layout: PaneLayout): PaneLeaf[] {
  return collectLeaves(layout.root, []);
}

/** The leaf holding a tab, or null. */
export function leafOf(layout: PaneLayout, tabId: string): PaneLeaf | null {
  return leaves(layout).find((l) => l.tabs.some((t) => t.id === tabId)) ?? null;
}

const findLeaf = (layout: PaneLayout, leafId: string): PaneLeaf | null =>
  leaves(layout).find((l) => l.id === leafId) ?? null;

const holds = (leaf: PaneLeaf, tabId: string): boolean => leaf.tabs.some((t) => t.id === tabId);

const containsLeaf = (node: PaneNode, leafId: string): boolean =>
  node.type === 'leaf' ? node.id === leafId : node.children.some((c) => containsLeaf(c, leafId));

/** Rebuild the tree with one leaf swapped for `fn(leaf)`; the same objects where nothing changed. */
function mapLeaf(node: PaneNode, leafId: string, fn: (leaf: PaneLeaf) => PaneLeaf): PaneNode {
  if (node.type === 'leaf') return node.id === leafId ? fn(node) : node;
  let changed = false;
  const children = node.children.map((c) => {
    const next = mapLeaf(c, leafId, fn);
    if (next !== c) changed = true;
    return next;
  });
  return changed ? { ...node, children } : node;
}

function replaceLeaf(
  layout: PaneLayout,
  leafId: string,
  fn: (leaf: PaneLeaf) => PaneLeaf,
): PaneLayout {
  const root = mapLeaf(layout.root, leafId, fn);
  return root === layout.root ? layout : { ...layout, root };
}

// ── Changing a pane ───────────────────────────────────────────────────────────

/** Show `tabId` in `leafId`. The same layout when the leaf does not hold it or already shows it. */
export function activate(layout: PaneLayout, leafId: string, tabId: string): PaneLayout {
  return replaceLeaf(layout, leafId, (leaf) =>
    holds(leaf, tabId) && leaf.active !== tabId ? { ...leaf, active: tabId } : leaf,
  );
}

/** Make `leafId` the focused pane. The same layout when it is, or when no such leaf exists. */
export function focusLeaf(layout: PaneLayout, leafId: string): PaneLayout {
  if (layout.focused === leafId || !findLeaf(layout, leafId)) return layout;
  return { ...layout, focused: leafId };
}

/**
 * Add a tab to a pane. A tab is in at most one pane, so one already held elsewhere is left where
 * it is (moving is `moveTab`'s job); one already in this pane is only activated when asked.
 */
export function addTab(
  layout: PaneLayout,
  leafId: string,
  tab: TabRef,
  makeActive: boolean,
): PaneLayout {
  const held = leafOf(layout, tab.id);
  if (held) return held.id === leafId && makeActive ? activate(layout, leafId, tab.id) : layout;
  return replaceLeaf(layout, leafId, (leaf) => ({
    ...leaf,
    tabs: [...leaf.tabs, { id: tab.id, kind: tab.kind }],
    active: makeActive ? tab.id : leaf.active,
  }));
}

/**
 * Take a tab out of its pane. If the pane was showing it, the new active tab is its left
 * neighbour in that pane's strip, else its right: the strip is the SERVER's order filtered to the
 * pane, which is why `order` is needed (a tab appended to the pane last is not last in the strip).
 * A pane left with no tabs goes with its last tab, unless it is the only pane.
 */
export function removeTab(layout: PaneLayout, tabId: string, order: string[]): PaneLayout {
  const leaf = leafOf(layout, tabId);
  if (!leaf) return layout;
  const tabs = leaf.tabs.filter((t) => t.id !== tabId);
  let active = leaf.active;
  if (leaf.active === tabId) {
    const survivors = new Set(tabs.map((t) => t.id));
    const strip = order.filter((id) => holds(leaf, id));
    // A tab no broadcast has listed yet is not in `order`, so it can be the only survivor and still
    // not be anyone's neighbour; the pane's own first tab is better than showing nothing.
    active = neighborAfterClose(strip, tabId, survivors) ?? tabs[0]?.id ?? null;
  }
  const next = replaceLeaf(layout, leaf.id, (l) => ({ ...l, tabs, active }));
  return tabs.length === 0 ? removeLeaf(next, leaf.id) : next;
}

/** Move a tab into another pane as its active tab, and focus that pane. */
export function moveTab(
  layout: PaneLayout,
  tabId: string,
  targetLeafId: string,
  order: string[],
): PaneLayout {
  const source = leafOf(layout, tabId);
  const target = findLeaf(layout, targetLeafId);
  if (!source || !target) return layout;
  if (source.id === target.id) return focusLeaf(activate(layout, target.id, tabId), target.id);
  const ref = source.tabs.find((t) => t.id === tabId)!;
  const removed = removeTab(layout, tabId, order);
  return focusLeaf(
    replaceLeaf(removed, target.id, (leaf) => ({
      ...leaf,
      tabs: [...leaf.tabs, { id: ref.id, kind: ref.kind }],
      active: tabId,
    })),
    target.id,
  );
}

// ── Splitting ─────────────────────────────────────────────────────────────────

const orientationOf = (side: Side): Orientation =>
  side === 'left' || side === 'right' ? 'row' : 'column';

function wrapLeaf(target: PaneLeaf, fresh: PaneLeaf, orientation: Orientation, before: boolean) {
  const kept: PaneLeaf = { ...target, size: 0.5 };
  const added: PaneLeaf = { ...fresh, size: 0.5 };
  const branch: PaneBranch = {
    type: 'branch',
    orientation,
    children: before ? [added, kept] : [kept, added],
    size: target.size,
  };
  return branch;
}

function insertBeside(
  node: PaneNode,
  targetId: string,
  fresh: PaneLeaf,
  orientation: Orientation,
  before: boolean,
): PaneNode {
  if (node.type === 'leaf') {
    return node.id === targetId ? wrapLeaf(node, fresh, orientation, before) : node;
  }
  const at = node.children.findIndex((c) => c.type === 'leaf' && c.id === targetId);
  if (at !== -1) {
    const target = node.children[at] as PaneLeaf;
    const children = [...node.children];
    if (node.orientation === orientation) {
      // The parent already runs this way: a sibling, taking half of the target's room.
      const kept: PaneLeaf = { ...target, size: target.size / 2 };
      const added: PaneLeaf = { ...fresh, size: target.size / 2 };
      children.splice(at, 1, ...(before ? [added, kept] : [kept, added]));
    } else {
      children[at] = wrapLeaf(target, fresh, orientation, before);
    }
    return { ...node, children };
  }
  let changed = false;
  const children = node.children.map((c) => {
    const next = insertBeside(c, targetId, fresh, orientation, before);
    if (next !== c) changed = true;
    return next;
  });
  return changed ? { ...node, children } : node;
}

// Side → sibling or wrap ported from VS Code src/vs/base/browser/ui/grid/grid.ts getRelativeLocation. Copyright (c) Microsoft Corporation. Licensed under the MIT License.
/**
 * Open a new pane beside `targetLeafId`, holding `tab`, and focus it. `tab` leaves its own pane
 * first (which disappears if that was its only tab); it may also be a tab no pane holds yet (a
 * fresh terminal). Dropping a pane's only tab on its own edge changes nothing.
 */
export function splitPane(
  layout: PaneLayout,
  targetLeafId: string,
  side: Side,
  tab: TabRef,
  order: string[],
): PaneLayout {
  const target = findLeaf(layout, targetLeafId);
  if (!target) return layout;
  if (target.tabs.length === 1 && target.tabs[0]!.id === tab.id) return layout;
  const removed = removeTab(layout, tab.id, order);
  const id = `p${removed.nextId.toString(36)}`;
  const fresh: PaneLeaf = {
    type: 'leaf',
    id,
    tabs: [{ id: tab.id, kind: tab.kind }],
    active: tab.id,
    size: 0.5,
  };
  const root = insertBeside(
    removed.root,
    targetLeafId,
    fresh,
    orientationOf(side),
    side === 'left' || side === 'top',
  );
  return { ...removed, root, focused: id, nextId: removed.nextId + 1 };
}

// ── Removing a pane ───────────────────────────────────────────────────────────

const firstLeafId = (node: PaneNode): string =>
  node.type === 'leaf' ? node.id : firstLeafId(node.children[0]!);

/** The pane that takes focus when `leafId` goes: its next sibling, else the previous one. */
function adjacentLeafId(node: PaneNode, leafId: string): string | null {
  if (node.type === 'leaf') return null;
  const at = node.children.findIndex((c) => containsLeaf(c, leafId));
  if (at === -1) return null;
  const child = node.children[at]!;
  if (child.type === 'leaf') {
    const sibling = node.children[at + 1] ?? node.children[at - 1];
    return sibling ? firstLeafId(sibling) : null;
  }
  return adjacentLeafId(child, leafId);
}

/** `branch` without the leaf, collapsed as far as that leaves it a branch of one child. */
function dropLeaf(branch: PaneBranch, leafId: string): PaneNode {
  const at = branch.children.findIndex((c) => containsLeaf(c, leafId));
  const child = branch.children[at]!;
  let children: PaneNode[];
  if (child.type === 'leaf') {
    // Its room goes to the siblings in proportion to the room they have.
    const rest = branch.children.filter((_, i) => i !== at);
    const restSum = rest.reduce((sum, c) => sum + c.size, 0);
    children = rest.map((c) => ({ ...c, size: c.size + child.size * (c.size / restSum) }));
  } else {
    // The deeper branch may collapse to one node; whatever replaces it keeps its room.
    const replaced: PaneNode = { ...dropLeaf(child, leafId), size: child.size };
    children = branch.children.map((c, i) => (i === at ? replaced : c));
    if (replaced.type === 'branch' && replaced.orientation === branch.orientation) {
      // The same orientation as this branch: its children join this one, their sizes scaled by the
      // room it took.
      children.splice(
        at,
        1,
        ...replaced.children.map((g) => ({ ...g, size: g.size * replaced.size })),
      );
    }
  }
  // A branch left with one child is that child, which takes the branch's room.
  return children.length === 1 ? { ...children[0]!, size: branch.size } : { ...branch, children };
}

// Sibling collapse ported from VS Code src/vs/base/browser/ui/grid/gridview.ts removeView. Copyright (c) Microsoft Corporation. Licensed under the MIT License.
/**
 * Remove a pane and give its room to its siblings. The last pane is never removed. Focus moves
 * ONLY when the removed pane was the focused one (to the sibling that was adjacent, descending to
 * its first pane): a pane another window emptied never moves this window's focus.
 */
export function removeLeaf(layout: PaneLayout, leafId: string): PaneLayout {
  if (layout.root.type === 'leaf' || !containsLeaf(layout.root, leafId)) return layout;
  const focused =
    layout.focused === leafId
      ? (adjacentLeafId(layout.root, leafId) ?? layout.focused)
      : layout.focused;
  // The root's lone survivor is promoted to root, and the root always takes the whole area.
  const root: PaneNode = { ...dropLeaf(layout.root, leafId), size: 1 };
  return { ...layout, root, focused };
}

// ── Sashes and rects ──────────────────────────────────────────────────────────

/**
 * Move the sash between children `index` and `index + 1` of the branch at `path` by
 * `deltaFraction` of that branch's main axis. Only those two siblings change, and neither goes
 * below `MIN_FRACTION` (a pane a split already made smaller than that may not shrink further, but
 * is not jumped up to it by a drag either). The pair keeps its total, so siblings still sum to 1.
 */
export function resizeSash(
  layout: PaneLayout,
  path: number[],
  index: number,
  deltaFraction: number,
): PaneLayout {
  if (!Number.isFinite(deltaFraction)) return layout;
  let branch: PaneNode = layout.root;
  for (const i of path) {
    if (branch.type !== 'branch' || !branch.children[i]) return layout;
    branch = branch.children[i]!;
  }
  if (branch.type !== 'branch') return layout;
  const first = branch.children[index];
  const second = branch.children[index + 1];
  if (!first || !second) return layout;
  const total = first.size + second.size;
  const lowest = Math.min(MIN_FRACTION, first.size);
  const highest = total - Math.min(MIN_FRACTION, second.size);
  const size = Math.max(lowest, Math.min(highest, first.size + deltaFraction));
  if (size === first.size) return layout;

  const resize = (node: PaneNode, depth: number): PaneNode => {
    if (node.type !== 'branch') return node;
    if (depth === path.length) {
      const children = [...node.children];
      children[index] = { ...first, size };
      children[index + 1] = { ...second, size: total - size };
      return { ...node, children };
    }
    const at = path[depth]!;
    const children = [...node.children];
    children[at] = resize(children[at]!, depth + 1);
    return { ...node, children };
  };
  return { ...layout, root: resize(layout.root, 0) };
}

function walkRects(
  node: PaneNode,
  rect: Rect,
  path: number[],
  panes: Map<string, Rect>,
  sashes: Sash[],
): void {
  if (node.type === 'leaf') {
    panes.set(node.id, rect);
    return;
  }
  const row = node.orientation === 'row';
  let offset = 0;
  const cells = node.children.map((child, i) => {
    const main = (row ? rect.width : rect.height) * child.size;
    const cell: Rect = row
      ? { left: rect.left + offset, top: rect.top, width: main, height: rect.height }
      : { left: rect.left, top: rect.top + offset, width: rect.width, height: main };
    offset += main;
    if (i < node.children.length - 1) {
      sashes.push({
        path,
        index: i,
        orientation: node.orientation,
        rect: row
          ? { left: rect.left + offset, top: rect.top, width: 0, height: rect.height }
          : { left: rect.left, top: rect.top + offset, width: rect.width, height: 0 },
        branch: rect,
      });
    }
    return cell;
  });
  node.children.forEach((child, i) => walkRects(child, cells[i]!, [...path, i], panes, sashes));
}

/** Every pane's rect and every sash, in percent of the content area. */
export function layoutRects(layout: PaneLayout): { panes: Map<string, Rect>; sashes: Sash[] } {
  const panes = new Map<string, Rect>();
  const sashes: Sash[] = [];
  walkRects(layout.root, { left: 0, top: 0, width: 100, height: 100 }, [], panes, sashes);
  return { panes, sashes };
}

// ── Following the server ──────────────────────────────────────────────────────

/** The first of a pane's tabs in server order; tabs the order does not list yet only if none is. */
export const firstInOrder = (tabs: TabRef[], order: string[]): string | null => {
  let best: string | null = null;
  let bestAt = Infinity;
  for (const t of tabs) {
    const at = order.indexOf(t.id);
    if (at !== -1 && at < bestAt) {
      best = t.id;
      bestAt = at;
    }
  }
  return best ?? tabs[0]?.id ?? null;
};

/**
 * Make a layout agree with a `sessions` broadcast. Never creates a tab and never errors.
 *
 * `pending` is the ids this window put into the layout that no broadcast has listed yet: a
 * terminal's id is picked by the client and the server only learns of it when its pane attaches,
 * so dropping it for being absent would unmount the pane about to create it.
 *
 * Idempotent, and the SAME layout object when nothing changed.
 */
export function reconcile(
  layout: PaneLayout,
  tabs: TabMeta[],
  prevOrder: string[],
  pending: ReadonlySet<string>,
): PaneLayout {
  const byId = new Map(tabs.map((t) => [t.id, t]));
  const order = tabs.map((t) => t.id);
  // At boot there is no "before", so a dead active tab's neighbour is read off the new order.
  const before = prevOrder.length > 0 ? prevOrder : order;

  // 1 + 2. Drop what is gone or recycled into another kind, and re-pick a pane's active tab if it
  // was one of them, by the same left-then-right rule a close uses.
  let current = layout;
  for (const leaf of leaves(layout)) {
    const kept: TabRef[] = [];
    let changed = false;
    for (const ref of leaf.tabs) {
      const live = byId.get(ref.id);
      if (live === undefined ? pending.has(ref.id) : live.kind === ref.kind) kept.push(ref);
      else if (live !== undefined && pending.has(ref.id)) {
        // Listed for the first time, as another kind than the client guessed: the list is right.
        kept.push({ id: ref.id, kind: live.kind });
        changed = true;
      } else changed = true;
    }
    if (!changed) continue;
    let active = leaf.active;
    if (active !== null && !kept.some((t) => t.id === active)) {
      const old = new Set(leaf.tabs.map((t) => t.id));
      const survivors = new Set(kept.map((t) => t.id));
      active = neighborAfterClose(
        before.filter((id) => old.has(id)),
        active,
        survivors,
      );
    }
    current = replaceLeaf(current, leaf.id, (l) => ({ ...l, tabs: kept, active }));
  }

  // 3. An empty pane goes; the last one stays.
  for (const leaf of leaves(current)) {
    if (leaf.tabs.length === 0) current = removeLeaf(current, leaf.id);
  }

  // A window whose one pane shows nothing is on the New-tab page and stays there: the pane was
  // emptied just now, or it already showed nothing before this broadcast (tabs other windows made
  // joined it on an earlier one). Step 5 leaves it alone, on this broadcast and on every later one.
  // A pane that showed a tab this broadcast took away is not blank, whatever it has left.
  const blank =
    current.root.type === 'leaf' &&
    (current.root.tabs.length === 0 ||
      (layout.root.type === 'leaf' && layout.root.active === null));

  // 4. A tab no pane holds (another window made it) joins the focused pane, without taking over.
  const held = new Set(leaves(current).flatMap((l) => l.tabs.map((t) => t.id)));
  const missing = tabs.filter((t) => !held.has(t.id));
  if (missing.length > 0) {
    current = replaceLeaf(current, current.focused, (leaf) => ({
      ...leaf,
      tabs: [...leaf.tabs, ...missing.map((t) => ({ id: t.id, kind: t.kind }))],
    }));
  }

  // 5. Every other pane with tabs shows one: its first in server order when it shows none.
  if (blank) return current;
  for (const leaf of leaves(current)) {
    if (leaf.tabs.length > 0 && (leaf.active === null || !holds(leaf, leaf.active))) {
      current = replaceLeaf(current, leaf.id, (l) => ({
        ...l,
        active: firstInOrder(l.tabs, order),
      }));
    }
  }
  return current;
}

// ── Reading a saved layout ────────────────────────────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isSize = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

interface ParseState {
  tabIds: Set<string>;
  leafIds: Set<string>;
  highest: number;
}

function parseNode(v: unknown, state: ParseState): PaneNode | null {
  if (!isRecord(v) || !isSize(v['size'])) return null;
  const size = v['size'];
  if (v['type'] === 'leaf') {
    const id = v['id'];
    if (typeof id !== 'string' || !/^p[0-9a-z]+$/.test(id) || state.leafIds.has(id)) return null;
    state.leafIds.add(id);
    state.highest = Math.max(state.highest, parseInt(id.slice(1), 36));
    if (!Array.isArray(v['tabs'])) return null;
    const tabs: TabRef[] = [];
    for (const t of v['tabs'] as unknown[]) {
      if (!isRecord(t) || typeof t['id'] !== 'string' || !isTabKind(t['kind'])) return null;
      if (state.tabIds.has(t['id'])) return null; // a tab is in one pane, once
      state.tabIds.add(t['id']);
      tabs.push({ id: t['id'], kind: t['kind'] });
    }
    const active = v['active'];
    if (active !== null && (typeof active !== 'string' || !tabs.some((t) => t.id === active))) {
      return null;
    }
    return { type: 'leaf', id, tabs, active, size };
  }
  if (v['type'] === 'branch') {
    const orientation = v['orientation'];
    if (orientation !== 'row' && orientation !== 'column') return null;
    // A branch of fewer than two children is a leaf that was never collapsed: no operation here
    // writes one.
    if (!Array.isArray(v['children']) || v['children'].length < 2) return null;
    const children: PaneNode[] = [];
    for (const c of v['children'] as unknown[]) {
      const node = parseNode(c, state);
      if (!node) return null;
      children.push(node);
    }
    // Siblings share the branch between them. A layout that does not add up would leave a gap no
    // operation here closes (a hand-off keeps the sum it is given).
    const sum = children.reduce((total, c) => total + c.size, 0);
    if (Math.abs(sum - 1) > SUM_TOLERANCE) return null;
    return { type: 'branch', orientation, children, size };
  }
  return null;
}

/** A saved layout, or null for anything unusable (never throws). */
export function parseLayout(raw: string | null): PaneLayout | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!isRecord(v) || v['v'] !== 3 || typeof v['focused'] !== 'string') return null;
    const nextId = v['nextId'];
    if (typeof nextId !== 'number' || !Number.isInteger(nextId)) return null;
    const state: ParseState = { tabIds: new Set(), leafIds: new Set(), highest: -1 };
    const root = parseNode(v['root'], state);
    if (!root || !state.leafIds.has(v['focused']) || nextId <= state.highest) return null;
    return { v: 3, root, focused: v['focused'], nextId };
  } catch {
    return null;
  }
}
