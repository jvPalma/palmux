// ── The drawer's session tree (pure) ──────────────────────────────────────────
//
// The mobile drawer lists tabs as a two-level tree: a group is a parent, a tab is
// a leaf, and a group never holds a group. This is the model behind its
// long-press drag, ported from the DGSL design system's TreeView (`rows.ts`,
// `types.ts` and the drop maths in `TreeView.tsx`), which is where the owner's
// "drag a row between rows, onto a header, or out of every group" behaviour was
// settled. The input layer (pointer events in the drawer) and the render stay out
// of here, so the model is shared and testable without a DOM.
//
// Node values are `t:<tabId>` and `g:<groupId>`. The prefix is what tells the two
// kinds apart, because a tab id and a group id live in different id spaces and the
// drop maths has to name either one as a target.
//
// A drop resolves to what the server already speaks: a new full order plus at most
// one membership change, which the caller sends as `reorderTabs` or `groupUpdate`.
// The order goes through the shared `normalizeOrder`, the same function the server
// runs after every mutation, so the optimistic order equals the broadcast one.

import { normalizeOrder } from '@palmux/shared';
import type { TabGroup, TabMeta } from '@palmux/shared';

export interface DrawerNode {
  /** `t:<tabId>` or `g:<groupId>`; unique in the whole tree. */
  value: string;
  /** The member tabs of a group, in full order. Tabs have none. */
  children?: DrawerNode[];
}

/**
 * Where a dragged node lands: `inside` the `target` (`null` is the top level,
 * the permanent drop area under the last row), or `before` / `after` it among
 * the target's siblings. Over a group HEADER, before/after name the position
 * relative to the whole group block, not to its first or last member.
 */
export type DrawerDrop =
  | { target: string | null; position: 'inside' }
  | { target: string; position: 'before' | 'after' };

/** A drop on the empty area below the last row: into the top level. */
export const ROOT_DROP: DrawerDrop = { target: null, position: 'inside' };

/** What a drop changes about the dragged tab's group. At most one key is set. */
export interface MembershipChange {
  /** The tab joins this group. Joining one group from another needs no `removeFrom`. */
  addTo?: string;
  /** The tab leaves this group for the top level. */
  removeFrom?: string;
}

export interface DropResult {
  /** The full strip order after the drop, already normalized (group blocks contiguous). */
  order: string[];
  membership: MembershipChange;
}

/** The rows the drawer draws: a group's members follow it only while it is open. */
export interface DrawerRow {
  key: string;
  node: DrawerNode;
  /** The nesting level for assistive technology, from 0. */
  level: number;
  parent: string | null;
  /** Position among the nodes of its level, from 1, and how many there are. */
  position: number;
  siblings: number;
}

export const tabValue = (id: string): string => `t:${id}`;
export const groupValue = (id: string): string => `g:${id}`;
export const isGroupValue = (value: string): boolean => value.startsWith('g:');

type ParsedValue = { kind: 'tab' | 'group'; id: string };

function parseValue(value: string): ParsedValue | null {
  if (value.startsWith('t:')) return { kind: 'tab', id: value.slice(2) };
  if (value.startsWith('g:')) return { kind: 'group', id: value.slice(2) };
  return null;
}

/**
 * The tree for a broadcast. A group sits where its FIRST member sits in the full
 * order (the strip's rule) and holds all its members in that order. A tab whose
 * `groupId` names no listed group is a top-level leaf, as the strip draws it.
 */
export function buildNodes(tabs: readonly TabMeta[], groups: readonly TabGroup[]): DrawerNode[] {
  const known = new Set(groups.map((g) => g.id));
  const membersOf = new Map<string, DrawerNode[]>();
  const nodes: DrawerNode[] = [];
  for (const tab of tabs) {
    const leaf: DrawerNode = { value: tabValue(tab.id) };
    const gid = tab.groupId;
    if (gid === undefined || !known.has(gid)) {
      nodes.push(leaf);
      continue;
    }
    let members = membersOf.get(gid);
    if (members === undefined) {
      members = [];
      membersOf.set(gid, members);
      nodes.push({ value: groupValue(gid), children: members });
    }
    members.push(leaf);
  }
  return nodes;
}

/** The values of the nodes above `value`, nearest last; empty for a top-level node or an unknown value. */
export function ancestorsOf(nodes: readonly DrawerNode[], value: string): string[] {
  const walk = (level: readonly DrawerNode[], path: string[]): string[] | null => {
    for (const node of level) {
      if (node.value === value) return path;
      const found = walk(node.children ?? [], [...path, node.value]);
      if (found) return found;
    }
    return null;
  };
  return walk(nodes, []) ?? [];
}

