#!/usr/bin/env node
// ── Vendor Material Icon Theme into the file browser ──────────────────────────
//
// Reads a local install of the VS Code extension `PKief.material-icon-theme`
// (MIT) and writes the parts palmux needs into `packages/client/public/`:
//
//   file-icons/<name>.svg   one file per REACHABLE icon (~825 KB total)
//   file-icons/index.json   a compacted name → icon lookup (~215 KB, ~29 KB gzipped)
//
// Run manually, output committed. It must NOT be part of `yarn build`: the
// extension is on THIS machine, and a build that needs a VS Code install would
// stop being self-hostable, which is the whole point of the project.
//
// "Reachable" means referenced by one of the maps the browser can consult, plus
// the defaults. The extension ships 1251 icons; 1135 are reachable and the rest
// belong to variants palmux does not render (light / high contrast). `du`
// reports 5.1 MB for the icon directory — that is block overhead on 1251 tiny
// files; the bytes are 825 KB, and only the icons on screen are ever fetched.
//
// The index does NOT carry `folderNamesExpanded`. Measured on 5.38.1, all 4654
// of its entries are mechanically `<closed>-open`, so shipping it would add
// ~148 KB to say what one string concatenation says. The build asserts that
// property still holds and refuses to write an index that would be wrong.
//
//   node scripts/build-file-icons.mjs [--ext <path to the extension dir>]

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '../packages/client/public/file-icons');

/** Newest `pkief.material-icon-theme-*` under the usual VS Code roots. */
function findExtension() {
  const roots = [
    join(process.env['HOME'] ?? '', '.vscode-server/extensions'),
    join(process.env['HOME'] ?? '', '.vscode/extensions'),
    join(process.env['HOME'] ?? '', '.cursor-server/extensions'),
  ];
  const hits = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root)) {
      if (name.startsWith('pkief.material-icon-theme-')) hits.push(join(root, name));
    }
  }
  // Version sort by the trailing x.y.z so a stale copy never wins.
  const key = (p) =>
    (basename(p).split('-').pop() ?? '0')
      .split('.')
      .map((n) => Number(n) || 0)
      .reduce((a, n) => a * 1000 + n, 0);
  hits.sort((a, b) => key(b) - key(a));
  return hits[0] ?? null;
}

const argIdx = process.argv.indexOf('--ext');
const ext = argIdx > -1 ? process.argv[argIdx + 1] : findExtension();
if (!ext || !existsSync(ext)) {
  console.error(
    'material-icon-theme not found. Install the VS Code extension PKief.material-icon-theme,\n' +
      'or pass --ext <path to the extension directory>.',
  );
  process.exit(1);
}

const themePath = join(ext, 'dist/material-icons.json');
if (!existsSync(themePath)) {
  console.error(`no dist/material-icons.json under ${ext} — is this the right extension?`);
  process.exit(1);
}

const theme = JSON.parse(readFileSync(themePath, 'utf8'));
const defs = theme.iconDefinitions ?? {};

// The maps palmux consults, in the order it consults them. `languageIds` is
// carried because a future caller may know a language id; nothing reads it yet.
const MAPS = [
  'fileExtensions',
  'fileNames',
  'folderNames',
  // An expanded folder gets its own icon in VS Code and the tree has that state,
  // so dropping these would make every open folder fall back to the generic one.
  'folderNamesExpanded',
  'languageIds',
];
const DEFAULTS = ['file', 'folder', 'folderExpanded'];

const needed = new Set();
for (const m of MAPS) for (const v of Object.values(theme[m] ?? {})) needed.add(v);
for (const d of DEFAULTS) if (theme[d]) needed.add(theme[d]);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

let bytes = 0;
let written = 0;
const missing = [];
for (const name of needed) {
  const def = defs[name];
  if (!def?.iconPath) {
    missing.push(name);
    continue;
  }
  const src = resolve(join(ext, 'dist'), def.iconPath);
  if (!existsSync(src)) {
    missing.push(name);
    continue;
  }
  const svg = readFileSync(src);
  writeFileSync(join(OUT, `${name}.svg`), svg);
  bytes += svg.length;
  written++;
}

// Only entries whose icon actually landed — a lookup that resolves to a 404 is
// worse than the default, because the row renders a broken image instead.
const keep = (obj) =>
  Object.fromEntries(Object.entries(obj ?? {}).filter(([, v]) => defs[v] && !missing.includes(v)));

const index = {
  // Provenance, so nobody has to guess where these came from or under what terms.
  _source: 'PKief.material-icon-theme',
  _version: basename(ext).split('-').pop(),
  _license: 'MIT',
  fileExtensions: keep(theme.fileExtensions),
  fileNames: keep(theme.fileNames),
  folderNames: keep(theme.folderNames),
  languageIds: keep(theme.languageIds),
  file: theme.file ?? 'file',
  folder: theme.folder ?? 'folder',
  folderExpanded: theme.folderExpanded ?? 'folder-open',
};

// The index omits folderNamesExpanded and the client appends `-open` instead.
// That is only safe while the extension keeps the naming convention, so verify
// it rather than assume it — a silent drift would give every expanded folder a
// 404 and a broken image.
const expanded = theme.folderNamesExpanded ?? {};
const drifted = Object.entries(expanded).filter(
  ([k, v]) => index.folderNames[k] && v !== `${index.folderNames[k]}-open`,
);
if (drifted.length) {
  console.error(
    `${drifted.length} expanded folder icon(s) are not "<closed>-open" — the client's rule is\n` +
      `no longer valid. First: ${drifted[0][0]} → ${drifted[0][1]}\n` +
      'Re-add folderNamesExpanded to the index and read it in file-icons.ts.',
  );
  process.exit(1);
}

const json = JSON.stringify(index);
writeFileSync(join(OUT, 'index.json'), json);

const license = join(ext, 'LICENSE.txt');
if (existsSync(license)) {
  writeFileSync(
    join(OUT, 'LICENSE.txt'),
    `${readFileSync(license, 'utf8')}\n\nVendored into palmux by scripts/build-file-icons.mjs from ${basename(ext)}.\n`,
  );
}

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
console.log(`source     ${ext}`);
console.log(`icons      ${written} svg, ${kb(bytes)}`);
console.log(`index      ${kb(json.length)}`);
if (missing.length) console.log(`skipped    ${missing.length} unresolvable icon name(s)`);
console.log(`out        ${OUT}`);
