import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createNativeSelectionLayer,
  lineGroups,
  visibleRows,
  type TerminalLike,
  type TextLayerGeometry,
} from './native-selection';

const GEOM: TextLayerGeometry = { rows: 3, cols: 80, cellWidth: 8, cellHeight: 16 };

/** A row prefixed with '>' is a WRAPPED continuation of the row above it. */
const makeTerm = (initial: string[], viewportY = 0) => {
  let lines = initial;
  const term: TerminalLike = {
    get rows() {
      return lines.length - viewportY;
    },
    cols: 80,
    buffer: {
      active: {
        viewportY,
        getLine: (y: number) => {
          const entry = lines[y];
          if (entry === undefined) return undefined;
          const isWrapped = entry.startsWith('>');
          const raw = isWrapped ? entry.slice(1) : entry;
          return {
            isWrapped,
            translateToString: (trim?: boolean) => (trim ? raw.replace(/\s+$/, '') : raw),
          };
        },
      },
    },
  };
  return { term, setLines: (next: string[]) => (lines = next) };
};

const rowEls = (host: HTMLElement) => Array.from(host.querySelectorAll('.native-sel-row'));
const layerEl = (host: HTMLElement) => host.querySelector<HTMLElement>('[data-native-sel]');

describe('visibleRows', () => {
  it('reads the viewport rows and trims trailing blanks', () => {
    const { term } = makeTerm(['top line', 'alpha   ', 'beta  ', 'gamma'], 1);
    expect(visibleRows(term)).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('yields empty strings for rows past the end of the buffer', () => {
    const { term } = makeTerm(['only'], 0);
    const short: TerminalLike = { ...term, rows: 3 };
    expect(visibleRows(short)).toEqual(['only', '', '']);
  });
});

describe('lineGroups', () => {
  it('keeps unwrapped rows as one group each', () => {
    const { term } = makeTerm(['alpha', 'beta']);
    expect(lineGroups(term, 80)).toEqual([
      { row: 0, span: 1, text: 'alpha' },
      { row: 1, span: 1, text: 'beta' },
    ]);
  });

  it('joins a wrapped line into ONE group with no newline at the wrap', () => {
    // This is the whole point: whatever the OS copies must paste back into a
    // shell as a single command, not as two lines that run early.
    const { term } = makeTerm(['git commit -', '>-amend']);
    const groups = lineGroups(term, 12);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.span).toBe(2);
    expect(groups[0]!.text).not.toContain('\n');
    // The interior row is already full-width, so the wrap point is untouched and
    // the flag survives the wrap intact.
    expect(groups[0]!.text).toBe('git commit --amend');
  });

  it('trims only the LAST row of a wrapped group', () => {
    const { term } = makeTerm(['abc', '>de   ']);
    expect(lineGroups(term, 5)[0]!.text).toBe('abc  de');
  });
});

describe('createNativeSelectionLayer', () => {
  let host: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is disabled by default and completely inert', () => {
    const { term } = makeTerm(['a', 'b', 'c']);
    const layer = createNativeSelectionLayer(term, host, () => GEOM);

    expect(layer.isEnabled()).toBe(false);
    const el = layerEl(host);
    // Either absent from the DOM, or present but unable to receive a touch.
    if (el) {
      expect(el.style.pointerEvents).toBe('none');
      expect(el.style.display).toBe('none');
    } else {
      expect(el).toBeNull();
    }
    layer.update(); // a no-op while disabled
    expect(rowEls(host)).toHaveLength(0);
  });

  it('renders one positioned row element per visible row once enabled', () => {
    const { term } = makeTerm(['alpha', 'beta', 'gamma']);
    const layer = createNativeSelectionLayer(term, host, () => GEOM);

    layer.setEnabled(true);

    expect(layer.isEnabled()).toBe(true);
    const els = rowEls(host) as HTMLElement[];
    // Every line but the last carries its own '\n': absolutely-positioned rows
    // serialise with NO break between them, so the copy would run them together.
    expect(els.map((el) => el.textContent)).toEqual(['alpha\n', 'beta\n', 'gamma']);
    expect(els.map((el) => el.style.top)).toEqual(['0px', '16px', '32px']);
    // The text must be invisible but still selectable.
    expect(layerEl(host)?.style.color).toBe('transparent');
    expect(layerEl(host)?.style.display).not.toBe('none');
  });

  it('rewrites changed text without replacing the row elements', () => {
    const { term, setLines } = makeTerm(['alpha', 'beta', 'gamma']);
    const layer = createNativeSelectionLayer(term, host, () => GEOM);
    layer.setEnabled(true);
    const before = rowEls(host);

    setLines(['alpha', 'BETA', 'gamma']);
    layer.update();

    const after = rowEls(host);
    expect(after).toHaveLength(3);
    after.forEach((el, i) => expect(el).toBe(before[i]));
    expect(after.map((el) => el.textContent)).toEqual(['alpha\n', 'BETA\n', 'gamma']);
  });

  it('adjusts the element count when the row count changes', () => {
    const { term, setLines } = makeTerm(['alpha', 'beta', 'gamma']);
    const layer = createNativeSelectionLayer(term, host, () => GEOM);
    layer.setEnabled(true);

    setLines(['alpha', 'beta']);
    layer.update();
    expect(rowEls(host)).toHaveLength(2);

    setLines(['alpha', 'beta', 'gamma', 'delta']);
    layer.update();
    expect(rowEls(host).map((el) => el.textContent)).toEqual([
      'alpha\n',
      'beta\n',
      'gamma\n',
      'delta',
    ]);
  });

  it('breaks between logical lines but NEVER inside a wrapped one', () => {
    const { term } = makeTerm(['git commit', '> --amend', 'done']);
    const layer = createNativeSelectionLayer(term, host, () => GEOM);
    layer.setEnabled(true);

    // The wrapped pair is one element ending in ONE '\n'; a soft wrap adds none,
    // so pasting the command back into a shell can't execute it early.
    const els = rowEls(host);
    expect(els).toHaveLength(2);
    expect(els[0]!.textContent!.match(/\n/g)).toHaveLength(1);
    expect(els[0]!.textContent!.endsWith('\n')).toBe(true);
    expect(els[1]!.textContent).toBe('done');
  });

  it('detaches the layer again when disabled', () => {
    const { term } = makeTerm(['alpha']);
    const layer = createNativeSelectionLayer(term, host, () => GEOM);

    layer.setEnabled(true);
    layer.setEnabled(false);

    expect(layer.isEnabled()).toBe(false);
    expect(layerEl(host)).toBeNull();
  });

  it('destroy() removes everything and is safe to call twice', () => {
    const { term } = makeTerm(['alpha', 'beta']);
    const layer = createNativeSelectionLayer(term, host, () => GEOM);
    layer.setEnabled(true);

    layer.destroy();
    layer.destroy();

    expect(layerEl(host)).toBeNull();
    expect(rowEls(host)).toHaveLength(0);
    expect(layer.isEnabled()).toBe(false);
  });

  it('renders a wrapped line as ONE element tall enough for its rows', () => {
    const { term } = makeTerm(['git commit', '> --amend', 'done']);
    const layer = createNativeSelectionLayer(term, host, () => GEOM);
    layer.setEnabled(true);

    const els = rowEls(host) as HTMLElement[];
    expect(els).toHaveLength(2);
    expect(els[0]!.style.height).toBe('32px'); // two rows
    expect(els[0]!.style.whiteSpace).toBe('pre-wrap');
    expect(els[0]!.style.wordBreak).toBe('break-all');
    expect(els[1]!.style.top).toBe('32px');
    expect(els[1]!.style.whiteSpace).toBe('pre'); // unwrapped: never re-wraps
  });

  /** Pretend the user is holding a selection anchored inside the layer. */
  const holdSelection = (removeAllRanges = () => {}) => {
    const inside = layerEl(host)!.firstChild!;
    vi.spyOn(window, 'getSelection').mockReturnValue({
      rangeCount: 1,
      isCollapsed: false,
      anchorNode: inside,
      focusNode: inside,
      toString: () => 'alpha',
      removeAllRanges,
    } as unknown as Selection);
  };

  it('freezes while a selection is live so printing output cannot collapse it', () => {
    const { term, setLines } = makeTerm(['alpha', 'beta']);
    const layer = createNativeSelectionLayer(term, host, () => GEOM);
    layer.setEnabled(true);
    holdSelection();

    setLines(['CHANGED', 'beta']);
    layer.update();
    layer.update();

    expect((rowEls(host)[0] as HTMLElement).textContent).toBe('alpha\n');
    expect(layer.selectedText()).toBe('alpha');
  });

  it('never drops the selection when the grid resizes under it', () => {
    // The soft keyboard closing is what fires this: starting a selection blurs
    // the keyboard textarea, the IME leaves, the terminal re-fits. Dropping the
    // selection here made it vanish the instant the user began selecting.
    const { term } = makeTerm(['alpha', 'beta']);
    let geom = { ...GEOM };
    const layer = createNativeSelectionLayer(term, host, () => geom);
    layer.setEnabled(true);
    const removeAllRanges = vi.fn();
    holdSelection(removeAllRanges);

    geom = { ...GEOM, rows: 2, cellHeight: 20, top: 13 };
    layer.update();

    expect(removeAllRanges).not.toHaveBeenCalled();
    expect(layer.selectedText()).toBe('alpha');
    // Geometry still follows — moving an element keeps its text node intact.
    expect(layerEl(host)!.style.height).toBe('40px');
    expect(layerEl(host)!.style.top).toBe('13px');
  });

  it('re-applies geometry when only the ROW COUNT changes', () => {
    // A keyboard toggle changes rows and the grid origin but not the cell size;
    // comparing only cols/cell size left the layer at its old height and offset.
    const { term } = makeTerm(['alpha', 'beta', 'gamma']);
    let geom = { ...GEOM };
    const layer = createNativeSelectionLayer(term, host, () => geom);
    layer.setEnabled(true);
    expect(layerEl(host)!.style.height).toBe('48px');

    geom = { ...GEOM, rows: 2, top: 13 };
    layer.update();

    expect(layerEl(host)!.style.height).toBe('32px');
    expect(layerEl(host)!.style.top).toBe('13px');
  });

  it('selectedText() is empty when nothing is selected', () => {
    const { term } = makeTerm(['alpha', 'beta']);
    const layer = createNativeSelectionLayer(term, host, () => GEOM);
    layer.setEnabled(true);

    expect(layer.selectedText()).toBe('');
  });
});
