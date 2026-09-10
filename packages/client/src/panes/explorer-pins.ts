// ── Explorer pinned roots ─────────────────────────────────────────────────────
//
// The Explorer shows the server's HOME as one collapsible root, and every pinned
// folder as another — VS Code's multi-root workspace, minus the workspace file.
//
// The list is a SYNCED setting rather than per-device view state, unlike the tab
// groups' collapse set. These are paths on the SERVER's filesystem: the same list
// is correct on every device pointed at the same palmux, and a phone that has to
// re-pin what the desktop already pinned is just worse.
//
// Everything here is pure so the ordering and dedupe rules are testable without
// a tree, a socket or a settings round trip.

/** Normalize for comparison: no trailing slash, except for the root itself. */
export function normalizePin(path: string): string {
  const p = path.trim();
  if (!p.startsWith('/')) return '';
  const stripped = p.replace(/\/+$/, '');
  return stripped || '/';
}

/**
 * Add `path` to the pins.
 *
 * Newest FIRST, because pinning is immediately followed by working in the thing
 * you just pinned — the host opens it and collapses the rest, and a root that
 * appears at the bottom of a long list would have to be scrolled to.
 * Re-pinning an existing path moves it to the front rather than duplicating it.
 */
export function addPin(pins: string[], path: string): string[] {
  const p = normalizePin(path);
  if (!p) return pins;
  return [p, ...pins.filter((x) => normalizePin(x) !== p)];
}

export function removePin(pins: string[], path: string): string[] {
  const p = normalizePin(path);
  return pins.filter((x) => normalizePin(x) !== p);
}

export function isPinned(pins: string[], path: string): boolean {
  const p = normalizePin(path);
  return pins.some((x) => normalizePin(x) === p);
}

/**
 * The roots to render, home first.
 *
 * Home is not a pin and cannot be unpinned — it is the tree's floor, and the
 * only thing the Explorer can show before anything has been pinned at all. A
 * pin EQUAL to home is dropped rather than drawn twice; a pin nested inside home
 * is kept, because that is the entire point (a project folder is a shortcut into
 * a tree you can already reach the slow way).
 */
export function explorerRoots(home: string | null, pins: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [...(home ? [home] : []), ...pins]) {
    const p = normalizePin(raw);
    if (!p || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

/** Last path segment, for a root's label. `/` renders as itself. */
export function rootLabel(path: string): string {
  const p = normalizePin(path);
  if (p === '/') return '/';
  return p.slice(p.lastIndexOf('/') + 1) || p;
}

/**
 * The directory a root lives IN, with a trailing slash — the dim half of a root
 * header, next to `rootLabel`'s last segment.
 *
 * Not the full path: the header already shows the segment, so repeating it is
 * noise, and the full path needs end-truncation to fit. Truncating the FRONT
 * instead (the `direction: rtl` trick) reorders the neutral leading slash and
 * renders `/home/user/projects` as `home/user/projects/` — measured on screen.
 */
export function rootParent(path: string): string {
  const p = normalizePin(path);
  if (p === '/' || !p) return '';
  const cut = p.lastIndexOf('/');
  return cut <= 0 ? '/' : `${p.slice(0, cut)}/`;
}

/** Parse a persisted pin list, dropping anything unusable. Never throws. */
export function parsePins(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== 'string') continue;
    const p = normalizePin(v);
    if (p && p !== '/' && !out.includes(p)) out.push(p);
  }
  return out;
}
