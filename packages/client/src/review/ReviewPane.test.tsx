// The review pane, end to end inside happy-dom: the real status store, the real
// file queue and rows model, the real virtual list. What is stubbed is the network
// (`fetch`), Monaco (the loader) and ResizeObserver, whose reports play the browser's
// layout: the pane's width, and how tall a wrapped row came out.
//
// Scenario names follow `diff-review` ("A review opens in the content area", "The
// review shows the whole group as one list", the layouts, the algorithm, the gaps,
// "Special files are explained", "Lines, colours and hunks describe one version",
// "The review follows the disk while visible") and `source-control` ("Only the
// active project is read").

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useMemo, useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ColorProfile,
  ScmEntry,
  ScmFileSnapshot,
  ScmHunk,
  ScmHunkLine,
  TabMeta,
} from '@palmux/shared';
import { setEditorProfile } from '../panes/monaco-theme';
import { scmStatusStore } from '../scm/status-store';
import { DEFAULTS } from '../settings/settings';
import {
  DEFAULT_REVIEW_HOST,
  ReviewHostContext,
  type ReviewHost,
  type ReviewPreferences,
  type ReviewScrollTarget,
} from './review-host';
import { ReviewPane } from './ReviewPane';
import { reviewApiFor } from './review-registry';
import { browserScrolling } from './review-test-support';

// ── Monaco ──────────────────────────────────────────────────────────────────
const monaco = vi.hoisted(() => ({
  getMonacoCalls: 0,
  colorize: vi.fn<(text: string, language: string, options: object) => Promise<string>>(),
}));
vi.mock('../panes/monaco-loader', () => ({
  getMonaco: () => {
    monaco.getMonacoCalls++;
    return { editor: { colorize: monaco.colorize } };
  },
}));

const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Monaco's output shape: one span per line, every line ending in `<br/>`. */
const colorizeWith =
  (cls: string) =>
  (text: string): Promise<string> =>
    Promise.resolve(
      `${text
        .split('\n')
        .map((line) => `<span class="${cls}">${escapeHtml(line)}</span>`)
        .join('<br/>')}<br/>`,
    );

// ── ResizeObserver and layout ────────────────────────────────────────────────
class FakeResizeObserver {
  static all: FakeResizeObserver[] = [];
  /**
   * What a browser would measure an element at. A real observer reports every element
   * it is first given (its first observation), so with this set the fake does too.
   */
  static measure: ((element: Element) => number | undefined) | null = null;
  observed = new Set<Element>();
  constructor(readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.all.push(this);
  }
  observe(element: Element) {
    this.observed.add(element);
    const height = FakeResizeObserver.measure?.(element);
    if (height === undefined) return;
    setTimeout(() => {
      if (!this.observed.has(element)) return;
      this.callback(
        [
          {
            target: element,
            contentRect: { width: 0, height },
            borderBoxSize: [{ inlineSize: 0, blockSize: height }],
          } as unknown as ResizeObserverEntry,
        ],
        this as unknown as ResizeObserver,
      );
    }, 0);
  }
  unobserve(element: Element) {
    this.observed.delete(element);
  }
  disconnect() {
    this.observed.clear();
  }
}

/** The browser reporting that `element` now measures this big. */
function reportSize(element: Element, size: { width?: number; height?: number }) {
  const width = size.width ?? 0;
  const height = size.height ?? 0;
  act(() => {
    for (const observer of FakeResizeObserver.all) {
      if (!observer.observed.has(element)) continue;
      observer.callback(
        [
          {
            target: element,
            contentRect: { width, height },
            borderBoxSize: [{ inlineSize: width, blockSize: height }],
          } as unknown as ResizeObserverEntry,
        ],
        observer as unknown as ResizeObserver,
      );
    }
  });
}

/** The list's height before the browser reports one (`DEFAULT_LIST_HEIGHT`); happy-dom never does. */
const DEFAULT_LIST_HEIGHT_PX = 600;

let paneWidth = 1400;
const setPaneWidth = (width: number) => {
  paneWidth = width;
  reportSize(document.querySelector('.rv-body') as Element, { width });
};

// ── The server ───────────────────────────────────────────────────────────────
const REPO = '/work/app';
const OTHER = '/work/lib';

const entry = (path: string, over: Partial<ScmEntry> = {}): ScmEntry => ({
  path,
  kind: 'ordinary',
  status: 'M',
  fp: `fp-${path}-1`,
  added: 1,
  removed: 1,
  ...over,
});

const statusBody = (over: Record<string, unknown> = {}, top = REPO) => ({
  top,
  branch: 'main',
  unborn: false,
  merge: [],
  staged: [],
  changes: [],
  truncated: false,
  tookMs: 5,
  commentsRev: 0,
  attrEpoch: 'e0',
  ...over,
});

function hunk(
  lines: [ScmHunkLine['kind'], string][],
  start: { old: number; new: number } = { old: 1, new: 1 },
): ScmHunk {
  let old = start.old;
  let now = start.new;
  const out = lines.map(([kind, text]): ScmHunkLine => {
    const line: ScmHunkLine = { kind, text };
    if (kind !== 'add') line.old = old++;
    if (kind !== 'del') line.new = now++;
    return line;
  });
  return {
    oldStart: start.old,
    newStart: start.new,
    oldLines: out.filter((l) => l.kind !== 'add').length,
    newLines: out.filter((l) => l.kind !== 'del').length,
    header: `@@ -${start.old} +${start.new} @@`,
    lines: out,
  };
}

function snapshot(path: string, over: Partial<ScmFileSnapshot> = {}): ScmFileSnapshot {
  return {
    path,
    group: 'changes',
    algorithm: 'histogram',
    old: { id: 'o', text: 'before\n' },
    new: { id: 'n', text: 'after\n' },
    hunks: [
      hunk([
        ['del', 'before'],
        ['add', 'after'],
      ]),
    ],
    binary: false,
    tooLarge: false,
    converted: false,
    unmerged: false,
    modes: {},
    attrs: {},
    version: `v-${path}-1`,
    ...over,
  };
}

const numbered = (n: number, over: Record<number, string> = {}): string =>
  `${Array.from({ length: n }, (_, i) => over[i + 1] ?? `line ${i + 1}`).join('\n')}\n`;

interface Server {
  /** What /scm/status answers, by repo. */
  status: Record<string, ReturnType<typeof statusBody>>;
  /** What /scm/file answers, by path; a function plays a slow or failing one. */
  files: Record<string, ScmFileSnapshot | (() => Promise<unknown>)>;
  requests: { path: string; algorithm: string; repo: string; group: string }[];
  statusRepos: string[];
}

let server: Server;
const reply = (body: unknown, status = 200) =>
  Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      const u = new URL(url, 'http://palmux');
      if (u.pathname === '/scm/status') {
        const repo = u.searchParams.get('repo') ?? '';
        server.statusRepos.push(repo);
        return reply(server.status[repo] ?? statusBody({}, repo));
      }
      if (u.pathname === '/scm/file') {
        const path = u.searchParams.get('path') ?? '';
        server.requests.push({
          path,
          algorithm: u.searchParams.get('algorithm') ?? '',
          repo: u.searchParams.get('repo') ?? '',
          group: u.searchParams.get('group') ?? '',
        });
        const file = server.files[path];
        if (typeof file === 'function') return file();
        return file ? reply(file) : reply({ error: 'no such file' }, 404);
      }
      return reply(null, 404);
    }),
  );
}

// ── Rendering ────────────────────────────────────────────────────────────────
const tab = (url = `changes:${REPO}`, id = '7'): TabMeta => ({ id, kind: 'review', url });

interface HostSpy {
  preferences: ReviewPreferences[];
  activated: string[];
  opened: string[];
  scrollTargets: Map<string, ReviewScrollTarget>;
  takes: string[];
}

/** A host whose preferences are real state, so choosing one redraws the pane. */
function Harness({
  children,
  repos,
  spy,
  initial,
  tick,
}: {
  children: ReactNode;
  repos: string[];
  spy: HostSpy;
  initial?: Partial<ReviewHost>;
  tick: number;
}) {
  const [prefs, setPrefs] = useState({
    layout: initial?.layout ?? DEFAULTS.scmLayout,
    algorithm: initial?.algorithm ?? DEFAULTS.scmAlgorithm,
    wrap: initial?.wrap ?? DEFAULTS.scmWrap,
    codeFontSize: initial?.codeFontSize ?? DEFAULTS.codeFontSize,
  });
  const host = useMemo<ReviewHost>(
    () => ({
      ...DEFAULT_REVIEW_HOST,
      repos,
      ...prefs,
      openTick: tick,
      setPreferences: (change) => {
        spy.preferences.push(change);
        setPrefs((p) => ({
          layout: change.scmLayout ?? p.layout,
          algorithm: change.scmAlgorithm ?? p.algorithm,
          wrap: change.scmWrap === undefined ? p.wrap : change.scmWrap,
          codeFontSize: change.codeFontSize === undefined ? p.codeFontSize : change.codeFontSize,
        }));
      },
      activate: (repo) => spy.activated.push(repo),
      openFile: (path) => spy.opened.push(path),
      takeScrollTarget: (url) => {
        spy.takes.push(url);
        const target = spy.scrollTargets.get(url);
        spy.scrollTargets.delete(url);
        return target;
      },
    }),
    [repos, prefs, tick, spy],
  );
  return <ReviewHostContext.Provider value={host}>{children}</ReviewHostContext.Provider>;
}

interface Options {
  tab?: TabMeta;
  visible?: boolean;
  repos?: string[];
  host?: Partial<ReviewHost>;
  /** Make the tab's repo the one the status store reads, as App does. */
  active?: string | null;
}

function mount(options: Options = {}) {
  const spy: HostSpy = {
    preferences: [],
    activated: [],
    opened: [],
    scrollTargets: new Map(),
    takes: [],
  };
  const review = options.tab ?? tab();
  const repos = options.repos ?? [REPO];
  if (options.active !== null) scmStatusStore.setActiveRepo(options.active ?? REPO);
  // Unified unless a test asks for another: most of these read lines, and the
  // automatic mode is its own describe.
  const initial: Partial<ReviewHost> = { layout: 'unified', ...options.host };
  const element = (visible: boolean, tick = 0, t: TabMeta = review) => (
    <Harness repos={repos} spy={spy} tick={tick} initial={initial}>
      <ReviewPane tab={t} visible={visible} focused />
    </Harness>
  );
  const result = render(element(options.visible ?? true));
  return {
    spy,
    ...result,
    show: (visible: boolean, tick = 0) => result.rerender(element(visible, tick)),
  };
}