/** The values at the level of `value`, `value` included, in order; empty for an unknown value. */
export function siblingsOf(nodes: readonly DrawerNode[], value: string): string[] {
  const walk = (level: readonly DrawerNode[]): string[] | null => {
    if (level.some((node) => node.value === value)) return level.map((node) => node.value);
    for (const node of level) {
      const found = walk(node.children ?? []);
      if (found) return found;
    }
    return null;
  };
  return walk(nodes) ?? [];
}

/** `expanded` holds node values (`g:<groupId>`), not bare group ids. */
export function toRows(nodes: readonly DrawerNode[], expanded: ReadonlySet<string>): DrawerRow[] {
  const rows: DrawerRow[] = [];
  const walk = (level: readonly DrawerNode[], depth: number, parent: string | null) => {
    level.forEach((node, index) => {
      rows.push({
        key: node.value,
        node,
        level: depth,
        parent,
        position: index + 1,
        siblings: level.length,
      });
      if (node.children?.length && expanded.has(node.value))
        walk(node.children, depth + 1, node.value);
    });
  };
  walk(nodes, 0, null);
  return rows;
}

/**
 * The drop a pointer at `clientY` means over a row. A tab row splits in halves,
 * before and after, because a tab holds nothing. A group header splits in
 * quarters: the top one drops before the group, the bottom one after, and the
 * middle half drops inside it, so joining is the generous target.
 */
export function dropAt(
  rect: { top: number; height: number },
  clientY: number,
  target: string,
  isGroup: boolean,
): DrawerDrop {
  const y = clientY - rect.top;
  if (!isGroup) return { target, position: y < rect.height / 2 ? 'before' : 'after' };
  if (y < rect.height / 4) return { target, position: 'before' };
  if (y > (rect.height * 3) / 4) return { target, position: 'after' };
  return { target, position: 'inside' };
}

/** Whether `value` names a node anywhere in the tree. */
export const hasNode = (nodes: readonly DrawerNode[], value: string): boolean =>
  siblingsOf(nodes, value).length > 0;

/** The full order and membership a tree draws, which is what `resolveDrop` runs on. */
function flatten(nodes: readonly DrawerNode[]): {
  order: string[];
  groupOf: (id: string) => string | undefined;
} {
  const order: string[] = [];
  const membership = new Map<string, string>();
  for (const node of nodes) {
    const parsed = parseValue(node.value);
    if (parsed?.kind === 'tab') order.push(parsed.id);
    if (parsed?.kind !== 'group') continue;
    for (const child of node.children ?? []) {
      const leaf = parseValue(child.value);
      if (leaf?.kind !== 'tab') continue;
      order.push(leaf.id);
      membership.set(leaf.id, parsed.id);
    }
  }
  return { order, groupOf: (id) => membership.get(id) };
}

/**
 * Whether dropping `dragged` there is a move at all. It refuses a drop on itself,
 * a group into itself or its own members, a group inside a group (the tree is one
 * level deep), a tab inside a tab, and a drop that would leave the node exactly
 * where it is. A node that is no longer in the tree is refused too: a drag
 * outlives other windows' edits, and the tab or group it points at may be gone by
 * the time it lands.
 *
 * "Where it is" is judged by the RESULT, not by the parent. The DGSL TreeView
 * refuses any drop inside the parent a node already has, and a top-level node on
 * the root; palmux's contract gives both a position — inside a header appends as
 * the group's last member, the root sends a node to the end of the top level — so
 * either is a real move unless the node is already last there.
 */
export function accepts(nodes: readonly DrawerNode[], dragged: string, drop: DrawerDrop): boolean {
  const { target } = drop;
  if (target === dragged) return false;
  if (!hasNode(nodes, dragged)) return false;
  if (target !== null && !hasNode(nodes, target)) return false;
  const targetAncestors = target === null ? [] : ancestorsOf(nodes, target);
  if (targetAncestors.includes(dragged)) return false;
  const draggedIsGroup = isGroupValue(dragged);
  if (drop.position === 'inside') {
    if (target !== null && (!isGroupValue(target) || draggedIsGroup)) return false;
  } else if (draggedIsGroup && targetAncestors.length > 0) {
    return false;
  }
  // A no-op is a drop whose normalized result is the order and membership the tree
  // already has: the same test App applies before anything goes on the wire.
  const { order, groupOf } = flatten(nodes);
  const result = resolveDrop(order, groupOf, dragged, drop);
  if (result === null) return false;
  const { addTo, removeFrom } = result.membership;
  return (
    addTo !== undefined ||
    removeFrom !== undefined ||
    result.order.some((id, index) => id !== order[index])
  );
}

