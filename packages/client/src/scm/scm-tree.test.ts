// The tree model and its collapse store, as pure functions. What the view draws
// from them is in SourceControlTree.test.tsx.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScmEntry } from '@palmux/shared';
import {
  COLLAPSED_KEY,
  MAX_COLLAPSED,
  buildTree,
  flattenTree,
  listRows,
  readCollapsed,
  setFolderCollapsed,
  splitPath,
  treeOrder,
  type FolderNode,
  type TreeNode,
} from './scm-tree';

const entry = (path: string, over: Partial<ScmEntry> = {}): ScmEntry => ({
  path,
  kind: 'ordinary',
  status: 'M',
  fp: `fp-${path}`,
  ...over,
});

const entriesOf = (...paths: string[]): ScmEntry[] => paths.map((p) => entry(p));

const folder = (node: TreeNode | undefined): FolderNode => {
  if (node?.kind !== 'folder') throw new Error('expected a folder');
  return node;
};

/** `depth name` per row, folders marked with a trailing slash. */
const outline = (nodes: readonly TreeNode[], collapsed: string[] = []): string[] =>
  flattenTree(nodes, new Set(collapsed)).map(
    (row) =>
      `${row.depth} ${row.kind === 'folder' ? `${row.node.name}/${row.open ? '' : ' (closed)'}` : row.name}`,
  );

describe('splitPath', () => {
  it('splits a name from its directory', () => {
    expect(splitPath('a.ts')).toEqual({ name: 'a.ts', dir: '' });
    expect(splitPath('src/panes/a.ts')).toEqual({ name: 'a.ts', dir: 'src/panes' });
  });

  it('keeps the trailing slash of a nested repository on its name', () => {
    expect(splitPath('vendor/inner/')).toEqual({ name: 'inner/', dir: 'vendor' });
    expect(splitPath('inner/')).toEqual({ name: 'inner/', dir: '' });
  });
});

describe('buildTree', () => {
  it('nests files under their folders and counts the files below each', () => {
    const tree = buildTree(entriesOf('README.md', 'src/a.ts', 'src/b.ts', 'src/ui/c.ts'));
    expect(tree.map((n) => n.kind)).toEqual(['file', 'folder']);
    const src = folder(tree[1]);
    expect(src).toMatchObject({ path: 'src', name: 'src', files: 3 });
    expect(src.children.map((n) => n.kind)).toEqual(['file', 'file', 'folder']);
    expect(folder(src.children[2])).toMatchObject({ path: 'src/ui', files: 1 });
  });

  it('shows a chain of single-folder folders as one row named by the chain', () => {
    const tree = buildTree(
      entriesOf('packages/client/src/review/a.ts', 'packages/client/src/review/b.ts'),
    );
    expect(tree).toHaveLength(1);
    expect(folder(tree[0])).toMatchObject({
      path: 'packages/client/src/review',
      name: 'packages/client/src/review',
      files: 2,
    });
    expect(outline(tree)).toEqual(['0 packages/client/src/review/', '1 a.ts', '1 b.ts']);
  });

  it('stops the chain at a folder that holds a file or a second folder', () => {
    const tree = buildTree(
      entriesOf('a/b/c/x.ts', 'a/b/y.ts', 'a/z/w/v.ts', 'a/z/w/u.ts', 'a/z/q.ts'),
    );
    expect(outline(tree)).toEqual([
      '0 a/',
      '1 b/',
      '2 c/',
      '3 x.ts',
      '2 y.ts',
      '1 z/',
      '2 w/',
      '3 v.ts',
      '3 u.ts',
      '2 q.ts',
    ]);
  });

  it('merges only down to the first folder that branches', () => {
    const tree = buildTree(entriesOf('a/b/c/x.ts', 'a/b/c/d/y.ts', 'a/b/c/e/z.ts'));
    expect(outline(tree)).toEqual(['0 a/b/c/', '1 x.ts', '1 d/', '2 y.ts', '1 e/', '2 z.ts']);
    // The collapse key of a chain is its deepest folder.
    expect(folder(tree[0]).path).toBe('a/b/c');
  });

  it('keeps one top-level file or folder per entry and never re-sorts', () => {
    const tree = buildTree(entriesOf('zeta/a.ts', 'alpha/b.ts', 'm.ts', 'zeta/c.ts', 'beta/d.ts'));
    expect(outline(tree)).toEqual([
      '0 zeta/',
      '1 a.ts',
      '1 c.ts',
      '0 alpha/',
      '1 b.ts',
      '0 m.ts',
      '0 beta/',
      '1 d.ts',
    ]);
  });

  it('puts a folder where its first file was, files and folders mixed in the entries order', () => {
    const tree = buildTree(entriesOf('a.ts', 'b/x.ts', 'c.ts', 'd/y.ts', 'e.ts'));
    expect(tree.map((n) => (n.kind === 'folder' ? `${n.name}/` : n.name))).toEqual([
      'a.ts',
      'b/',
      'c.ts',
      'd/',
      'e.ts',
    ]);
  });

  it('lists a repeated path once', () => {
    const tree = buildTree(entriesOf('a/x.ts', 'a/x.ts', 'a/y.ts'));
    expect(folder(tree[0]).files).toBe(2);
    expect(outline(tree)).toEqual(['0 a/', '1 x.ts', '1 y.ts']);
  });

  it('allows a file and a folder with the same name, as a typechange leaves in one group', () => {
    const tree = buildTree(entriesOf('a', 'a/b.ts'));
    expect(tree.map((n) => n.kind)).toEqual(['file', 'folder']);
    expect(folder(tree[1]).path).toBe('a');
    const rows = flattenTree(tree, new Set());
    expect(rows.map((r) => r.key)).toEqual(['f:a', 'd:a', 'f:a/b.ts']);
  });

  it('draws a nested repository as a leaf named with its slash, not as an empty name', () => {
    const tree = buildTree(entriesOf('vendor/inner/', 'vendor/other.ts'));
    expect(outline(tree)).toEqual(['0 vendor/', '1 inner/', '1 other.ts']);
  });

  it('is empty for no entries', () => {
    expect(buildTree([])).toEqual([]);
  });
});

