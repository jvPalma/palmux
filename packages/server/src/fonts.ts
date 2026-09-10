// ── User font discovery ───────────────────────────────────────────────────────
//
// Scans the user's font directories (default ~/.fonts, recursively) for font
// files, reads the real family / weight / style from each file's name + OS/2
// tables via fontkit, and exposes them so the client can register @font-face
// faces and offer them in the picker. Faces of one family share a family name,
// so xterm's bold/italic rendering maps to the right file.
//
// Files are served by id (a hash of the absolute path) — the path itself is
// never derived from client input, so there's no traversal surface.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';

import { extname, join } from 'node:path';
import type { FontInfo } from '@palmux/shared';

// fontkit ships a browser ESM build (no filesystem) and a CJS Node build with
// openSync(); require() resolves the Node build regardless of the ESM importer.
const fontkit = createRequire(import.meta.url)('fontkit') as {
  openSync: (path: string) => unknown;
};

const EXT_TYPE: Record<string, string> = {
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttc': 'font/collection',
};

const MAX_FILES = 600; // cap scan/parse cost on large font collections
const MAX_DEPTH = 8;

export interface FontRegistry {
  faces: FontInfo[];
  serve: (id: string) => { path: string; type: string } | null;
}

// Directories come from app-config (config.json fontDirs / PALMUX_FONT_DIRS).

function walk(dir: string, out: string[], depth = 0): void {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= MAX_FILES) return;
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, out, depth + 1);
    else if (e.isFile() && extname(e.name).toLowerCase() in EXT_TYPE) out.push(full);
  }
}

// Minimal shape of what we read off a fontkit Font / collection.
interface FkFont {
  familyName?: string;
  subfamilyName?: string;
  italicAngle?: number;
  ['OS/2']?: { usWeightClass?: number };
}

function readFaces(file: string): { family: string; weight: number; style: 'normal' | 'italic' }[] {
  const opened = fontkit.openSync(file) as FkFont & { fonts?: FkFont[] };
  const fonts = Array.isArray(opened.fonts) ? opened.fonts : [opened];
  const out: { family: string; weight: number; style: 'normal' | 'italic' }[] = [];
  for (const f of fonts) {
    const family = f.familyName?.trim();
    if (!family) continue;
    const sub = (f.subfamilyName ?? '').toLowerCase();
    const w = f['OS/2']?.usWeightClass;
    const weight = typeof w === 'number' && w > 0 ? w : sub.includes('bold') ? 700 : 400;
    const italic =
      sub.includes('italic') ||
      sub.includes('oblique') ||
      (typeof f.italicAngle === 'number' && f.italicAngle !== 0);
    out.push({ family, weight, style: italic ? 'italic' : 'normal' });
  }
  return out;
}

export function discoverFonts(dirs: string[]): FontRegistry {
  const files: string[] = [];
  for (const dir of dirs) if (existsSync(dir)) walk(dir, files);

  const byId = new Map<string, { path: string; type: string }>();
  const faces: FontInfo[] = [];
  const seen = new Set<string>(); // family|weight|style — first file wins

  for (const file of files) {
    const ext = extname(file).toLowerCase();
    const type = EXT_TYPE[ext];
    if (!type) continue;
    let parsed;
    try {
      parsed = readFaces(file);
    } catch {
      continue; // unreadable / unsupported file — skip
    }
    if (!parsed.length) continue;
    const id = createHash('sha1').update(file).digest('hex').slice(0, 16) + ext;
    let used = false;
    for (const p of parsed) {
      const key = `${p.family}|${p.weight}|${p.style}`;
      if (seen.has(key)) continue;
      seen.add(key);
      faces.push({ family: p.family, weight: p.weight, style: p.style, url: `/fonts/${id}` });
      used = true;
    }
    if (used) byId.set(id, { path: file, type });
  }

  faces.sort((a, b) => a.family.localeCompare(b.family) || a.weight - b.weight);
  return { faces, serve: (id) => byId.get(id) ?? null };
}
