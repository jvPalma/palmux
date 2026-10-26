// What the review pane's integration tests share: the browser the pane runs in
// (a ResizeObserver whose reports play the layout, a width for the body) and the
// server it talks to (status, file snapshots, the comments store, the three index
// writes), all in memory. The pane under test is the real one, with the real status
// store, comments store, file queue and virtual list. Only the network, Monaco and
// the layout engine are stood in for.
//
// This is test support, not a test: it holds no assertions of its own.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, render, screen } from '@testing-library/react';
import { parse } from 'postcss';
import type { ReactNode } from 'react';
import { vi } from 'vitest';
import type { ScmEntry, ScmFileSnapshot, ScmHunk, ScmHunkLine, TabMeta } from '@palmux/shared';
import { scmStatusStore } from '../scm/status-store';
import type { ScmLayoutPref } from '../settings/settings';
import {
  DEFAULT_REVIEW_HOST,
  ReviewHostContext,
  type ReviewHost,
  type ReviewToastAction,
} from './review-host';
import { ReviewPane } from './ReviewPane';
import { commentsStore } from './use-comments';
import { resetWriteLog } from './write-log';

export const REPO = '/work/app';
export const OTHER = '/work/lib';

// ── The browser ──────────────────────────────────────────────────────────────

export class FakeResizeObserver {
  static all: FakeResizeObserver[] = [];
  observed = new Set<Element>();
  constructor(readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.all.push(this);
  }
  observe(element: Element) {
    this.observed.add(element);
  }
  unobserve(element: Element) {
    this.observed.delete(element);
  }
  disconnect() {
    this.observed.clear();
  }
}

/** The browser reporting that a row it draws measured `height` tall. */
export function measureRow(element: Element, height: number): void {
  act(() => {
    for (const observer of FakeResizeObserver.all) {
      if (!observer.observed.has(element)) continue;
      observer.callback(
        [
          {
            target: element,
            contentRect: { width: 0, height },
            borderBoxSize: [{ inlineSize: 0, blockSize: height }],
          } as unknown as ResizeObserverEntry,
        ],
        observer as unknown as ResizeObserver,
      );
    }
  });
}

