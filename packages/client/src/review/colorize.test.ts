import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScmFileSnapshot } from '@palmux/shared';
import { Colorizer, MAX_COLORIZED_LINES, type ColorizerOptions } from './colorize';

// The loader is mocked, so no test here can pull the real Monaco chunk. What it
// counts is how often colouring actually reached for it.
const monaco = vi.hoisted(() => ({
  factoryRuns: 0,
  getMonacoCalls: 0,
  colorize: vi.fn<(text: string, language: string, options: object) => Promise<string>>(),
  failToLoad: false,
}));

vi.mock('../panes/monaco-loader', () => {
  monaco.factoryRuns++;
  return {
    getMonaco: () => {
      monaco.getMonacoCalls++;
      if (monaco.failToLoad) throw new Error('chunk failed to load');
      return { editor: { colorize: monaco.colorize } };
    },
  };
});

const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * What Monaco's `colorize` returns: one `<span>` run per line, every line ending in
 * `<br/>`. Lines inside a block comment are classed as comments, which only a
 * tokenizer that saw the opening `/*` can know.
 */
function fakeColorize(text: string): Promise<string> {
  let inComment = false;
  const html = text
    .split(/\r\n|\r|\n/)
    .map((line) => {
      if (line.includes('/*')) inComment = true;
      const cls = inComment ? 'mtk-comment' : 'mtk1';
      if (line.includes('*/')) inComment = false;
      return `<span><span class="${cls}">${escapeHtml(line)}</span></span><br/>`;
    })
    .join('');
  return Promise.resolve(html);
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) {
    // oxlint-disable-next-line no-await-in-loop -- a chain of awaits needs several turns of the loop
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

/** The next `colorize` call hangs until `release` is called with its markup. */
function holdNextColorize(): { release: (html: string) => void } {
  const held = { release: (_html: string): void => {} };
  monaco.colorize.mockImplementationOnce(
    () => new Promise<string>((resolve) => (held.release = resolve)),
  );
  return held;
}

function snapshot(
  path: string,
  over: {
    version?: string;
    old?: string;
    new?: string;
    algorithm?: ScmFileSnapshot['algorithm'];
  } = {},
): ScmFileSnapshot {
  return {
    path,
    group: 'changes',
    algorithm: over.algorithm ?? 'histogram',
    old: { id: 'old', text: over.old ?? 'old line\n' },
    new: { id: 'new', text: over.new ?? 'new line\n' },
    hunks: [],
    binary: false,
    tooLarge: false,
    converted: false,
    unmerged: false,
    modes: {},
    attrs: {},
    version: over.version ?? 'v1',
  };
}

function setup(options: Partial<ColorizerOptions> = {}) {
  const tasks: (() => void)[] = [];
  const colored: string[] = [];
  const errors: unknown[] = [];
  const colorizer = new Colorizer({
    onColored: (_path, version) => colored.push(version),
    onError: (error) => errors.push(error),
    schedule: (task) => tasks.push(task),
    ...options,
  });
  /** Run the next scheduled task and everything it awaits. */
  const runTask = async (): Promise<void> => {
    const task = tasks.shift();
    if (!task) throw new Error('nothing scheduled');
    task();
    await flush();
  };
  return { colorizer, tasks, colored, errors, runTask };
}

const manyLines = (count: number): string =>
  `${Array.from({ length: count }, (_, i) => `l${i}`).join('\n')}\n`;

beforeEach(() => {
  monaco.getMonacoCalls = 0;
  monaco.failToLoad = false;
  monaco.colorize.mockReset();
  monaco.colorize.mockImplementation(fakeColorize);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Colorizer', () => {
  // This one runs first on purpose: the factory above has not run until something
  // reaches for the loader, so a module that imported Monaco at load would show here.
  it('loads no Monaco code until a side has something to colour', async () => {
    const { colorizer, tasks } = setup();
    expect(monaco.factoryRuns).toBe(0);

    colorizer.request(snapshot('notes.xyz'));
    colorizer.request(snapshot('empty.ts', { version: 'v2', old: '', new: '' }));
    colorizer.request(
      snapshot('big.ts', { version: 'v3', old: manyLines(MAX_COLORIZED_LINES + 1), new: '' }),
    );
    expect(tasks.length).toBeLessThanOrEqual(2);
    expect(monaco.factoryRuns).toBe(0);
    expect(monaco.getMonacoCalls).toBe(0);
  });

  describe('colouring a file', () => {
    it('colours both sides with the grammar of the path, from the whole side', async () => {
      const { colorizer, runTask, colored } = setup();
      colorizer.request(snapshot('src/a.ts', { old: 'const a = 1;\n', new: 'const a = 2;\n' }));
      expect(colorizer.get('src/a.ts', 'v1', 'old')).toBeUndefined();

      await runTask();
      expect(monaco.colorize).toHaveBeenCalledTimes(2);
      expect(monaco.colorize).toHaveBeenCalledWith('const a = 1;', 'typescript', {});
      expect(monaco.colorize).toHaveBeenCalledWith('const a = 2;', 'typescript', {});
      expect(colorizer.get('src/a.ts', 'v1', 'old')).toEqual([
        '<span><span class="mtk1">const a = 1;</span></span>',
      ]);
      expect(colorizer.get('src/a.ts', 'v1', 'new')).toEqual([
        '<span><span class="mtk1">const a = 2;</span></span>',
      ]);
      expect(colored).toEqual(['v1']);
    });

    it('splits the output into one entry per line, blank lines included', async () => {
      const { colorizer, runTask } = setup();
      colorizer.request(snapshot('a.ts', { old: '', new: 'a\n\nb\n' }));
      await runTask();
      const lines = colorizer.get('a.ts', 'v1', 'new');
      expect(lines).toHaveLength(3);
      expect(lines?.[1]).toBe('<span><span class="mtk1"></span></span>');
    });

    it('hands the escaped markup through untouched', async () => {
      const { colorizer, runTask } = setup();
      colorizer.request(snapshot('a.html', { old: '', new: '<b>&</b>\n' }));
      await runTask();
      expect(colorizer.get('a.html', 'v1', 'new')?.[0]).toContain('&lt;b&gt;&amp;&lt;/b&gt;');
    });

    // The reason colouring uses a side's whole text and not the hunk.
    it('colours a line inside a block comment that starts above the hunk as a comment', async () => {
      const { colorizer, runTask } = setup();
      const text = [
        '/*',
        ' * a long explanation',
        ' * of the next function',
        ' */',
        'code();',
        '',
      ].join('\n');
      colorizer.request(snapshot('a.ts', { old: '', new: text }));
      await runTask();
      const lines = colorizer.get('a.ts', 'v1', 'new') ?? [];
      // A hunk would start at line 3, in the middle of the comment.
      expect(lines[2]).toContain('mtk-comment');
      expect(lines[4]).toContain('mtk1');
    });

    it('sends one text per side, without the trailing newline, and without carriage returns', async () => {
      const { colorizer, runTask } = setup();
      colorizer.request(snapshot('a.ts', { old: 'a\r\nb\r\n', new: 'x\n\ny\n' }));
      await runTask();
      expect(monaco.colorize.mock.calls.map((c) => c[0])).toEqual(['a\nb', 'x\n\ny']);
      expect(colorizer.get('a.ts', 'v1', 'old')).toHaveLength(2);
    });

    it('colours the side that exists when the other is absent', async () => {
      const { colorizer, runTask } = setup();
      colorizer.request(snapshot('a.ts', { old: '', new: 'one\n' }));
      await runTask();
      expect(monaco.colorize).toHaveBeenCalledTimes(1);
      expect(colorizer.get('a.ts', 'v1', 'old')).toBeUndefined();
      expect(colorizer.get('a.ts', 'v1', 'new')).toHaveLength(1);
    });

    it('colours the first side before starting the second', async () => {
      const held = holdNextColorize();
      const { colorizer, runTask } = setup();
      colorizer.request(snapshot('a.ts'));
      await runTask();
      expect(monaco.colorize).toHaveBeenCalledTimes(1);
      held.release('<span>x</span><br/>');
      await flush();
      expect(monaco.colorize).toHaveBeenCalledTimes(2);
    });
  });

  describe('staying plain', () => {
    it('keeps a side over 20,000 lines plain and never asks Monaco to colour it', async () => {
      const { colorizer, runTask, colored } = setup();
      colorizer.request(
        snapshot('big.ts', { old: manyLines(MAX_COLORIZED_LINES + 1), new: 'small\n' }),
      );
      await runTask();
      expect(colorizer.get('big.ts', 'v1', 'old')).toBeUndefined();
      expect(colorizer.get('big.ts', 'v1', 'new')).toHaveLength(1);
      expect(monaco.colorize).toHaveBeenCalledTimes(1);
      expect(colored).toEqual(['v1']);
    });

    it('colours a side of exactly 20,000 lines', async () => {
      const { colorizer, runTask } = setup();
      colorizer.request(snapshot('big.ts', { old: '', new: manyLines(MAX_COLORIZED_LINES) }));
      await runTask();
      expect(colorizer.get('big.ts', 'v1', 'new')).toHaveLength(MAX_COLORIZED_LINES);
    });

    it('does not load Monaco at all when every side is over the cap', async () => {
      const { colorizer, runTask, colored } = setup();
      const big = manyLines(MAX_COLORIZED_LINES + 1);
      colorizer.request(snapshot('big.ts', { old: big, new: big }));
      await runTask();
      expect(monaco.getMonacoCalls).toBe(0);
      expect(colored).toEqual([]);
    });

    it('keeps a file with no grammar plain without scheduling anything', () => {
      const { colorizer, tasks, colored } = setup();
      colorizer.request(snapshot('yarn.lock'));
      colorizer.request(snapshot('data.xyz', { version: 'v2' }));
      expect(tasks).toEqual([]);
      expect(colorizer.get('yarn.lock', 'v1', 'new')).toBeUndefined();
      expect(colored).toEqual([]);
      expect(monaco.getMonacoCalls).toBe(0);
    });

    it('keeps a side plain when the colours do not line up with its lines', async () => {
      monaco.colorize.mockResolvedValue('<span>only one</span><br/>');
      const { colorizer, runTask, colored } = setup();
      colorizer.request(snapshot('a.ts', { old: '', new: 'a\nb\nc\n' }));
      await runTask();
      expect(colorizer.get('a.ts', 'v1', 'new')).toBeUndefined();
      expect(colored).toEqual([]);

      // Known to stay plain, so asking again does not try again.
      colorizer.request(snapshot('a.ts', { old: '', new: 'a\nb\nc\n' }));
      expect(monaco.colorize).toHaveBeenCalledTimes(1);
    });

    it('keeps the file plain, reports the error and does not retry when colouring throws', async () => {
      monaco.colorize.mockRejectedValue(new Error('tokenizer failed'));
      const { colorizer, runTask, errors, colored, tasks } = setup();
      colorizer.request(snapshot('a.ts'));
      await runTask();
      expect(errors).toEqual([new Error('tokenizer failed')]);
      expect(colored).toEqual([]);
      expect(colorizer.get('a.ts', 'v1', 'new')).toBeUndefined();

      colorizer.request(snapshot('a.ts'));
      expect(tasks).toEqual([]);
    });

    it('does the same when the Monaco chunk fails to load', async () => {
      monaco.failToLoad = true;
      const { colorizer, runTask, errors, colored } = setup();
      colorizer.request(snapshot('a.ts'));
      await runTask();
      expect(errors).toHaveLength(1);
      expect(colored).toEqual([]);
      expect(colorizer.get('a.ts', 'v1', 'old')).toBeUndefined();
    });
  });

  describe('the cache', () => {
    it('is keyed by file, version and side, so a version of a file is coloured once', async () => {
      const { colorizer, runTask, tasks } = setup();
      colorizer.request(snapshot('a.ts'));
      await runTask();
      expect(monaco.colorize).toHaveBeenCalledTimes(2);

      colorizer.request(snapshot('a.ts'));
      expect(tasks).toEqual([]);
      expect(monaco.colorize).toHaveBeenCalledTimes(2);
    });

    it('shares colours across algorithms, which do not change the text', async () => {
      const { colorizer, runTask, tasks } = setup();
      colorizer.request(snapshot('a.ts', { algorithm: 'myers' }));
      await runTask();
      colorizer.request(snapshot('a.ts', { algorithm: 'patience' }));
      expect(tasks).toEqual([]);
      expect(colorizer.get('a.ts', 'v1', 'new')).toBeDefined();
    });

    it('colours a new version of the same file again', async () => {
      const { colorizer, runTask } = setup();
      colorizer.request(snapshot('a.ts', { version: 'one', new: 'a\n' }));
      await runTask();
      colorizer.request(snapshot('a.ts', { version: 'two', new: 'b\n' }));
      await runTask();

      expect(monaco.colorize).toHaveBeenCalledTimes(4);
      expect(colorizer.get('a.ts', 'one', 'new')?.[0]).toContain('>a<');
      expect(colorizer.get('a.ts', 'two', 'new')?.[0]).toContain('>b<');
    });

    it('does not queue a version twice while its job is waiting', () => {
      const { colorizer, tasks } = setup();
      colorizer.request(snapshot('a.ts'));
      colorizer.request(snapshot('a.ts'));
      expect(tasks).toHaveLength(1);
    });

    // A version names a pair of blobs, not a file: a copy not yet edited, or two
    // identical new files, carry the same one.
    describe('two files with the same version', () => {
      it('colours each, and forgetting one leaves the other coloured', async () => {
        const paths: string[] = [];
        const { colorizer, runTask } = setup({ onColored: (path) => paths.push(path) });
        colorizer.request(snapshot('a.ts'));
        colorizer.request(snapshot('b.ts'));
        await runTask();
        await runTask();
        expect(paths).toEqual(['a.ts', 'b.ts']);

        colorizer.forget('b.ts', 'v1');
        expect(colorizer.get('a.ts', 'v1', 'new')).toBeDefined();
        expect(colorizer.get('b.ts', 'v1', 'new')).toBeUndefined();
      });

      it('leaves the other’s queued job alone when one is forgotten', async () => {
        const { colorizer, runTask } = setup();
        colorizer.request(snapshot('a.ts'));
        colorizer.request(snapshot('b.ts'));
        colorizer.forget('a.ts', 'v1');
        // a.ts was already handed to the scheduler: it fires and finds itself forgotten.
        await runTask();
        await runTask();
        expect(colorizer.get('a.ts', 'v1', 'new')).toBeUndefined();
        expect(colorizer.get('b.ts', 'v1', 'new')).toBeDefined();
      });

      it('does not let a plain-text twin keep a file with a grammar plain', async () => {
        const { colorizer, runTask } = setup();
        colorizer.request(snapshot('notes.xyz'));
        colorizer.request(snapshot('a.ts'));
        await runTask();
        expect(colorizer.get('a.ts', 'v1', 'new')).toBeDefined();
        expect(colorizer.get('notes.xyz', 'v1', 'new')).toBeUndefined();
      });

      it('does not lend a file’s colours to its plain-text twin', async () => {
        const { colorizer, runTask, tasks } = setup();
        colorizer.request(snapshot('a.ts'));
        await runTask();
        colorizer.request(snapshot('notes.xyz'));
        expect(tasks).toEqual([]);
        expect(colorizer.get('notes.xyz', 'v1', 'new')).toBeUndefined();
        expect(colorizer.get('a.ts', 'v1', 'new')).toBeDefined();
      });
    });

    it('forgets the oldest sides past its limit', async () => {
      const { colorizer, runTask } = setup({ maxEntries: 2 });
      colorizer.request(snapshot('a.ts', { version: 'one' }));
      await runTask();
      colorizer.request(snapshot('a.ts', { version: 'two' }));
      await runTask();

      expect(colorizer.get('a.ts', 'one', 'old')).toBeUndefined();
      expect(colorizer.get('a.ts', 'one', 'new')).toBeUndefined();
      expect(colorizer.get('a.ts', 'two', 'old')).toBeDefined();
      expect(colorizer.get('a.ts', 'two', 'new')).toBeDefined();
    });

    it('treats a request for a version it holds as using it', async () => {
      // Two entries a file: the plain old side is remembered too.
      const { colorizer, runTask } = setup({ maxEntries: 4 });
      colorizer.request(snapshot('a.ts', { version: 'one', old: '' }));
      await runTask();
      colorizer.request(snapshot('b.ts', { version: 'two', old: '' }));
      await runTask();
      // `one` is touched again, so `two` is the oldest when `three` arrives.
      colorizer.request(snapshot('a.ts', { version: 'one', old: '' }));
      colorizer.request(snapshot('c.ts', { version: 'three', old: '' }));
      await runTask();
      expect(colorizer.get('a.ts', 'one', 'new')).toBeDefined();
      expect(colorizer.get('b.ts', 'two', 'new')).toBeUndefined();
    });
  });

  describe('clear', () => {
    it('drops every colour so a theme change recolours', async () => {
      const { colorizer, runTask, colored } = setup();
      colorizer.request(snapshot('a.ts'));
      await runTask();
      colorizer.clear();
      expect(colorizer.get('a.ts', 'v1', 'old')).toBeUndefined();
      expect(colorizer.get('a.ts', 'v1', 'new')).toBeUndefined();

      colorizer.request(snapshot('a.ts'));
      await runTask();
      expect(monaco.colorize).toHaveBeenCalledTimes(4);
      expect(colorizer.get('a.ts', 'v1', 'new')).toBeDefined();
      expect(colored).toEqual(['v1', 'v1']);
    });

    it('discards the result of a job that was colouring when the theme changed', async () => {
      const held = holdNextColorize();
      const { colorizer, runTask, colored } = setup();
      colorizer.request(snapshot('a.ts'));
      await runTask();

      colorizer.clear();
      held.release('<span>stale colours</span><br/>');
      await flush();

      expect(colorizer.get('a.ts', 'v1', 'old')).toBeUndefined();
      expect(colored).toEqual([]);
    });

    it('drops jobs that were still waiting', async () => {
      const { colorizer, tasks, runTask } = setup();
      colorizer.request(snapshot('a.ts', { version: 'one' }));
      colorizer.request(snapshot('b.ts', { version: 'two' }));
      colorizer.clear();
      await runTask();
      // The first job's task still fires, finds itself discarded and colours nothing.
      expect(monaco.colorize).not.toHaveBeenCalled();
      expect(colorizer.get('a.ts', 'one', 'new')).toBeUndefined();
      expect(colorizer.get('b.ts', 'two', 'new')).toBeUndefined();
      expect(tasks).toEqual([]);
    });

    it('lets a file requested after the change colour normally while an old job finishes', async () => {
      const held = holdNextColorize();
      const { colorizer, runTask, tasks } = setup();
      colorizer.request(snapshot('a.ts'));
      await runTask();
      colorizer.clear();
      colorizer.request(snapshot('a.ts'));
      expect(tasks).toHaveLength(0);

      held.release('<span>old theme</span><br/>');
      await flush();
      expect(tasks).toHaveLength(1);
      await runTask();
      expect(colorizer.get('a.ts', 'v1', 'new')?.[0]).toContain('new line');
    });
  });

  describe('forget', () => {
    it('drops a version’s colours and its queued job', async () => {
      const { colorizer, runTask, tasks } = setup();
      colorizer.request(snapshot('a.ts', { version: 'one' }));
      await runTask();
      colorizer.request(snapshot('b.ts', { version: 'two' }));
      colorizer.request(snapshot('c.ts', { version: 'three' }));

      monaco.colorize.mockClear();
      colorizer.forget('a.ts', 'one');
      colorizer.forget('b.ts', 'two');
      expect(colorizer.get('a.ts', 'one', 'new')).toBeUndefined();
      // `two` was already handed to the scheduler: it fires, finds itself forgotten and does nothing.
      await runTask();
      expect(monaco.colorize).not.toHaveBeenCalled();
      expect(colorizer.get('b.ts', 'two', 'new')).toBeUndefined();
      await runTask();
      expect(colorizer.get('c.ts', 'three', 'new')).toBeDefined();
      expect(tasks).toEqual([]);
    });

    it('discards what a running job brings for a version forgotten meanwhile', async () => {
      const held = holdNextColorize();
      const { colorizer, runTask, colored } = setup();
      colorizer.request(snapshot('a.ts'));
      await runTask();
      colorizer.forget('a.ts', 'v1');
      held.release('<span>x</span><br/>');
      await flush();
      expect(colorizer.get('a.ts', 'v1', 'old')).toBeUndefined();
      expect(colored).toEqual([]);
    });
  });

  describe('scheduling', () => {
    it('runs nothing until the scheduler gives it time', async () => {
      const { colorizer, tasks } = setup();
      colorizer.request(snapshot('a.ts'));
      await flush();
      expect(monaco.colorize).not.toHaveBeenCalled();
      expect(tasks).toHaveLength(1);
    });

    it('colours one file at a time, in the order requested', async () => {
      const { colorizer, tasks, runTask } = setup();
      colorizer.request(snapshot('a.ts', { version: 'one' }));
      colorizer.request(snapshot('b.ts', { version: 'two' }));
      colorizer.request(snapshot('c.ts', { version: 'three' }));
      expect(tasks).toHaveLength(1);

      await runTask();
      expect(colorizer.get('a.ts', 'one', 'new')).toBeDefined();
      expect(colorizer.get('b.ts', 'two', 'new')).toBeUndefined();
      expect(tasks).toHaveLength(1);

      await runTask();
      await runTask();
      expect(colorizer.get('b.ts', 'two', 'new')).toBeDefined();
      expect(colorizer.get('c.ts', 'three', 'new')).toBeDefined();
    });

    it('goes on to the next file after one fails', async () => {
      monaco.colorize.mockRejectedValueOnce(new Error('nope'));
      const { colorizer, runTask } = setup();
      colorizer.request(snapshot('a.ts', { version: 'one' }));
      colorizer.request(snapshot('b.ts', { version: 'two' }));
      await runTask();
      await runTask();
      expect(colorizer.get('b.ts', 'two', 'new')).toBeDefined();
    });

    it('uses requestIdleCallback with a timeout when the browser has one', async () => {
      const idle = vi.fn((task: () => void) => task());
      vi.stubGlobal('requestIdleCallback', idle);
      const colored: string[] = [];
      const colorizer = new Colorizer({ onColored: (_path, version) => colored.push(version) });
      colorizer.request(snapshot('a.ts'));
      await flush();

      expect(idle).toHaveBeenCalledWith(expect.any(Function), { timeout: 1000 });
      expect(colored).toEqual(['v1']);
    });

    it('falls back to setTimeout without requestIdleCallback', async () => {
      vi.stubGlobal('requestIdleCallback', undefined);
      vi.useFakeTimers();
      const colored: string[] = [];
      const colorizer = new Colorizer({ onColored: (_path, version) => colored.push(version) });
      colorizer.request(snapshot('a.ts'));
      expect(monaco.colorize).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(10);
      expect(colored).toEqual(['v1']);
    });
  });
});
