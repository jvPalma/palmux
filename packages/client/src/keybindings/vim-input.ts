// ── Vim input mode for app text inputs ────────────────────────────────────────
//
// A pure reducer giving palmux's OWN inputs (the command palette) modal editing,
// independent of anything running in the PTY. It never touches the DOM: the caller
// feeds it `KeyboardEvent.key` and renders `state.text`/`state.caret` back onto the
// input, and `handled` says whether to preventDefault.
//
// Single-line only, so there are no line motions: `dd`/`yy`/`cc` operate on the
// whole (one) line. Operator ranges follow vim:
//   dw → [caret, next-word-start)   exclusive; at the last word it runs to EOL
//   db → [prev-word-start, caret)   exclusive of the char under the caret
//   de → [caret, word-end]          inclusive of the endpoint
//   d0 → [0, caret)   d$ → [caret, EOL]   dh → one char left   dl → one char
// Two deliberate simplifications vs real vim: `cw` uses the same range as `dw`
// (vim secretly rewrites it to `ce`), and `y` never moves the caret.

export type VimMode = 'insert' | 'normal';

export interface VimState {
  mode: VimMode;
  text: string;
  caret: number;
  register: string;
  /** Partial operator awaiting a motion, e.g. 'd'. Empty when idle. */
  pending: string;
}

export interface VimKeyResult {
  state: VimState;
  handled: boolean;
}

export function initialVimState(text = ''): VimState {
  return { mode: 'insert', text, caret: text.length, register: '', pending: '' };
}

type CharClass = 'space' | 'word' | 'punct';

const classOf = (c: string): CharClass =>
  /\s/.test(c) ? 'space' : /[A-Za-z0-9_]/.test(c) ? 'word' : 'punct';

/** Last valid caret cell in normal mode (0 for empty text). */
const lastCell = (text: string): number => Math.max(0, text.length - 1);

/** `w` target, UNCLAMPED — returns text.length when no word follows (so `dw` reaches EOL). */
function wordForward(text: string, from: number): number {
  const len = text.length;
  let i = from;
  if (i >= len) return len;
  const start = classOf(text[i]!);
  if (start !== 'space') {
    while (i < len && classOf(text[i]!) === start) i++;
  }
  while (i < len && classOf(text[i]!) === 'space') i++;
  return i;
}

function wordBack(text: string, from: number): number {
  let i = Math.min(from, text.length) - 1;
  while (i >= 0 && classOf(text[i]!) === 'space') i--;
  if (i < 0) return 0;
  const cls = classOf(text[i]!);
  while (i > 0 && classOf(text[i - 1]!) === cls) i--;
  return i;
}

function wordEnd(text: string, from: number): number {
  const len = text.length;
  let i = from + 1;
  while (i < len && classOf(text[i]!) === 'space') i++;
  if (i >= len) return lastCell(text);
  const cls = classOf(text[i]!);
  while (i + 1 < len && classOf(text[i + 1]!) === cls) i++;
  return i;
}

/** Caret destination for a bare motion key, or null if `key` is not a motion. */
function motionTarget(text: string, caret: number, key: string): number | null {
  switch (key) {
    case 'h':
      return Math.max(0, caret - 1);
    case 'l':
      return Math.min(caret + 1, lastCell(text));
    case '0':
      return 0;
    case '$':
      return lastCell(text);
    case 'w':
      return Math.min(wordForward(text, caret), lastCell(text));
    case 'b':
      return wordBack(text, caret);
    case 'e':
      return wordEnd(text, caret);
    default:
      return null;
  }
}

/** Half-open [start, end) span an operator covers for `key`, or null if not a motion. */
function opRange(text: string, caret: number, key: string): { start: number; end: number } | null {
  const len = text.length;
  switch (key) {
    case 'h':
      return { start: Math.max(0, caret - 1), end: caret };
    case 'l':
      return { start: caret, end: Math.min(caret + 1, len) };
    case '0':
      return { start: 0, end: caret };
    case '$':
      return { start: caret, end: len };
    case 'w':
      return { start: caret, end: wordForward(text, caret) };
    case 'b':
      return { start: wordBack(text, caret), end: caret };
    case 'e':
      return { start: caret, end: wordEnd(text, caret) + 1 };
    default:
      return null;
  }
}

/** Copies unconditionally so a swallowed key can never alias (let alone mutate) the input. */
const swallow = (state: VimState): VimKeyResult => ({ state: { ...state }, handled: true });

function applyOperator(state: VimState, op: string, key: string): VimKeyResult {
  const { text, caret } = state;

  // Doubled operator (dd/yy/cc): the whole single line.
  if (key === op) {
    if (op === 'y') return swallow({ ...state, register: text, pending: '' });
    return swallow({
      ...state,
      mode: op === 'c' ? 'insert' : 'normal',
      text: '',
      caret: 0,
      register: text,
      pending: '',
    });
  }

  const range = opRange(text, caret, key);
  if (!range || range.start >= range.end) return swallow({ ...state, pending: '' });

  const cut = text.slice(range.start, range.end);
  if (op === 'y') return swallow({ ...state, register: cut, pending: '' });

  const next = text.slice(0, range.start) + text.slice(range.end);
  return swallow({
    ...state,
    mode: op === 'c' ? 'insert' : 'normal',
    text: next,
    // `c` leaves the caret in the hole it made; `d` must stay on a real cell.
    caret: op === 'c' ? range.start : Math.min(range.start, lastCell(next)),
    register: cut,
    pending: '',
  });
}

function paste(state: VimState, before: boolean): VimKeyResult {
  const { text, register, caret } = state;
  if (!register) return swallow(state);
  const at = before ? caret : Math.min(caret + 1, text.length);
  return swallow({
    ...state,
    text: text.slice(0, at) + register + text.slice(at),
    caret: at + register.length - 1,
    pending: '',
  });
}

function normalKey(state: VimState, key: string): VimKeyResult {
  const { text, caret } = state;

  switch (key) {
    case 'i':
      return swallow({ ...state, mode: 'insert' });
    case 'a':
      return swallow({ ...state, mode: 'insert', caret: Math.min(caret + 1, text.length) });
    case 'I':
      return swallow({ ...state, mode: 'insert', caret: 0 });
    case 'A':
      return swallow({ ...state, mode: 'insert', caret: text.length });
    case 'x': {
      if (!text) return swallow(state);
      const next = text.slice(0, caret) + text.slice(caret + 1);
      return swallow({
        ...state,
        text: next,
        caret: Math.min(caret, lastCell(next)),
        register: text.slice(caret, caret + 1),
      });
    }
    case 'd':
    case 'y':
    case 'c':
      return swallow({ ...state, pending: key });
    case 'p':
      return paste(state, false);
    case 'P':
      return paste(state, true);
    default: {
      const target = motionTarget(text, caret, key);
      if (target === null) return swallow(state); // unknown printable — never typed through
      return swallow({ ...state, caret: target });
    }
  }
}

/** `key` is a KeyboardEvent.key value. */
export function vimKey(state: VimState, key: string): VimKeyResult {
  if (state.mode === 'insert') {
    if (key !== 'Escape') return { state, handled: false };
    return swallow({ ...state, mode: 'normal', caret: Math.max(0, state.caret - 1) });
  }

  if (key === 'Escape') return swallow(state.pending ? { ...state, pending: '' } : state);

  // Named keys (Enter, ArrowDown, Tab…) belong to the host widget's own navigation.
  if (key.length !== 1) return { state, handled: false };

  return state.pending ? applyOperator(state, state.pending, key) : normalKey(state, key);
}