describe('flattenTree', () => {
  const tree = buildTree(entriesOf('a/b/x.ts', 'a/b/y.ts', 'a/c.ts', 'd.ts'));

  it('lists every row of an open tree, with depth and the parent folder', () => {
    const rows = flattenTree(tree, new Set());
    expect(rows.map((r) => [r.key, r.depth, r.parent])).toEqual([
      ['d:a', 0, null],
      ['d:a/b', 1, 'a'],
      ['f:a/b/x.ts', 2, 'a/b'],
      ['f:a/b/y.ts', 2, 'a/b'],
      ['f:a/c.ts', 1, 'a'],
      ['f:d.ts', 0, null],
    ]);
  });

  it('hides everything under a collapsed folder and keeps the folder row', () => {
    expect(outline(tree, ['a'])).toEqual(['0 a/ (closed)', '0 d.ts']);
    expect(outline(tree, ['a/b'])).toEqual(['0 a/', '1 b/ (closed)', '1 c.ts', '0 d.ts']);
  });

  it('marks a folder open or closed on its row', () => {
    const rows = flattenTree(tree, new Set(['a/b']));
    const open = Object.fromEntries(
      rows.flatMap((r) => (r.kind === 'folder' ? [[r.node.path, r.open]] : [])),
    );
    expect(open).toEqual({ a: true, 'a/b': false });
  });

  it('keeps a collapse for a folder that is not in the tree without effect', () => {
    expect(outline(tree, ['gone/away'])).toEqual(outline(tree));
  });
});

describe('the tree lists the files in the order of the review', () => {
  it('equals the entries order for a path-sorted list, whatever the shape', () => {
    // The server's order: by code unit, so `-` and `.` sort before `/` and `0` after it.
    const sorted = entriesOf(
      '.github/workflows/ci.yml',
      'README.md',
      'a-b.ts',
      'a.ts',
      'a/b/c.ts',
      'a/b/d.ts',
      'a/e.ts',
      'a0.ts',
      'packages/client/src/review/x.ts',
      'packages/client/src/review/y.ts',
      'packages/server/src/s.ts',
      'z.ts',
    );
    expect(treeOrder(sorted).map((e) => e.path)).toEqual(sorted.map((e) => e.path));
    const rowFiles = flattenTree(buildTree(sorted), new Set())
      .filter((r) => r.kind === 'file')
      .map((r) => r.key.slice(2));
    expect(rowFiles).toEqual(sorted.map((e) => e.path));
  });

  it('equals the order of the flat list', () => {
    const sorted = entriesOf('a/x.ts', 'a/y.ts', 'b/z.ts', 'c.ts');
    expect(
      listRows(sorted)
        .filter((r) => r.kind === 'file')
        .map((r) => r.key),
    ).toEqual(
      flattenTree(buildTree(sorted), new Set())
        .filter((r) => r.kind === 'file')
        .map((r) => r.key),
    );
  });

  it('gathers a folder under its first file when the list is not path-sorted', () => {
    const unsorted = entriesOf('src/a.ts', 'test/c.ts', 'src/new.ts');
    expect(treeOrder(unsorted).map((e) => e.path)).toEqual(['src/a.ts', 'src/new.ts', 'test/c.ts']);
  });

  it('never moves a file across a collapsed folder: collapsing hides rows, it does not reorder', () => {
    const sorted = entriesOf('a/x.ts', 'a/y.ts', 'b.ts', 'c/z.ts');
    const visible = flattenTree(buildTree(sorted), new Set(['a']))
      .filter((r) => r.kind === 'file')
      .map((r) => r.key.slice(2));
    expect(visible).toEqual(['b.ts', 'c/z.ts']);
  });
});

describe('listRows', () => {
  it('is every file at depth 0 in the entries order, once each', () => {
    const rows = listRows(entriesOf('b/x.ts', 'a.ts', 'b/x.ts'));
    expect(rows.map((r) => [r.key, r.depth, r.parent])).toEqual([
      ['f:b/x.ts', 0, null],
      ['f:a.ts', 0, null],
    ]);
    expect(rows[0]).toMatchObject({ kind: 'file', name: 'x.ts' });
  });
});

