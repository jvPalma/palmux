import { describe, it, expect } from 'vitest';
import { initialVimState, vimKey, type VimState } from './vim-input';

const normal = (text: string, caret: number): VimState => ({
  mode: 'normal',
  text,
  caret,
  register: '',
  pending: '',
});

/** Feed a whole key sequence, returning the final state. */
const feed = (state: VimState, ...keys: string[]): VimState =>
  keys.reduce((s, k) => vimKey(s, k).state, state);

const LINE = 'foo bar baz'; // f0 o1 o2 _3 b4 a5 r6 _7 b8 a9 z10

describe('initialVimState', () => {
  it('starts in insert mode with the caret at the end', () => {
    expect(initialVimState('abc')).toEqual({
      mode: 'insert',
      text: 'abc',
      caret: 3,
      register: '',
      pending: '',
    });
    expect(initialVimState().text).toBe('');
  });
});

describe('insert mode', () => {
  it('leaves every non-Escape key to the input', () => {
    const s = initialVimState('abc');
    for (const key of ['a', 'Z', '0', 'Enter', 'Backspace', 'ArrowLeft']) {
      const r = vimKey(s, key);
      expect(r.handled).toBe(false);
      expect(r.state).toBe(s);
    }
  });

  it('Escape enters normal mode and steps the caret back', () => {
    const r = vimKey(initialVimState('abc'), 'Escape');
    expect(r.handled).toBe(true);
    expect(r.state.mode).toBe('normal');
    expect(r.state.caret).toBe(2);
  });

  it('Escape clamps the caret at 0', () => {
    expect(vimKey({ ...initialVimState('abc'), caret: 0 }, 'Escape').state.caret).toBe(0);
  });
});

describe('normal mode key gating', () => {
  it('swallows every bare printable so it is never typed into the input', () => {
    const s = normal(LINE, 5);
    for (let c = 97; c <= 122; c++) {
      const key = String.fromCharCode(c);
      expect(vimKey(s, key).handled).toBe(true);
    }
    expect(vimKey(s, 'Escape').handled).toBe(true);
    expect(vimKey(s, 'ç').handled).toBe(true);
  });

  it('lets named keys through so palette navigation keeps working', () => {
    const s = normal(LINE, 5);
    for (const key of ['ArrowDown', 'ArrowLeft', 'Enter', 'Tab', 'Home', 'Backspace']) {
      const r = vimKey(s, key);
      expect(r.handled).toBe(false);
      expect(r.state).toBe(s);
    }
  });

  it('unrecognised printables leave the state alone', () => {
    const r = vimKey(normal(LINE, 5), 'q');
    expect(r.handled).toBe(true);
    expect(r.state).toEqual(normal(LINE, 5));
  });
});

describe('mode switches', () => {
  it('i / a / I / A', () => {
    expect(vimKey(normal('foo', 1), 'i').state).toMatchObject({ mode: 'insert', caret: 1 });
    expect(vimKey(normal('foo', 1), 'a').state).toMatchObject({ mode: 'insert', caret: 2 });
    expect(vimKey(normal('foo', 1), 'I').state).toMatchObject({ mode: 'insert', caret: 0 });
    expect(vimKey(normal('foo', 1), 'A').state).toMatchObject({ mode: 'insert', caret: 3 });
  });

  it('a clamps past the end of the text', () => {
    expect(vimKey(normal('foo', 2), 'a').state.caret).toBe(3);
    expect(vimKey(normal('', 0), 'a').state.caret).toBe(0);
  });
});