const settle = async (turns = 8) => {
  await act(async () => {
    for (let i = 0; i < turns; i++) {
      // oxlint-disable-next-line no-await-in-loop -- a chain of awaits needs several turns of the loop
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
};

/** The list's scroller: where a browser would scroll. */
const scroller = (): HTMLElement => screen.getByTestId('review-list');

const scrollTo = (top: number) => {
  act(() => {
    scroller().scrollTop = top;
    fireEvent.scroll(scroller());
  });
};

const paths = (): string[] =>
  screen.queryAllByTestId('review-file').map((el) => el.getAttribute('data-path') ?? '');

const fileRow = (path: string): HTMLElement => {
  const row = screen.queryAllByTestId('review-file').find((el) => el.dataset['path'] === path);
  if (!row) throw new Error(`no header for ${path}`);
  return row;
};

const offsetOf = (el: HTMLElement): number =>
  Number(/translateY\((-?[\d.]+)px\)/.exec(el.style.transform)?.[1]);

const textsOf = (testId: string): string[] =>
  screen.queryAllByTestId(testId).map((el) => el.textContent ?? '');

/**
 * The open menu's items as a screen reader reads them: the role, and `aria-checked`
 * for the current choice. The drawn check must agree with it, or the eye and the
 * ear are told two different things.
 */
const menuItems = () =>
  [...screen.getByRole('menu').querySelectorAll<HTMLElement>('[role^="menuitem"]')].map((item) => {
    const checked = item.getAttribute('aria-checked') === 'true';
    expect(item.querySelector('svg') !== null).toBe(checked);
    return {
      // A button that shows only a glyph is named by its aria-label.
      label: item.getAttribute('aria-label') ?? item.textContent,
      role: item.getAttribute('role'),
      checked,
      disabled: item.hasAttribute('data-disabled'),
    };
  });

beforeEach(() => {
  paneWidth = 1400;
  FakeResizeObserver.all = [];
  FakeResizeObserver.measure = null;
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: HTMLElement) {
      return { width: this.classList.contains('rv-body') ? paneWidth : 0 } as DOMRect;
    },
  );
  server = { status: {}, files: {}, requests: [], statusRepos: [] };
  stubFetch();
  monaco.getMonacoCalls = 0;
  monaco.colorize.mockReset();
  monaco.colorize.mockImplementation(colorizeWith('mtk1'));
});

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset['mobile'];
  scmStatusStore.setActiveRepo('');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ── A review opens in the content area ───────────────────────────────────────

describe('the whole group as one list', () => {
  it('shows every file under a header with its status and its added and removed counts', async () => {
    server.status[REPO] = statusBody({
      changes: [
        entry('a.txt', { added: 3, removed: 1 }),
        entry('b.txt', { status: 'D', added: 0, removed: 7 }),
      ],
    });
    mount();
    await screen.findByTestId('review-list');
    expect(paths()).toEqual(['a.txt', 'b.txt']);
    expect(within(fileRow('a.txt')).getByTestId('review-file-counts')).toHaveTextContent('+3−1');
    expect(within(fileRow('b.txt')).getByTestId('review-file-state')).toHaveTextContent('Deleted');
    expect(within(fileRow('b.txt')).getByTestId('review-file-counts')).toHaveTextContent('+0−7');
    expect(screen.getByTestId('review-summary')).toHaveTextContent('2 files · +3 −8');
    expect(screen.getByTestId('review-title')).toHaveTextContent('Changes · app');
  });

  it('opens a Staged review on the staged group, and lists Merge Changes ahead of Changes', async () => {
    server.status[REPO] = statusBody({
      merge: [entry('conflict.ts', { kind: 'unmerged', status: 'U', fp: 'u1' })],
      staged: [entry('s.txt')],
      changes: [entry('c.txt')],
    });
    const staged = mount({ tab: tab(`staged:${REPO}`) });
    await screen.findByTestId('review-list');
    expect(paths()).toEqual(['s.txt']);
    expect(screen.getByTestId('review-title')).toHaveTextContent('Staged · app');
    staged.unmount();

    mount({ tab: tab(`changes:${REPO}`, '8') });
    await screen.findByTestId('review-list');
    expect(paths()).toEqual(['conflict.ts', 'c.txt']);
  });

  it('says so when the group is empty', async () => {
    server.status[REPO] = statusBody({});
    mount({ tab: tab(`staged:${REPO}`) });
    expect(await screen.findByTestId('review-message')).toHaveTextContent('No staged changes.');
    expect(screen.queryByTestId('review-list')).toBeNull();
  });

  it('refuses an address that is not a review', () => {
    mount({ tab: { id: '7', kind: 'review', url: 'nonsense' }, active: null });
    expect(screen.getByRole('alert')).toHaveTextContent('no valid address');
  });

  it('collapses a file to its header, and the next file’s header follows it directly', async () => {
    server.status[REPO] = statusBody({ changes: [entry('a.txt'), entry('b.txt')] });
    server.files['a.txt'] = snapshot('a.txt');
    server.files['b.txt'] = snapshot('b.txt');
    mount();
    await screen.findByTestId('review-list');
    await settle();
    expect(screen.queryAllByTestId('review-line').length).toBeGreaterThan(0);

    const toggle = within(fileRow('a.txt')).getByTestId('review-file-toggle');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(toggle);
    await settle();
    expect(within(fileRow('a.txt')).getByTestId('review-file-toggle')).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    const rows = [...scroller().querySelectorAll<HTMLElement>('[data-rv-key]')];
    const a = rows.findIndex((r) => r.dataset['rvKey'] === 'a.txt|file');
    expect(rows[a + 1]?.dataset['rvKey']).toBe('b.txt|file');

    fireEvent.click(within(fileRow('a.txt')).getByTestId('review-file-toggle'));
    await settle();
    expect(screen.queryAllByTestId('review-line').length).toBeGreaterThan(0);
  });

  it('opens the file in the editor from its header, by absolute path', async () => {
    server.status[REPO] = statusBody({
      changes: [entry('src/a.txt'), entry('gone.txt', { status: 'D' })],
    });
    const { spy } = mount();
    await screen.findByTestId('review-list');
    fireEvent.click(within(fileRow('src/a.txt')).getByTestId('review-file-open'));
    expect(spy.opened).toEqual([`${REPO}/src/a.txt`]);
    // A deleted file has nothing on disk to open.
    expect(within(fileRow('gone.txt')).getByTestId('review-file-open')).toBeDisabled();
  });
});

// ── Fetching ─────────────────────────────────────────────────────────────────

describe('only the files near the visible part are fetched', () => {
  const many = Array.from({ length: 400 }, (_, i) => `f${String(i).padStart(3, '0')}.txt`);

  it('opens a 400-file group showing the first files and asking for those near them', async () => {
    server.status[REPO] = statusBody({ changes: many.map((p) => entry(p)) });
    for (const p of many) server.files[p] = snapshot(p);
    mount();
    await screen.findByTestId('review-list');
    await settle();
    expect(server.requests.length).toBeGreaterThan(0);
    // Far fewer than 400: the files near the top (a loaded file is shorter than its
    // placeholder, so a few more come into view as they land), and none from the end.
    expect(server.requests.length).toBeLessThan(40);
    expect(server.requests.map((r) => r.path)).toContain('f000.txt');
    expect(server.requests.map((r) => r.path)).not.toContain('f399.txt');
    // And only the rows near the view are in the DOM.
    expect(scroller().querySelectorAll('[data-rv-key]').length).toBeLessThan(60);
  });

  it('fetches the files around a new place when the reader jumps', async () => {
    server.status[REPO] = statusBody({ changes: many.map((p) => entry(p)) });
    for (const p of many) server.files[p] = snapshot(p);
    mount();
    await screen.findByTestId('review-list');
    await settle();
    server.requests.length = 0;
    // About file 250: every file is a header and a placeholder until it loads.
    scrollTo(250 * 200);
    await settle();
    const asked = server.requests.map((r) => r.path);
    expect(asked.some((p) => Number(p.slice(1, 4)) > 200 && Number(p.slice(1, 4)) < 300)).toBe(
      true,
    );
    expect(asked).not.toContain('f399.txt');
  });

  it('sends the repo, the group and the algorithm the review is set to', async () => {
    server.status[REPO] = statusBody({ staged: [entry('a.txt')] });
    server.files['a.txt'] = snapshot('a.txt', { group: 'staged' });
    mount({ tab: tab(`staged:${REPO}`), host: { algorithm: 'patience' } });
    await screen.findByTestId('review-list');
    await settle();
    expect(server.requests[0]).toEqual({
      path: 'a.txt',
      algorithm: 'patience',
      repo: REPO,
      group: 'staged',
    });
  });

  it('shows why a file did not load, and loads it on Retry', async () => {
    server.status[REPO] = statusBody({ changes: [entry('a.txt')] });
    server.files['a.txt'] = () => reply({ error: 'index is busy' }, 409);
    mount();
    await screen.findByTestId('review-list');
    await settle();
    expect(screen.getByTestId('review-placeholder-error')).toHaveTextContent('index is busy');

    server.files['a.txt'] = snapshot('a.txt');
    fireEvent.click(screen.getByTestId('review-retry'));
    await settle();
    expect(screen.queryByTestId('review-placeholder-error')).toBeNull();
    expect(screen.getAllByTestId('review-line').length).toBe(2);
  });
});

describe('a hidden review issues no request', () => {
  it('reads and fetches nothing until it is shown, and again nothing once hidden', async () => {
    server.status[REPO] = statusBody({ changes: [entry('a.txt')] });
    server.files['a.txt'] = snapshot('a.txt');
    const pane = mount({ visible: false });
    await settle();
    expect(server.statusRepos).toEqual([]);
    expect(server.requests).toEqual([]);

    pane.show(true);
    await screen.findByTestId('review-list');
    await settle();
    expect(server.statusRepos.length).toBeGreaterThan(0);
    expect(server.requests.length).toBe(1);

    pane.show(false);
    await settle();
    const reads = server.statusRepos.length;
    const fetched = server.requests.length;
    // A change that lands while hidden is not fetched until the pane is shown.
    server.status[REPO] = statusBody({
      changes: [entry('a.txt', { fp: 'fp-a-2' }), entry('b.txt')],
    });
    server.files['b.txt'] = snapshot('b.txt');
    act(() => scmStatusStore.refresh());
    await settle();
    expect(server.statusRepos).toHaveLength(reads);
    expect(server.requests).toHaveLength(fetched);
  });
});

// ── Layouts ──────────────────────────────────────────────────────────────────

describe('side-by-side and unified layouts', () => {
  const edit = () =>
    snapshot('a.txt', {
      old: { id: 'o', text: numbered(6) },
      new: { id: 'n', text: numbered(5, { 4: 'first new', 5: 'second new' }) },
      hunks: [
        hunk(
          [
            ['ctx', 'line 3'],
            ['del', 'line 4'],
            ['del', 'line 5'],
            ['add', 'first new'],
          ],
          { old: 3, new: 3 },
        ),
      ],
    });

  beforeEach(() => {
    server.status[REPO] = statusBody({ changes: [entry('a.txt')] });
    server.files['a.txt'] = edit();
  });

  it('uses the unified layout in a 390px pane in automatic mode', async () => {
    paneWidth = 390;
    mount({ host: { layout: 'auto' } });
    await screen.findByTestId('review-list');
    await settle();
    expect(screen.getByTestId('review-pane-7')).toHaveAttribute('data-layout', 'unified');
    expect(screen.queryAllByTestId('review-split')).toHaveLength(0);
    // Removed lines above added ones, one column, old and new numbers side by side.
    expect(screen.getAllByTestId('review-line').map((r) => r.dataset['kind'])).toEqual([
      'ctx',
      'del',
      'del',
      'add',
    ]);
    expect(textsOf('review-no-old')).toEqual(['3', '4', '5', '']);
    expect(textsOf('review-no-new')).toEqual(['3', '', '', '4']);
  });

  it('draws two columns in automatic mode when the pane is wide', async () => {
    mount({ host: { layout: 'auto' } });
    await screen.findByTestId('review-list');
    await settle();
    expect(screen.getByTestId('review-pane-7')).toHaveAttribute('data-layout', 'split');
    expect(screen.queryAllByTestId('review-line')).toHaveLength(0);
    expect(screen.getAllByTestId('review-split')).toHaveLength(3);
  });

  it('forcing side-by-side puts old numbers on the left and new numbers on the right, changed lines paired', async () => {
    paneWidth = 1400;
    mount({ host: { layout: 'split' } });
    await screen.findByTestId('review-list');
    await settle();
    expect(textsOf('review-no-left')).toEqual(['3', '4', '5']);
    expect(textsOf('review-no-right')).toEqual(['3', '4']);
    const cells = screen
      .getAllByTestId('review-split')
      .map((row) => [
        within(row).getByTestId('review-cell-left').dataset['kind'],
        within(row).getByTestId('review-cell-right').dataset['kind'],
      ]);
    // The first deletion is paired with the addition, the second stands alone.
    expect(cells).toEqual([
      ['ctx', 'ctx'],
      ['del', 'add'],
      ['del', 'empty'],
    ]);
  });

  it('switches the layout from the bar, keeps the choice in the host, and keeps the file in view', async () => {
    server.status[REPO] = statusBody({ changes: [entry('a.txt'), entry('b.txt')] });
    server.files['b.txt'] = snapshot('b.txt');
    paneWidth = 390;
    const { spy } = mount({ host: { layout: 'auto' } });
    await screen.findByTestId('review-list');
    await settle();
    expect(screen.getByTestId('review-pane-7')).toHaveAttribute('data-layout', 'unified');

    // A 390px bar holds the controls in its one menu.
    await userEvent.click(screen.getByTestId('review-view-options'));
    await userEvent.click(screen.getByTestId('review-view-menu-layout-split'));
    await settle();
    expect(spy.preferences).toEqual([{ scmLayout: 'split' }]);
    expect(screen.getByTestId('review-pane-7')).toHaveAttribute('data-layout', 'split');
    expect(screen.getAllByTestId('review-split').length).toBeGreaterThan(0);
    expect(screen.getByTestId('review-current')).toHaveTextContent('a.txt');
  });

  describe('the bar of a narrow pane', () => {
    it('folds the layout, wrap and algorithm controls into one menu below 500px, so it is one row', async () => {
      paneWidth = 390;
      mount({ host: { layout: 'auto' } });
      await screen.findByTestId('review-list');
      await settle();
      expect(screen.getByTestId('review-title')).toHaveTextContent('Changes · app');
      expect(screen.getByTestId('review-summary')).toHaveTextContent('1 file');
      expect(screen.getByTestId('review-view-options')).toHaveAccessibleName('View options');
      expect(screen.queryByTestId('review-layout')).toBeNull();
      expect(screen.queryByTestId('review-wrap')).toBeNull();
      expect(screen.queryByTestId('review-algorithm')).toBeNull();

      // Wider than the fold, the three controls are back in the bar and the menu is gone.
      setPaneWidth(600);
      await settle();
      expect(screen.getByTestId('review-layout')).toBeInTheDocument();
      expect(screen.getByTestId('review-wrap')).toBeInTheDocument();
      expect(screen.getByTestId('review-algorithm')).toBeInTheDocument();
      expect(screen.queryByTestId('review-view-options')).toBeNull();
      setPaneWidth(499);
      await settle();
      expect(screen.getByTestId('review-view-options')).toBeInTheDocument();
    });

    it('offers every choice in the menu, marks the current ones, and hands a pick to the host', async () => {
      paneWidth = 390;
      const { spy } = mount({ host: { layout: 'auto' } });
      await screen.findByTestId('review-list');
      await settle();
      await userEvent.click(screen.getByTestId('review-view-options'));
      const radio = 'menuitemradio';
      expect(menuItems()).toEqual([
        { label: 'Auto layout', role: radio, checked: true, disabled: false },
        { label: 'Split layout', role: radio, checked: false, disabled: false },
        { label: 'Unified layout', role: radio, checked: false, disabled: false },
        // Narrow and unified: wrapping by default.
        { label: 'Wrap long lines', role: 'menuitemcheckbox', checked: true, disabled: false },
        { label: 'Myers diff', role: radio, checked: false, disabled: false },
        { label: 'Minimal diff', role: radio, checked: false, disabled: false },
        { label: 'Patience diff', role: radio, checked: false, disabled: false },
        { label: 'Histogram diff', role: radio, checked: true, disabled: false },
        // The code size: a minus and a plus, neither of which closes the menu.
        { label: 'Smaller code', role: 'menuitem', checked: false, disabled: false },
        { label: 'Larger code', role: 'menuitem', checked: false, disabled: false },
      ]);
      await userEvent.click(screen.getByTestId('review-view-menu-algorithm-patience'));
      await settle();
      expect(spy.preferences).toEqual([{ scmAlgorithm: 'patience' }]);

      await userEvent.click(screen.getByTestId('review-view-options'));
      await userEvent.click(screen.getByTestId('review-view-menu-wrap'));
      await settle();
      expect(spy.preferences).toContainEqual({ scmWrap: false });
      expect(screen.getAllByTestId('review-line')[0]).not.toHaveClass('rv-wrap');

      // Side by side always wraps, and says so instead of offering the toggle.
      await userEvent.click(screen.getByTestId('review-view-options'));
      await userEvent.click(screen.getByTestId('review-view-menu-layout-split'));
      await settle();
      await userEvent.click(screen.getByTestId('review-view-options'));
      expect(menuItems()).toContainEqual({
        label: 'Side by side always wraps',
        role: 'menuitemcheckbox',
        checked: true,
        disabled: true,
      });
    });

    it('announces the current layout, wrap and algorithm, and takes a pick from the keyboard', async () => {
      paneWidth = 390;
      const { spy } = mount({ host: { layout: 'auto' } });
      await screen.findByTestId('review-list');
      await settle();
      screen.getByTestId('review-view-options').focus();
      await userEvent.keyboard('{Enter}');
      const menu = screen.getByRole('menu');
      // Two radio sets (layout, algorithm), each one group with one option checked. The
      // code size is a group too, of two buttons.
      const sets = within(menu)
        .getAllByRole('group')
        .filter((group) => within(group).queryAllByRole('menuitemradio').length > 0);
      expect(sets.map((set) => within(set).getAllByRole('menuitemradio').length)).toEqual([3, 4]);
      for (const set of sets) {
        const checked = within(set)
          .getAllByRole('menuitemradio')
          .filter((item) => item.getAttribute('aria-checked') === 'true');
        expect(checked).toHaveLength(1);
      }
      expect(screen.getByTestId('review-view-menu-layout-auto')).toHaveAttribute(
        'aria-checked',
        'true',
      );
      expect(screen.getByTestId('review-view-menu-wrap')).toHaveAttribute('aria-checked', 'true');

      // Auto, Split: Enter picks it.
      await userEvent.keyboard('{ArrowDown}');
      expect(screen.getByTestId('review-view-menu-layout-split')).toHaveFocus();
      await userEvent.keyboard('{Enter}');
      await settle();
      expect(spy.preferences).toEqual([{ scmLayout: 'split' }]);

      // The menu reopens on the new state: Split is the checked layout now.
      screen.getByTestId('review-view-options').focus();
      await userEvent.keyboard('{Enter}');
      expect(screen.getByTestId('review-view-menu-layout-split')).toHaveAttribute(
        'aria-checked',
        'true',
      );
      expect(screen.getByTestId('review-view-menu-layout-auto')).toHaveAttribute(
        'aria-checked',
        'false',
      );
      await userEvent.keyboard('{End}');
      // The last item is the code size's plus, two above the last algorithm.
      expect(screen.getByTestId('review-view-menu-code-size-increase')).toHaveFocus();
      await userEvent.keyboard('{ArrowUp}{ArrowUp}');
      expect(screen.getByTestId('review-view-menu-algorithm-histogram')).toHaveFocus();
      await userEvent.keyboard('{ArrowUp}{ArrowUp} ');
      await settle();
      expect(spy.preferences).toEqual([{ scmLayout: 'split' }, { scmAlgorithm: 'minimal' }]);
    });
  });

  it('re-lays out only when the pane crosses the threshold, not on every resize', async () => {
    mount({ host: { layout: 'auto' } });
    await screen.findByTestId('review-list');
    await settle();
    expect(screen.getByTestId('review-pane-7')).toHaveAttribute('data-layout', 'split');
    const splitRows = screen.getAllByTestId('review-split');

    setPaneWidth(1100);
    setPaneWidth(900);
    await settle();
    // The same elements: nothing was rebuilt for a width that stayed wide.
    expect(screen.getAllByTestId('review-split')[0]).toBe(splitRows[0]);
    expect(screen.getByTestId('review-pane-7')).toHaveAttribute('data-layout', 'split');

    setPaneWidth(500);
    await settle();
    expect(screen.getByTestId('review-pane-7')).toHaveAttribute('data-layout', 'unified');
    setPaneWidth(1000);
    await settle();
    expect(screen.getByTestId('review-pane-7')).toHaveAttribute('data-layout', 'split');
  });

  it('does not take a hidden pane’s zero width for a narrow one', async () => {
    mount({ host: { layout: 'auto' } });
    await screen.findByTestId('review-list');
    await settle();
    setPaneWidth(0);
    await settle();
    expect(screen.getByTestId('review-pane-7')).toHaveAttribute('data-layout', 'split');
  });

  describe('hunk headings', () => {
    const withHeader = (header: string) => {
      const hunks = [{ ...hunk([['add', 'x']], { old: 4, new: 4 }), header }];
      server.files['a.txt'] = snapshot('a.txt', { hunks });
    };

    // The server sends the section git found after the second `@@`, which is empty
    // for most hunks: the row must still say where the hunk is.
    it('draws the range for a hunk that came with no context', async () => {
      withHeader('');
      mount();
      await screen.findByTestId('review-list');
      await settle();
      expect(screen.getByTestId('review-hunk')).toHaveTextContent('@@ -4,0 +4,1 @@');
    });

    it('draws the range and then the context git found', async () => {
      withHeader('function total() {');
      mount();
      await screen.findByTestId('review-list');
      await settle();
      expect(screen.getByTestId('review-hunk')).toHaveTextContent(
        '@@ -4,0 +4,1 @@ function total() {',
      );
    });

    it('keeps a heading that is already the whole `@@` line', async () => {
      withHeader('@@ -4,0 +4,1 @@ already whole');
      mount();
      await screen.findByTestId('review-list');
      await settle();
      expect(screen.getByTestId('review-hunk')).toHaveTextContent(
        /^@@ -4,0 \+4,1 @@ already whole$/,
      );
    });
  });

  describe('Wrap', () => {
    it('is on by default in a narrow pane and off in a wide one, and the toggle reaches the host', async () => {
      paneWidth = 1400;
      server.files['a.txt'] = edit();
      const { spy } = mount({ host: { layout: 'unified' } });
      await screen.findByTestId('review-list');
      await settle();
      const wrap = screen.getByTestId('review-wrap');
      expect(wrap).toHaveAttribute('aria-pressed', 'false');
      expect(screen.getAllByTestId('review-line')[0]).not.toHaveClass('rv-wrap');

      fireEvent.click(wrap);
      await settle();
      expect(spy.preferences).toContainEqual({ scmWrap: true });
      expect(screen.getByTestId('review-wrap')).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getAllByTestId('review-line')[0]).toHaveClass('rv-wrap');
    });

    it('is always on, and cannot be turned off, side by side', async () => {
      mount({ host: { layout: 'split', wrap: false } });
      await screen.findByTestId('review-list');
      await settle();
      const wrap = screen.getByTestId('review-wrap');
      expect(wrap).toHaveAttribute('aria-pressed', 'true');
      expect(wrap).toBeDisabled();
    });

    it('moves the rows below a wrapped row down by the height the browser measured', async () => {
      paneWidth = 390;
      server.files['a.txt'] = snapshot('a.txt', {
        hunks: [
          hunk([
            ['add', 'x'.repeat(200)],
            ['add', 'short'],
          ]),
        ],
        old: { id: 'o', text: '' },
        new: { id: 'n', text: `${'x'.repeat(200)}\nshort\n` },
      });
      mount();
      await screen.findByTestId('review-list');
      await settle();
      const [long, short] = screen.getAllByTestId('review-line');
      const before = offsetOf(short as HTMLElement);
      expect((long as HTMLElement).style.height).toBe('auto');

      // The browser wrapped the long line over four rows of text.
      reportSize(long as HTMLElement, { height: 80 });
      await settle();
      const after = offsetOf(screen.getAllByTestId('review-line')[1] as HTMLElement);
      expect(after - before).toBe(80 - (before - offsetOf(long as HTMLElement)));
    });
  });
});

