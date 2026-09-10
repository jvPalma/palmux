// ── Theme import by URL/name ──────────────────────────────────────────────────
//
// Fetch a terminal colour theme and drop it into `~/.config/palmux/themes/`,
// where the existing discovery + fs watch pick it up and broadcast it to every
// client — so an imported theme appears in the picker without a restart.
//
// Input is deliberately forgiving, because what a user has to hand is a browser
// tab, not a raw URL: a bare theme name, the install COMMAND the Gogh gallery's
// Copy button hands out, a Gogh page link, a github.com blob URL, or a direct
// raw URL all resolve to the same fetch. A pasted command is parsed for its
// theme name and otherwise inert — palmux never runs it.
//
// Trust: the fetch runs server-side, which is only meaningful because the cookie
// gate already fronts a shell that can curl anything itself — the importer adds
// no reach the session did not already have. What it DOES add is a write into
// the themes dir, so the filename is derived from the parsed theme, never from
// the URL.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseGoghTheme, parseWindowsTerminalScheme, type ColorProfile } from '@palmux/shared';
import { configDir } from './config';

/** Max theme payload — a colour scheme is ~1 KB; anything larger is not one. */
const MAX_BYTES = 256 * 1024;
const GOGH_RAW = 'https://raw.githubusercontent.com/Gogh-Co/Gogh/master/themes';

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'theme';

/**
 * Read the theme name out of a Gogh install command — what the Gogh gallery's
 * Copy button actually gives you:
 *
 *   bash -c "$(wget -qO- https://git.io/vQgMr)" -- "Everforest Light Hard"
 *
 * The command is NEVER executed, and nothing in it is fetched. It is treated
 * purely as a carrier for the quoted name, which is then resolved against the
 * current Gogh repo — deliberately ignoring the URL the command carries, since
 * that one still points at the pre-rename `Mayccoll/Gogh`.
 *
 * Gogh accepts several names in one command; we take the FIRST, because an
 * import selects exactly one theme.
 */
export function themeNameFromCommand(input: string): string | null {
  if (!/\b(?:bash|sh|zsh|wget|curl)\b/.test(input)) return null;
  // A standalone `--` ends the options and begins the theme list. The flags in
  // the command itself (`-qO-`, `-sLo-`) never match: `--` must stand alone.
  const args = /\s--\s+(\S.*)$/.exec(input);
  if (!args) return null;
  const first = /^"([^"]+)"|^'([^']+)'|^(\S+)/.exec(args[1]!.trim());
  const name = first?.[1] ?? first?.[2] ?? first?.[3];
  return name?.trim() || null;
}

/**
 * Turn whatever the user pasted into a fetchable URL.
 * A bare name ("Tokyo Night") becomes a Gogh theme lookup; Gogh spells its files
 * in Title Case with spaces, so the name is passed through as typed (encoded),
 * not slugged.
 */
export function resolveThemeUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;

  // A pasted install command: the name inside it wins over any URL it carries.
  const named = themeNameFromCommand(raw);
  if (named) return `${GOGH_RAW}/${encodeURIComponent(named)}.yml`;
  // …unless it is the newer per-theme form, whose URL IS the theme file.
  if (/\b(?:bash|sh|zsh|wget|curl)\b/.test(raw)) {
    const install = /https?:\/\/\S*?\/installs\/[\w.%-]+\.sh/.exec(raw);
    if (install) return install[0];
  }

  // github.com/<o>/<r>/blob/<ref>/<path> → the raw host (a blob URL serves HTML).
  const blob = /^https?:\/\/github\.com\/([^/]+\/[^/]+)\/blob\/(.+)$/.exec(raw);
  if (blob) return `https://raw.githubusercontent.com/${blob[1]}/${blob[2]}`;

  // The Gogh gallery links a theme as .../Gogh/#<name> — the fragment is the name.
  const gallery = /^https?:\/\/gogh-co\.github\.io\/Gogh\/?#(.+)$/.exec(raw);
  if (gallery) return `${GOGH_RAW}/${encodeURIComponent(decodeURIComponent(gallery[1]!))}.yml`;

  if (/^https?:\/\//i.test(raw)) return raw;
  // Anything else is treated as a Gogh theme name. Quotes are stripped because a
  // name copied out of a command usually arrives still wearing them.
  const bare = raw.replace(/^["']|["']$/g, '').trim();
  if (/^[\w .'+-]{1,64}$/.test(bare)) return `${GOGH_RAW}/${encodeURIComponent(bare)}.yml`;
  return null;
}

/** Parse fetched text by shape: JSON → Windows-Terminal scheme, else Gogh. */
export function parseImportedTheme(text: string, fallbackName: string): ColorProfile | null {
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{')) {
    try {
      return parseWindowsTerminalScheme(JSON.parse(text), `user:${slug(fallbackName)}`);
    } catch {
      return null;
    }
  }
  return parseGoghTheme(text, `user:${slug(fallbackName)}`, fallbackName);
}

export type ImportResult = { ok: true; id: string; name: string } | { ok: false; error: string };

/** Fetch, parse and save a theme. Returns the profile so the caller can report it. */
export async function importTheme(input: string): Promise<ImportResult> {
  const url = resolveThemeUrl(input);
  if (!url) return { ok: false, error: 'Not a theme name or URL' };

  let text: string;
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
      headers: { accept: 'text/plain, application/json, */*' },
    });
    if (!res.ok) {
      return { ok: false, error: res.status === 404 ? 'No theme at that name/URL' : `HTTP ${res.status}` }; // prettier-ignore
    }
    const body = await res.arrayBuffer();
    if (body.byteLength > MAX_BYTES) return { ok: false, error: 'Too large to be a theme' };
    text = new TextDecoder().decode(body);
  } catch {
    return { ok: false, error: 'Could not reach that URL' };
  }

  // Name the file after the theme, not the URL — the URL is untrusted input and
  // the parsed name is what the picker will show anyway.
  const guess = decodeURIComponent(url.split('/').pop() ?? 'theme').replace(/\.(yml|yaml|sh|json|conf)$/i, ''); // prettier-ignore
  const profile = parseImportedTheme(text, guess);
  if (!profile) return { ok: false, error: 'No foreground/background colours found' };

  const ext = text.trimStart().startsWith('{') ? 'json' : 'yml';
  const file = `${slug(profile.name)}.${ext}`;
  try {
    const dir = join(configDir(), 'themes');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, file), text, { encoding: 'utf8', mode: 0o644 });
  } catch {
    return { ok: false, error: 'Could not write to the themes folder' };
  }
  // discoverThemes() derives the id from the FILENAME, so mirror it here — the
  // client uses this to select the theme it just imported.
  return { ok: true, id: `user:${slug(profile.name)}`, name: profile.name };
}