describe('motions', () => {
  const caretAfter = (text: string, caret: number, key: string): number =>
    vimKey(normal(text, caret), key).state.caret;

  it('h / l / 0 / $ from mid-line', () => {
    expect(caretAfter(LINE, 5, 'h')).toBe(4);
    expect(caretAfter(LINE, 5, 'l')).toBe(6);
    expect(caretAfter(LINE, 5, '0')).toBe(0);
    expect(caretAfter(LINE, 5, '$')).toBe(10);
  });

  it('h / l clamp at the edges', () => {
    expect(caretAfter(LINE, 0, 'h')).toBe(0);
    expect(caretAfter(LINE, 10, 'l')).toBe(10);
  });

  it('w moves to the next word start and stops on the last cell', () => {
    expect(caretAfter(LINE, 0, 'w')).toBe(4);
    expect(caretAfter(LINE, 5, 'w')).toBe(8);
    expect(caretAfter(LINE, 8, 'w')).toBe(10);
  });

  it('b moves to the previous word start', () => {
    expect(caretAfter(LINE, 8, 'b')).toBe(4);
    expect(caretAfter(LINE, 5, 'b')).toBe(4);
    expect(caretAfter(LINE, 4, 'b')).toBe(0);
    expect(caretAfter(LINE, 0, 'b')).toBe(0);
  });

  it('e moves to the end of the current or next word', () => {
    expect(caretAfter(LINE, 0, 'e')).toBe(2);
    expect(caretAfter(LINE, 2, 'e')).toBe(6);
    expect(caretAfter(LINE, 4, 'e')).toBe(6);
    expect(caretAfter(LINE, 10, 'e')).toBe(10);
  });

  it('treats punctuation runs as their own words', () => {
    expect(caretAfter('a.b', 0, 'w')).toBe(1);
    expect(caretAfter('a.b', 1, 'w')).toBe(2);
    expect(caretAfter('a..b', 0, 'e')).toBe(2);
    expect(caretAfter('a.b', 2, 'b')).toBe(1);
  });

  it('every motion is a no-op on empty text', () => {
    for (const key of ['h', 'l', '0', '$', 'w', 'b', 'e']) {
      expect(caretAfter('', 0, key)).toBe(0);
    }
  });
});

describe('x', () => {
  it('deletes the char under the caret into the register', () => {
    const r = vimKey(normal('abc', 1), 'x');
    expect(r.state).toMatchObject({ text: 'ac', caret: 1, register: 'b' });
  });

  it('clamps the caret when deleting the last char', () => {
    expect(vimKey(normal('abc', 2), 'x').state).toMatchObject({ text: 'ab', caret: 1 });
    expect(vimKey(normal('a', 0), 'x').state).toMatchObject({ text: '', caret: 0 });
  });

  it('is a swallowed no-op on empty text', () => {
    const r = vimKey(normal('', 0), 'x');
    expect(r.handled).toBe(true);
    expect(r.state).toEqual(normal('', 0));
  });
});