describe('wrapped rows are measured again when the width changes', () => {
  const longLine = 'x'.repeat(200);

  // An observer only reports a row whose size CHANGED since it last reported. After a
  // width change the measurements start over, so a row that comes out the same height
  // at the new width would otherwise never be measured again and would be laid out
  // at its estimate, under (or over) its neighbour.
  it('re-measures a row whose height did not change, so the rows below stay clear of it', async () => {
    paneWidth = 390;
    server.status[REPO] = statusBody({ changes: [entry('a.txt')] });
    server.files['a.txt'] = snapshot('a.txt', {
      old: { id: 'o', text: '' },
      new: { id: 'n', text: `${longLine}\nshort\n` },
      hunks: [
        hunk([
          ['add', longLine],
          ['add', 'short'],
        ]),
      ],
    });
    // The browser lays the long line out over three rows of text at both widths.
    FakeResizeObserver.measure = (element) =>
      (element as HTMLElement).dataset['rvKey']?.endsWith('|0:0') ? 60 : undefined;
    mount({ host: { layout: 'unified' } });
    await screen.findByTestId('review-list');
    await settle();
    const gap = () => {
      const [long, short] = screen.getAllByTestId('review-line') as HTMLElement[];
      return offsetOf(short as HTMLElement) - offsetOf(long as HTMLElement);
    };
    expect(gap()).toBe(60);

    // 390 to 450 crosses a measurement bucket: the old measurements are dropped.
    setPaneWidth(450);
    await settle();
    expect(gap()).toBe(60);
  });
});

