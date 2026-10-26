// The model is the wiring between the file queue, the colourer and the rows: what
// it promises is about WHICH files are fetched, WHICH answer is kept, and what a
// file's rows are while it has no snapshot. The queue's own bounds are
// file-queue.test.ts; these tests hold the model to them end to end.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScmEntry, ScmFileSnapshot, ScmHunk, ScmHunkLine } from '@palmux/shared';
import { ReviewModel, type ReviewModelOptions } from './review-model';
import { ERROR_ROW_HEIGHT, type Row } from './rows';

const monaco = vi.hoisted(() => ({
  colorize: vi.fn<(text: string, language: string, options: object) => Promise<string>>(),
}));
vi.mock('../panes/monaco-loader', () => ({
  getMonaco: () => ({ editor: { colorize: monaco.colorize } }),
}));

const entry = (path: string, over: Partial<ScmEntry> = {}): ScmEntry => ({
  path,
  kind: 'ordinary',
  status: 'M',
  fp: `fp-${path}-1`,
  added: 1,
  removed: 1,
  ...over,
});

function hunk(lines: [ScmHunkLine['kind'], string][], start = 1): ScmHunk {
  let old = start;
  let now = start;
  const out = lines.map(([kind, text]): ScmHunkLine => {
    const line: ScmHunkLine = { kind, text };
    if (kind !== 'add') line.old = old++;
    if (kind !== 'del') line.new = now++;
    return line;
  });
  return {
    oldStart: start,
    newStart: start,
    oldLines: out.filter((l) => l.kind !== 'add').length,
    newLines: out.filter((l) => l.kind !== 'del').length,
    header: `@@ -${start} +${start} @@`,
    lines: out,
  };
}

