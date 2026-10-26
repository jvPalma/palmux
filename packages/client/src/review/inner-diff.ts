// ── Inner marks: which characters differ between a paired removed/added line ──
//
// Computed here, not by git (`--word-diff` is a non-goal), and only between two
// lines the rows model already paired. Both bounds below exist because this runs
// on the main thread while a phone scrolls: an unbounded LCS over a minified
// bundle line would stall a frame, and a line that long has no readable inner
// marks anyway.

/** Half-open character offsets into one line. */
export interface TextRange {
  start: number;
  end: number;
}

export interface InnerDiff {
  old: TextRange[];
  new: TextRange[];
}

export const MAX_INNER_LINE_CHARS = 400;
export const MAX_INNER_CELLS = 10_000;

// A word, a run of whitespace, or ONE punctuation character. Splitting punctuation
// per character keeps `a.b(c)` from being one opaque token that differs wholesale.
const TOKEN = /[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu;

interface Token {
  text: string;
  start: number;
  end: number;
}

function tokenize(line: string): Token[] {
  const tokens: Token[] = [];
  for (const match of line.matchAll(TOKEN)) {
    const start = match.index ?? 0;
    tokens.push({ text: match[0], start, end: start + match[0].length });
  }
  return tokens;
}

/** Which tokens of `a` and of `b` the longest common subsequence keeps. */
function commonTokens(a: readonly Token[], b: readonly Token[]): { a: boolean[]; b: boolean[] } {
  const keptA = Array.from({ length: a.length }, () => false);
  const keptB = Array.from({ length: b.length }, () => false);
  const width = b.length + 1;
  const table = new Uint16Array((a.length + 1) * width);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      table[i * width + j] =
        a[i - 1]?.text === b[j - 1]?.text
          ? (table[(i - 1) * width + (j - 1)] ?? 0) + 1
          : Math.max(table[(i - 1) * width + j] ?? 0, table[i * width + (j - 1)] ?? 0);
    }
  }
  let i = a.length;
  let j = b.length;
  while (i > 0 && j > 0) {
    if (a[i - 1]?.text === b[j - 1]?.text) {
      keptA[i - 1] = true;
      keptB[j - 1] = true;
      i--;
      j--;
    } else if ((table[(i - 1) * width + j] ?? 0) >= (table[i * width + (j - 1)] ?? 0)) {
      i--;
    } else {
      j--;
    }
  }
  return { a: keptA, b: keptB };
}

/**
 * Ranges of the changed tokens. Two changed tokens with only whitespace between
 * them form one range, so `foo bar` → `baz qux` marks a phrase and not two words
 * with an unmarked space between.
 */
function changedRanges(
  line: string,
  tokens: readonly Token[],
  kept: readonly boolean[],
): TextRange[] {
  const ranges: TextRange[] = [];
  tokens.forEach((token, index) => {
    if (kept[index]) return;
    const last = ranges[ranges.length - 1];
    if (last && line.slice(last.end, token.start).trim() === '') {
      last.end = token.end;
    } else {
      ranges.push({ start: token.start, end: token.end });
    }
  });
  return ranges;
}

/**
 * The changed ranges on each side of a paired line, or null when either line is
 * too long or the comparison too big to do cheaply (the pane then draws the line
 * without inner marks).
 */
export function innerDiff(oldLine: string, newLine: string): InnerDiff | null {
  if (oldLine.length >= MAX_INNER_LINE_CHARS || newLine.length >= MAX_INNER_LINE_CHARS) {
    return null;
  }
  if (oldLine === newLine) return { old: [], new: [] };

  const oldTokens = tokenize(oldLine);
  const newTokens = tokenize(newLine);

  // Trim what both lines share at either end first. A one-word edit in a long line
  // then costs a one-cell table, and the cell bound applies to the work left.
  let head = 0;
  while (
    head < oldTokens.length &&
    head < newTokens.length &&
    oldTokens[head]?.text === newTokens[head]?.text
  ) {
    head++;
  }
  let tail = 0;
  while (
    tail < oldTokens.length - head &&
    tail < newTokens.length - head &&
    oldTokens[oldTokens.length - 1 - tail]?.text === newTokens[newTokens.length - 1 - tail]?.text
  ) {
    tail++;
  }

  const oldMiddle = oldTokens.slice(head, oldTokens.length - tail);
  const newMiddle = newTokens.slice(head, newTokens.length - tail);
  if (oldMiddle.length * newMiddle.length > MAX_INNER_CELLS) return null;

  const common = commonTokens(oldMiddle, newMiddle);
  const keptOld = oldTokens.map((_, index) =>
    index < head || index >= oldTokens.length - tail ? true : (common.a[index - head] ?? false),
  );
  const keptNew = newTokens.map((_, index) =>
    index < head || index >= newTokens.length - tail ? true : (common.b[index - head] ?? false),
  );
  return {
    old: changedRanges(oldLine, oldTokens, keptOld),
    new: changedRanges(newLine, newTokens, keptNew),
  };
}