describe('the sticky controls are the width of the view', () => {
  // `.rv-sticky` (every file header, notice, gap and hunk heading) is
  // `width: var(--rv-view-w, 100%)`. In no-wrap mode the pane writes the view's width
  // there so a header stays at the left edge of a list that scrolls sideways; a value
  // left behind in wrap mode holds every header at a width the view no longer has.
  const viewWidth = () => scroller().style.getPropertyValue('--rv-view-w');
  const scrollWidth = () => scroller().style.getPropertyValue('--rv-scroll-w');
  let lineWidth = 0;

  beforeEach(() => {
    lineWidth = 0;
    server.status[REPO] = statusBody({ changes: [entry('a.txt')] });
    server.files['a.txt'] = snapshot('a.txt');
    // The scroller is as wide as the pane; a line as wide as its text.
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(
      function (this: HTMLElement) {
        return this.dataset['testid'] === 'review-list' ? paneWidth : 0;
      },
    );
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(
      function (this: HTMLElement) {
        return this.classList.contains('rv-line') ? lineWidth : 0;
      },
    );
  });

  it('drops the widths when the Wrap toggle turns wrapping on, and writes them again when it is off', async () => {
    mount({ host: { layout: 'unified' } });
    await screen.findByTestId('review-list');
    await settle();
    expect(viewWidth()).toBe('1400px');
    expect(scrollWidth()).toBe('1400px');
    scrollTo(10);
    await settle();

    fireEvent.click(screen.getByTestId('review-wrap'));
    await settle();
    expect(screen.getAllByTestId('review-line')[0]).toHaveClass('rv-wrap');
    expect(viewWidth()).toBe('');
    expect(scrollWidth()).toBe('');
    // A scroll in wrap mode writes nothing back.
    scrollTo(0);
    await settle();
    expect(viewWidth()).toBe('');

    fireEvent.click(screen.getByTestId('review-wrap'));
    await settle();
    expect(viewWidth()).toBe('1400px');
  });

  it('drops them when a narrowing pane starts wrapping by itself, and writes the new width when it widens', async () => {
    mount({ host: { layout: 'unified' } });
    await screen.findByTestId('review-list');
    await settle();
    expect(viewWidth()).toBe('1400px');

    // A desktop review split beside a terminal: the width and the wrapping change together.
    setPaneWidth(550);
    await settle();
    expect(screen.getAllByTestId('review-line')[0]).toHaveClass('rv-wrap');
    expect(viewWidth()).toBe('');
    expect(scrollWidth()).toBe('');

    setPaneWidth(1300);
    await settle();
    expect(screen.getAllByTestId('review-line')[0]).not.toHaveClass('rv-wrap');
    expect(viewWidth()).toBe('1300px');
  });

  it('drops them side by side, which always wraps', async () => {
    mount({ host: { layout: 'unified' } });
    await screen.findByTestId('review-list');
    await settle();
    expect(viewWidth()).toBe('1400px');

    fireEvent.click(screen.getByTestId('review-layout-split'));
    await settle();
    expect(viewWidth()).toBe('');
  });

  it('follows a resize that stays inside one measuring bucket', async () => {
    mount({ host: { layout: 'unified' } });
    await screen.findByTestId('review-list');
    await settle();
    // 1400 and 1420 round to the same 64px bucket: nothing is rebuilt.
    setPaneWidth(1420);
    await settle();
    expect(viewWidth()).toBe('1420px');
  });

  it('widens the scrolled content to a wider line a scroll brings in', async () => {
    mount({ host: { layout: 'unified' } });
    await screen.findByTestId('review-list');
    await settle();
    expect(scrollWidth()).toBe('1400px');

    lineWidth = 2000;
    scrollTo(5);
    await settle();
    expect(scrollWidth()).toBe('2000px');
    expect(viewWidth()).toBe('1400px');
  });
});

// ── The algorithm ────────────────────────────────────────────────────────────

describe('the diff algorithm is git’s and is selectable', () => {
  it('refetches the loaded files with the chosen algorithm and keeps the current file in view', async () => {
    server.status[REPO] = statusBody({ changes: [entry('a.txt'), entry('b.txt')] });
    server.files['a.txt'] = snapshot('a.txt');
    server.files['b.txt'] = snapshot('b.txt');
    const { spy } = mount();
    await screen.findByTestId('review-list');
    await settle();
    expect(server.requests.map((r) => r.algorithm)).toEqual(['histogram', 'histogram']);
    const current = screen.getByTestId('review-current').textContent;

    fireEvent.click(screen.getByTestId('review-algorithm'));
    fireEvent.click(screen.getByTestId('review-algorithm-option-myers'));
    await settle();
    expect(spy.preferences).toEqual([{ scmAlgorithm: 'myers' }]);
    expect(server.requests.slice(2).map((r) => [r.path, r.algorithm])).toEqual([
      ['a.txt', 'myers'],
      ['b.txt', 'myers'],
    ]);
    expect(screen.getByTestId('review-current').textContent).toBe(current);
    expect(screen.getAllByTestId('review-line').length).toBe(4);
  });
});

// ── Gaps ─────────────────────────────────────────────────────────────────────

describe('hidden lines between hunks can be expanded', () => {
  const eighty = () => {
    // 100 lines; one change at line 10 and one at line 91, with 80 unchanged lines between.
    const text = numbered(100);
    return snapshot('a.txt', {
      old: { id: 'o', text },
      new: { id: 'n', text },
      hunks: [
        hunk(
          [
            ['ctx', 'line 9'],
            ['add', 'inserted high'],
            ['ctx', 'line 10'],
          ],
          { old: 9, new: 9 },
        ),
        hunk(
          [
            ['ctx', 'line 90'],
            ['add', 'inserted low'],
            ['ctx', 'line 91'],
          ],
          { old: 89, new: 90 },
        ),
      ],
    });
  };

  const gapFor = (index: number) =>
    screen.getAllByTestId('review-gap').find((el) => el.dataset['gapIndex'] === String(index))!;

  it('reveals the lines a step at a time, with their old and new numbers, and never refetches', async () => {
    paneWidth = 390;
    server.status[REPO] = statusBody({ changes: [entry('a.txt')] });
    server.files['a.txt'] = eighty();
    mount();
    await screen.findByTestId('review-list');
    await settle();
    const fetched = server.requests.length;

    // The gap between the hunks: new lines 11..89 (hunk one ends at new 11, hunk two starts at 90).
    scrollTo(0);
    const between = gapFor(1);
    expect(within(between).getByTestId('review-gap-hidden')).toHaveTextContent('78 hidden lines');

    fireEvent.click(within(between).getByTestId('review-gap-down'));
    await settle();
    expect(within(gapFor(1)).getByTestId('review-gap-hidden')).toHaveTextContent('58 hidden lines');
    // The 20 lines revealed under the first hunk carry both numbers, which differ by one
    // after its insertion: old 11 sits at new 12.
    const revealed = screen
      .getAllByTestId('review-line')
      .filter((row) => row.dataset['kind'] === 'ctx')
      .map((row) => [
        within(row).getByTestId('review-no-old').textContent,
        within(row).getByTestId('review-no-new').textContent,
      ]);
    expect(revealed).toContainEqual(['11', '12']);
    expect(revealed).toContainEqual(['30', '31']);

    fireEvent.click(within(gapFor(1)).getByTestId('review-gap-all'));
    await settle();
    expect(screen.queryAllByTestId('review-gap').some((g) => g.dataset['gapIndex'] === '1')).toBe(
      false,
    );
    expect(server.requests).toHaveLength(fetched);
  });

  it('offers the lines before the first hunk and after the last, one direction each', async () => {
    server.status[REPO] = statusBody({ changes: [entry('a.txt')] });
    server.files['a.txt'] = eighty();
    mount();
    await screen.findByTestId('review-list');
    await settle();
    const start = gapFor(0);
    expect(within(start).queryByTestId('review-gap-down')).toBeNull();
    expect(within(start).getByTestId('review-gap-up')).toBeInTheDocument();
  });
});

// ── A phone draws the structure shorter ──────────────────────────────────────

describe('on a phone the review wastes no height', () => {
  const twoHunks = () => {
    const text = numbered(100);
    return snapshot('a.txt', {
      old: { id: 'o', text },
      new: { id: 'n', text },
      hunks: [
        hunk(
          [
            ['ctx', 'line 9'],
            ['add', 'inserted high'],
            ['ctx', 'line 10'],
          ],
          { old: 9, new: 9 },
        ),
        hunk(
          [
            ['ctx', 'line 90'],
            ['add', 'inserted low'],
            ['ctx', 'line 91'],
          ],
          { old: 89, new: 90 },
        ),
      ],
    });
  };
  // Unwrapped, so a code line is a fixed 20px row too and the sums have no measured row.
  const open = async () => {
    paneWidth = 390;
    server.status[REPO] = statusBody({ changes: [entry('a.txt')] });
    server.files['a.txt'] = twoHunks();
    const pane = mount({ host: { wrap: false } });
    await screen.findByTestId('review-list');
    await settle();
    return pane;
  };
  const height = (el: HTMLElement) => Number.parseFloat(el.style.height);
  const gaps = () => screen.getAllByTestId('review-gap');
  const hunks = () => screen.getAllByTestId('review-hunk');
  const pane = () => screen.getByTestId('review-pane-7');

  it('keeps the desktop rows: a header 40px, a gap 32px, a hunk header 24px, the kit’s buttons', async () => {
    await open();
    expect(pane()).not.toHaveAttribute('data-dense');
    expect(height(fileRow('a.txt'))).toBe(40);
    expect(gaps().map(height)).toEqual([32, 32, 32]);
    expect(hunks().map(height)).toEqual([24, 24]);
    const controls = within(gaps()[1]!).getAllByRole('button');
    expect(controls).toHaveLength(3);
    for (const control of controls) expect(control).toHaveClass('ui-btn', 'ui-btn-sm');
    expect(gaps()[1]!.querySelector('.rv-chip')).toBeNull();
  });

  it('draws the structural rows shorter: a header 36px, a gap 28px, a hunk header 20px', async () => {
    document.documentElement.dataset['mobile'] = 'true';
    await open();
    expect(pane()).toHaveAttribute('data-dense', 'true');
    expect(height(fileRow('a.txt'))).toBe(36);
    expect(gaps().map(height)).toEqual([28, 28, 28]);
    expect(hunks().map(height)).toEqual([20, 20]);
    // Each is at most the 28px the owner's contract names, and a hunk header one code line.
    for (const row of [...gaps(), ...hunks()]) expect(height(row)).toBeLessThanOrEqual(28);
    expect(hunks().map(height)).toEqual([20, 20]);
    // A code line is what it always was: the rows between lines are what gave way.
    const line = screen.getAllByTestId('review-line')[0]!;
    expect(height(line)).toBe(20);
  });

  it('adds the shorter heights up exactly: each row starts where the one above ends', async () => {
    document.documentElement.dataset['mobile'] = 'true';
    await open();
    const rows = [...screen.getByTestId('review-list').querySelectorAll<HTMLElement>('.rv-row')]
      .map((el) => ({ top: offsetOf(el), height: height(el) }))
      .sort((a, b) => a.top - b.top);
    expect(rows.length).toBeGreaterThan(8);
    expect(rows[0]!.top).toBe(0);
    for (const [i, row] of rows.entries()) {
      if (i === 0) continue;
      expect(row.top, `row ${i}`).toBe(rows[i - 1]!.top + rows[i - 1]!.height);
    }
  });

  it('draws a gap’s controls as chips that fit the row, and they still expand it', async () => {
    document.documentElement.dataset['mobile'] = 'true';
    await open();
    const between = gaps()[1]!;
    const up = within(between).getByTestId('review-gap-up');
    const down = within(between).getByTestId('review-gap-down');
    const all = within(between).getByTestId('review-gap-all');
    for (const chip of [up, down, all]) {
      expect(chip).toHaveClass('rv-chip');
      expect(chip).not.toHaveClass('ui-btn');
      expect(chip.tagName).toBe('BUTTON');
    }
    expect(up).toHaveAccessibleName('Show 20 more lines above');
    expect(down).toHaveAccessibleName('Show 20 more lines below');
    expect(all).toHaveAccessibleName('Show all');

    expect(within(between).getByTestId('review-gap-hidden')).toHaveTextContent('78 hidden lines');
    fireEvent.click(down);
    await settle();
    expect(within(gaps()[1]!).getByTestId('review-gap-hidden')).toHaveTextContent(
      '58 hidden lines',
    );
    fireEvent.click(within(gaps()[1]!).getByTestId('review-gap-all'));
    await settle();
    expect(gaps().some((g) => g.dataset['gapIndex'] === '1')).toBe(false);
  });

  it('follows the app into and out of the mobile layer while a review is open', async () => {
    await open();
    expect(height(gaps()[0]!)).toBe(32);
    act(() => {
      document.documentElement.dataset['mobile'] = 'true';
    });
    await settle();
    expect(pane()).toHaveAttribute('data-dense', 'true');
    expect(gaps().map(height)).toEqual([28, 28, 28]);
    expect(within(gaps()[1]!).getByTestId('review-gap-up')).toHaveClass('rv-chip');
    act(() => {
      delete document.documentElement.dataset['mobile'];
    });
    await settle();
    expect(pane()).not.toHaveAttribute('data-dense');
    expect(gaps().map(height)).toEqual([32, 32, 32]);
    expect(within(gaps()[1]!).getByTestId('review-gap-up')).toHaveClass('ui-btn');
  });

  it('keeps the file header’s controls and its path, and lets the state word go to CSS', async () => {
    document.documentElement.dataset['mobile'] = 'true';
    await open();
    const header = fileRow('a.txt');
    // Hidden by the stylesheet (`display: none`), never removed: assistive tech and the
    // desktop still have it, and the letter keeps it as its title.
    expect(within(header).getByTestId('review-file-state')).toHaveTextContent('Modified');
    expect(within(header).getByTestId('review-file-reviewed')).toHaveClass('ui-btn-sm');
    expect(within(header).getByTestId('review-file-open')).toBeInTheDocument();
    expect(within(header).getByTestId('review-file-toggle')).toBeInTheDocument();
  });
});

