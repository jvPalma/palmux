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
  | { kind: 'tab'; tab: TabMeta }
  | { kind: 'fused'; a: TabMeta; b: TabMeta };

/**
 * Which visible tabs fuse into one strip entry: for each adjacent pair in
 * VISIBLE order (collapsed members already excluded), a pairing fuses them
 * when its two ids equal that adjacent pair (in either strip order — the
 * emitted item keeps the pairing's OWN a/b slot order, not strip order).
 * Returns id-of-first-visible-member → the pairing, plus the set of second
 * members to skip when the main loop walks `tabs`.
 */
function planFusions(
  visibleIds: string[],
  pairingByTab: Map<string, { a: string; b: string }>,
): { starts: Map<string, { a: string; b: string }>; skip: Set<string> } {
  const starts = new Map<string, { a: string; b: string }>();
  const skip = new Set<string>();
  let i = 0;
  while (i < visibleIds.length - 1) {
    const x = visibleIds[i]!;
    const y = visibleIds[i + 1]!;
    const p = pairingByTab.get(x);
    if (p && ((p.a === x && p.b === y) || (p.a === y && p.b === x))) {
      starts.set(x, p);
      skip.add(y);
      i += 2; // both members consumed, resume after the pair
    } else {
      i += 1;
    }
  }
  return { starts, skip };
}

export function buildStrip(
  tabs: TabMeta[],
  groups: TabGroup[],
  collapsed: ReadonlySet<string>,
  pairings?: { a: string; b: string }[],
): StripItem[] {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const count = new Map<string, number>();
  const firstMember = new Map<string, string>();
  for (const t of tabs) {
    if (!t.groupId) continue;
    count.set(t.groupId, (count.get(t.groupId) ?? 0) + 1);
    if (!firstMember.has(t.groupId)) firstMember.set(t.groupId, t.id);
  }

  const tabById = new Map(tabs.map((t) => [t.id, t]));
  const pairingByTab = new Map<string, { a: string; b: string }>();
  for (const p of pairings ?? []) {
    pairingByTab.set(p.a, p);
    pairingByTab.set(p.b, p);
  }
  const visibleIds = tabs.filter((t) => !(t.groupId && collapsed.has(t.groupId))).map((t) => t.id);
  const { starts: fusedStarts, skip: fusedSkip } = planFusions(visibleIds, pairingByTab);

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
    if (fusedSkip.has(t.id)) continue; // second half, already emitted at its partner
    const fp = fusedStarts.get(t.id);
    if (fp) {
      items.push({ kind: 'fused', a: tabById.get(fp.a)!, b: tabById.get(fp.b)! });
      continue;
    }
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
 * Decide whether a completed tab drop is a plain reorder, a JOIN, or a LEAVE,
 * given the resulting `order` (dragged already at its dropped index). `centerJoin`
 * is the group id when the drop landed ON a member tab's center. Pure; the
 * decision table lives in docs/dnd-decision-table.md.
 */
export function decideGroupDrop(
  order: string[],
  groupIdOf: (id: string) => string | undefined,
  dragged: string,
  centerJoin?: string | undefined,
): { join?: string; leave?: string } {
  const dg = groupIdOf(dragged);
  if (centerJoin && centerJoin !== dg) return { join: centerJoin };
  const j = order.indexOf(dragged);
  const L = j > 0 ? order[j - 1] : undefined;
  const R = j < order.length - 1 ? order[j + 1] : undefined;
  const gL = L ? groupIdOf(L) : undefined;
  const gR = R ? groupIdOf(R) : undefined;
  // Interior of some OTHER group → join it.
  if (gL && gL === gR && gL !== dg) return { join: gL };
  // Leave only when FULLY detached from its own group (neither neighbor is a
  // member). Reordering a member to the edge of its own span keeps it — dragging
  // it clearly OUT (both sides non-group) ejects it. (Refined from the doc's
  // stricter "front-edge == leave", which would eject on an in-place front drop.)
  if (dg && gL !== dg && gR !== dg) return { leave: dg };
  return {};
}