/** Colour every line in one span per line, the shape Monaco answers. */
export const colorize = (text: string): Promise<string> =>
  Promise.resolve(
    `${text
      .split('\n')
      .map((line) => `<span>${line.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</span>`)
      .join('<br/>')}<br/>`,
  );

/** How tall the browser model draws the review list: react-window's first-paint height. */
const MODEL_LIST_HEIGHT = 600;

/**
 * The list's children that review.css takes out of the layout (`display: none`, as
 * it does react-window's spacer). Read from the sheet and not named here, so the
 * model lays out what a browser given that sheet would, and a rule that stops
 * matching shows up as content a browser would not have.
 */
const HIDDEN_LIST_CHILDREN: readonly string[] = (() => {
  const selectors: string[] = [];
  parse(readFileSync(join(__dirname, 'review.css'), 'utf8')).walkRules((rule) => {
    if (!rule.selector.startsWith('.rv-list >')) return;
    rule.walkDecls('display', (decl) => {
      if (decl.value === 'none') selectors.push(rule.selector);
    });
  });
  return selectors;
})();

/** How tall the list's content is, from the boxes its children declare inline. */
function contentHeight(list: HTMLElement): number {
  let flow = 0;
  let lowest = 0;
  for (const child of list.children) {
    if (HIDDEN_LIST_CHILDREN.some((selector) => child.matches(selector))) continue;
    const { style } = child as HTMLElement;
    const height = parseFloat(style.height) || 0;
    if (style.position === 'absolute') {
      const translated = /translateY\((-?[\d.]+)px\)/.exec(style.transform)?.[1];
      const top = parseFloat(style.top) || Number(translated ?? 0);
      lowest = Math.max(lowest, top + height);
    } else {
      flow += height;
    }
  }
  return Math.max(flow, lowest);
}

/**
 * Make the review list scroll the way a browser's does, in the two ways a jump
 * depends on and happy-dom does neither: an offset past the end of the content is
 * CLAMPED to it (the content being what the list's children declare inline, which
 * is all react-window and the pane use, less what review.css hides), and a change
 * of offset is REPORTED by a `scroll` event a turn later. Without it a jump past
 * the content's end passes here and fails on a real screen. `vi.restoreAllMocks`
 * (in `teardown`) removes it.
 */
export function browserScrolling(): void {
  const original = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
  const get = original?.get;
  const set = original?.set;
  if (!get || !set) throw new Error('Element.prototype has no scrollTop accessor to wrap');
  vi.spyOn(Element.prototype, 'scrollTop', 'set').mockImplementation(function (
    this: Element,
    value: number,
  ) {
    if (!(this instanceof HTMLElement) || this.dataset['testid'] !== 'review-list') {
      set.call(this, value);
      return;
    }
    const before = get.call(this) as number;
    const end = Math.max(0, contentHeight(this) - MODEL_LIST_HEIGHT);
    set.call(this, Math.min(Math.max(0, value), end));
    if (get.call(this) !== before) {
      setTimeout(() => this.dispatchEvent(new Event('scroll')), 0);
    }
  });
}

/** The pane's body is this wide, so the layout rule has something to read. */
let bodyWidth = 1400;
export const setBodyWidth = (width: number): void => {
  bodyWidth = width;
};

// ── Fixtures ─────────────────────────────────────────────────────────────────

export const entry = (path: string, over: Partial<ScmEntry> = {}): ScmEntry => ({
  path,
  kind: 'ordinary',
  status: 'M',
  fp: `fp-${path}-1`,
  added: 1,
  removed: 1,
  ...over,
});

export const statusBody = (over: Record<string, unknown> = {}, top = REPO) => ({
  top,
  branch: 'main',
  unborn: false,
  merge: [] as ScmEntry[],
  staged: [] as ScmEntry[],
  changes: [] as ScmEntry[],
  truncated: false,
  tookMs: 5,
  commentsRev: 0,
  attrEpoch: 'e0',
  ...over,
});
export type StatusBody = ReturnType<typeof statusBody>;

export function hunk(
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

export function snapshot(path: string, over: Partial<ScmFileSnapshot> = {}): ScmFileSnapshot {
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
    token: `tok-${path}-1`,
    ...over,
  };
}

/** `count` lines, `line 1` … `line N`, with the numbered ones replaced. */
export const lines = (count: number, replace: Record<number, string> = {}): string[] =>
  Array.from({ length: count }, (_, i) => replace[i + 1] ?? `line ${i + 1}`);

/**
 * A file of `total` lines whose only change is line `at`, edited from `old` to
 * `new`, with three lines of context either side: the shape git answers.
 */
export function editedAt(
  path: string,
  at: number,
  total = 50,
  over: Partial<ScmFileSnapshot> = {},
): ScmFileSnapshot {
  const text = (replace: Record<number, string>): string => `${lines(total, replace).join('\n')}\n`;
  const first = Math.max(1, at - 3);
  const last = Math.min(total, at + 3);
  const body: [ScmHunkLine['kind'], string][] = [];
  for (let n = first; n < at; n++) body.push(['ctx', `line ${n}`]);
  body.push(['del', `line ${at}`], ['add', `edited ${at}`]);
  for (let n = at + 1; n <= last; n++) body.push(['ctx', `line ${n}`]);
  return snapshot(path, {
    old: { id: 'o', text: text({}) },
    new: { id: 'n', text: text({ [at]: `edited ${at}` }) },
    hunks: [hunk(body, { old: first, new: first })],
    ...over,
  });
}

// ── The server ───────────────────────────────────────────────────────────────

const reply = (answer: unknown, status = 200): Promise<unknown> =>
  Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(answer) });

export interface StoredComment {
  id: string;
  path: string;
  version: string;
  side: string;
  start: number;
  end: number;
  lines: string[];
  before: string[];
  after: string[];
  body: string;
  createdAt: number;
  updatedAt: number;
}

export interface LoggedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body: Record<string, unknown> | undefined;
}

type Answer = { status: number; body: unknown };
type WriteKind = 'stage' | 'unstage' | 'restore';