// ── Special files ────────────────────────────────────────────────────────────

describe('special files are explained, not rendered', () => {
  const one = (e: ScmEntry, s: ScmFileSnapshot) => {
    server.status[REPO] = statusBody({ changes: [e] });
    server.files[e.path] = s;
  };

  it.each([
    ['a binary file', { binary: true }, 'binary', 'Binary file not shown.'],
    ['a file over the size limit', { tooLarge: true }, 'tooLarge', 'File too large to show.'],
    [
      'a file converted by git',
      { converted: true },
      'converted',
      'This file is converted by git and cannot be shown here.',
    ],
  ] as const)('%s shows its notice and draws no lines', async (_name, flags, kind, text) => {
    one(entry('x.dat', { binary: kind === 'binary' }), snapshot('x.dat', { ...flags, hunks: [] }));
    mount();
    await screen.findByTestId('review-list');
    await settle();
    const notice = screen.getByTestId('review-notice');
    expect(notice).toHaveAttribute('data-notice', kind);
    expect(notice).toHaveTextContent(text);
    expect(screen.queryAllByTestId('review-line')).toHaveLength(0);
    expect(screen.queryAllByTestId('review-split')).toHaveLength(0);
  });

  it('a binary file’s header says so', async () => {
    one(entry('x.dat', { binary: true }), snapshot('x.dat', { binary: true, hunks: [] }));
    mount();
    await screen.findByTestId('review-list');
    expect(within(fileRow('x.dat')).getByTestId('review-file-state')).toHaveTextContent('binary');
  });

  it('a staged rename shows both paths and the one changed line, not a whole new file', async () => {
    server.status[REPO] = statusBody({
      staged: [entry('b.ts', { kind: 'rename', status: 'R', oldPath: 'a.ts' })],
    });
    server.files['b.ts'] = snapshot('b.ts', {
      group: 'staged',
      oldPath: 'a.ts',
      hunks: [
        hunk([
          ['ctx', 'same'],
          ['del', 'old'],
          ['add', 'new'],
        ]),
      ],
    });
    mount({ tab: tab(`staged:${REPO}`) });
    await screen.findByTestId('review-list');
    await settle();
    expect(within(fileRow('b.ts')).getByTestId('review-file-old')).toHaveTextContent('a.ts →');
    expect(screen.getByTestId('review-notice')).toHaveTextContent('Renamed from a.ts');
    expect(
      screen.getAllByTestId('review-line').filter((r) => r.dataset['kind'] !== 'ctx'),
    ).toHaveLength(2);
  });

  it('a mode change is listed with its header notice', async () => {
    one(
      entry('run.sh', { added: 0, removed: 0 }),
      snapshot('run.sh', { hunks: [], modes: { old: '100644', new: '100755' } }),
    );
    mount();
    await screen.findByTestId('review-list');
    await settle();
    expect(screen.getByTestId('review-notice')).toHaveTextContent(
      'Mode changed from 100644 to 100755',
    );
  });

  it('a new file, a staged file before the first commit, shows every line as added', async () => {
    server.status[REPO] = statusBody({
      unborn: true,
      staged: [entry('a.ts', { status: 'A', added: 2, removed: 0 })],
    });
    server.files['a.ts'] = snapshot('a.ts', {
      group: 'staged',
      old: { id: 'absent', text: '' },
      new: { id: 'n', text: 'one\ntwo\n' },
      hunks: [
        hunk(
          [
            ['add', 'one'],
            ['add', 'two'],
          ],
          { old: 0, new: 1 },
        ),
      ],
    });
    mount({ tab: tab(`staged:${REPO}`) });
    await screen.findByTestId('review-list');
    await settle();
    expect(screen.getAllByTestId('review-line').map((r) => r.dataset['kind'])).toEqual([
      'add',
      'add',
    ]);
  });

  describe('a conflicted file', () => {
    const conflicted = () => {
      server.status[REPO] = statusBody({
        merge: [{ path: 'c.ts', kind: 'unmerged', status: 'U', fp: 'u1' }],
      });
    };

    it('shows a read-only notice with Open file, no diff, and no snapshot request', async () => {
      conflicted();
      const { spy } = mount();
      await screen.findByTestId('review-list');
      await settle();
      expect(within(fileRow('c.ts')).getByTestId('review-file-state')).toHaveTextContent(
        'Conflicted',
      );
      const notice = screen.getByTestId('review-notice');
      expect(notice).toHaveAttribute('data-notice', 'unmerged');
      expect(notice).toHaveTextContent('This file has conflicts. Resolve them in your editor.');
      expect(screen.queryAllByTestId('review-line')).toHaveLength(0);
      expect(server.requests).toEqual([]);

      fireEvent.click(within(notice).getByTestId('review-notice-open'));
      expect(spy.opened).toEqual([`${REPO}/c.ts`]);
    });

    it('stays out of the fetch queue however long the review is read', async () => {
      conflicted();
      mount();
      await screen.findByTestId('review-list');
      scrollTo(10);
      await settle();
      act(() => scmStatusStore.refresh());
      await settle();
      expect(server.requests).toEqual([]);
    });
  });
});

// ── One version ──────────────────────────────────────────────────────────────

describe('lines, colours and hunks describe one version', () => {
  it('never lets a slow answer overwrite a newer one', async () => {
    server.status[REPO] = statusBody({ changes: [entry('a.txt', { fp: 'fp-1' })] });
    let releaseSlow: (body: unknown) => void = () => {};
    server.files['a.txt'] = () =>
      new Promise((resolve) => {
        releaseSlow = (body) =>
          resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
      });
    mount();
    await screen.findByTestId('review-list');
    await settle();
    expect(server.requests).toHaveLength(1);

    // Ten lines are inserted on disk while the first answer is still on the wire.
    server.status[REPO] = statusBody({ changes: [entry('a.txt', { fp: 'fp-2' })] });
    server.files['a.txt'] = snapshot('a.txt', {
      version: 'v-new',
      hunks: [
        hunk([
          ['del', 'before'],
          ['add', 'the newer line'],
        ]),
      ],
    });
    act(() => scmStatusStore.refresh());
    await settle();
    expect(screen.getByText('the newer line')).toBeInTheDocument();

    // The stale answer arrives last and is dropped.
    await act(async () => {
      releaseSlow(snapshot('a.txt', { version: 'v-old' }));
    });
    await settle();
    expect(screen.getByText('the newer line')).toBeInTheDocument();
    expect(screen.queryByText('after')).toBeNull();
  });
});

// ── Colours ──────────────────────────────────────────────────────────────────

describe('lines are coloured by the editor’s grammars and the palmux theme', () => {
  const PROFILE: ColorProfile = {
    id: 'light',
    name: 'Light',
    fg: 0x222222,
    bg: 0xffffff,
    ansi16: Array.from({ length: 16 }, (_, i) => i * 0x111111),
  };
  const BASE: ColorProfile = { ...PROFILE, id: 'dark', name: 'Dark', fg: 0xeeeeee, bg: 0x111111 };

  // The bridge is module state: every test starts from one palette, published before
  // any pane mounts, so `PROFILE` is a real change whatever the last test left.
  beforeEach(() => setEditorProfile(BASE));

  const ts = () => {
    server.status[REPO] = statusBody({ changes: [entry('a.ts')] });
    server.files['a.ts'] = snapshot('a.ts', {
      old: { id: 'o', text: 'const a = 1;\n' },
      new: { id: 'n', text: 'const b = 1;\n' },
      hunks: [
        hunk([
          ['del', 'const a = 1;'],
          ['add', 'const b = 1;'],
        ]),
      ],
    });
  };

  it('draws plain text first, then Monaco’s coloured markup without changing the rows', async () => {
    ts();
    mount();
    await screen.findByTestId('review-list');
    await settle();
    const added = screen.getAllByTestId('review-line').find((r) => r.dataset['kind'] === 'add')!;
    expect(added.querySelector('.mtk1')).not.toBeNull();
    expect(added.textContent).toContain('const b = 1;');
    expect(added.style.height).toBe('20px');
  });

  it('marks the characters that differ inside the coloured line', async () => {
    ts();
    mount();
    await screen.findByTestId('review-list');
    await settle();
    const added = screen.getAllByTestId('review-line').find((r) => r.dataset['kind'] === 'add')!;
    const removed = screen.getAllByTestId('review-line').find((r) => r.dataset['kind'] === 'del')!;
    expect([...added.querySelectorAll('.rv-mark')].map((m) => m.textContent)).toEqual(['b']);
    expect([...removed.querySelectorAll('.rv-mark')].map((m) => m.textContent)).toEqual(['a']);
  });

  it('repaints when the theme changes, without reloading the files', async () => {
    ts();
    mount();
    await screen.findByTestId('review-list');
    await settle();
    expect(document.querySelector('.mtk1')).not.toBeNull();
    const fetched = server.requests.length;

    monaco.colorize.mockImplementation(colorizeWith('mtk7'));
    act(() => setEditorProfile(PROFILE));
    await settle();
    expect(document.querySelector('.mtk7')).not.toBeNull();
    expect(document.querySelector('.mtk1')).toBeNull();
    expect(server.requests).toHaveLength(fetched);
  });

  it('updates every open review on one profile change, and a closed one stops listening', async () => {
    ts();
    const first = mount({ tab: tab(`changes:${REPO}`, '7') });
    await screen.findByTestId('review-list');
    await settle();
    const second = mount({ tab: tab(`staged:${REPO}`, '8'), active: null });
    server.status[REPO] = statusBody({ staged: [entry('a.ts')], changes: [entry('a.ts')] });
    act(() => scmStatusStore.refresh());
    await settle();
    expect(document.querySelectorAll('.mtk1').length).toBeGreaterThan(0);

    monaco.colorize.mockClear();
    monaco.colorize.mockImplementation(colorizeWith('mtk7'));
    act(() => setEditorProfile(PROFILE));
    await settle();
    // Both panes drew again: colouring ran for each, and nothing is left in the old colour.
    expect(monaco.colorize.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(document.querySelector('.mtk1')).toBeNull();

    first.unmount();
    second.unmount();
    monaco.colorize.mockClear();
    act(() => setEditorProfile({ ...PROFILE, id: 'again', fg: 0x333333 }));
    await settle();
    expect(monaco.colorize).not.toHaveBeenCalled();
  });

  // App publishes the profile on every `themes` message, and the server sends one in
  // the handshake of every reconnect: a PWA back from the background does one.
  it('does not recolour for a profile whose palette it already drew with', async () => {
    ts();
    mount();
    await screen.findByTestId('review-list');
    await settle();
    expect(document.querySelector('.mtk1')).not.toBeNull();

    monaco.colorize.mockClear();
    monaco.colorize.mockImplementation(colorizeWith('mtk7'));
    act(() => setEditorProfile({ ...BASE }));
    act(() => setEditorProfile({ ...BASE, id: 'same-colours', name: 'Same colours' }));
    await settle();
    expect(monaco.colorize).not.toHaveBeenCalled();
    expect(document.querySelector('.mtk1')).not.toBeNull();
    expect(document.querySelector('.mtk7')).toBeNull();
  });

  it('a hidden review recolours when it is shown, not when the theme changes', async () => {
    ts();
    const pane = mount();
    await screen.findByTestId('review-list');
    await settle();
    expect(document.querySelector('.mtk1')).not.toBeNull();
    pane.show(false);
    await settle();

    monaco.colorize.mockClear();
    monaco.colorize.mockImplementation(colorizeWith('mtk7'));
    act(() => setEditorProfile(PROFILE));
    await settle();
    expect(monaco.colorize).not.toHaveBeenCalled();

    pane.show(true);
    await settle();
    expect(monaco.colorize).toHaveBeenCalled();
    expect(document.querySelector('.mtk7')).not.toBeNull();
    expect(document.querySelector('.mtk1')).toBeNull();
  });

  it('a hidden review that saw the palette change and change back draws nothing again', async () => {
    ts();
    const pane = mount();
    await screen.findByTestId('review-list');
    await settle();
    pane.show(false);
    await settle();

    monaco.colorize.mockClear();
    act(() => setEditorProfile(PROFILE));
    act(() => setEditorProfile(BASE));
    pane.show(true);
    await settle();
    expect(monaco.colorize).not.toHaveBeenCalled();
    expect(document.querySelector('.mtk1')).not.toBeNull();
  });

  it('never reaches for Monaco for a file with no grammar, so a plain review downloads nothing', async () => {
    server.status[REPO] = statusBody({ changes: [entry('notes.txt')] });
    server.files['notes.txt'] = snapshot('notes.txt');
    mount();
    await screen.findByTestId('review-list');
    await settle();
    expect(monaco.getMonacoCalls).toBe(0);
    expect(monaco.colorize).not.toHaveBeenCalled();
  });

  it('colours nothing it was not given: a line is escaped text or Monaco’s own markup', async () => {
    server.status[REPO] = statusBody({ changes: [entry('a.ts')] });
    server.files['a.ts'] = snapshot('a.ts', {
      old: { id: 'o', text: '' },
      new: { id: 'n', text: '<img src=x onerror=alert(1)>\n' },
      hunks: [hunk([['add', '<img src=x onerror=alert(1)>']], { old: 0, new: 1 })],
    });
    monaco.colorize.mockImplementation(() => Promise.reject(new Error('no grammar loaded')));
    mount();
    await screen.findByTestId('review-list');
    await settle();
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByTestId('review-line')).toHaveTextContent('<img src=x onerror=alert(1)>');
  });
});

