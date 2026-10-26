// What the two scroll surfaces promise. happy-dom has no layout, so the list is
// given an explicit height (react-window then never asks the element for a size)
// and row heights arrive through a stubbed ResizeObserver, the way a browser
// would report them. The stylesheet half reads ui.css as TEXT, like the rest of
// the kit's guards: a colour literal in a scrollbar rule has no runtime symptom
// until someone switches to a light theme.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { parse, Rule } from 'postcss';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScrollArea, VirtualList, useDynamicRowHeight, type RowComponentProps } from './index';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

type LabelProps = { labels: string[] };

function LabelRow({ index, style, labels }: RowComponentProps<LabelProps>) {
  return (
    <div data-row={index} style={style}>
      {labels[index]}
    </div>
  );
}

function PlainRow({ index, style }: RowComponentProps<object>) {
  return (
    <div data-row={index} style={style}>
      row {index}
    </div>
  );
}

const rowsIn = (container: HTMLElement): HTMLElement[] => [
  ...container.querySelectorAll<HTMLElement>('[data-row]'),
];

const indexOf = (row: HTMLElement): number => Number(row.dataset.row);

/** The `translateY` react-window positions a row with. */
const offsetOf = (row: HTMLElement): number =>
  Number(/translateY\((-?[\d.]+)px\)/.exec(row.style.transform)?.[1]);

