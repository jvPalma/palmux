// ── Syntax colour for a review: each side's whole file, off the critical path ──
//
// Lines render plain first and swap to coloured HTML when this has it, so colour
// never changes a row's height. Colouring uses the WHOLE side, not the hunk, which
// is what makes a line inside a block comment that starts above the hunk a comment.
//
// Monaco is a lazy chunk a terminal-only session must never download, so nothing
// here imports it at module load: the loader is reached through a dynamic import,
// and only when a side actually has a grammar to colour with. A file with no
// grammar, an empty side and a side over the line cap never load it at all.

import type { ScmFileSnapshot } from '@palmux/shared';
import { languageOf } from '../panes/editor-language';
import { splitLines } from './anchor';
import type { DiffSide } from './rows';

/** Above this a side stays plain; the 1 MB snapshot limit is already behind it. */
export const MAX_COLORIZED_LINES = 20_000;

const DEFAULT_MAX_ENTRIES = 200;
/** Colouring is background work, but it must not starve behind a scroll that never idles. */
const IDLE_TIMEOUT_MS = 1000;

export interface ColorizerOptions {
  /** A file's sides were coloured; the pane re-renders its lines. Not called when everything stayed plain. */
  onColored: (path: string, version: string) => void;
  /** Colouring failed; the file stays plain. */
  onError?: (error: unknown) => void;
  /** Run `task` when the main thread has room. Defaults to `requestIdleCallback`, else `setTimeout`. */
  schedule?: (task: () => void) => void;
  /** Coloured sides kept; two per file. */
  maxEntries?: number;
}

interface Job {
  path: string;
  version: string;
  /** `fileKey(path, version)`: what `pending` and `forget` name the job by. */
  key: string;
  language: string;
  sides: { side: DiffSide; text: string }[];
  epoch: number;
}

function defaultSchedule(task: () => void): void {
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(task, { timeout: IDLE_TIMEOUT_MS });
  } else {
    setTimeout(task, 0);
  }
}

/** Monaco's `colorize` ends every line with `<br/>`, the last one included. */
function lineHtml(html: string, expected: number): string[] | null {
  const parts = html.split('<br/>');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts.length === expected ? parts : null;
}

async function colorizeFn(): Promise<(text: string, language: string) => Promise<string>> {
  const { getMonaco } = await import('../panes/monaco-loader');
  const monaco = getMonaco();
  return (text, language) => monaco.editor.colorize(text, language, {});
}

export class Colorizer {
  private readonly options: ColorizerOptions;
  private readonly schedule: (task: () => void) => void;
  private readonly maxEntries: number;

  /**
   * `path\0version\0side` → per-line HTML, or null when the side is known to stay
   * plain. The path is part of the key because a version names a pair of blobs, not
   * a file: a copy not yet edited, or two identical new files, share one. Keyed by
   * version alone, forgetting one file erased the colours its twin was drawing, and
   * a plain-text twin's null kept a file with a grammar plain (or lent it its colours).
   */
  private readonly cache = new Map<string, readonly string[] | null>();
  private readonly jobs: Job[] = [];
  /** Files (by `fileKey`) with a job queued or running; `forget` removes one so its job's result is discarded. */
  private readonly pending = new Set<string>();
  private running = false;
  /** Bumped by `clear`: a job that started under an older epoch drops its results. */
  private epoch = 0;