// ── Only the active project is read ──────────────────────────────────────────

describe('only the active project is read', () => {
  it('pauses a review of another project, keeps what it had, and asks for nothing', async () => {
    server.status[REPO] = statusBody({ changes: [entry('a.txt')] });
    server.status[OTHER] = statusBody({ changes: [entry('z.txt')] }, OTHER);
    server.files['a.txt'] = snapshot('a.txt');
    const { spy } = mount({ repos: [REPO, OTHER] });
    await screen.findByTestId('review-list');
    await settle();
    expect(screen.queryByTestId('review-paused')).toBeNull();
    const fetched = server.requests.length;

    // The user selects the other project in the dock.
    act(() => scmStatusStore.setActiveRepo(OTHER));
    await settle();
    const paused = screen.getByTestId('review-paused');
    expect(paused).toHaveTextContent('Paused');
    expect(within(paused).getByTestId('review-activate')).toHaveTextContent('Make app active');
    // Its last data is still on screen under the bar.
    expect(paths()).toEqual(['a.txt']);
    expect(screen.getAllByTestId('review-line').length).toBeGreaterThan(0);
    // This project is neither read nor fetched from any more.
    const reads = server.statusRepos.length;
    act(() => scmStatusStore.refresh());
    await settle();
    expect(server.statusRepos).toHaveLength(reads);
    expect(server.requests).toHaveLength(fetched);

    fireEvent.click(within(paused).getByTestId('review-activate'));
    expect(spy.activated).toEqual([REPO]);
  });

  it('shows the paused bar over nothing for a review that was never read', async () => {
    mount({ active: OTHER, repos: [REPO, OTHER] });
    await settle();
    expect(screen.getByTestId('review-paused')).toBeInTheDocument();
    expect(screen.getByTestId('review-message')).toHaveTextContent('Nothing loaded yet.');
    expect(server.statusRepos.every((r) => r === OTHER)).toBe(true);
    expect(server.requests).toEqual([]);
  });

  it('reads again, and resumes, once its project is made active', async () => {
    server.status[REPO] = statusBody({ changes: [entry('a.txt')] });
    server.files['a.txt'] = snapshot('a.txt');
    mount({ active: OTHER, repos: [REPO, OTHER] });
    await settle();
    expect(screen.getByTestId('review-paused')).toBeInTheDocument();
    act(() => scmStatusStore.setActiveRepo(REPO));
    await screen.findByTestId('review-list');
    await settle();
    expect(screen.queryByTestId('review-paused')).toBeNull();
    expect(server.requests.length).toBe(1);
  });

  it('turns a removed project into a notice and never reads it', async () => {
    server.status[REPO] = statusBody({ changes: [entry('a.txt')] });
    server.files['a.txt'] = snapshot('a.txt');
    mount({ repos: [OTHER] });
    await settle();
    const removed = screen.getByTestId('review-removed');
    expect(removed).toHaveTextContent('Project removed');
    expect(screen.queryByTestId('review-list')).toBeNull();
    expect(screen.queryByTestId('review-paused')).toBeNull();
    expect(server.statusRepos).toEqual([]);
    expect(server.requests).toEqual([]);
  });

  it('shows what it last read for a project that is removed while it is open, as a notice only', async () => {
    server.status[REPO] = statusBody({ changes: [entry('a.txt')] });
    server.files['a.txt'] = snapshot('a.txt');
    const spy: HostSpy = {
      preferences: [],
      activated: [],
      opened: [],
      scrollTargets: new Map(),
      takes: [],
    };
    scmStatusStore.setActiveRepo(REPO);
    const ui = (repos: string[]) => (
      <Harness repos={repos} spy={spy} tick={0}>
        <ReviewPane tab={tab()} visible focused />
      </Harness>
    );
    const { rerender } = render(ui([REPO]));
    await screen.findByTestId('review-list');
    rerender(ui([]));
    await settle();
    expect(screen.getByTestId('review-removed')).toBeInTheDocument();
    expect(screen.queryByTestId('review-list')).toBeNull();
  });
});

// ── Following the disk ───────────────────────────────────────────────────────

describe('the review follows the disk while visible', () => {
  const hundred = () => {
    const text = numbered(100);
    return snapshot('a.txt', {
      old: { id: 'o', text },
      new: { id: 'n', text },
      hunks: [
        hunk(
          [
            ['ctx', 'line 98'],
            ['del', 'line 99'],
            ['add', 'line 99 changed'],
            ['ctx', 'line 100'],
          ],
          { old: 98, new: 98 },
        ),
      ],
    });
  };

  it('adds a file that joins the group, and removes one that leaves it, in path order', async () => {
    server.status[REPO] = statusBody({ changes: [entry('a.txt'), entry('c.txt')] });
    for (const p of ['a.txt', 'b.txt', 'c.txt']) server.files[p] = snapshot(p);
    mount();
    await screen.findByTestId('review-list');
    await settle();
    server.status[REPO] = statusBody({ changes: [entry('a.txt'), entry('b.txt'), entry('c.txt')] });
    act(() => scmStatusStore.refresh());
    await settle();
    expect(paths()).toEqual(['a.txt', 'b.txt', 'c.txt']);

    server.status[REPO] = statusBody({ changes: [entry('a.txt'), entry('c.txt')] });
    act(() => scmStatusStore.refresh());
    await settle();
    expect(paths()).toEqual(['a.txt', 'c.txt']);
  });

  it('fetches only the file whose fingerprint changed', async () => {
    server.status[REPO] = statusBody({ changes: [entry('a.txt'), entry('b.txt')] });
    server.files['a.txt'] = snapshot('a.txt');
    server.files['b.txt'] = snapshot('b.txt');
    mount();
    await screen.findByTestId('review-list');
    await settle();
    server.requests.length = 0;
    server.status[REPO] = statusBody({
      changes: [entry('a.txt'), entry('b.txt', { fp: 'fp-b-2' })],
    });
    act(() => scmStatusStore.refresh());
    await settle();
    expect(server.requests.map((r) => r.path)).toEqual(['b.txt']);
  });

  it('refetches every loaded file when the attribute epoch changes', async () => {
    server.status[REPO] = statusBody({ changes: [entry('a.txt'), entry('b.txt')] });
    server.files['a.txt'] = snapshot('a.txt');
    server.files['b.txt'] = snapshot('b.txt');
    mount();
    await screen.findByTestId('review-list');
    await settle();
    server.requests.length = 0;
    server.status[REPO] = statusBody({
      changes: [entry('a.txt'), entry('b.txt')],
      attrEpoch: 'e1',
    });
    act(() => scmStatusStore.refresh());
    await settle();
    expect(server.requests.map((r) => r.path).toSorted()).toEqual(['a.txt', 'b.txt']);
  });

  it('keeps the same code in view, now renumbered, when lines are inserted above it', async () => {
    server.status[REPO] = statusBody({ changes: [entry('a.txt')] });
    server.files['a.txt'] = hundred();
    mount();
    await screen.findByTestId('review-list');
    await settle();

    // Read line 100: 4px of the row above it scrolled out of view.
    const target = screen
      .getAllByTestId('review-line')
      .find((r) => r.textContent?.includes('line 100'))!;
    const top = offsetOf(target);
    scrollTo(top + 4);
    const before = scroller().scrollTop;

    // Ten lines are inserted at line 5: the hunk and everything in it shifts down by ten.
    const inserted = Array.from({ length: 10 }, (_, i) => `inserted ${i + 1}`);
    const lines = numbered(100).split('\n');
    lines.pop();
    const shifted = `${[...lines.slice(0, 4), ...inserted, ...lines.slice(4)].join('\n')}\n`;
    server.status[REPO] = statusBody({ changes: [entry('a.txt', { fp: 'fp-a-2' })] });
    server.files['a.txt'] = snapshot('a.txt', {
      version: 'v-shifted',
      old: { id: 'o', text: shifted },
      new: { id: 'n', text: shifted },
      hunks: [
        hunk(
          [
            ['ctx', 'line 98'],
            ['del', 'line 99'],
            ['add', 'line 99 changed'],
            ['ctx', 'line 100'],
          ],
          { old: 108, new: 108 },
        ),
      ],
    });
    act(() => scmStatusStore.refresh());
    await settle();

    // The line is numbered 110 now, and sits exactly where it did on screen.
    const after = screen
      .getAllByTestId('review-line')
      .find((r) => r.textContent?.includes('line 100'))!;
    expect(within(after).getByTestId('review-no-new')).toHaveTextContent('110');
    expect(offsetOf(after) - scroller().scrollTop).toBe(top - before);
  });

  it('leaves the lines in view where they are when an edit lands below them', async () => {
    server.status[REPO] = statusBody({ changes: [entry('a.txt'), entry('b.txt')] });
    server.files['a.txt'] = hundred();
    server.files['b.txt'] = snapshot('b.txt');
    mount();
    await screen.findByTestId('review-list');
    await settle();
    const target = screen
      .getAllByTestId('review-line')
      .find((r) => r.textContent?.includes('line 99 changed'))!;
    scrollTo(offsetOf(target) + 3);
    const before = scroller().scrollTop;

    server.status[REPO] = statusBody({
      changes: [entry('a.txt'), entry('b.txt', { fp: 'fp-b-2' })],
    });
    server.files['b.txt'] = snapshot('b.txt', {
      version: 'v-b2',
      hunks: [
        hunk([
          ['del', 'before'],
          ['add', 'edited near the end'],
        ]),
      ],
    });
    act(() => scmStatusStore.refresh());
    await settle();
    expect(scroller().scrollTop).toBe(before);
    expect(screen.getByText('edited near the end')).toBeInTheDocument();
  });

  it('keeps the view when a file above it loads and grows', async () => {
    server.status[REPO] = statusBody({ changes: [entry('a.txt'), entry('b.txt')] });
    let releaseA: (body: unknown) => void = () => {};
    server.files['a.txt'] = () =>
      new Promise((resolve) => {
        releaseA = (body) => resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
      });
    server.files['b.txt'] = snapshot('b.txt');
    mount();
    await screen.findByTestId('review-list');
    await settle();
    // Scroll to b's first line while a.txt is still a placeholder above it.
    const bLine = screen.getAllByTestId('review-line').find((r) => r.dataset['path'] === 'b.txt')!;
    scrollTo(offsetOf(bLine) + 2);
    const bLineTop = (): number =>
      offsetOf(
        screen
          .getAllByTestId('review-line')
          .find((r) => r.dataset['path'] === 'b.txt') as HTMLElement,
      );
    const before = bLineTop() - scroller().scrollTop;

    // a.txt arrives with a long diff: everything below it moves down.
    const long = Array.from(
      { length: 30 },
      (_, i) => ['add', `added ${i}`] as [ScmHunkLine['kind'], string],
    );
    await act(async () => {
      releaseA(
        snapshot('a.txt', {
          hunks: [hunk(long, { old: 0, new: 1 })],
          old: { id: 'o', text: '' },
          new: { id: 'n', text: `${long.map(([, t]) => t).join('\n')}\n` },
        }),
      );
    });
    await settle();
    expect(bLineTop() - scroller().scrollTop).toBe(before);
  });
});

