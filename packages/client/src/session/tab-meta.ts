// ── Tab display metadata ──────────────────────────────────────────────────────
//
// Pure helpers shared by the desktop tab strip and the mobile drawer so both
// render the same identity for a tab: kind icon, display title (custom name >
// live OSC title > kind default), and the fixed color palette (names on the
// wire, theme-matched hex here).

import type { TabKind, TabMeta } from '@palmux/shared';

const KIND_ICONS: { [K in TabKind]: string } = {
  terminal: '❯',
  web: '🌐',
  dashboard: '▦',
  editor: '✎',
  markdown: '📖',
};

export function kindIcon(kind: TabKind): string {
  return KIND_ICONS[kind];
}

/**
 * Chrome-tab-group style accent palette: the 16 ANSI slots, each a theme-aware
 * CSS var (`--tab-c-ansi<n>`, set by applyThemeTokens) so the SAME persisted
 * slot name renders in the active theme's own ansi16. Older, pre-ANSI16 color
 * names (red, peach, …) are never rewritten in persisted data — they resolve
 * forever through {@link LEGACY_COLOR_SLOTS} / {@link resolveColorSlot}.
 */
export const TAB_COLORS: { name: string; value: string }[] = Array.from({ length: 16 }, (_, n) => ({
  name: `ansi${n}`,
  value: `var(--tab-c-ansi${n})`,
}));

/** Pre-ANSI16 color names, forever mapped to their nearest ansi slot. */
const LEGACY_COLOR_SLOTS: { [name: string]: string } = {
  red: 'ansi1',
  green: 'ansi2',
  yellow: 'ansi3',
  blue: 'ansi4',
  mauve: 'ansi5',
  teal: 'ansi6',
  gray: 'ansi8',
  peach: 'ansi9',
  maroon: 'ansi9',
  lavender: 'ansi12',
  pink: 'ansi13',
  sky: 'ansi14',
};

/** A valid slot name as-is, else its legacy mapping, else undefined. */
export function resolveColorSlot(name: string | undefined): string | undefined {
  if (!name) return undefined;
  if (TAB_COLORS.some((c) => c.name === name)) return name;
  return LEGACY_COLOR_SLOTS[name];
}

export function tabColorValue(name: string | undefined): string | undefined {
  const slot = resolveColorSlot(name);
  return slot ? `var(--tab-c-${slot})` : undefined;
}

export function tabColorInk(name: string | undefined): string | undefined {
  const slot = resolveColorSlot(name);
  return slot ? `var(--tab-c-${slot}-ink)` : undefined;
}

/** Default title for a web tab: hostname for absolute URLs, path for same-origin. */
function webTitle(url: string | undefined): string {
  if (!url) return 'web';
  try {
    if (url.startsWith('/')) {
      const base = new URL(url, 'http://local');
      const segments = base.pathname.split('/').filter(Boolean);
      return segments[segments.length - 1] ?? url;
    }
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

/** What a tab is called in the strip/drawer: name > OSC title > kind default. */
export function displayTitle(tab: TabMeta): string {
  if (tab.name) return tab.name;
  switch (tab.kind) {
    case 'terminal':
      return tab.title || 'shell';
    case 'web':
      return webTitle(tab.url);
    case 'dashboard':
      return 'dashboard';
    case 'editor':
      // An editor tab is two things, told apart by `url`: with an absolute path
      // it edits that file on disk and is named after it (the same rule
      // markdown uses); without one it is the tab's own note.
      return tab.url ? (tab.url.split('/').pop() ?? 'notes') : 'notes';
    case 'markdown':
      return tab.url ? (tab.url.split('/').pop() ?? 'markdown') : 'markdown';
  }
}

/**
 * Move `id` to insertion `index` within `ids` (index counted over the CURRENT
 * list, dragged tab included — the standard strip-reorder convention). Unknown
 * ids and out-of-range indices are handled totally: unknown → unchanged,
 * index clamped to [0, length].
 */
export function reorderIds(ids: string[], id: string, index: number): string[] {
  const from = ids.indexOf(id);
  if (from === -1) return ids;
  const clamped = Math.max(0, Math.min(Math.trunc(index), ids.length));
  const without = ids.filter((x) => x !== id);
  // Removing the dragged tab shifts targets to its right one slot left.
  const at = clamped > from ? clamped - 1 : clamped;
  without.splice(at, 0, id);
  return without;
}

/**
 * Where to go when `closedId` disappears from the strip: its LEFT neighbor in
 * display order, else its right one, else the first surviving tab, else null
 * (nothing left — the caller shows the New-tab page). `survivors` filters out
 * tabs that died in the same broadcast.
 */
export function neighborAfterClose(
  prevIds: string[],
  closedId: string,
  survivors: ReadonlySet<string>,
): string | null {
  const alive = prevIds.filter((id) => id === closedId || survivors.has(id));
  const at = alive.indexOf(closedId);
  if (at === -1) return prevIds.find((id) => survivors.has(id)) ?? null;
  return alive[at - 1] ?? alive[at + 1] ?? null;
}

/**
 * Drop keys not in `live` from a set, returning the SAME reference when nothing
 * was removed so a React state update bails (no needless re-render). The prune
 * every `sessions` broadcast runs over per-device view state.
 */
export function pruneSet(prev: ReadonlySet<string>, live: ReadonlySet<string>): Set<string> {
  let changed = false;
  const next = new Set<string>();
  for (const id of prev) {
    if (live.has(id)) next.add(id);
    else changed = true;
  }
  return changed ? next : (prev as Set<string>);
}

/** As {@link pruneSet}, for an id→value record. */
export function pruneRecord<V>(
  prev: { [id: string]: V },
  live: ReadonlySet<string>,
): { [id: string]: V } {
  let changed = false;
  const next: { [id: string]: V } = {};
  for (const [id, v] of Object.entries(prev)) {
    if (live.has(id)) next[id] = v;
    else changed = true;
  }
  return changed ? next : prev;
}
