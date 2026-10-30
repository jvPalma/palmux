// The review's stylesheet, read as text like the kit's guards: happy-dom has no
// layout, so a colour literal, an animated row or a height that disagrees with
// `review-metrics.ts` has no symptom here until a phone shows it.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'postcss';
import { describe, expect, it } from 'vitest';
import {
  codeLineHeight,
  COMPACT_ROW_METRICS,
  DEFAULT_CODE_FONT_PX,
  QUOTE_MAX_LINES,
  ROW_METRICS,
} from './review-metrics';

const css = readFileSync(join(__dirname, 'review.css'), 'utf8');
const root = parse(css);

const declarations: { selector: string; prop: string; value: string }[] = [];
root.walkDecls((decl) => {
  const parent = decl.parent;
  declarations.push({
    selector: parent && 'selector' in parent ? String(parent.selector) : '',
    prop: decl.prop,
    value: decl.value,
  });
});

const NAMED_COLORS =
  /\b(white|black|red|green|blue|yellow|orange|purple|pink|gray|grey|silver|maroon|navy|teal|olive|lime|aqua|fuchsia)\b/;

describe('review.css theming contract', () => {
  it('declares no colour literal and names no colour keyword', () => {
    const offenders = declarations.filter(
      (d) =>
        /#[0-9a-f]{3,8}\b/i.test(d.value) ||
        /\b(rgba?|hsla?)\(/i.test(d.value) ||
        NAMED_COLORS.test(d.value),
    );
    expect(offenders, 'use var(--t-*) or a color-mix() over one').toEqual([]);
  });

  it('reads only the eight tokens, the theme ANSI slots for the diff hues, and its own properties', () => {
    const used = new Set([...css.matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map((m) => m[1]));
    const allowed = new Set([
      '--t-base',
      '--t-mantle',
      '--t-surface',
      '--t-text',
      '--t-subtext',
      '--t-accent',
      '--t-accent-alt',
      '--t-accent-ink',
      // Added green and removed red are not among the eight tokens.
      '--tab-c-ansi1',
      '--tab-c-ansi2',
      '--font-mono',
    ]);
    const foreign = [...used].filter(
      (name): name is string =>
        name !== undefined && !allowed.has(name) && !/^--(?:rv|sp|fs|r|ctl)-/.test(name),
    );
    expect(foreign).toEqual([]);
    expect(css).not.toMatch(/--t-crust\b/);
  });

  it('animates nothing: no transition, no animation, no keyframes', () => {
    expect(declarations.filter((d) => /^(transition|animation)/.test(d.prop))).toEqual([]);
    expect(css).not.toMatch(/@keyframes/);
  });

  it('has no uppercase transform (headings.test.ts holds the rest of the type scale)', () => {
    expect(css).not.toMatch(/text-transform:\s*uppercase/);
  });

  it('puts the added and removed hues on the theme’s green and red slots', () => {
    expect(css).toMatch(/--rv-add:\s*var\(--tab-c-ansi2/);
    expect(css).toMatch(/--rv-del:\s*var\(--tab-c-ansi1/);
  });
});

describe('row heights are the same numbers in the CSS and in review-metrics.ts', () => {
  // The heights are written from the `--sp-*` scale (see the sheet's header), so the
  // test resolves them the way a browser would: `var(--sp-n)`, sums and products. `--fs-2`
  // resolves too, for the default code size.
  const scale = new Map<string, number>();
  parse(readFileSync(join(__dirname, '..', 'index.css'), 'utf8')).walkDecls(
    /^--(?:sp|fs)-\d$/,
    (decl) => {
      scale.set(decl.prop, Number.parseFloat(decl.value));
    },
  );

  const declaredValue = (name: string): string | undefined =>
    new RegExp(`${name}:\\s*([^;]+);`).exec(css)?.[1]?.trim();

  /** px of `value`, resolving `var(--sp-n)`, `var(--fs-n)` and `var(--rv-*)` and the `calc` of + and *. */
  const resolve = (value: string): number => {
    let text = value;
    for (let guard = 0; guard < 10 && /var\(/.test(text); guard++) {
      text = text.replace(/var\((--[a-z0-9-]+)\)/g, (_m, name: string) => {
        const px = scale.get(name);
        if (px !== undefined) return `${px}`;
        const own = declaredValue(name);
        if (own === undefined) throw new Error(`cannot resolve ${name}`);
        return `(${own})`;
      });
    }
    text = text.replace(/calc\(/g, '(').replace(/px/g, '');
    if (!/^[\d\s.+*()]+$/.test(text)) throw new Error(`cannot evaluate ${value}`);
    // The only operators are + and *, over numbers and parentheses.
    return Function(`"use strict"; return (${text});`)() as number;
  };

  const declared = (name: string): number | undefined => {
    const value = declaredValue(name);
    return value === undefined ? undefined : resolve(value);
  };

  it.each([
    ['--rv-line-h', ROW_METRICS.line],
    ['--rv-head-h', ROW_METRICS.header],
    ['--rv-notice-h', ROW_METRICS.notice],
    ['--rv-gap-h', ROW_METRICS.gap],
    ['--rv-hunk-h', ROW_METRICS.hunk],
    ['--rv-error-h', ROW_METRICS.error],
  ])('%s is %ipx', (name, px) => {
    expect(declared(name)).toBe(px);
  });

  it('draws a code line at the default size, and as tall as the list thinks, until the pane says otherwise', () => {
    // The pane writes `--rv-code-fs` and `--rv-code-lh` on the frame from the code font
    // size. What the sheet declares is what a frame without them shows, which must be
    // the default size over the default line, or the rows would jump the first time one
    // was written.
    expect(declared('--rv-code-fs')).toBe(DEFAULT_CODE_FONT_PX);
    expect(declared('--rv-code-lh')).toBe(codeLineHeight(DEFAULT_CODE_FONT_PX));
    expect(declared('--rv-code-lh')).toBe(ROW_METRICS.line);
  });

  it('gives a code line the code size and line height, and the chrome rows neither', () => {
    const rulesFor = (prop: string, value: string) =>
      declarations
        .filter((d) => d.prop === prop && d.value.includes(value))
        .map((d) => d.selector)
        .sort();
    expect(rulesFor('font-size', '--rv-code-fs')).toEqual(['.rv-line,\n.rv-split']);
    expect(rulesFor('line-height', '--rv-code-lh')).toEqual(['.rv-line,\n.rv-split']);
    // The properties are read by lines and split rows alone: nothing that is chrome.
    const readers = declarations.filter((d) => /--rv-code-(?:fs|lh)\b/.test(d.value));
    const selectors = new Set(readers.map((d) => d.selector));
    expect([...selectors].sort()).toEqual([
      '.rv-line',
      '.rv-line,\n.rv-split',
      '.rv-split',
      '.rv-wrap.rv-line,\n.rv-wrap.rv-split',
    ]);
  });

  it('shows as many lines of quoted code as review-metrics.ts sizes for', () => {
    expect(declared('--rv-quote-h')).toBe(ROW_METRICS.line * QUOTE_MAX_LINES);
  });

  it('writes every row height from the scale, never as a bare pixel count', () => {
    const lengths = declarations.filter(
      (d) => /^--rv-[a-z]+-h$/.test(d.prop) || d.prop === 'width',
    );
    expect(lengths.length).toBeGreaterThan(5);
    for (const d of lengths) {
      expect(d.value, `${d.selector} { ${d.prop} }`).not.toMatch(/\d\s*px\b/);
    }
  });

  it('sizes the rows from those properties and from nothing else', () => {
    const heights = declarations.filter((d) => /^(?:min-|max-)?height$/.test(d.prop));
    for (const d of heights) {
      expect(d.value, `${d.selector} { ${d.prop} }`).toMatch(
        /^(?:0|auto|var\(--rv-(?:[a-z]+-h|code-lh)\))$/,
      );
    }
  });

  it('holds the file header’s controls inside its row', () => {
    // A small kit button is `--ctl-h` less one step: 32px on a phone, which must fit
    // in a header 40px tall, and so must the Retry button in an errored placeholder.
    expect(ROW_METRICS.header).toBeGreaterThanOrEqual(36);
    expect(ROW_METRICS.error).toBeGreaterThanOrEqual(36);
  });
});

// A phone's rows: `.rv-frame[data-dense='true']` overrides the same properties, and what
// it says must be the compact table's numbers, as the first block's are the desktop's.
describe('the compact rows are the same numbers in the CSS and in review-metrics.ts', () => {
  const DENSE = ".rv-frame[data-dense='true']";
  const scale = new Map<string, number>();
  parse(readFileSync(join(__dirname, '..', 'index.css'), 'utf8')).walkDecls(
    /^--(?:sp|fs)-\d$/,
    (decl) => {
      scale.set(decl.prop, Number.parseFloat(decl.value));
    },
  );

  const block = (selector: string): Map<string, string> => {
    const held = new Map<string, string>();
    root.walkRules((rule) => {
      if (rule.selector.replace(/\s+/g, ' ').trim() !== selector) return;
      rule.walkDecls((d) => void held.set(d.prop, d.value.replace(/\s+/g, ' ').trim()));
    });
    return held;
  };
  const base = block('.rv-frame');
  const dense = block(DENSE);

  /** px of a declaration on a dense frame: its own block first, then the frame's. */
  const resolve = (value: string): number => {
    let text = value;
    for (let guard = 0; guard < 10 && /var\(/.test(text); guard++) {
      text = text.replace(/var\((--[a-z0-9-]+)\)/g, (_m, name: string) => {
        const px = scale.get(name);
        if (px !== undefined) return `${px}`;
        const own = dense.get(name) ?? base.get(name);
        if (own === undefined) throw new Error(`cannot resolve ${name}`);
        return `(${own})`;
      });
    }
    text = text.replace(/calc\(/g, '(').replace(/px/g, '');
    if (!/^[\d\s.+\-*()]+$/.test(text)) throw new Error(`cannot evaluate ${value}`);
    return Function(`"use strict"; return (${text});`)() as number;
  };
  const dim = (name: string): number => {
    const value = dense.get(name) ?? base.get(name);
    if (value === undefined) throw new Error(`${name} is not declared`);
    return resolve(value);
  };

  it.each([
    ['--rv-head-h', COMPACT_ROW_METRICS.header],
    ['--rv-gap-h', COMPACT_ROW_METRICS.gap],
    ['--rv-hunk-h', COMPACT_ROW_METRICS.hunk],
    ['--rv-notice-h', COMPACT_ROW_METRICS.notice],
    ['--rv-line-h', COMPACT_ROW_METRICS.line],
    ['--rv-error-h', COMPACT_ROW_METRICS.error],
  ])('%s is %ipx on a phone', (name, px) => {
    expect(dim(name)).toBe(px);
  });

  it('overrides only the structural rows: the header, the gap, the hunk, and the gap’s chip', () => {
    expect([...dense.keys()].sort()).toEqual([
      '--rv-chip-h',
      '--rv-gap-h',
      '--rv-head-h',
      '--rv-hunk-h',
    ]);
  });

  it('writes each of them from the scale, never as a bare pixel count', () => {
    for (const [name, value] of dense) expect(value, name).not.toMatch(/\d\s*px\b/);
  });

  it('holds a divider (a gap and a hunk header) to 20px, one code line, and a file header to 28px', () => {
    expect(dim('--rv-gap-h')).toBeLessThanOrEqual(20);
    expect(dim('--rv-hunk-h')).toBeLessThanOrEqual(20);
    expect(dim('--rv-hunk-h')).toBe(dim('--rv-line-h'));
    expect(dim('--rv-gap-h')).toBe(dim('--rv-line-h'));
    expect(dim('--rv-head-h')).toBeLessThanOrEqual(28);
  });

  it('draws a chip as tall as the divider row it sits in, which fits the file header too', () => {
    expect(dim('--rv-chip-h')).toBe(dim('--rv-gap-h'));
    // The header's own box is the row less its two 1px borders, and a chip fits inside it.
    expect(dim('--rv-chip-h')).toBeLessThanOrEqual(dim('--rv-head-h') - 2);
  });

  it('draws a gap control from the chip height, which is not a kit control', () => {
    const chip = block('.rv-chip');
    expect(chip.get('height')).toBe('var(--rv-chip-h)');
    expect(chip.get('min-height')).toBeUndefined();
    // `.rv-chip` is not `.ui-btn`: the kit’s small button is 32px on a phone, taller than
    // a 28px row, and the kit’s sizes live in ui.css alone.
    expect(css).not.toMatch(/\.ui-(?:btn|icon-btn)/);
    // Its focus ring is inset, because the list’s scroller clips an outset one.
    expect(block('.rv-chip:focus-visible').get('outline-offset')).toBe('-2px');
  });

  it('draws the file header’s controls as chips too: the kit’s 32px small buttons do not fit 28px', () => {
    // Which is why the header takes `.rv-chip` on a phone (ReviewRow), as the gap does.
    expect(COMPACT_ROW_METRICS.header).toBeLessThan(32);
    expect(COMPACT_ROW_METRICS.header).toBeGreaterThanOrEqual(COMPACT_ROW_METRICS.gap + 2 + 2);
  });

  it('paints the primary chip as the kit’s primary button, from tokens', () => {
    const primary = block('.rv-chip-primary');
    expect(primary.get('background')).toBe('var(--t-accent)');
    expect(primary.get('color')).toBe('var(--t-accent-ink)');
    expect(primary.get('border-color')).toBe('var(--t-accent)');
    expect(block('.rv-chip:disabled').get('opacity')).toBe('0.5');
  });

  it('hides the state word beside the counts on a phone, and tightens the divider, nothing else', () => {
    expect(block(`${DENSE} .rv-state`).get('display')).toBe('none');
    const others = [...root.nodes]
      .filter(
        (node) =>
          node.type === 'rule' && node.selector.startsWith(DENSE) && node.selector !== DENSE,
      )
      .map((node) => (node.type === 'rule' ? node.selector.replace(/\s+/g, ' ') : ''))
      .toSorted();
    expect(others).toEqual([`${DENSE} .rv-gap .rv-sticky`, `${DENSE} .rv-state`]);
    // The divider's parts sit one step apart and the controls pad one step: the heading gets the rest.
    expect(block(`${DENSE} .rv-gap .rv-sticky`).get('gap')).toBe('var(--sp-1)');
    expect(block('.rv-gap .rv-chip').get('padding')).toBe('0 var(--sp-1)');
  });

  it('lets the heading on a divider take what its count and controls leave, and end in an ellipsis', () => {
    const text = block('.rv-gap .rv-hunk-text');
    expect(text.get('flex')).toBe('1 1 0');
    expect(text.get('min-width')).toBe('0');
    const own = block('.rv-hunk-text');
    expect(own.get('overflow')).toBe('hidden');
    expect(own.get('text-overflow')).toBe('ellipsis');
    expect(own.get('white-space')).toBe('nowrap');
  });
});

describe('a session that never opens a review downloads no colouring code', () => {
  // The editor chunk is the one thing a terminal-only session must never fetch.
  // It is reached through a dynamic `import()` in `colorize.ts` alone; a static
  // import anywhere on the path from App to a review would drag it in with App.
  const staticImports = (file: string): string[] =>
    [...readFileSync(file, 'utf8').matchAll(/^import\s[^;]*?from\s+'([^']+)';/gms)].map(
      (m) => m[1] ?? '',
    );
  const reviewFiles = readdirSync(__dirname)
    .filter((f) => /\.tsx?$/.test(f) && !/\.test\./.test(f))
    .map((f) => join(__dirname, f));
  const others = [
    join(__dirname, '../panes/PaneHost.tsx'),
    join(__dirname, '../panes/monaco-theme.ts'),
    join(__dirname, '../App.tsx'),
  ];

  it.each([...reviewFiles, ...others])(
    '%s imports neither Monaco nor its loader statically',
    (file) => {
      const offenders = staticImports(file).filter(
        (spec) => spec.endsWith('monaco-loader') || spec.startsWith('monaco-editor'),
      );
      expect(offenders).toEqual([]);
    },
  );

  it('reaches the loader through a dynamic import, in colorize.ts only', () => {
    const dynamic = reviewFiles.filter((file) =>
      /import\(\s*'\.\.\/panes\/monaco-loader'\s*\)/.test(readFileSync(file, 'utf8')),
    );
    expect(dynamic.map((f) => f.split('/').pop())).toEqual(['colorize.ts']);
  });
});
