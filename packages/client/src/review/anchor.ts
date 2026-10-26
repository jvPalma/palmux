// ── Anchoring: find a stored piece of code again in a changed file ────────────
//
// Comments (D9) and scroll position (D7) both need to answer "where is that code
// now?", and they must answer it the same way, so there is one function. It scores
// EVERY exact match of the stored lines, the old position included, and the old
// position gets no head start: a `}` or a blank line left at its old number must
// never beat the real line ten rows further down, which is what a fast path that
// accepts the old position before comparing context would do.

/** Text → lines, without the phantom empty line a trailing newline would add. */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export interface AnchorSpec {
  /** The anchored lines, exactly as they were. */
  lines: readonly string[];
  /** Up to three lines above `lines`, nearest last. */
  before: readonly string[];
  /** Up to three lines below `lines`, nearest first. */
  after: readonly string[];
  /** 1-based number of the first anchored line when it was stored. */
  start: number;
}

export type AnchorResult =
  | { outdated: false; start: number; end: number; score: number }
  | { outdated: true };

const OUTDATED: AnchorResult = { outdated: true };

function matchesAt(current: readonly string[], index: number, lines: readonly string[]): boolean {
  for (let k = 0; k < lines.length; k++) {
    if (current[index + k] !== lines[k]) return false;
  }
  return true;
}

/** How many stored context lines sit, equal, at the same offsets around `index`. */
function contextScore(current: readonly string[], index: number, spec: AnchorSpec): number {
  let score = 0;
  const firstBefore = index - spec.before.length;
  for (let j = 0; j < spec.before.length; j++) {
    if (current[firstBefore + j] === spec.before[j]) score++;
  }
  const firstAfter = index + spec.lines.length;
  for (let j = 0; j < spec.after.length; j++) {
    if (current[firstAfter + j] === spec.after[j]) score++;
  }
  return score;
}

/**
 * Where `spec` sits in `current` now, or `outdated`.
 *
 * Candidates are ranked by agreeing context lines, then by distance from the old
 * start. A tie for best is outdated rather than a guess: attaching a comment to
 * the wrong duplicate is worse than listing it as outdated.
 */
export function anchorLines(current: readonly string[], spec: AnchorSpec): AnchorResult {
  const count = spec.lines.length;
  const first = spec.lines[0];
  if (count === 0 || first === undefined) return OUTDATED;

  let best: { index: number; score: number; distance: number } | undefined;
  let tied = false;
  for (let index = 0; index + count <= current.length; index++) {
    if (current[index] !== first || !matchesAt(current, index, spec.lines)) continue;
    const score = contextScore(current, index, spec);
    const distance = Math.abs(index + 1 - spec.start);
    if (!best || score > best.score || (score === best.score && distance < best.distance)) {
      best = { index, score, distance };
      tied = false;
    } else if (score === best.score && distance === best.distance) {
      tied = true;
    }
  }
  if (!best || tied) return OUTDATED;
  return { outdated: false, start: best.index + 1, end: best.index + count, score: best.score };
}

export const DEFAULT_CONTEXT = 3;

/** One line with the context a stored anchor carries. `line` is 1-based. */
export function specAt(
  lines: readonly string[],
  line: number,
  context = DEFAULT_CONTEXT,
): AnchorSpec | null {
  const text = lines[line - 1];
  if (text === undefined) return null;
  return {
    lines: [text],
    before: lines.slice(Math.max(0, line - 1 - context), line - 1),
    after: lines.slice(line, line + context),
    start: line,
  };
}

/** How far from a vanished line the search for a surviving neighbour goes when no hunk bounds it. */
const FALLBACK_REACH = 50;

type Lines = string | readonly string[];

const toLines = (text: Lines): readonly string[] =>
  typeof text === 'string' ? splitLines(text) : text;

export interface RelocateOptions {
  /** Context lines either side that must agree; three, like a stored comment. */
  context?: number;
  /** Bounds, in old-side line numbers (1-based, inclusive), of the neighbour search: the hunk. */
  within?: { from: number; to: number };
}

export interface Relocated {
  /** 1-based line in the new text. */
  line: number;
  /** False when the line itself is gone and a surviving neighbour stands in for it. */
  exact: boolean;
}

/**
 * Where the old text's `line` is in the new text, for scroll anchoring.
 *
 * Same scoring as a comment. A deleted line falls back to the nearest surviving
 * line, searched outward within `within` (its hunk); null means nothing survived
 * and the caller falls back to the file header.
 */
export function relocateLine(
  oldText: Lines,
  newText: Lines,
  line: number,
  options: RelocateOptions = {},
): Relocated | null {
  const oldLines = toLines(oldText);
  const newLines = toLines(newText);
  if (line < 1 || line > oldLines.length) return null;

  const context = options.context ?? DEFAULT_CONTEXT;
  const find = (candidate: number): number | null => {
    const spec = specAt(oldLines, candidate, context);
    if (!spec) return null;
    const result = anchorLines(newLines, spec);
    return result.outdated ? null : result.start;
  };

  const own = find(line);
  if (own !== null) return { line: own, exact: true };

  const low = Math.max(1, options.within?.from ?? 1);
  const high = Math.min(oldLines.length, options.within?.to ?? oldLines.length);
  const reach = options.within ? Number.POSITIVE_INFINITY : FALLBACK_REACH;
  for (let distance = 1; distance <= reach; distance++) {
    const above = line - distance;
    const below = line + distance;
    if (above < low && below > high) break;
    for (const candidate of [above, below]) {
      if (candidate < low || candidate > high) continue;
      const found = find(candidate);
      if (found !== null) return { line: found, exact: false };
    }
  }
  return null;
}
