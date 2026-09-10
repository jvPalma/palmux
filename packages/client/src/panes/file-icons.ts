// ── File icons (Material Icon Theme) ──────────────────────────────────────────
//
// Resolves a file or directory NAME to an icon URL, using the same lookup order
// VS Code's `PKief.material-icon-theme` uses. The icons and the index are
// vendored into `public/file-icons/` by `scripts/build-file-icons.mjs` (MIT).
//
// Two things keep this cheap. The index is FETCHED, not bundled — 213 KB of
// lookup table has no business in the JS bundle for a terminal, and only the
// file browser ever asks for it. And each icon is its own file, so a session
// pulls the handful of icons actually on screen (~1 KB each, cached) instead of
// a sprite of 1135.
//
// The resolvers take the index as an ARGUMENT rather than reading the module
// cache. That is what lets a caller list it as a real React dependency: a
// version that read module state needed a `tick` counter to force re-renders,
// which the exhaustive-deps rule correctly called a lie. The module cache is
// still there — it stops a second tree re-fetching — but it is only a cache.
//
// A null index resolves to null, and callers render their own fallback. An icon
// appearing a moment late is invisible next to a tree that is itself still
// loading; blocking the tree on a 213 KB fetch would be felt.

const BASE = '/file-icons';

export interface IconIndex {
  fileExtensions: Record<string, string>;
  fileNames: Record<string, string>;
  folderNames: Record<string, string>;
  languageIds: Record<string, string>;
  file: string;
  folder: string;
  folderExpanded: string;
}

let cached: IconIndex | null = null;
let inflight: Promise<IconIndex | null> | null = null;

/** The cached index, or null if it has not loaded (or failed to). */
export function iconIndex(): IconIndex | null {
  return cached;
}

/**
 * Fetch the index once. Safe to call from every mount — concurrent callers share
 * one request, and a failure resolves to null rather than throwing: the tree
 * must still list files on a host where the icons were never vendored.
 */
export function loadIconIndex(): Promise<IconIndex | null> {
  if (cached) return Promise.resolve(cached);
  if (inflight) return inflight;
  inflight = fetch(`${BASE}/index.json`, { credentials: 'same-origin' })
    .then((r) => (r.ok ? (r.json() as Promise<IconIndex>) : null))
    .then((data) => {
      if (data && typeof data.file === 'string') cached = data;
      return cached;
    })
    .catch(() => null)
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Test seam — install an index synchronously, or clear it. */
export function __setIconIndex(next: IconIndex | null): void {
  cached = next;
  inflight = null;
}

export const iconUrl = (name: string): string => `${BASE}/${name}.svg`;

/**
 * Every extension chain of `name`, longest first: `app.spec.ts` → `spec.ts`,
 * `ts`. VS Code matches the longest, which is what makes `.spec.ts` and
 * `.d.ts` distinct from a plain `.ts`.
 *
 * A leading dot is NOT an extension: `.gitignore` is a file NAME, and treating
 * it as the extension `gitignore` would match nothing while shadowing the
 * fileNames hit that does.
 */
export function extensionChain(name: string): string[] {
  const lower = name.toLowerCase();
  const out: string[] = [];
  let from = lower.startsWith('.') ? 1 : 0;
  for (;;) {
    const dot = lower.indexOf('.', from);
    if (dot === -1) break;
    out.push(lower.slice(dot + 1));
    from = dot + 1;
  }
  return out;
}

/** The icon NAME for a file, or null with no index. */
export function fileIconName(idx: IconIndex | null, name: string): string | null {
  if (!idx) return null;
  const exact = idx.fileNames[name.toLowerCase()];
  if (exact) return exact;
  for (const ext of extensionChain(name)) {
    const hit = idx.fileExtensions[ext];
    if (hit) return hit;
  }
  return idx.file;
}

/** The icon NAME for a directory, or null with no index. */
export function folderIconName(idx: IconIndex | null, name: string, open: boolean): string | null {
  if (!idx) return null;
  const named = idx.folderNames[name.toLowerCase()];
  if (named) {
    // The index deliberately omits folderNamesExpanded: on 5.38.1 all 4654 of
    // its entries are `<closed>-open`, and the build refuses to run if that
    // stops being true, so the concatenation is checked rather than assumed.
    return open ? `${named}-open` : named;
  }
  return open ? idx.folderExpanded : idx.folder;
}

/** The icon URL for a tree entry, or null when there is nothing to show yet. */
export function entryIconUrl(
  idx: IconIndex | null,
  name: string,
  isDir: boolean,
  open = false,
): string | null {
  const icon = isDir ? folderIconName(idx, name, open) : fileIconName(idx, name);
  return icon ? iconUrl(icon) : null;
}
