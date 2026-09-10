// ── Link detection: OSC-8 hyperlinks + viewport regex fallback ────────────────
//
// Pure logic only — no xterm/DOM dependency. Two independent sources feed the
// same "url under this cell" question:
//   • Osc8Tracker replays the OSC 8 begin/end sequence pairs a shell/app can
//     emit (explicit hyperlinks) into absolute-buffer cell ranges.
//   • findRegexLinkInRow scans plain row text for bare http(s)/www. links when
//     no OSC 8 sequence is present (most terminal output).
// isSafeUrl/normalizeUrl gate and prepare whatever URL either source finds
// before it's handed to window.open.

/** Matches http(s), plus bare www. — used for the viewport regex pass. */
export const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;

const TRAILING_PUNCTUATION = new Set(['.', ',', ';', ':', '!', '?']);

// Sentence punctuation trailing a match is almost never part of the URL; a
// trailing ')' is ambiguous (wiki-style URLs legitimately end in one), so it's
// only trimmed when the match has no matching '(' earlier in it.
function trimTrailingPunctuation(raw: string): string {
  let end = raw.length;
  while (end > 0 && TRAILING_PUNCTUATION.has(raw[end - 1]!)) end--;
  let trimmed = raw.slice(0, end);
  if (trimmed.endsWith(')') && !trimmed.includes('(')) trimmed = trimmed.slice(0, -1);
  return trimmed;
}

/** The URL under `col` in a row of plain text, or null. */
export function findRegexLinkInRow(rowText: string, col: number): string | null {
  const re = new RegExp(URL_RE.source, URL_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(rowText))) {
    const start = m.index;
    const trimmed = trimTrailingPunctuation(m[0]!);
    const end = start + trimmed.length;
    if (col >= start && col < end) return trimmed;
  }
  return null;
}

/** Only schemes we are willing to hand to window.open. */
export function isSafeUrl(url: string): boolean {
  try {
    const scheme = new URL(url).protocol.toLowerCase();
    return scheme === 'http:' || scheme === 'https:' || scheme === 'mailto:';
  } catch {
    return false;
  }
}

/** Normalise a matched candidate for opening (adds https:// to a bare www. match). */
export function normalizeUrl(url: string): string {
  return /^www\./i.test(url) ? `https://${url}` : url;
}

/** Absolute-buffer-row link span produced by an OSC-8 sequence. */
export interface LinkRange {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  url: string;
}

export interface Osc8Tracker {
  /** OSC 8 with a URL: a link starts at this absolute cell. */
  begin(url: string, x: number, y: number): void;
  /** OSC 8 with an empty URL: the open link ends at this absolute cell. */
  end(x: number, y: number): void;
  /** The url covering an absolute cell, or null. */
  at(x: number, y: number): string | null;
  ranges(): readonly LinkRange[];
  clear(): void;
}

// Row-major ordering of absolute cells: row first, then column within the row.
function cellBefore(ax: number, ay: number, bx: number, by: number): boolean {
  return ay !== by ? ay < by : ax < bx;
}

/** Bounded ring — old ranges are evicted so long sessions can't grow without limit. */
export function createOsc8Tracker(max: number = 500): Osc8Tracker {
  let open: { url: string; x: number; y: number } | null = null;
  const list: LinkRange[] = [];

  // A begin() while a link is open (or an explicit end()) closes the open
  // link at (x, y), which becomes its exclusive end cell.
  const closeOpen = (x: number, y: number): void => {
    if (!open) return;
    list.push({ startX: open.x, startY: open.y, endX: x, endY: y, url: open.url });
    if (list.length > max) list.shift();
    open = null;
  };

  return {
    begin(url, x, y) {
      closeOpen(x, y);
      open = { url, x, y };
    },
    end(x, y) {
      closeOpen(x, y);
    },
    at(x, y) {
      for (const r of list) {
        const atOrAfterStart = !cellBefore(x, y, r.startX, r.startY);
        const beforeEnd = cellBefore(x, y, r.endX, r.endY);
        if (atOrAfterStart && beforeEnd) return r.url;
      }
      return null;
    },
    ranges() {
      return list;
    },
    clear() {
      list.length = 0;
      open = null;
    },
  };
}