// ── Scrolling to a file ──────────────────────────────────────────────────────

describe('a review opened for a file scrolls to it', () => {
  const group = () => {
    server.status[REPO] = statusBody({
      changes: [entry('a.txt'), entry('b.txt'), entry('c.txt')],
    });
    for (const p of ['a.txt', 'b.txt', 'c.txt']) server.files[p] = snapshot(p);
  };

  it('takes its pending target once and shows that file at the top of the view', async () => {
    group();
    const pane = mount({ visible: false });
    pane.spy.scrollTargets.set(`changes:${REPO}`, { path: 'c.txt' });
    pane.show(true, 1);
    await screen.findByTestId('review-list');
    await settle();
    expect(pane.spy.takes).toEqual([`changes:${REPO}`]);
    expect(pane.spy.scrollTargets.size).toBe(0);
    const header = offsetOf(fileRow('c.txt'));
    expect(scroller().scrollTop).toBe(header);
  });

  it('keeps the request until the group has loaded', async () => {
    group();
    const pane = mount({ visible: false });
    pane.spy.scrollTargets.set(`changes:${REPO}`, { path: 'b.txt' });
    pane.show(true, 1);
    // The status has not answered yet: nothing to scroll in.
    expect(screen.queryByTestId('review-list')).toBeNull();
    await screen.findByTestId('review-list');
    await settle();
    expect(scroller().scrollTop).toBe(offsetOf(fileRow('b.txt')));
  });

  it('scrolls again when another file of the same review is opened while it is shown', async () => {
    group();
    const pane = mount();
    await screen.findByTestId('review-list');
    await settle();
    expect(scroller().scrollTop).toBe(0);
    pane.spy.scrollTargets.set(`changes:${REPO}`, { path: 'b.txt' });
    pane.show(true, 1);
    await settle();
    expect(scroller().scrollTop).toBe(offsetOf(fileRow('b.txt')));

    pane.spy.scrollTargets.set(`changes:${REPO}`, { path: 'c.txt' });
    pane.show(true, 2);
    await settle();
    expect(scroller().scrollTop).toBe(offsetOf(fileRow('c.txt')));
  });

  it('ignores a target whose file is not in the group', async () => {
    group();
    const pane = mount();
    await screen.findByTestId('review-list');
    await settle();
    pane.spy.scrollTargets.set(`changes:${REPO}`, { path: 'gone.txt' });
    pane.show(true, 1);
    await settle();
    expect(scroller().scrollTop).toBe(0);
    expect(pane.spy.scrollTargets.size).toBe(0);
  });

  // The shape that failed on a real screen. The files above the target are
  // placeholders whose estimates (from the status counts) are far from the rows they
  // turn into, and the target lies past the content react-window had sized its
  // scroller for, which a browser clamps a scroll offset to.
  describe('in a group whose files are not the height they were estimated at', () => {
    const PATHS = Array.from({ length: 40 }, (_, i) => `f${String(i).padStart(2, '0')}.txt`);
    /** By file: [the lines the status claims a side, the lines the diff really has]. */
    const SHAPES = PATHS.map((_, i): [number, number] => {
      if (i < 6) return [1, 60];
      if (i < 20) return [400, 2];
      if (i === 23 || i === 24) return [300, 50];
      return [1, 2];
    });
    const added = (path: string, count: number): ScmFileSnapshot => {
      const texts = Array.from({ length: count }, (_, i) => `${path} ${i + 1}`);
      return snapshot(path, {
        old: { id: 'o', text: '' },
        new: { id: 'n', text: `${texts.join('\n')}\n` },
        hunks: [
          hunk(
            texts.map((text) => ['add', text]),
            { old: 0, new: 1 },
          ),
        ],
      });
    };
    const bigGroup = () => {
      const changes: ScmEntry[] = [];
      PATHS.forEach((p, i) => {
        const [claimed, real] = SHAPES[i] ?? [1, 1];
        changes.push(entry(p, { added: claimed, removed: claimed }));
        // A server across a network answers after the browser has reported a scroll.
        const body = added(p, real);
        server.files[p] = () => new Promise((resolve) => setTimeout(() => resolve(reply(body)), 0));
      });
      server.status[REPO] = statusBody({ changes });
    };
    /**
     * Let the view come to rest: each round lets the browser report the last write
     * and the fetches that report started answer (React applies a scroll's update
     * only as an `act` round ends), until neither the offset nor the requests move.
     */
    const settleView = async () => {
      const state = () => `${scroller().scrollTop}|${server.requests.length}`;
      for (let round = 0; round < 12; round++) {
        const before = state();
        // oxlint-disable-next-line no-await-in-loop -- each round needs the one before it
        await settle();
        if (state() === before) return;
      }
      throw new Error('the view never came to rest');
    };
    const expectAtTop = (path: string, position: string) => {
      expect(scroller().scrollTop).toBe(offsetOf(fileRow(path)));
      expect(screen.getByTestId('review-current')).toHaveTextContent(path);
      expect(screen.getByTestId('review-current')).toHaveTextContent(position);
    };

    beforeEach(browserScrolling);

    it('lands on the chosen file’s header and keeps it there while the files above it load', async () => {
      bigGroup();
      const pane = mount({ visible: false });
      pane.spy.scrollTargets.set(`changes:${REPO}`, { path: 'f25.txt' });
      pane.show(true, 1);
      await screen.findByTestId('review-list');
      await settleView();
      // The two files above it loaded, and each turned out a sixth of its estimate.
      const fetched = server.requests.map((r) => r.path);
      expect(fetched).toEqual(expect.arrayContaining(['f23.txt', 'f24.txt', 'f25.txt']));
      expectAtTop('f25.txt', '26 / 40');
    });

    it('lands on every file chosen while it is shown, wherever the last one left the view', async () => {
      bigGroup();
      const pane = mount();
      await screen.findByTestId('review-list');
      await settleView();
      const chosen: [string, string][] = [
        ['f25.txt', '26 / 40'],
        ['f12.txt', '13 / 40'],
        ['f33.txt', '34 / 40'],
        ['f25.txt', '26 / 40'],
      ];
      for (const [i, [path, position]] of chosen.entries()) {
        pane.spy.scrollTargets.set(`changes:${REPO}`, { path });
        pane.show(true, i + 1);
        // oxlint-disable-next-line no-await-in-loop -- each choice lands before the next
        await settleView();
        expectAtTop(path, position);
      }
    });

    it('steps to the next and previous file’s header from there', async () => {
      bigGroup();
      const pane = mount({ visible: false });
      pane.spy.scrollTargets.set(`changes:${REPO}`, { path: 'f25.txt' });
      pane.show(true, 1);
      await screen.findByTestId('review-list');
      await settleView();
      const step = async (run: () => void) => {
        act(run);
        await settleView();
      };
      await step(() => reviewApiFor('7')?.nextFile());
      expectAtTop('f26.txt', '27 / 40');
      await step(() => reviewApiFor('7')?.prevFile());
      expectAtTop('f25.txt', '26 / 40');
      await step(() => reviewApiFor('7')?.prevFile());
      expectAtTop('f24.txt', '25 / 40');
    });

    // The compact rows are other numbers in the same sums: the list is given a height per
    // row, and a landing is the offset those heights add up to. A phone's header (36px)
    // and hunk header (20px) must still put the chosen file's header exactly at the top.
    it('lands and steps the same way on a phone, whose header and hunk rows are shorter', async () => {
      document.documentElement.dataset['mobile'] = 'true';
      bigGroup();
      const pane = mount({ visible: false });
      pane.spy.scrollTargets.set(`changes:${REPO}`, { path: 'f25.txt' });
      pane.show(true, 1);
      await screen.findByTestId('review-list');
      await settleView();
      expect(screen.getByTestId('review-pane-7')).toHaveAttribute('data-dense', 'true');
      expect(fileRow('f25.txt').style.height).toBe('36px');
      expectAtTop('f25.txt', '26 / 40');
      const step = async (run: () => void) => {
        act(run);
        await settleView();
      };
      await step(() => reviewApiFor('7')?.nextFile());
      expectAtTop('f26.txt', '27 / 40');
      await step(() => reviewApiFor('7')?.prevFile());
      expectAtTop('f25.txt', '26 / 40');
    });
  });

  it('does not take a target while hidden', async () => {
    group();
    const pane = mount({ visible: false });
    pane.spy.scrollTargets.set(`changes:${REPO}`, { path: 'b.txt' });
    pane.show(false, 1);
    await settle();
    expect(pane.spy.takes).toEqual([]);
    expect(pane.spy.scrollTargets.size).toBe(1);
  });
});

// react-window sizes its scroller from an in-flow spacer as tall as its ESTIMATE:
// the row count times the average of the rows laid out so far. The extent box
// raises the scroller to the real total where that is shorter; where it is taller,
// the sheet hides the spacer, or the reader could scroll past the last file into
// blank space (`browserScrolling` lays out what review.css leaves on screen).
describe('the scroller is exactly as tall as the rows', () => {
  beforeEach(browserScrolling);

  it('ends at the last file when the estimate is taller than the rows', async () => {
    // One placeholder thousands of pixels tall on top, a hundred short ones under it,
    // and no file ever answers: the rows laid out first are the tall ones.
    const PATHS = Array.from({ length: 100 }, (_, i) => `f${String(i).padStart(3, '0')}.txt`);
    server.status[REPO] = statusBody({
      changes: PATHS.map((p, i) =>
        entry(p, i === 0 ? { added: 400, removed: 400 } : { added: 1, removed: 0 }),
      ),
    });
    for (const p of PATHS) server.files[p] = () => new Promise(() => {});
    mount();
    await screen.findByTestId('review-list');
    await settle();

    const list = scroller();
    const extent = list.querySelector<HTMLElement>('.rv-extent');
    const spacer = list.lastElementChild as HTMLElement;
    const total = parseFloat(extent?.style.height ?? '');
    expect(spacer).toHaveAttribute('aria-hidden', 'true');
    expect(spacer).not.toBe(extent);
    // The shape under test: react-window's estimate runs far past the rows.
    expect(parseFloat(spacer.style.height)).toBeGreaterThan(total * 2);

    // The End key, or the scrollbar dragged to the bottom, before react-window has
    // laid out any of the rows down there.
    scrollTo(10_000_000);
    expect(list.scrollTop).toBe(total - DEFAULT_LIST_HEIGHT_PX);
    await settle();
    expect(list.scrollTop).toBe(total - DEFAULT_LIST_HEIGHT_PX);
    // The last file is drawn, and its last row ends at the bottom of the view.
    expect(paths()).toContain('f099.txt');
    const bottoms = [...list.querySelectorAll<HTMLElement>('[data-rv-key]')].map(
      (row) => offsetOf(row) + parseFloat(row.style.height),
    );
    expect(Math.max(...bottoms)).toBe(total);
  });
});