export class FakeServer {
  status: Record<string, StatusBody> = {};
  /** By `${group}:${path}`, else by path; a function plays a slow or failing answer. */
  files: Record<string, ScmFileSnapshot | (() => Promise<unknown>)> = {};
  comments: StoredComment[] = [];
  rev = 0;
  log: LoggedRequest[] = [];
  /** What the next write of each kind answers, in order; none left means success. */
  answers: Record<WriteKind, Answer[]> = { stage: [], unstage: [], restore: [] };
  /** What the next comment writes answer instead of succeeding, in order. */
  commentRefusals: Answer[] = [];
  /** While set, an index write waits for it: a slow server, for a tap made while one is out. */
  hold: Promise<void> | null = null;
  /** Called after a write that succeeded, so a test can move the file in the status. */
  onWrite: ((kind: WriteKind, body: Record<string, unknown>) => void) | null = null;
  private serial = 0;

  requests(path: string): LoggedRequest[] {
    return this.log.filter((r) => r.path === path);
  }

  fileRequests(): LoggedRequest[] {
    return this.requests('/scm/file');
  }

  private list = () => ({ rev: this.rev, comments: this.comments });

  readonly fetch = (url: string, init?: RequestInit): Promise<unknown> => {
    const u = new URL(url, 'http://palmux');
    const method = init?.method ?? 'GET';
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : undefined;
    const query = Object.fromEntries(u.searchParams.entries());
    this.log.push({ method, path: u.pathname, query, body });

    switch (u.pathname) {
      case '/scm/status': {
        const repo = query['repo'] ?? '';
        return reply(this.status[repo] ?? statusBody({}, repo));
      }
      case '/scm/file': {
        const path = query['path'] ?? '';
        const file = this.files[`${query['group']}:${path}`] ?? this.files[path];
        if (typeof file === 'function') return file();
        return file ? reply(file) : reply({ error: 'no such file' }, 404);
      }
      case '/scm/comments':
        return this.comment(method, query, body);
      case '/scm/stage':
      case '/scm/unstage':
      case '/scm/restore': {
        const kind = u.pathname.slice('/scm/'.length) as WriteKind;
        const answer = (): Promise<unknown> => {
          const next = this.answers[kind].shift();
          if (next) return reply(next.body, next.status);
          this.onWrite?.(kind, body ?? {});
          const status = kind === 'stage' ? 'staged' : kind === 'unstage' ? 'unstaged' : 'restored';
          return reply({ receiptId: `receipt-${kind}-${++this.serial}`, status });
        };
        return this.hold ? this.hold.then(answer) : answer();
      }
      default:
        return reply(null, 404);
    }
  };

  private comment(
    method: string,
    query: Record<string, string>,
    body: Record<string, unknown> | undefined,
  ): Promise<unknown> {
    if (method !== 'GET') {
      const refusal = this.commentRefusals.shift();
      if (refusal) return reply(refusal.body, refusal.status);
    }
    if (method === 'POST') {
      const comment = {
        ...(body as Omit<StoredComment, 'id' | 'createdAt' | 'updatedAt'>),
        id: `c${++this.serial}`,
        createdAt: this.serial,
        updatedAt: this.serial,
      };
      this.comments = [...this.comments, comment];
      this.rev++;
    } else if (method === 'PATCH') {
      this.comments = this.comments.map((c) =>
        c.id === query['id'] ? { ...c, ...body, updatedAt: c.updatedAt + 100 } : c,
      );
      this.rev++;
    } else if (method === 'DELETE') {
      this.comments = this.comments.filter((c) => c.id !== query['id']);
      this.rev++;
    }
    return reply(this.list());
  }
}

// ── Mounting ─────────────────────────────────────────────────────────────────

export interface Toast {
  message: string;
  action: ReviewToastAction | undefined;
}

export interface MountOptions {
  tab?: TabMeta;
  visible?: boolean;
  repos?: string[];
  /** The project the app reads; null reads none. Defaults to REPO. */
  active?: string | null;
  layout?: ScmLayoutPref;
  host?: Partial<ReviewHost>;
}

