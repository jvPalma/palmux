// ── PWA manifest, themed ──────────────────────────────────────────────────────
//
// The static `public/manifest.webmanifest` carried a hardcoded Mocha
// `theme_color`, and an INSTALLED app takes its system bars from the manifest —
// not from the `<meta name="theme-color">` the client keeps in sync. So a phone
// running a light theme got a near-black status bar over a cream page, and no
// amount of runtime meta-tag updating could reach it: by then Chrome has already
// baked the colour in from the manifest it fetched.
//
// Serving the manifest from here fixes that at the only place that can. The file
// on disk stays the source for everything else (name, icons, display, …); only
// the two colour fields are overwritten, so adding an icon or changing the scope
// still means editing the JSON and nothing here.
//
// The manifest is fetched WITHOUT credentials (browsers do that by spec, which
// is why the auth gate exempts it), so this must resolve the theme from the
// server's own stored settings rather than from any session. `themeId` is a
// per-device key that every client writes over the wire, so what is on disk is
// the last theme anyone chose — right for a single-user host, and the honest
// limit of a per-origin manifest.
//
// Chrome re-reads a manifest on its own schedule, so a theme change shows up on
// the system bars at the next manifest refresh or re-install, not instantly. The
// meta tag covers the browser-tab case immediately; between them every surface
// ends up on the right colour.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getProfile, hex, type ColorProfile } from '@palmux/shared';

/** The two fields an installed PWA actually paints with. */
export interface ManifestColors {
  theme_color: string;
  background_color: string;
}

export function manifestColors(profile: ColorProfile): ManifestColors {
  // Both take the terminal's OWN background, not a derived UI token: the app is
  // a terminal, and the splash screen should be the colour the terminal opens on.
  const bg = hex(profile.bg);
  return { theme_color: bg, background_color: bg };
}

/**
 * The on-disk manifest with its colours replaced. Returns null when the file is
 * missing (a source checkout with no build), so the caller can fall through to
 * the static handler rather than inventing one.
 */
export async function themedManifest(
  clientDir: string,
  themeId: string,
): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await readFile(join(clientDir, 'manifest.webmanifest'), 'utf8');
  } catch {
    return null;
  }
  let base: Record<string, unknown>;
  try {
    base = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null; // a broken manifest is the build's problem, not ours to guess at
  }
  return { ...base, ...manifestColors(getProfile(themeId)) };
}