describe('operators', () => {
  it('d waits for a motion', () => {
    const r = vimKey(normal(LINE, 0), 'd');
    expect(r.handled).toBe(true);
    expect(r.state).toMatchObject({ pending: 'd', text: LINE });
  });

  it('dw deletes up to the next word start', () => {
    expect(feed(normal(LINE, 0), 'd', 'w')).toMatchObject({
      text: 'bar baz',
      caret: 0,
      register: 'foo ',
      pending: '',
      mode: 'normal',
    });
  });

  it('dw on the last word runs to the end of the line', () => {
    expect(feed(normal(LINE, 8), 'd', 'w')).toMatchObject({
      text: 'foo bar ',
      caret: 7,
      register: 'baz',
    });
  });

  it('db deletes back to the previous word start', () => {
    expect(feed(normal(LINE, 8), 'd', 'b')).toMatchObject({
      text: 'foo baz',
      caret: 4,
      register: 'bar ',
    });
  });

  it('de deletes through the end of the word', () => {
    expect(feed(normal(LINE, 4), 'd', 'e')).toMatchObject({
      text: 'foo  baz',
      caret: 4,
      register: 'bar',
    });
  });

  it('d$ deletes to the end of the line and clamps the caret', () => {
    expect(feed(normal(LINE, 4), 'd', '$')).toMatchObject({
      text: 'foo ',
      caret: 3,
      register: 'bar baz',
    });
  });

  it('d0 deletes back to the start, exclusive of the caret', () => {
    expect(feed(normal(LINE, 4), 'd', '0')).toMatchObject({
      text: 'bar baz',
      caret: 0,
      register: 'foo ',
    });
  });

  it('dh / dl delete a single char', () => {
    expect(feed(normal(LINE, 4), 'd', 'h')).toMatchObject({ text: 'foobar baz', caret: 3 });
    expect(feed(normal(LINE, 4), 'd', 'l')).toMatchObject({ text: 'foo ar baz', caret: 4 });
  });

  it('dd clears the whole line into the register', () => {
    expect(feed(normal(LINE, 5), 'd', 'd')).toMatchObject({
      text: '',
      caret: 0,
      register: LINE,
      mode: 'normal',
    });
  });

  it('yw yanks without touching the text or caret', () => {
    expect(feed(normal(LINE, 0), 'y', 'w')).toMatchObject({
      text: LINE,
      caret: 0,
      register: 'foo ',
      mode: 'normal',
    });
    expect(feed(normal(LINE, 8), 'y', 'b')).toMatchObject({ text: LINE, caret: 8 });
  });

  it('yy yanks the whole line', () => {
    expect(feed(normal(LINE, 5), 'y', 'y')).toMatchObject({
      text: LINE,
      caret: 5,
      register: LINE,
    });
  });

  it('cw deletes and enters insert mode', () => {
    expect(feed(normal('foo bar', 0), 'c', 'w')).toMatchObject({
      mode: 'insert',
      text: 'bar',
      caret: 0,
      register: 'foo ',
    });
  });

  it('cc clears the line and enters insert mode', () => {
    expect(feed(normal(LINE, 5), 'c', 'c')).toMatchObject({
      mode: 'insert',
      text: '',
      caret: 0,
      register: LINE,
    });
  });

  it('an empty range is a swallowed no-op that still clears pending', () => {
    expect(feed(normal(LINE, 0), 'd', 'h')).toMatchObject({ text: LINE, pending: '' });
    expect(feed(normal(LINE, 0), 'd', '0')).toMatchObject({ text: LINE, pending: '' });
  });

  it('Escape clears a pending operator without acting', () => {
    const r = vimKey({ ...normal(LINE, 5), pending: 'd' }, 'Escape');
    expect(r.handled).toBe(true);
    expect(r.state).toMatchObject({ pending: '', text: LINE, caret: 5, mode: 'normal' });
  });

  it('a non-motion printable cancels the operator', () => {
    expect(feed(normal(LINE, 5), 'd', 'z')).toMatchObject({ pending: '', text: LINE, caret: 5 });
  });

  it('a named key neither cancels nor is handled while pending', () => {
    const pending = { ...normal(LINE, 5), pending: 'd' };
    const r = vimKey(pending, 'ArrowDown');
    expect(r.handled).toBe(false);
    expect(r.state.pending).toBe('d');
  });
});

describe('paste', () => {
  const withReg = (text: string, caret: number, register: string): VimState => ({
    ...normal(text, caret),
    register,
  });

  it('p pastes after the caret, ending on the last pasted char', () => {
    expect(vimKey(withReg('foo', 0, 'XY'), 'p').state).toMatchObject({
      text: 'fXYoo',
      caret: 2,
    });
  });

  it('P pastes before the caret', () => {
    expect(vimKey(withReg('foo', 0, 'XY'), 'P').state).toMatchObject({
      text: 'XYfoo',
      caret: 1,
    });
  });

  it('p at the end of the line appends', () => {
    expect(vimKey(withReg('foo', 2, 'XY'), 'p').state).toMatchObject({
      text: 'fooXY',
      caret: 4,
    });
  });

  it('p on empty text lands at the start', () => {
    expect(vimKey(withReg('', 0, 'ab'), 'p').state).toMatchObject({ text: 'ab', caret: 1 });
  });

  it('yy then p duplicates the line', () => {
    expect(feed(normal('foo', 2), 'y', 'y', 'p')).toMatchObject({ text: 'foofoo', caret: 5 });
    expect(feed(normal('foo', 0), 'y', 'y', 'P')).toMatchObject({ text: 'foofoo', caret: 2 });
  });

  it('an empty register is a swallowed no-op', () => {
    const r = vimKey(normal('foo', 1), 'p');
    expect(r.handled).toBe(true);
    expect(r.state).toEqual(normal('foo', 1));
  });
});

describe('purity', () => {
  it('never mutates the incoming state and always returns a fresh object', () => {
    const before = normal(LINE, 5);
    const snapshot = { ...before };
    for (const key of ['x', 'd', 'w', 'p', 'i', 'Escape', 'q']) {
      const r = vimKey(before, key);
      expect(r.state).not.toBe(before);
      expect(before).toEqual(snapshot);
    }
  });
});