function Harness({ host, children }: { host: ReviewHost; children: ReactNode }) {
  return <ReviewHostContext.Provider value={host}>{children}</ReviewHostContext.Provider>;
}

export const tab = (url = `changes:${REPO}`, id = '7'): TabMeta => ({ id, kind: 'review', url });

export function mountReview(options: MountOptions = {}) {
  const toasts: Toast[] = [];
  const opened: string[] = [];
  const host: ReviewHost = {
    ...DEFAULT_REVIEW_HOST,
    repos: options.repos ?? [REPO],
    layout: options.layout ?? 'unified',
    notify: (message, action) => toasts.push({ message, action }),
    openFile: (path) => opened.push(path),
    ...options.host,
  };
  if (options.active !== null) {
    scmStatusStore.setActiveRepo(options.active ?? REPO);
    commentsStore.setActiveRepo(options.active ?? REPO);
  }
  const element = (visible: boolean) => (
    <Harness host={host}>
      <ReviewPane tab={options.tab ?? tab()} visible={visible} focused />
    </Harness>
  );
  const result = render(element(options.visible ?? true));
  return {
    toasts,
    opened,
    ...result,
    show: (visible: boolean) => result.rerender(element(visible)),
  };
}

/** Install the browser and the server; call from `beforeEach`, and `teardown` from `afterEach`. */
export function setup(): FakeServer {
  const server = new FakeServer();
  // The writes still inside their Undo window outlive a test, like the stores do.
  resetWriteLog();
  bodyWidth = 1400;
  FakeResizeObserver.all = [];
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: HTMLElement) {
      return { width: this.classList.contains('rv-body') ? bodyWidth : 0 } as DOMRect;
    },
  );
  vi.stubGlobal('fetch', vi.fn(server.fetch));
  return server;
}

export function teardown(): void {
  cleanup();
  scmStatusStore.setActiveRepo('');
  // Drafts belong to the store, which outlives a test: close every one a test left open.
  for (const repo of [REPO, OTHER]) {
    commentsStore.setActiveRepo(repo);
    for (const draft of commentsStore.getSnapshot().drafts) commentsStore.clearDraft(repo, draft);
  }
  commentsStore.setActiveRepo('');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
}

export const settle = async (turns = 8): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < turns; i++) {
      // oxlint-disable-next-line no-await-in-loop -- a chain of awaits needs several turns of the loop
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
};

// ── Reading the list ─────────────────────────────────────────────────────────

export const scroller = (): HTMLElement => screen.getByTestId('review-list');

export const offsetOf = (el: HTMLElement): number =>
  Number(/translateY\((-?[\d.]+)px\)/.exec(el.style.transform)?.[1]);

export const fileRow = (path: string): HTMLElement => {
  const row = screen.queryAllByTestId('review-file').find((el) => el.dataset['path'] === path);
  if (!row) throw new Error(`no header for ${path}`);
  return row;
};

export const rowByKey = (key: string): HTMLElement => {
  const row = [...scroller().querySelectorAll<HTMLElement>('[data-rv-key]')].find(
    (el) => el.dataset['rvKey'] === key,
  );
  if (!row) throw new Error(`no row ${key}`);
  return row;
};

export const scrollTo = (top: number): void => {
  act(() => {
    scroller().scrollTop = top;
    scroller().dispatchEvent(new Event('scroll'));
  });
};

/** The line number cell showing `no`, on the new side (unified), in `root` (the whole screen by default). */
export const newNumber = (
  no: number,
  root: Pick<typeof screen, 'getAllByTestId'> = screen,
): HTMLElement => {
  const cell = root.getAllByTestId('review-no-new').find((el) => el.textContent === String(no));
  if (!cell) throw new Error(`no new-side line ${no} on screen`);
  return cell;
};

export const oldNumber = (
  no: number,
  root: Pick<typeof screen, 'getAllByTestId'> = screen,
): HTMLElement => {
  const cell = root.getAllByTestId('review-no-old').find((el) => el.textContent === String(no));
  if (!cell) throw new Error(`no old-side line ${no} on screen`);
  return cell;
};
