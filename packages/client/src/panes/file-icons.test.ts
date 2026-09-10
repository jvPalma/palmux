// The Material-icon lookup. Everything here is about the two ways a filename
// can be misread — the extension chain and the leading dot — plus the promise
// the build script makes about expanded folders.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __setIconIndex,
  iconIndex,
  entryIconUrl,
  extensionChain,
  fileIconName,
  folderIconName,
  iconUrl,
  loadIconIndex,
} from './file-icons';

const INDEX = {
  fileExtensions: { ts: 'typescript', 'spec.ts': 'test-ts', 'd.ts': 'typescript-def', md: 'markdown' },
  fileNames: { 'package.json': 'nodejs', '.gitignore': 'git', 'readme.md': 'readme' },
  folderNames: { src: 'folder-src', node_modules: 'folder-node' },
  languageIds: { typescript: 'typescript' },
  file: 'file',
  folder: 'folder',
  folderExpanded: 'folder-open',
};

let IDX = INDEX as never;
beforeEach(() => {
  IDX = INDEX as never;
  __setIconIndex(INDEX);
});
afterEach(() => {
  __setIconIndex(null);
  vi.unstubAllGlobals();
});

describe('extensionChain', () => {
  it('yields every suffix, longest first', () => {
    expect(extensionChain('app.spec.ts')).toEqual(['spec.ts', 'ts']);
    expect(extensionChain('types.d.ts')).toEqual(['d.ts', 'ts']);
    expect(extensionChain('plain.md')).toEqual(['md']);
    expect(extensionChain('Makefile')).toEqual([]);
  });

  // A dotfile's leading dot is part of its NAME. Treating it as an extension
  // would look up `gitignore`, match nothing, and shadow the fileNames hit.
  it('does not read a leading dot as an extension', () => {
    expect(extensionChain('.gitignore')).toEqual([]);
    expect(extensionChain('.eslintrc.json')).toEqual(['json']);
  });

  it('is case-insensitive', () => {
    expect(extensionChain('README.MD')).toEqual(['md']);
  });
});

describe('fileIconName', () => {
  it('prefers an exact filename over any extension', () => {
    expect(fileIconName(IDX, 'package.json')).toBe('nodejs');
    expect(fileIconName(IDX, 'README.md')).toBe('readme'); // not `markdown`
  });

  it('takes the LONGEST matching extension', () => {
    expect(fileIconName(IDX, 'app.spec.ts')).toBe('test-ts');
    expect(fileIconName(IDX, 'types.d.ts')).toBe('typescript-def');
    expect(fileIconName(IDX, 'index.ts')).toBe('typescript');
  });

  it('resolves a dotfile by name', () => {
    expect(fileIconName(IDX, '.gitignore')).toBe('git');
  });

  it('falls back to the generic file icon', () => {
    expect(fileIconName(IDX, 'whatever.qqq')).toBe('file');
    expect(fileIconName(IDX, 'Makefile')).toBe('file');
  });

  it('answers null with no index rather than guessing', () => {
    expect(fileIconName(null, 'index.ts')).toBeNull();
    expect(entryIconUrl(null, 'index.ts', false)).toBeNull();
  });
});

describe('folderIconName', () => {
  it('resolves a known folder and its open form by concatenation', () => {
    expect(folderIconName(IDX, 'src', false)).toBe('folder-src');
    expect(folderIconName(IDX, 'src', true)).toBe('folder-src-open');
  });

  it('falls back to the generic pair', () => {
    expect(folderIconName(IDX, 'whatever', false)).toBe('folder');
    expect(folderIconName(IDX, 'whatever', true)).toBe('folder-open');
  });

  it('is case-insensitive', () => {
    expect(folderIconName(IDX, 'SRC', false)).toBe('folder-src');
  });
});

describe('entryIconUrl', () => {
  it('builds a public path under /file-icons', () => {
    expect(iconUrl('typescript')).toBe('/file-icons/typescript.svg');
    expect(entryIconUrl(IDX, 'index.ts', false)).toBe('/file-icons/typescript.svg');
    expect(entryIconUrl(IDX, 'src', true, true)).toBe('/file-icons/folder-src-open.svg');
  });
});

describe('loadIconIndex', () => {
  it('shares one request between concurrent callers', async () => {
    __setIconIndex(null);
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => INDEX }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    const [a, b] = await Promise.all([loadIconIndex(), loadIconIndex()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(a).toBe(iconIndex());
    expect(fileIconName(a, 'index.ts')).toBe('typescript');
  });

  // A host that never ran the vendor script still has to list files.
  it('resolves null on a failure instead of throwing', async () => {
    __setIconIndex(null);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    await expect(loadIconIndex()).resolves.toBeNull();
    expect(iconIndex()).toBeNull();
  });

  it('rejects a body that is not an index', async () => {
    __setIconIndex(null);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) }) as Response));
    await expect(loadIconIndex()).resolves.toBeNull();
  });

  it('does not re-fetch once loaded', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await loadIconIndex();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── Against the REAL vendored index ───────────────────────────────────────────
//
// The unit tests above run on a hand-written index, which proves the algorithm
// and nothing about what `scripts/build-file-icons.mjs` actually produced. This
// reads the file on disk: it is the only thing that catches the build emitting
// a shape the resolver cannot use, or an entry whose SVG was never written.
describe('the vendored index', () => {
  const dir = join(__dirname, '../../public/file-icons');
  const path = join(dir, 'index.json');
  const present = existsSync(path);

  it.runIf(present)('resolves the kinds this repo is actually made of', () => {
    const real = JSON.parse(readFileSync(path, 'utf8'));
    const cases: [string, boolean, string][] = [
      ['App.tsx', false, 'react_ts'],
      ['server.ts', false, 'typescript'],
      ['package.json', false, 'nodejs'],
      ['README.md', false, 'readme'],
      ['.gitignore', false, 'git'],
      ['index.css', false, 'css'],
      ['build.mjs', false, 'javascript'],
      ['node_modules', true, 'folder-node'],
      ['src', true, 'folder-src'],
    ];
    for (const [name, isDir, expected] of cases) {
      const got = isDir ? folderIconName(real, name, false) : fileIconName(real, name);
      expect(got, name).toBe(expected);
    }
  });

  // Every name the resolver can return must have a file, or the row renders a
  // broken image — strictly worse than the fallback glyph it replaced.
  it.runIf(present)('has an SVG behind every reachable name, open forms included', () => {
    const idx = JSON.parse(readFileSync(path, 'utf8'));
    const names = new Set<string>([
      ...Object.values<string>(idx.fileExtensions),
      ...Object.values<string>(idx.fileNames),
      ...Object.values<string>(idx.folderNames),
      ...Object.values<string>(idx.folderNames).map((n) => `${n}-open`),
      idx.file,
      idx.folder,
      idx.folderExpanded,
    ]);
    const missing = [...names].filter((n) => !existsSync(join(dir, `${n}.svg`)));
    expect(missing, `missing ${missing.length} icon file(s)`).toEqual([]);
  });
});