describe('the collapse store', () => {
  const REPO = '/home/u/app';
  const stored = (): unknown => JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? 'null');

  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('reads nothing before anything is stored', () => {
    expect(readCollapsed(REPO, 'changes')).toEqual([]);
  });

  it('keeps each project and each group apart', () => {
    setFolderCollapsed(REPO, 'changes', 'packages/server', true);
    setFolderCollapsed(REPO, 'staged', 'docs', true);
    setFolderCollapsed('/home/u/lib', 'changes', 'src', true);
    expect(readCollapsed(REPO, 'changes')).toEqual(['packages/server']);
    expect(readCollapsed(REPO, 'staged')).toEqual(['docs']);
    expect(readCollapsed('/home/u/lib', 'changes')).toEqual(['src']);
    expect(readCollapsed('/home/u/lib', 'staged')).toEqual([]);
  });

  it('stores {v:1, byRepo:{[top]:{[group]: paths}}}', () => {
    setFolderCollapsed(REPO, 'changes', 'a/b', true);
    expect(stored()).toEqual({ v: 1, byRepo: { [REPO]: { changes: ['a/b'] } } });
  });

  it('expanding removes the path, and the last one leaves no empty husk behind', () => {
    setFolderCollapsed(REPO, 'changes', 'a', true);
    setFolderCollapsed(REPO, 'changes', 'b', true);
    setFolderCollapsed(REPO, 'changes', 'a', false);
    expect(readCollapsed(REPO, 'changes')).toEqual(['b']);
    setFolderCollapsed(REPO, 'changes', 'b', false);
    expect(stored()).toEqual({ v: 1, byRepo: {} });
  });

  it('collapsing twice stores the path once', () => {
    setFolderCollapsed(REPO, 'changes', 'a', true);
    setFolderCollapsed(REPO, 'changes', 'a', true);
    expect(readCollapsed(REPO, 'changes')).toEqual(['a']);
  });

  it('applies one change to what is stored now, not to a copy a mount holds', () => {
    // Two trees of one device (a dock and a drawer) each change one folder.
    setFolderCollapsed(REPO, 'changes', 'a', true);
    const first = readCollapsed(REPO, 'changes');
    setFolderCollapsed(REPO, 'changes', 'b', true);
    expect(first).toEqual(['a']);
    setFolderCollapsed(REPO, 'changes', 'a', false);
    expect(readCollapsed(REPO, 'changes')).toEqual(['b']);
  });

  it('is never pruned against a tree: a folder nobody lists stays', () => {
    setFolderCollapsed(REPO, 'changes', 'gone/for/now', true);
    setFolderCollapsed(REPO, 'changes', 'a', true);
    expect(readCollapsed(REPO, 'changes')).toEqual(['gone/for/now', 'a']);
  });

  it('bounds a group by dropping the oldest', () => {
    for (let i = 0; i < MAX_COLLAPSED + 3; i += 1) {
      setFolderCollapsed(REPO, 'changes', `d${i}`, true);
    }
    const kept = readCollapsed(REPO, 'changes');
    expect(kept).toHaveLength(MAX_COLLAPSED);
    expect(kept[0]).toBe('d3');
    expect(kept.at(-1)).toBe(`d${MAX_COLLAPSED + 2}`);
  });

  describe('a forgiving parse', () => {
    const put = (raw: string) => localStorage.setItem(COLLAPSED_KEY, raw);

    it('reads as empty for text that is not JSON, or JSON of another shape', () => {
      for (const raw of [
        '{',
        'null',
        '7',
        '[]',
        '{"v":2,"byRepo":{}}',
        '{"v":1}',
        '{"v":1,"byRepo":[]}',
      ]) {
        put(raw);
        expect(readCollapsed(REPO, 'changes'), raw).toEqual([]);
      }
    });

    it('keeps what is well formed beside what is not', () => {
      put(
        JSON.stringify({
          v: 1,
          byRepo: {
            [REPO]: { changes: ['a', 7, null, 'a', 'b'], staged: 'nope', merge: [] },
            '/bad': 'nope',
          },
        }),
      );
      expect(readCollapsed(REPO, 'changes')).toEqual(['a', 'b']);
      expect(readCollapsed(REPO, 'staged')).toEqual([]);
      expect(readCollapsed('/bad', 'changes')).toEqual([]);
    });

    it('lets the next write start from what survived', () => {
      put(JSON.stringify({ v: 1, byRepo: { [REPO]: { changes: ['a', 7] } } }));
      setFolderCollapsed(REPO, 'changes', 'b', true);
      expect(stored()).toEqual({ v: 1, byRepo: { [REPO]: { changes: ['a', 'b'] } } });
    });
  });

  describe('storage that fails', () => {
    it('reads as empty when the read throws', () => {
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('denied');
      });
      expect(readCollapsed(REPO, 'changes')).toEqual([]);
    });

    it('swallows a write that throws', () => {
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('quota');
      });
      expect(() => setFolderCollapsed(REPO, 'changes', 'a', true)).not.toThrow();
    });
  });
});