describe('a review shown again keeps its place', () => {
  it('puts the view back when the browser lost the scroll offset of a hidden pane', async () => {
    const long = Array.from({ length: 400 }, (_, i) => `f${String(i).padStart(3, '0')}.txt`);
    server.status[REPO] = statusBody({ changes: long.map((p) => entry(p)) });
    for (const p of long) server.files[p] = snapshot(p);
    const pane = mount();
    await screen.findByTestId('review-list');
    await settle();
    scrollTo(5000);
    await settle();
    const place = scroller().scrollTop;

    pane.show(false);
    await settle();
    // display:none drops a scroller's offset.
    act(() => {
      scroller().scrollTop = 0;
    });
    pane.show(true);
    await settle();
    expect(Math.abs(scroller().scrollTop - place)).toBeLessThan(2);
  });
});

// ── The code font size is adjustable at any time ─────────────────────────────

describe('the code font size', () => {
  const frame = (): HTMLElement => screen.getByTestId('review-pane-7');
  const sizeOf = (): { fs: string; lh: string } => ({
    fs: frame().style.getPropertyValue('--rv-code-fs'),
    lh: frame().style.getPropertyValue('--rv-code-lh'),
  });
  const codeRows = (): HTMLElement[] => screen.getAllByTestId('review-line');

  /** Every row the list draws, top to bottom, with where it starts and how tall it is. */
  const rowsByOffset = () =>
    [...scroller().querySelectorAll<HTMLElement>('[data-rv-key]')]
      .map((el) => ({ el, top: offsetOf(el), height: parseFloat(el.style.height) }))
      .toSorted((a, b) => a.top - b.top);

  /** A file with a hunk header, a gap above it and lines in it, so every kind of row is drawn. */
  const longFile = () => {
    const text = numbered(100);
    return snapshot('a.txt', {
      old: { id: 'o', text },
      new: { id: 'n', text },
      hunks: [
        hunk(
          [
            ['ctx', 'line 50'],
            ['del', 'line 51'],
            ['add', 'line 51 changed'],
            ['ctx', 'line 52'],
          ],
          { old: 50, new: 50 },
        ),
      ],
    });
  };

  const open = async (options: Options = {}) => {
    server.status[REPO] = statusBody({ changes: [entry('a.txt')] });
    server.files['a.txt'] = longFile();
    const pane = mount(options);
    await screen.findByTestId('review-list');
    await settle();
    return pane;
  };

  it('is the default size over the default line for a device that never chose', async () => {
    await open({ host: { wrap: false } });
    expect(sizeOf()).toEqual({ fs: '12px', lh: '20px' });
    for (const row of codeRows()) expect(row.style.height).toBe('20px');
    // The wide bar says so too.
    expect(screen.getByTestId('review-code-size')).toHaveTextContent('12');
  });

  it('draws the size the device chose, with a line to match', async () => {
    await open({ host: { wrap: false, codeFontSize: 16 } });
    expect(sizeOf()).toEqual({ fs: '16px', lh: '27px' });
    for (const row of codeRows()) expect(row.style.height).toBe('27px');
    expect(screen.getByTestId('review-code-size')).toHaveTextContent('16');
  });

  describe('smaller code on a phone', () => {
    it('shrinks the diff two steps from the view menu, leaves it open and the terminal alone', async () => {
      paneWidth = 390;
      const { spy } = await open({ host: { wrap: false } });
      await userEvent.click(screen.getByTestId('review-view-options'));
      expect(screen.getByTestId('review-view-menu-code-size-value')).toHaveTextContent('12');

      await userEvent.click(screen.getByTestId('review-view-menu-code-size-decrease'));
      await userEvent.click(screen.getByTestId('review-view-menu-code-size-decrease'));
      await settle();

      // Two steps at once, one preference each, and not a word about the terminal.
      expect(spy.preferences).toEqual([{ codeFontSize: 11 }, { codeFontSize: 10 }]);
      expect(sizeOf()).toEqual({ fs: '10px', lh: '17px' });
      for (const row of codeRows()) expect(row.style.height).toBe('17px');
      // The menu is still there, showing the new value.
      expect(screen.getByRole('menu')).toBeInTheDocument();
      expect(screen.getByTestId('review-view-menu-code-size-value')).toHaveTextContent('10');

      // And a larger step from the same open menu goes back up one.
      await userEvent.click(screen.getByTestId('review-view-menu-code-size-increase'));
      await settle();
      expect(spy.preferences.at(-1)).toEqual({ codeFontSize: 11 });
      expect(sizeOf()).toEqual({ fs: '11px', lh: '18px' });
      expect(screen.getByRole('menu')).toBeInTheDocument();
    });

    it('is reached from the keyboard with clear names, and announces the value', async () => {
      paneWidth = 390;
      const { spy } = await open({ host: { wrap: false } });
      screen.getByTestId('review-view-options').focus();
      await userEvent.keyboard('{Enter}');
      const group = screen.getByRole('group', { name: 'Code font size' });
      expect(within(group).getByRole('menuitem', { name: 'Smaller code' })).toBeInTheDocument();
      expect(within(group).getByRole('menuitem', { name: 'Larger code' })).toBeInTheDocument();
      expect(screen.getByTestId('review-view-menu-code-size-value')).toHaveAttribute(
        'aria-live',
        'polite',
      );

      await userEvent.keyboard('{End}');
      expect(screen.getByTestId('review-view-menu-code-size-increase')).toHaveFocus();
      await userEvent.keyboard('{Enter}{Enter}');
      await userEvent.keyboard('{ArrowUp}{Enter}');
      await settle();
      expect(spy.preferences).toEqual([
        { codeFontSize: 13 },
        { codeFontSize: 14 },
        { codeFontSize: 13 },
      ]);
      expect(screen.getByRole('menu')).toBeInTheDocument();
      expect(screen.getByTestId('review-view-menu-code-size-value')).toHaveTextContent('13');
    });

    it('stops at the ends of the range the terminal font takes', async () => {
      paneWidth = 390;
      await open({ host: { wrap: false, codeFontSize: 6 } });
      await userEvent.click(screen.getByTestId('review-view-options'));
      expect(screen.getByTestId('review-view-menu-code-size-decrease')).toHaveAttribute(
        'data-disabled',
      );
      expect(screen.getByTestId('review-view-menu-code-size-increase')).not.toHaveAttribute(
        'data-disabled',
      );
    });
  });

  describe('the wide bar', () => {
    it('has the same minus, value and plus, named for assistive technology', async () => {
      const { spy } = await open({ host: { wrap: false } });
      const group = screen.getByRole('group', { name: 'Code font size' });
      expect(within(group).getByRole('button', { name: 'Smaller code' })).toBe(
        screen.getByTestId('review-code-smaller'),
      );
      expect(within(group).getByRole('button', { name: 'Larger code' })).toBe(
        screen.getByTestId('review-code-larger'),
      );
      expect(screen.getByTestId('review-code-size')).toHaveAttribute('aria-live', 'polite');

      await userEvent.click(screen.getByTestId('review-code-larger'));
      await userEvent.click(screen.getByTestId('review-code-larger'));
      await userEvent.click(screen.getByTestId('review-code-smaller'));
      await settle();
      expect(spy.preferences).toEqual([
        { codeFontSize: 13 },
        { codeFontSize: 14 },
        { codeFontSize: 13 },
      ]);
      expect(screen.getByTestId('review-code-size')).toHaveTextContent('13');
      expect(sizeOf()).toEqual({ fs: '13px', lh: '22px' });
    });

    it('is only a menu below 500px, and the bar has the control above', async () => {
      paneWidth = 390;
      await open({ host: { wrap: false } });
      expect(screen.queryByTestId('review-code-smaller')).toBeNull();
      setPaneWidth(600);
      await settle();
      expect(screen.getByTestId('review-code-smaller')).toBeInTheDocument();
    });

    it('disables each button at its end of the range', async () => {
      await open({ host: { wrap: false, codeFontSize: 48 } });
      expect(screen.getByTestId('review-code-larger')).toBeDisabled();
      expect(screen.getByTestId('review-code-smaller')).not.toBeDisabled();
      cleanup();
      await open({ host: { wrap: false, codeFontSize: 6 } });
      expect(screen.getByTestId('review-code-smaller')).toBeDisabled();
      expect(screen.getByTestId('review-code-larger')).not.toBeDisabled();
    });
  });

  it('keeps every row aligned with the next at every size, chrome and code alike', async () => {
    await open({ host: { wrap: false } });
    // 12 → 11 → 10 → 11 → 12 → 13 → 14 → 13
    const steps = ['smaller', 'smaller', 'larger', 'larger', 'larger', 'larger', 'smaller'];
    const sizes: string[] = [];
    for (const step of steps) {
      // oxlint-disable-next-line no-await-in-loop -- one step at a time, each settled
      await userEvent.click(screen.getByTestId(`review-code-${step}`));
      // oxlint-disable-next-line no-await-in-loop
      await settle();
      sizes.push(sizeOf().fs);
      const rows = rowsByOffset();
      expect(rows.length).toBeGreaterThan(5);
      for (let i = 1; i < rows.length; i++) {
        const before = rows[i - 1]!;
        // Each row starts where the one above ends: nothing overlaps and nothing is left.
        expect(rows[i]!.top, `${sizeOf().fs}, row ${i}`).toBe(before.top + before.height);
      }
    }
    expect(sizes).toEqual(['11px', '10px', '11px', '12px', '13px', '14px', '13px']);
  });

  it('resizes the code rows and leaves the file header, hunk header and gaps as they were', async () => {
    await open({ host: { wrap: false, codeFontSize: 20 } });
    const heightOf = (testId: string): string[] =>
      screen.getAllByTestId(testId).map((el) => el.style.height);
    for (const row of codeRows()) expect(row.style.height).toBe('33px');
    expect(heightOf('review-file')).toEqual(['40px']);
    expect(heightOf('review-hunk')).toEqual(['24px']);
    for (const height of heightOf('review-gap')) expect(height).toBe('32px');
  });

  it('keeps the same code under the reader’s eye when the size changes', async () => {
    await open({ host: { wrap: false } });
    const target = () => codeRows().find((r) => r.textContent?.includes('line 51 changed'))!;
    // Read the changed line, 4px of it scrolled out of view.
    scrollTo(offsetOf(target()) + 4);
    await settle();
    const offsetInView = () => offsetOf(target()) - scroller().scrollTop;
    expect(offsetInView()).toBe(-4);

    for (const testId of ['review-code-smaller', 'review-code-smaller', 'review-code-larger']) {
      // oxlint-disable-next-line no-await-in-loop -- one step at a time, each settled
      await userEvent.click(screen.getByTestId(testId));
      // oxlint-disable-next-line no-await-in-loop
      await settle();
      // The same line, at the same distance from the top of the view.
      expect(target()).toBeInTheDocument();
      expect(offsetInView()).toBe(-4);
    }
    expect(sizeOf()).toEqual({ fs: '11px', lh: '18px' });
  });

  it('forgets the heights it measured at the old size: a wrapped row is estimated afresh', async () => {
    paneWidth = 390;
    // Wrapping is the narrow default, so the line rows are the ones the browser measures.
    await open();
    const [first, second] = codeRows();
    reportSize(first!, { height: 61 });
    await settle();
    const gap = () => offsetOf(second!) - offsetOf(first!);
    expect(gap()).toBe(61);

    await userEvent.click(screen.getByTestId('review-view-options'));
    await userEvent.click(screen.getByTestId('review-view-menu-code-size-decrease'));
    await settle();
    // Not 61, and not 20: an estimate at the new size, until the browser measures again.
    expect(gap()).toBe(18);
  });
});