/** First and last index of a group's members in `ids`, or null when it has none there. */
function groupSpan(
  ids: readonly string[],
  groupOf: (id: string) => string | undefined,
  gid: string,
): { first: number; last: number } | null {
  let first = -1;
  let last = -1;
  ids.forEach((id, index) => {
    if (groupOf(id) !== gid) return;
    if (first === -1) first = index;
    last = index;
  });
  return first === -1 ? null : { first, last };
}

function membershipChange(from: string | undefined, into: string | undefined): MembershipChange {
  if (from === into) return {};
  if (into !== undefined) return { addTo: into };
  return from === undefined ? {} : { removeFrom: from };
}

function resolveTabDrop(
  fullOrder: readonly string[],
  groupOf: (id: string) => string | undefined,
  id: string,
  drop: DrawerDrop,
): DropResult | null {
  if (!fullOrder.includes(id)) return null;
  const rest = fullOrder.filter((x) => x !== id);
  const { target } = drop;
  let at: number;
  let into: string | undefined;
  if (target === null) {
    // The root: the end of the top level, out of any group. The end of the full
    // order is that place, because the last top-level node is either a tab or a block.
    at = rest.length;
    into = undefined;
  } else {
    const parsed = parseValue(target);
    if (parsed === null) return null;
    if (parsed.kind === 'tab') {
      // A tab takes its sibling's parent: that tab's group, or the top level.
      const index = rest.indexOf(parsed.id);
      if (drop.position === 'inside' || index === -1) return null;
      at = drop.position === 'before' ? index : index + 1;
      into = groupOf(parsed.id);
    } else {
      const span = groupSpan(rest, groupOf, parsed.id);
      // A group the dragged tab is the only member of has no span left in `rest`:
      // its header sits where the tab was, and a before/after drop ungroups it there.
      const only = span === null && groupOf(id) === parsed.id;
      if (span === null && !only) return null;
      const home = fullOrder.indexOf(id);
      if (drop.position === 'inside') {
        at = span === null ? home : span.last + 1;
        into = parsed.id;
      } else {
        at = span === null ? home : drop.position === 'before' ? span.first : span.last + 1;
        into = undefined;
      }
    }
  }
  const next = [...rest.slice(0, at), id, ...rest.slice(at)];
  const order = normalizeOrder(next, (x) => (x === id ? into : groupOf(x)));
  return { order, membership: membershipChange(groupOf(id), into) };
}

function resolveGroupDrop(
  fullOrder: readonly string[],
  groupOf: (id: string) => string | undefined,
  gid: string,
  drop: DrawerDrop,
): DropResult | null {
  const members = fullOrder.filter((x) => groupOf(x) === gid);
  if (members.length === 0) return null;
  const rest = fullOrder.filter((x) => groupOf(x) !== gid);
  const { target } = drop;
  let at: number;
  if (target === null) {
    at = rest.length;
  } else {
    const parsed = parseValue(target);
    if (parsed === null || drop.position === 'inside') return null;
    if (parsed.kind === 'tab') {
      // Only a top-level tab is a place for a block; a member's place is inside its group.
      const index = rest.indexOf(parsed.id);
      if (index === -1 || groupOf(parsed.id) !== undefined) return null;
      at = drop.position === 'before' ? index : index + 1;
    } else {
      const span = groupSpan(rest, groupOf, parsed.id);
      if (span === null) return null;
      at = drop.position === 'before' ? span.first : span.last + 1;
    }
  }
  const order = normalizeOrder([...rest.slice(0, at), ...members, ...rest.slice(at)], groupOf);
  return { order, membership: {} };
}

/**
 * What a drop does to the strip, or null when it cannot be resolved against the
 * current order (an unknown node, a group into a group, anything inside a tab).
 * `dragged` and `drop.target` are node values; `groupOf` is the broadcast's
 * membership (`groupIdMap`). Call `accepts` first: this resolves the maths and
 * does not judge whether the drop is a move, so a same-place drop comes back
 * with the order and membership unchanged.
 *
 * - before/after a TAB: the dragged tab takes that tab's parent (its group, or the
 *   top level) and lands at that spot.
 * - before/after a GROUP header: a tab lands as a top-level node immediately
 *   before or after that whole block, leaving its own group if it had one.
 * - inside a group: the tab is appended as the group's last member.
 * - the root (`target: null`): the tab goes to the end of the top level, out of its group.
 * - a dragged group moves as a block, before or after a top-level node.
 */
export function resolveDrop(
  fullOrder: readonly string[],
  groupOf: (id: string) => string | undefined,
  dragged: string,
  drop: DrawerDrop,
): DropResult | null {
  const parsed = parseValue(dragged);
  if (parsed === null) return null;
  return parsed.kind === 'tab'
    ? resolveTabDrop(fullOrder, groupOf, parsed.id, drop)
    : resolveGroupDrop(fullOrder, groupOf, parsed.id, drop);
}