  constructor(options: ColorizerOptions) {
    this.options = options;
    this.schedule = options.schedule ?? defaultSchedule;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  /** Per-line HTML for a side of a file's version, or undefined while it is not coloured (render plain). */
  get(path: string, version: string, side: DiffSide): readonly string[] | undefined {
    return this.cache.get(cacheKey(path, version, side)) ?? undefined;
  }

  /** Colour a snapshot's sides in the background. A version of a file already coloured, plain or queued is a no-op. */
  request(snapshot: ScmFileSnapshot): void {
    const { path, version } = snapshot;
    const sides: Job['sides'] = [];
    for (const side of ['old', 'new'] as const) {
      const key = cacheKey(path, version, side);
      if (this.cache.has(key)) {
        this.touch(key);
      } else {
        sides.push({ side, text: snapshot[side].text });
      }
    }
    const file = fileKey(path, version);
    if (sides.length === 0 || this.pending.has(file)) return;

    const language = languageOf(path);
    if (language === 'plaintext') {
      for (const { side } of sides) this.store(cacheKey(path, version, side), null);
      return;
    }
    this.pending.add(file);
    this.jobs.push({ path, version, key: file, language, sides, epoch: this.epoch });
    this.pump();
  }

  /** The file's version is gone (superseded or evicted): drop its colours and its queued job. */
  forget(path: string, version: string): void {
    this.cache.delete(cacheKey(path, version, 'old'));
    this.cache.delete(cacheKey(path, version, 'new'));
    const key = fileKey(path, version);
    this.pending.delete(key);
    const queued = this.jobs.findIndex((job) => job.key === key);
    if (queued >= 0) this.jobs.splice(queued, 1);
  }

  /** Theme change: every colour is stale. The pane requests its loaded files again. */
  clear(): void {
    this.epoch++;
    this.cache.clear();
    this.jobs.length = 0;
    this.pending.clear();
  }

  private pump(): void {
    if (this.running) return;
    const job = this.jobs.shift();
    if (!job) return;
    this.running = true;
    this.schedule(() => {
      void this.run(job).finally(() => {
        this.running = false;
        this.pump();
      });
    });
  }

  private alive(job: Job): boolean {
    return job.epoch === this.epoch && this.pending.has(job.key);
  }

  private async run(job: Job): Promise<void> {
    // Forgotten or cleared between being scheduled and getting its turn.
    if (!this.alive(job)) return;

    const work: { side: DiffSide; lines: string[] }[] = [];
    for (const { side, text } of job.sides) {
      const lines = splitLines(text);
      if (lines.length === 0 || lines.length > MAX_COLORIZED_LINES) {
        if (this.alive(job)) this.store(cacheKey(job.path, job.version, side), null);
      } else {
        work.push({ side, lines });
      }
    }

    let colored = false;
    if (work.length > 0) {
      try {
        const colorize = await colorizeFn();
        for (const { side, lines } of work) {
          // The sides are coloured one after the other on purpose: both at once would
          // be one long task on the main thread instead of two short ones.
          // oxlint-disable-next-line no-await-in-loop
          const html = await colorize(lines.map(stripCarriageReturn).join('\n'), job.language);
          if (!this.alive(job)) return;
          const perLine = lineHtml(html, lines.length);
          this.store(cacheKey(job.path, job.version, side), perLine);
          colored ||= perLine !== null;
        }
      } catch (error) {
        if (!this.alive(job)) return;
        for (const { side } of work) {
          const key = cacheKey(job.path, job.version, side);
          if (!this.cache.has(key)) this.store(key, null);
        }
        this.options.onError?.(error);
      }
    }

    if (!this.alive(job)) return;
    this.pending.delete(job.key);
    if (colored) this.options.onColored(job.path, job.version);
  }

  private touch(key: string): void {
    const value = this.cache.get(key);
    if (value === undefined) return;
    this.cache.delete(key);
    this.cache.set(key, value);
  }

  private store(key: string, lines: readonly string[] | null): void {
    this.cache.delete(key);
    this.cache.set(key, lines);
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}

// A git path never holds a NUL, so it cannot run into the version.
const fileKey = (path: string, version: string): string => `${path}\0${version}`;
const cacheKey = (path: string, version: string, side: DiffSide): string =>
  `${fileKey(path, version)}\0${side}`;

// Monaco splits on a lone CR as well as on CRLF, so a CR left in a line would add a
// line to its output and shift every colour below it.
const stripCarriageReturn = (line: string): string => line.replace(/\r/g, '');
