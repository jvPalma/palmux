// ── Tab-group view logic (pure) ───────────────────────────────────────────────
//
// Everything the strip/drawer need to render groups and resolve group drags,
// kept out of the JSX so it is unit-testable. The server owns the group MODEL
// (membership, contiguity); this is the CLIENT view over the broadcast +
// per-device collapse state. See docs/{group-model,collapse-state-machine,
// dnd-decision-table}.md.

import type { TabGroup, TabMeta } from '@palmux/shared';

/** Stable empty collapsed-set for the `collapsed` prop fallback — a shared
 *  reference avoids allocating a fresh Set every render (memo-safe). */
export const NO_COLLAPSED: ReadonlySet<string> = new Set<string>();

/** Forgiving parse of `localStorage['palmux-collapsed-groups']` (corrupt → []). */
export function parseCollapsed(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** groupId of a tab id in the current broadcast, or undefined. */
export function groupIdOf(tabs: TabMeta[], id: string): string | undefined {
  return tabs.find((t) => t.id === id)?.groupId;
}

/**
 * A drop boundary pinned to a GROUP's leading edge, not to a tab. A drag hovers
 * for as long as the user likes while other windows keep editing the strip, so a
 * tab id captured at hover time (the group's first member, then) can leave the
 * group and take the drop with it. The group is what the preview drew the
 * marker on, so the group is what the commit resolves — via `groupEdgeTarget`,
 * against the order the drop actually applies to.
 */
export interface GroupEdge {
  groupId: string;
  edge: 'before';
}

/** The tab a group edge lands before right now — the group's first member in
 *  FULL order (collapsed or not) — or undefined once the group has no members. */
export function groupEdgeTarget(tabs: TabMeta[], anchor: GroupEdge): string | undefined {
  return tabs.find((t) => t.groupId === anchor.groupId)?.id;
}

/**
 * id → groupId for the tabs that have one — an O(1) membership accessor. Build
 * this once per operation instead of calling `groupIdOf` (an O(n) `find`) inside
 * a loop, which would be O(n²) over the strip.
 */
export function groupIdMap(tabs: TabMeta[]): (id: string) => string | undefined {
  const m = new Map<string, string>();
  for (const t of tabs) if (t.groupId) m.set(t.id, t.groupId);
  return (id) => m.get(id);
}

/**
 * The strip render sequence: a chip is emitted BEFORE each group's first tab
 * (collapsed groups show only their chip; their members are omitted). `tabIndex`
 * counts ONLY tab items, so chips never shift the reorder drop math.
 */
export type StripItem =
  | {
      kind: 'chip';
      group: TabGroup;
      memberCount: number;
      collapsed: boolean;
      firstMemberId: string;
    }
  | { kind: 'tab'; tab: TabMeta };

export function buildStrip(
  tabs: TabMeta[],
  groups: TabGroup[],
  collapsed: ReadonlySet<string>,
): StripItem[] {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const count = new Map<string, number>();
  const firstMember = new Map<string, string>();
  for (const t of tabs) {
    if (!t.groupId) continue;
    count.set(t.groupId, (count.get(t.groupId) ?? 0) + 1);
    if (!firstMember.has(t.groupId)) firstMember.set(t.groupId, t.id);
  }

  const chipDone = new Set<string>();
  const items: StripItem[] = [];
  for (const t of tabs) {
    const g = t.groupId ? byId.get(t.groupId) : undefined;
    if (g && !chipDone.has(g.id)) {
      chipDone.add(g.id);
      items.push({
        kind: 'chip',
        group: g,
        memberCount: count.get(g.id) ?? 0,
        collapsed: collapsed.has(g.id),
        firstMemberId: firstMember.get(g.id)!,
      });
    }
    if (t.groupId && collapsed.has(t.groupId)) continue; // hidden member
    items.push({ kind: 'tab', tab: t });
  }
  return items;
}

/** The tab immediately before a group's span, else immediately after, else null
 *  — `neighborAfterClose` semantics used for the collapse active-tab guard. */
export function nearestOutside(
  orderIds: string[],
  groupIdOf: (id: string) => string | undefined,
  gid: string,
): string | null {
  const first = orderIds.findIndex((id) => groupIdOf(id) === gid);
  if (first === -1) return null;
  let last = first;
  for (let i = first; i < orderIds.length; i++) if (groupIdOf(orderIds[i]!) === gid) last = i;
  return orderIds[first - 1] ?? orderIds[last + 1] ?? null;
}

/**
 * Move an insertion point that falls BETWEEN two members of a group the dragged
 * entry is not in (`own`) to that group's nearer outer edge, ties going before
 * it. A boundary drop — anything but the centre of a member: a gap, a pill's
 * half, a chip's half — never joins a group, and between two members is the one
 * place an order alone reads as a join. `rest` is the order without the dragged entry, `at` an
 * insertion index into it; returns the index to use instead (unchanged when the
 * point is not inside a foreign group).
 */
export function outsideForeignGroup(
  rest: string[],
  at: number,
  groupOf: (id: string) => string | undefined,
  own: string | undefined,
): number {
  if (at <= 0 || at >= rest.length) return at;
  const g = groupOf(rest[at - 1]!);
  if (g === undefined || g === own || groupOf(rest[at]!) !== g) return at;
  let first = at - 1;
  while (first > 0 && groupOf(rest[first - 1]!) === g) first--;
  let end = at;
  while (end < rest.length && groupOf(rest[end]!) === g) end++;
  return at - first <= end - at ? first : end;
}

/**
 * Decide whether a completed tab drop is a plain reorder, a JOIN, or a LEAVE,
 * given the resulting `order` (dragged already at its dropped index). `centerJoin`
 * is the group id when the drop landed ON a member tab's center. `boundary` marks
 * any other strip drop (a gap, a pill's half, a chip's half): it never joins,
 * whatever its neighbours are.
 * Pure; the decision table lives in docs/dnd-decision-table.md.
 */
export function decideGroupDrop(
  order: string[],
  groupIdOf: (id: string) => string | undefined,
  dragged: string,
  centerJoin?: string | undefined,
  boundary?: boolean,
): { join?: string; leave?: string } {
  const dg = groupIdOf(dragged);
  if (centerJoin && centerJoin !== dg) return { join: centerJoin };
  const j = order.indexOf(dragged);
  const L = j > 0 ? order[j - 1] : undefined;
  const R = j < order.length - 1 ? order[j + 1] : undefined;
  const gL = L ? groupIdOf(L) : undefined;
  const gR = R ? groupIdOf(R) : undefined;
  // Interior of some OTHER group → join it. Only an order without the boundary
  // flag can get here; every strip drop carries it, and was already moved to
  // the group's edge by outsideForeignGroup.
  if (!boundary && gL && gL === gR && gL !== dg) return { join: gL };
  // Leave only when FULLY detached from its own group (neither neighbor is a
  // member). Reordering a member to the edge of its own span keeps it — dragging
  // it clearly OUT (both sides non-group) ejects it. (Refined from the doc's
  // stricter "front-edge == leave", which would eject on an in-place front drop.)
  if (dg && gL !== dg && gR !== dg) return { leave: dg };
  return {};
}