describe('VirtualList', () => {
  const labels = Array.from({ length: 10_000 }, (_, i) => `row ${i}`);

  it('mounts fewer than 100 row elements for 10,000 rows in a 600px area', () => {
    const { container } = render(
      <VirtualList
        rowCount={labels.length}
        rowHeight={24}
        rowComponent={LabelRow}
        rowProps={{ labels }}
        style={{ height: 600 }}
      />,
    );
    const rows = rowsIn(container);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(100);
    expect(indexOf(rows[0] as HTMLElement)).toBe(0);
  });

  it('renders the last rows once scrolled to the end', () => {
    const { container } = render(
      <VirtualList
        rowCount={labels.length}
        rowHeight={24}
        rowComponent={LabelRow}
        rowProps={{ labels }}
        style={{ height: 600 }}
      />,
    );
    const list = container.querySelector('[role="list"]') as HTMLElement;
    // What a browser does at the end of the track: the offset moves, then `scroll` fires.
    list.scrollTop = labels.length * 24 - 600;
    fireEvent.scroll(list);
    const rows = rowsIn(container).map(indexOf);
    expect(rows.length).toBeLessThan(100);
    expect(rows).toContain(labels.length - 1);
    expect(rows).not.toContain(0);
  });

  it('reports the rows it rendered, and wears the kit class beside the caller’s', () => {
    const onRowsRendered = vi.fn();
    const { container } = render(
      <VirtualList
        className="mine"
        onRowsRendered={onRowsRendered}
        rowCount={labels.length}
        rowHeight={24}
        rowComponent={LabelRow}
        rowProps={{ labels }}
        style={{ height: 600 }}
      />,
    );
    expect(onRowsRendered).toHaveBeenCalled();
    const [visible] = onRowsRendered.mock.calls.at(-1) as [{ startIndex: number }];
    expect(visible.startIndex).toBe(0);
    const list = container.querySelector('[role="list"]');
    expect(list).toHaveClass('ui-virtual-list', 'mine');
  });

  it('leaves a pointer press on a row uncancelled, so a touch pan is never taken', () => {
    const { container } = render(
      <VirtualList
        rowCount={labels.length}
        rowHeight={24}
        rowComponent={LabelRow}
        rowProps={{ labels }}
        style={{ height: 600 }}
      />,
    );
    const row = rowsIn(container)[0] as HTMLElement;
    // fireEvent answers false when a handler called preventDefault.
    expect(fireEvent.pointerDown(row, { pointerType: 'touch' })).toBe(true);
    expect(fireEvent.touchStart(row)).toBe(true);
  });

  describe('with dynamic row heights', () => {
    class FakeResizeObserver {
      static instances: FakeResizeObserver[] = [];
      observed = new Set<Element>();
      constructor(readonly callback: ResizeObserverCallback) {
        FakeResizeObserver.instances.push(this);
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

    function Dynamic() {
      const rowHeight = useDynamicRowHeight({ defaultRowHeight: 20 });
      return (
        <VirtualList
          rowCount={50}
          rowHeight={rowHeight}
          rowComponent={PlainRow}
          rowProps={{}}
          style={{ height: 200 }}
        />
      );
    }

    /** A browser's report that the row now measures `blockSize` px tall. */
    const measure = (container: HTMLElement, index: number, blockSize: number) => {
      const target = container.querySelector(`[data-row="${index}"]`) as HTMLElement;
      const observer = FakeResizeObserver.instances.find((o) => o.observed.has(target));
      if (!observer) throw new Error(`row ${index} is not observed`);
      const entry = {
        target,
        borderBoxSize: [{ blockSize, inlineSize: 300 }],
      } as unknown as ResizeObserverEntry;
      act(() => observer.callback([entry], observer as unknown as ResizeObserver));
    };

    it('moves the rows below a growing row down by its new height, with none overlapping', () => {
      FakeResizeObserver.instances = [];
      vi.stubGlobal('ResizeObserver', FakeResizeObserver);
      const { container } = render(<Dynamic />);

      const before = new Map(rowsIn(container).map((r) => [indexOf(r), offsetOf(r)]));
      expect(before.get(2)).toBe(40);
      expect(before.get(3)).toBe(60);

      // A comment editor opens inside row 2: 20px becomes 100px.
      measure(container, 2, 100);

      const after = new Map(rowsIn(container).map((r) => [indexOf(r), offsetOf(r)]));
      expect(after.get(2)).toBe(40);
      expect(after.get(3)).toBe(140);
      expect(after.get(4)).toBe(160);

      const heights = new Map([[2, 100]]);
      const indices = [...after.keys()].toSorted((a, b) => a - b);
      for (const [i, index] of indices.entries()) {
        const next = indices[i + 1];
        if (next === undefined) continue;
        const bottom = (after.get(index) as number) + (heights.get(index) ?? 20);
        expect(
          after.get(next) as number,
          `row ${next} starts at or below row ${index}`,
        ).toBeGreaterThanOrEqual(bottom);
      }
    });
  });
});

const viewportOf = (container: HTMLElement) =>
  container.querySelector('[data-radix-scroll-area-viewport]') as HTMLElement;
const contentOf = (container: HTMLElement) =>
  container.querySelector('.ui-scroll-content') as HTMLElement;

describe('ScrollArea', () => {
  it('holds its children in a viewport and scrolls vertically by default', () => {
    const { container, getByText } = render(
      <ScrollArea>
        <p>inside</p>
      </ScrollArea>,
    );
    expect(viewportOf(container)).toContainElement(getByText('inside'));
    expect(viewportOf(container).style.overflowY).toBe('scroll');
    expect(viewportOf(container).style.overflowX).toBe('hidden');
    // A long line must wrap or truncate here, not open a sideways scroll, so the
    // content is a block and not Radix's `display: table`.
    expect(contentOf(container).style.display).toBe('block');
  });

  it('scrolls sideways when asked, and then lets the content be as wide as it needs', () => {
    const { container } = render(
      <ScrollArea orientation="horizontal">
        <p>wide</p>
      </ScrollArea>,
    );
    expect(viewportOf(container).style.overflowX).toBe('scroll');
    expect(viewportOf(container).style.overflowY).toBe('hidden');
    expect(contentOf(container).style.display).toBe('table');
  });

  it('scrolls both ways when asked', () => {
    const { container } = render(
      <ScrollArea orientation="both">
        <p>both</p>
      </ScrollArea>,
    );
    expect(viewportOf(container).style.overflowX).toBe('scroll');
    expect(viewportOf(container).style.overflowY).toBe('scroll');
  });

  it('takes the room its siblings leave in a flex column with `fill`', () => {
    const { getByTestId, rerender } = render(<ScrollArea>x</ScrollArea>);
    expect(getByTestId('ui-scroll-area')).toHaveClass('ui-scroll');
    expect(getByTestId('ui-scroll-area')).not.toHaveClass('ui-scroll-fill');
    rerender(
      <ScrollArea fill className="mine">
        x
      </ScrollArea>,
    );
    expect(getByTestId('ui-scroll-area')).toHaveClass('ui-scroll', 'ui-scroll-fill', 'mine');
  });
});

describe('the scroll surfaces’ stylesheet', () => {
  const source = readFileSync(join(__dirname, 'ui.css'), 'utf8');
  const root = parse(source);

  const SCROLL_SELECTOR = /\.ui-(?:scroll|virtual-list)\b/;

  /** Every declaration of a rule that names a scroll surface, plus the thumb tokens. */
  const scrollDeclarations = (): { selector: string; prop: string; value: string }[] => {
    const found: { selector: string; prop: string; value: string }[] = [];
    root.walkRules((rule: Rule) => {
      const owns = SCROLL_SELECTOR.test(rule.selector);
      rule.walkDecls((decl) => {
        if (owns || decl.prop.startsWith('--ui-scroll')) {
          found.push({ selector: rule.selector, prop: decl.prop, value: decl.value });
        }
      });
    });
    return found;
  };

  it('finds rules for both surfaces and for the shared thumb colour', () => {
    const declared = scrollDeclarations();
    expect(declared.some((d) => d.selector.includes('.ui-scroll-thumb'))).toBe(true);
    expect(declared.some((d) => d.selector.includes('.ui-virtual-list'))).toBe(true);
    expect(declared.some((d) => d.prop === '--ui-scroll-thumb')).toBe(true);
  });

  it('holds no colour literal and no colour keyword but transparent', () => {
    const literal = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/i;
    const keyword =
      /\b(?:white|black|red|green|blue|yellow|orange|purple|pink|gray|grey|silver|maroon|navy|teal|olive|lime|aqua|fuchsia)\b/;
    const offenders = scrollDeclarations().filter(
      (d) => literal.test(d.value) || keyword.test(d.value),
    );
    expect(offenders).toEqual([]);
  });

  it('derives the thumb colour from the theme tokens alone', () => {
    const thumbs = scrollDeclarations().filter((d) => d.prop.startsWith('--ui-scroll-thumb'));
    expect(thumbs.map((d) => d.prop).toSorted()).toEqual([
      '--ui-scroll-thumb',
      '--ui-scroll-thumb-hover',
    ]);
    for (const { value } of thumbs) {
      expect(value).toMatch(/^color-mix\(in srgb, var\(--t-[a-z-]+\)/);
    }
  });

  it('paints the Radix thumb and the native scrollbar from the same colour', () => {
    const declared = scrollDeclarations();
    const radix = declared.find(
      (d) => d.selector === '.ui-scroll-thumb' && d.prop === 'background',
    );
    const native = declared.find(
      (d) => d.selector === '.ui-virtual-list' && d.prop === 'scrollbar-color',
    );
    expect(radix?.value).toBe('var(--ui-scroll-thumb)');
    expect(native?.value).toBe('var(--ui-scroll-thumb) transparent');
    expect(
      declared.find((d) => d.selector === '.ui-virtual-list' && d.prop === 'scrollbar-width'),
    ).toMatchObject({ value: 'thin' });
  });

  it('never takes the touch pan from what scrolls', () => {
    // The scrollbar's own handle may (a thumb drag must not pan the page); the
    // list, the viewport and the content may not, or a swipe inside stops scrolling.
    const offenders = scrollDeclarations().filter(
      (d) => d.prop === 'touch-action' && !d.selector.includes('.ui-scroll-bar'),
    );
    expect(offenders).toEqual([]);
  });

  it('draws no scrollbar on a phone, where one would sit under the drawer’s edge gesture', () => {
    const declared = scrollDeclarations();
    expect(
      declared.find(
        (d) => d.selector === ":root[data-mobile='true'] .ui-scroll-bar" && d.prop === 'display',
      ),
    ).toMatchObject({ value: 'none' });
    expect(
      declared.find(
        (d) =>
          d.selector === ":root[data-mobile='true'] .ui-virtual-list" &&
          d.prop === 'scrollbar-width',
      ),
    ).toMatchObject({ value: 'none' });
  });
});