function snapshot(path: string, over: Partial<ScmFileSnapshot> = {}): ScmFileSnapshot {
  return {
    path,
    group: 'changes',
    algorithm: 'histogram',
    old: { id: 'o', text: 'a\n' },
    new: { id: 'n', text: 'b\n' },
    hunks: [
      hunk([
        ['del', 'a'],
        ['add', 'b'],
      ]),
    ],
    binary: false,
    tooLarge: false,
    converted: false,
    unmerged: false,
    modes: {},
    attrs: {},
    version: `v-${path}`,
    ...over,
  };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) {
    // oxlint-disable-next-line no-await-in-loop -- a chain of awaits needs several turns of the loop
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

type Fetch = ReviewModelOptions['fetch'];

function setup(over: Partial<ReviewModelOptions> = {}, fetch?: Fetch) {
  const requests: { path: string; algorithm: string; resolve: (s: ScmFileSnapshot) => void }[] = [];
  const defaultFetch: Fetch = (request) =>
    new Promise<ScmFileSnapshot>((resolve) => {
      requests.push({ path: request.path, algorithm: request.algorithm, resolve });
    });
  const replaced: string[] = [];
  const model = new ReviewModel({
    fetch: fetch ?? defaultFetch,
    algorithm: 'histogram',
    layout: 'unified',
    measureRows: (rows) => rows.length * 20,
    onReplace: (path) => replaced.push(path),
    colorizer: { schedule: (task) => task() },
    ...over,
  });
  model.setEnabled(true);
  return { model, requests, replaced };
}

const rowTypes = (rows: readonly Row[], path: string): string[] =>
  rows.filter((row) => row.path === path).map((row) => row.type);

/** Answer the newest request for `path`. */
function resolveFor(
  requests: { path: string; resolve: (s: ScmFileSnapshot) => void }[],
  path: string,
  value: ScmFileSnapshot,
): void {
  const request = requests.findLast((r) => r.path === path);
  if (!request) throw new Error(`no request for ${path}`);
  request.resolve(value);
}

beforeEach(() => {
  monaco.colorize.mockReset();
  monaco.colorize.mockImplementation((text) =>
    Promise.resolve(
      `${text
        .split('\n')
        .map((line) => `<span class="mtk1">${line}</span>`)
        .join('<br/>')}<br/>`,
    ),
  );
});
afterEach(() => vi.restoreAllMocks());

describe('a large change set', () => {
  const four = Array.from({ length: 400 }, (_, i) =>
    entry(`src/f${String(i).padStart(3, '0')}.txt`),
  );

  it('lists every file as a header and a placeholder, and fetches none until a range is shown', () => {
    const { model, requests } = setup();
    model.setEntries(four, 'e0');
    const { rows, fileStart } = model.getRows('unified');
    expect(fileStart).toHaveLength(400);
    expect(rows).toHaveLength(800);
    expect(rowTypes(rows, 'src/f000.txt')).toEqual(['fileHeader', 'placeholder']);
    expect(requests).toEqual([]);
  });

  it('fetches only files near the visible rows, four at a time', () => {
    const { model, requests } = setup();
    model.setEntries(four, 'e0');
    // Rows 0-3 are the headers and placeholders of files 0 and 1.
    model.setVisibleRows(0, 3);
    // Visible files 0-1 plus two either side: files 0 to 3, all in flight at once.
    expect(requests.map((r) => r.path)).toEqual([
      'src/f000.txt',
      'src/f001.txt',
      'src/f002.txt',
      'src/f003.txt',
    ]);
    expect(model.stats().active).toBe(4);
    // A far file is never asked for.
    expect(requests.some((r) => r.path === 'src/f399.txt')).toBe(false);
  });

  it('asks for the files around the new place when the view jumps', () => {
    const { model, requests } = setup();
    model.setEntries(four, 'e0');
    model.setVisibleRows(0, 1);
    requests.length = 0;
    // Row 400 is the header of file 200.
    model.setVisibleRows(400, 401);
    expect(requests.map((r) => r.path)).toContain('src/f200.txt');
    expect(requests.map((r) => r.path)).not.toContain('src/f399.txt');
  });

  it('starts nothing while disabled (a hidden review), and starts it when enabled', () => {
    const { model, requests } = setup();
    model.setEnabled(false);
    model.setEntries(four, 'e0');
    model.setVisibleRows(0, 3);
    expect(requests).toEqual([]);
    model.setEnabled(true);
    expect(requests.length).toBeGreaterThan(0);
  });

  it('is disabled until told otherwise: a model nobody has enabled fetches nothing', () => {
    const idle = new ReviewModel({
      fetch: () => Promise.reject(new Error('must not be called')),
      algorithm: 'histogram',
      layout: 'unified',
      measureRows: () => 0,
      colorizer: { schedule: (task) => task() },
    });
    idle.setEntries(four, 'e0');
    idle.setVisibleRows(0, 3);
    expect(idle.stats().active).toBe(0);
  });
});

describe('a file landing', () => {
  it('replaces its placeholder with its notices, hunks and lines, and tells subscribers', async () => {
    const { model, requests } = setup();
    const seen: number[] = [];
    model.subscribe(() => seen.push(model.getVersion()));
    model.setEntries([entry('a.txt'), entry('b.txt')], 'e0');
    model.setVisibleRows(0, 1);
    const before = model.getVersion();
    requests[0]!.resolve(snapshot('a.txt'));
    await flush();
    expect(model.getVersion()).toBeGreaterThan(before);
    const { rows } = model.getRows('unified');
    expect(rowTypes(rows, 'a.txt')).toEqual(['fileHeader', 'hunkHeader', 'line', 'line']);
    expect(rowTypes(rows, 'b.txt')).toEqual(['fileHeader', 'placeholder']);
    expect(model.getSnapshot('a.txt')?.version).toBe('v-a.txt');
  });

  it('builds the other layout from the same snapshot without a request', async () => {
    const { model, requests } = setup();
    model.setEntries([entry('a.txt')], 'e0');
    model.setVisibleRows(0, 1);
    requests[0]!.resolve(snapshot('a.txt'));
    await flush();
    const before = requests.length;
    expect(rowTypes(model.getRows('unified').rows, 'a.txt')).toContain('line');
    expect(rowTypes(model.getRows('split').rows, 'a.txt')).toEqual([
      'fileHeader',
      'hunkHeader',
      'split',
    ]);
    expect(requests).toHaveLength(before);
  });

  it('collapses a file to its header and expands it again', async () => {
    const { model, requests } = setup();
    model.setEntries([entry('a.txt')], 'e0');
    model.setVisibleRows(0, 1);
    requests[0]!.resolve(snapshot('a.txt'));
    await flush();
    model.toggleCollapsed('a.txt');
    expect(rowTypes(model.getRows('unified').rows, 'a.txt')).toEqual(['fileHeader']);
    model.toggleCollapsed('a.txt');
    expect(rowTypes(model.getRows('unified').rows, 'a.txt')).toContain('line');
  });

  it('lists a conflicted file as a notice and never asks for its snapshot', () => {
    const { model, requests } = setup();
    model.setEntries([entry('c.ts', { kind: 'unmerged', status: 'U' })], 'e0');
    model.setVisibleRows(0, 1);
    expect(requests).toEqual([]);
    const { rows } = model.getRows('unified');
    expect(rowTypes(rows, 'c.ts')).toEqual(['fileHeader', 'notice']);
    expect(rows[1]).toMatchObject({ type: 'notice', notice: 'unmerged' });
  });

  it('keeps the error of a failed fetch and clears it on retry', async () => {
    let fail = true;
    const { model } = setup({}, () =>
      fail ? Promise.reject(new Error('HTTP 404')) : Promise.resolve(snapshot('a.txt')),
    );
    model.setEntries([entry('a.txt')], 'e0');
    model.setVisibleRows(0, 1);
    await flush();
    expect(model.errorOf('a.txt')).toBe('HTTP 404');
    fail = false;
    model.retry('a.txt');
    await flush();
    expect(model.errorOf('a.txt')).toBeUndefined();
    expect(model.getSnapshot('a.txt')).toBeDefined();
  });
});

describe('gaps', () => {
  const big = (): ScmFileSnapshot => {
    const text = `${Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n')}\n`;
    return snapshot('a.txt', {
      old: { id: 'o', text },
      new: { id: 'n', text },
      hunks: [
        hunk(
          [
            ['ctx', 'line 50'],
            ['add', 'inserted'],
          ],
          50,
        ),
      ],
    });
  };

  it('reveals a step at a time, with the right numbers, without refetching', async () => {
    const { model, requests } = setup();
    model.setEntries([entry('a.txt')], 'e0');
    model.setVisibleRows(0, 1);
    requests[0]!.resolve(big());
    await flush();
    const fetched = requests.length;

    const gapOf = () =>
      model.getRows('unified').rows.find((r) => r.type === 'gap' && r.gapIndex === 0);
    const start = gapOf();
    expect(start).toMatchObject({ type: 'gap', position: 'start', hidden: 49 });
    if (start?.type !== 'gap') return;
    model.expand('a.txt', start, 'up');
    expect(gapOf()).toMatchObject({ hidden: 29 });
    const lines = model
      .getRows('unified')
      .rows.filter((r) => r.type === 'line' && r.kind === 'ctx')
      .map((r) => (r.type === 'line' ? r.no : 0));
    // The 20 lines just above the hunk: 30..49, then the hunk's own context line 50.
    expect(lines.slice(0, 3)).toEqual([30, 31, 32]);
    expect(requests).toHaveLength(fetched);
  });
});

describe('versions, algorithms and stale answers', () => {
  it('drops a slow answer that a newer request has overtaken', async () => {
    const { model, requests } = setup();
    model.setEntries([entry('a.txt', { fp: 'fp-1' })], 'e0');
    model.setVisibleRows(0, 1);
    expect(requests).toHaveLength(1);

    // The file changes on disk while its first answer is still on the wire.
    model.setEntries([entry('a.txt', { fp: 'fp-2' })], 'e0');
    expect(requests).toHaveLength(2);

    requests[1]!.resolve(snapshot('a.txt', { version: 'newer' }));
    await flush();
    requests[0]!.resolve(snapshot('a.txt', { version: 'older' }));
    await flush();
    expect(model.getSnapshot('a.txt')?.version).toBe('newer');
  });

  it('refetches the loaded files with the new algorithm and keeps showing the old rows meanwhile', async () => {
    const { model, requests } = setup();
    model.setEntries([entry('a.txt')], 'e0');
    model.setVisibleRows(0, 1);
    requests[0]!.resolve(snapshot('a.txt'));
    await flush();

    model.setAlgorithm('patience');
    expect(requests.at(-1)).toMatchObject({ path: 'a.txt', algorithm: 'patience' });
    // Until it lands the old snapshot is still on screen.
    expect(rowTypes(model.getRows('unified').rows, 'a.txt')).toContain('line');

    requests.at(-1)!.resolve(snapshot('a.txt', { algorithm: 'patience' }));
    await flush();
    expect(model.getSnapshot('a.txt')?.algorithm).toBe('patience');
  });

  it('refetches every loaded file when the attribute epoch changes', async () => {
    const { model, requests } = setup();
    model.setEntries([entry('a.txt'), entry('b.txt')], 'e0');
    model.setVisibleRows(0, 3);
    requests[0]!.resolve(snapshot('a.txt'));
    requests[1]!.resolve(snapshot('b.txt'));
    await flush();
    const loaded = requests.length;
    model.setEntries([entry('a.txt'), entry('b.txt')], 'e1');
    expect(
      requests
        .slice(loaded)
        .map((r) => r.path)
        .toSorted(),
    ).toEqual(['a.txt', 'b.txt']);
  });

  it('reports the previous snapshot before a different one replaces it', async () => {
    const { model, requests, replaced } = setup();
    model.setEntries([entry('a.txt', { fp: 'fp-1' })], 'e0');
    model.setVisibleRows(0, 1);
    requests[0]!.resolve(snapshot('a.txt', { version: 'v1' }));
    await flush();
    expect(replaced).toEqual([]);
    model.setEntries([entry('a.txt', { fp: 'fp-2' })], 'e0');
    requests[1]!.resolve(snapshot('a.txt', { version: 'v2' }));
    await flush();
    expect(replaced).toEqual(['a.txt']);
  });

  it('adds and removes files as the group changes, in the order given', async () => {
    const { model } = setup();
    model.setEntries([entry('a.txt'), entry('c.txt')], 'e0');
    model.setEntries([entry('a.txt'), entry('b.txt'), entry('c.txt')], 'e0');
    expect(
      model.getRows('unified').fileStart.map((i) => model.getRows('unified').rows[i]?.path),
    ).toEqual(['a.txt', 'b.txt', 'c.txt']);
    model.setEntries([entry('a.txt'), entry('c.txt')], 'e0');
    expect(model.getRows('unified').fileStart).toHaveLength(2);
  });
});

describe('eviction', () => {
  it('returns an evicted file to a placeholder as tall as its rows were', async () => {
    const files = Array.from({ length: 64 }, (_, i) => entry(`f${String(i).padStart(2, '0')}.txt`));
    const { model } = setup({ measureRows: (rows) => rows.length * 20 }, (request) =>
      Promise.resolve(snapshot(request.path)),
    );
    model.setEntries(files, 'e0');
    // Walk the view down the list so each file is fetched in turn.
    for (let i = 0; i < files.length; i++) {
      model.setVisibleRows(
        model.getRows('unified').fileStart[i] ?? 0,
        model.getRows('unified').fileStart[i] ?? 0,
      );
      // oxlint-disable-next-line no-await-in-loop -- one file lands per step
      await flush();
    }
    expect(model.stats().files).toBeLessThanOrEqual(60);
    const { rows } = model.getRows('unified');
    const first = rows.filter((row) => row.path === 'f00.txt');
    // Header, hunk header, two lines were 4 rows × 20; the placeholder holds that height.
    expect(first.map((r) => r.type)).toEqual(['fileHeader', 'placeholder']);
    expect(first[1]).toMatchObject({ type: 'placeholder', height: 80 });
    expect(model.getSnapshot('f00.txt')).toBeUndefined();
  });
});

describe('colours', () => {
  const ts = (path = 'a.ts') =>
    snapshot(path, {
      old: { id: 'o', text: 'const a = 1;\n' },
      new: { id: 'n', text: 'const b = 1;\n' },
    });

  it('draws plain until a side is coloured, then hands out its lines', async () => {
    const { model, requests } = setup();
    model.setEntries([entry('a.ts')], 'e0');
    model.setVisibleRows(0, 1);
    requests[0]!.resolve(ts());
    expect(model.htmlOf('a.ts', 'new', 1)).toBeUndefined();
    await flush();
    expect(model.htmlOf('a.ts', 'new', 1)).toBe('<span class="mtk1">const b = 1;</span>');
    expect(model.htmlOf('a.ts', 'old', 1)).toBe('<span class="mtk1">const a = 1;</span>');
  });

  it('colours a file with no grammar never, and never reaches for Monaco for it', async () => {
    const { model, requests } = setup();
    model.setEntries([entry('notes.txt')], 'e0');
    model.setVisibleRows(0, 1);
    requests[0]!.resolve(snapshot('notes.txt'));
    await flush();
    expect(model.htmlOf('notes.txt', 'new', 1)).toBeUndefined();
    expect(monaco.colorize).not.toHaveBeenCalled();
  });

  it('drops every colour on a palette change and draws them again', async () => {
    const { model, requests } = setup();
    model.setEntries([entry('a.ts')], 'e0');
    model.setVisibleRows(0, 1);
    requests[0]!.resolve(ts());
    await flush();
    expect(model.htmlOf('a.ts', 'new', 1)).toBeDefined();

    monaco.colorize.mockImplementation((text) =>
      Promise.resolve(`<span class="mtk9">${text.trim()}</span><br/>`),
    );
    const before = model.getVersion();
    model.recolor();
    expect(model.getVersion()).toBeGreaterThan(before);
    expect(model.htmlOf('a.ts', 'new', 1)).toBeUndefined();
    await flush();
    expect(model.htmlOf('a.ts', 'new', 1)).toBe('<span class="mtk9">const b = 1;</span>');
  });

  // A version names a pair of blobs, not a file: a file copied before it is edited,
  // or two identical new files, carry the same one.
  describe('two files with the same version', () => {
    const twin = (path: string, version = 'same') => ({ ...ts(path), version });
    const colouredB = '<span class="mtk1">const b = 1;</span>';

    it('keeps one coloured when the other is edited', async () => {
      const { model, requests } = setup();
      model.setEntries([entry('a.ts'), entry('b.ts')], 'e0');
      model.setVisibleRows(0, 3);
      resolveFor(requests, 'a.ts', twin('a.ts'));
      resolveFor(requests, 'b.ts', twin('b.ts'));
      await flush();
      expect(model.htmlOf('b.ts', 'new', 1)).toBe(colouredB);

      model.setEntries([entry('a.ts'), entry('b.ts', { fp: 'fp-b.ts-2' })], 'e0');
      resolveFor(requests, 'b.ts', twin('b.ts', 'edited'));
      await flush();
      expect(model.htmlOf('a.ts', 'new', 1)).toBe(colouredB);
      expect(model.htmlOf('b.ts', 'new', 1)).toBe(colouredB);
    });

    it('keeps one coloured when the other leaves the group', async () => {
      const { model, requests } = setup();
      model.setEntries([entry('a.ts'), entry('b.ts')], 'e0');
      model.setVisibleRows(0, 3);
      resolveFor(requests, 'a.ts', twin('a.ts'));
      resolveFor(requests, 'b.ts', twin('b.ts'));
      await flush();

      model.setEntries([entry('a.ts')], 'e0');
      expect(model.htmlOf('a.ts', 'new', 1)).toBe(colouredB);
    });

    it('colours a file whose plain-text twin was asked for first', async () => {
      const { model, requests } = setup();
      model.setEntries([entry('notes.txt'), entry('a.ts')], 'e0');
      model.setVisibleRows(0, 3);
      resolveFor(requests, 'notes.txt', twin('notes.txt'));
      await flush();
      resolveFor(requests, 'a.ts', twin('a.ts'));
      await flush();
      expect(model.htmlOf('a.ts', 'new', 1)).toBe(colouredB);
      expect(model.htmlOf('notes.txt', 'new', 1)).toBeUndefined();
    });

    it('never dresses a plain-text file in its twin’s grammar', async () => {
      const { model, requests } = setup();
      model.setEntries([entry('a.ts'), entry('notes.txt')], 'e0');
      model.setVisibleRows(0, 3);
      resolveFor(requests, 'a.ts', twin('a.ts'));
      await flush();
      resolveFor(requests, 'notes.txt', twin('notes.txt'));
      await flush();
      expect(model.htmlOf('a.ts', 'new', 1)).toBe(colouredB);
      expect(model.htmlOf('notes.txt', 'new', 1)).toBeUndefined();
    });
  });
});

describe('disposal', () => {
  it('stops fetching and stops telling subscribers', async () => {
    const { model, requests } = setup();
    const heard = vi.fn();
    model.subscribe(heard);
    model.setEntries([entry('a.txt')], 'e0');
    model.setVisibleRows(0, 1);
    heard.mockClear();
    model.dispose();
    requests[0]!.resolve(snapshot('a.txt'));
    await flush();
    expect(heard).not.toHaveBeenCalled();
  });
});

// ── comments, marks and the failed placeholder ───────────────────────────────

import type { ScmComment } from '@palmux/shared';

const three = snapshot('a.ts', {
  old: { id: 'o', text: 'one\ntwo\nthree\n' },
  new: { id: 'n', text: 'one\nTWO\nthree\n' },
  hunks: [
    hunk([
      ['ctx', 'one'],
      ['del', 'two'],
      ['add', 'TWO'],
      ['ctx', 'three'],
    ]),
  ],
});

const note = (id: string, over: Partial<ScmComment> = {}): ScmComment => ({
  id,
  path: 'a.ts',
  version: 'worktree',
  side: 'new',
  start: 2,
  end: 2,
  lines: ['TWO'],
  before: ['one'],
  after: ['three'],
  body: 'rename',
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

async function withLoadedFile(over: Partial<ReviewModelOptions> = {}) {
  const ctx = setup(over);
  ctx.model.setEntries([entry('a.ts')], 'e0');
  ctx.model.setVisibleRows(0, 1);
  resolveFor(ctx.requests, 'a.ts', three);
  await flush();
  return ctx;
}

const typesOf = (model: ReviewModel): string[] =>
  model.getRows('unified').rows.map((row) => row.type);

describe('comments in the rows', () => {
  it('draws a comment under its line once the file has loaded, not before', async () => {
    const { model, requests } = setup();
    model.setEntries([entry('a.ts')], 'e0');
    model.setVisibleRows(0, 1);
    model.setNotes({ comments: [note('c1')], drafts: [] });
    expect(typesOf(model)).toEqual(['fileHeader', 'placeholder']);
    resolveFor(requests, 'a.ts', three);
    await flush();
    expect(typesOf(model)).toEqual([
      'fileHeader',
      'hunkHeader',
      'line',
      'line',
      'line',
      'comment',
      'line',
    ]);
  });

  it('rebuilds only the file whose comments changed', async () => {
    const { model, requests } = setup();
    model.setEntries([entry('a.ts'), entry('b.ts')], 'e0');
    model.setVisibleRows(0, 3);
    resolveFor(requests, 'a.ts', three);
    resolveFor(requests, 'b.ts', snapshot('b.ts'));
    await flush();
    const before = model.getRows('unified').rows;
    model.setNotes({ comments: [note('c1')], drafts: [] });
    const after = model.getRows('unified').rows;
    const rowsOf = (rows: readonly Row[], path: string) => rows.filter((r) => r.path === path);
    expect(rowsOf(after, 'b.ts')).toEqual(rowsOf(before, 'b.ts'));
    expect(rowsOf(after, 'b.ts').every((r, i) => r === rowsOf(before, 'b.ts')[i])).toBe(true);
    expect(rowsOf(after, 'a.ts')).toHaveLength(rowsOf(before, 'a.ts').length + 1);
  });

  it('moves a comment with its code when the file changes under it', async () => {
    const { model, requests } = await withLoadedFile();
    model.setNotes({ comments: [note('c1')], drafts: [] });
    // Ten lines inserted above: the same code, numbered 12.
    const moved = snapshot('a.ts', {
      version: 'v2',
      old: { id: 'o', text: 'one\ntwo\nthree\n' },
      new: { id: 'n2', text: `${'x\n'.repeat(10)}one\nTWO\nthree\n` },
      hunks: [
        hunk(
          [
            ['ctx', 'one'],
            ['del', 'two'],
            ['add', 'TWO'],
            ['ctx', 'three'],
          ],
          11,
        ),
      ],
    });
    const asked = model.reload('a.ts');
    resolveFor(requests, 'a.ts', moved);
    await asked;
    const row = model.getRows('unified').rows.find((r) => r.type === 'comment');
    expect(row).toMatchObject({ start: 12, end: 12, side: 'new' });
  });

  it('lists a comment whose code is gone, and attaches it to no line', async () => {
    const { model } = await withLoadedFile();
    model.setNotes({
      comments: [note('c1', { lines: ['deleted'], before: [], after: [], start: 40, end: 40 })],
      drafts: [],
    });
    const rows = model.getRows('unified').rows;
    expect(rows.some((r) => r.type === 'comment')).toBe(false);
    expect(rows.at(-1)).toMatchObject({ type: 'unplaced', items: [{ reason: 'outdated' }] });
  });

  it('does not draw comments on a collapsed file', async () => {
    const { model } = await withLoadedFile();
    model.setNotes({ comments: [note('c1')], drafts: [] });
    model.toggleCollapsed('a.ts');
    expect(typesOf(model)).toEqual(['fileHeader']);
  });

  it('draws the editor of an open draft under its lines', async () => {
    const { model } = await withLoadedFile();
    model.setNotes({ comments: [], drafts: [{ path: 'a.ts', side: 'new', start: 3, end: 3 }] });
    expect(typesOf(model).at(-1)).toBe('editor');
    expect(typesOf(model).filter((t) => t === 'editor')).toHaveLength(1);
  });
});

describe('marks', () => {
  it('says which lines are picked and which carry a comment, the pick winning', async () => {
    const { model } = await withLoadedFile();
    model.setNotes({
      comments: [note('c1', { start: 2, end: 3, lines: ['TWO', 'three'], after: [] })],
      drafts: [],
    });
    expect(model.markOf('a.ts', 'new', 2)).toBe('commented');
    expect(model.markOf('a.ts', 'new', 3)).toBe('commented');
    expect(model.markOf('a.ts', 'new', 1)).toBeUndefined();
    // The same number on the other side is a different line.
    expect(model.markOf('a.ts', 'old', 2)).toBeUndefined();
    model.setMarks({ path: 'a.ts', side: 'new', start: 3, end: 3 });
    expect(model.markOf('a.ts', 'new', 3)).toBe('selected');
    expect(model.markOf('a.ts', 'new', 2)).toBe('commented');
    expect(model.markOf('b.ts', 'new', 3)).toBeUndefined();
    expect(model.markOf('a.ts', 'new', undefined)).toBeUndefined();
    model.setMarks(null);
    expect(model.markOf('a.ts', 'new', 3)).toBe('commented');
  });

  it('redraws without rebuilding any file’s rows', async () => {
    const { model } = await withLoadedFile();
    const rows = model.getRows('unified').rows;
    const version = model.getVersion();
    model.setMarks({ path: 'a.ts', side: 'new', start: 2, end: 2 });
    expect(model.getVersion()).toBeGreaterThan(version);
    const again = model.getRows('unified').rows;
    expect(again.every((row, i) => row === rows[i])).toBe(true);
  });
});

describe('a file that failed to load', () => {
  it('holds a placeholder tall enough for its message and Retry, and returns to its height after', async () => {
    const failing: ReviewModelOptions['fetch'] = () => Promise.reject(new Error('git said no'));
    const { model } = setup({}, failing);
    // A binary file is estimated at one line, which a Retry button does not fit in.
    model.setEntries([entry('b.bin', { binary: true })], 'e0');
    const height = (): number => {
      const row = model.getRows('unified').rows.find((r) => r.type === 'placeholder');
      return row?.type === 'placeholder' ? row.height : -1;
    };
    expect(height()).toBe(20);
    model.setVisibleRows(0, 1);
    await flush();
    expect(model.errorOf('b.bin')).toBe('git said no');
    expect(height()).toBe(ERROR_ROW_HEIGHT);
  });
});

describe('load and reload', () => {
  it('fetches a far file on request and shows it', async () => {
    const { model, requests } = setup();
    model.setEntries([entry('a.ts'), entry('b.ts')], 'e0');
    const loading = model.load('b.ts');
    resolveFor(requests, 'b.ts', snapshot('b.ts'));
    expect((await loading)?.path).toBe('b.ts');
    expect(model.getSnapshot('b.ts')).toBeDefined();
    expect(model.getRows('unified').rows.some((r) => r.path === 'b.ts' && r.type === 'line')).toBe(
      true,
    );
  });

  it('knows which files are collapsed', async () => {
    const { model } = await withLoadedFile();
    expect(model.isCollapsed('a.ts')).toBe(false);
    model.toggleCollapsed('a.ts');
    expect(model.isCollapsed('a.ts')).toBe(true);
  });
});
