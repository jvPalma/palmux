// The black band under the terminal (ui-rework task 4.3).
//
// xterm.css paints `.xterm .xterm-viewport` `#000`, and in xterm 6 that element is
// an absolute layer over the whole `.xterm` box, beneath the scrollable element
// that draws the grid. Whatever the grid does not cover — xterm's 2px inset and
// the sub-cell remainder `height mod cellHeight` — therefore showed pure black
// instead of the `--t-term-bg` that `.term-wrap` is painted with for exactly that
// reason. Measured in Chromium at 1440x900: (0,0,0) in a 9px bottom band, a 2px
// left column and a 2px top row, against (30,30,46) in the grid.
//
// Layout does not exist in happy-dom, so there is no render to measure. What can
// be pinned is the CASCADE: the premise (xterm's own rule, read from the real
// package), the fix (our rule outranks it on specificity, not on source order —
// xterm.css is imported by main.tsx and its position in the bundle is not ours to
// depend on) and the variable the fix reads (published by applyThemeTokens).
// The detector is proven on synthetic sheets below, the way ui.test.tsx proves
// its focus-ring detectors, so "the test passes" is not "the test cannot fail".

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { AtRule, parse, Rule, type Declaration, type Node as CssNode } from 'postcss';
import { afterEach, describe, expect, it } from 'vitest';
import { applyThemeTokens, getProfile, hex } from '../settings/themes';

const APP_CSS = readFileSync(join(__dirname, '../index.css'), 'utf8');
const XTERM_CSS = readFileSync(
  createRequire(__filename).resolve('@xterm/xterm/css/xterm.css'),
  'utf8',
);

/** The rule the fix lives in: the host, the terminal, then the layer xterm paints black. */
const FIX_SELECTOR = '.term-host .xterm .xterm-viewport';

interface Paint {
  selector: string;
  prop: string;
  value: string;
  important: boolean;
  /** Inside an at-rule (a media query): not the element at rest. */
  conditional: boolean;
  /** (ids, classes + attributes + pseudo-classes, types) folded into one number. */
  specificity: number;
}

/**
 * Selectors Level 4 specificity for the plain selectors this file reads: classes,
 * attributes, pseudo-classes and types. It refuses the functional pseudo-classes
 * (`:is`, `:not`, `:where`, `:has`) rather than guess how they weigh in, so a
 * selector that needs a better helper fails loudly instead of ranking wrongly.
 */
function specificity(selector: string): number {
  if (/:(?:is|not|where|has|matches)\(/.test(selector)) {
    throw new Error(`specificity() does not model functional pseudo-classes: ${selector}`);
  }
  const ids = selector.match(/#[\w-]+/g)?.length ?? 0;
  const classes = selector.match(/\.[\w-]+|\[[^\]]*\]|(?<!:):(?!:)[\w-]+/g)?.length ?? 0;
  const types =
    selector
      .replace(/\[[^\]]*\]/g, '')
      .split(/[\s>+~]+/)
      .filter((compound) => /^[a-z]/i.test(compound)).length +
    (selector.match(/::[\w-]+/g)?.length ?? 0);
  return ids * 10_000 + classes * 100 + types;
}

/** Every background declaration whose rule paints the viewport layer itself. */
function viewportPaints(css: string): Paint[] {
  const out: Paint[] = [];
  parse(css).walkDecls((decl: Declaration) => {
    const prop = decl.prop.toLowerCase();
    if (prop !== 'background' && prop !== 'background-color') return;
    let rule: Rule | null = null;
    let conditional = false;
    for (let p: CssNode['parent'] = decl.parent; p; p = p.parent) {
      if (p instanceof Rule && !rule) rule = p;
      else if (p instanceof AtRule) conditional = true;
    }
    if (!rule) return;
    for (const raw of rule.selectors) {
      const selector = raw.replace(/\s+/g, ' ').trim();
      // The viewport as the SUBJECT (a state may follow it), not as an ancestor of
      // something else and not one of its pseudo-elements.
      if (!/\.xterm-viewport(?::[\w-]+)*$/.test(selector)) continue;
      out.push({
        selector,
        prop,
        value: decl.value.replace(/\s+/g, ' ').trim(),
        important: decl.important === true,
        conditional,
        specificity: specificity(selector),
      });
    }
  });
  return out;
}

/** What is wrong with the fix, in words; empty when it holds. */
function problems(appCss: string, xtermCss: string): string[] {
  const found: string[] = [];
  const theirs = viewportPaints(xtermCss).filter((p) => !p.conditional);
  const ours = viewportPaints(appCss);
  const fix = ours.find((p) => p.selector === FIX_SELECTOR && p.prop === 'background-color');

  if (!fix) {
    found.push(`no \`${FIX_SELECTOR} { background-color }\` rule`);
    return found;
  }
  if (fix.conditional)
    found.push('the fix sits inside an at-rule, so it is not the element at rest');
  if (!/^var\(--t-term-bg\b/.test(fix.value)) {
    found.push(`the fix paints ${fix.value}, not the terminal background (--t-term-bg)`);
  }
  for (const p of theirs) {
    if (p.important)
      found.push(`xterm.css marks ${p.selector} !important, which no selector beats`);
    if (!fix.important && fix.specificity <= p.specificity) {
      found.push(`${fix.selector} does not outrank xterm.css's ${p.selector} on specificity`);
    }
  }
  for (const p of ours) {
    if (/#|\brgba?\(|\bhsla?\(|\b(?:black|white)\b/i.test(p.value)) {
      found.push(`${p.selector} paints the viewport layer with the literal ${p.value}`);
    }
  }
  return found;
}

describe('xterm.css, the premise of the fix', () => {
  const theirs = viewportPaints(XTERM_CSS).filter((p) => !p.conditional);

  // If xterm stops painting this layer, the rule is dead weight; if it starts
  // using `!important`, the rule stops working and nothing else would say so.
  it('paints the viewport layer #000 at (0,2,0), without !important', () => {
    const paint = theirs.find((p) => p.selector === '.xterm .xterm-viewport');
    expect(
      paint,
      'xterm.css no longer paints .xterm-viewport — the fix may be obsolete',
    ).toBeTruthy();
    expect(paint?.prop).toBe('background-color');
    expect(paint?.value).toBe('#000');
    expect(paint?.important).toBe(false);
    expect(paint?.specificity).toBe(200);
  });

  it('paints it from no other selector our rule would have to outrank', () => {
    expect(theirs.map((p) => p.selector)).toEqual(['.xterm .xterm-viewport']);
  });
});

describe('the terminal remainder', () => {
  it('paints the viewport layer in the terminal background, and wins on specificity', () => {
    expect(problems(APP_CSS, XTERM_CSS)).toEqual([]);
  });

  // The fix and `.term-wrap` must read ONE variable: the wrapper covers the
  // overhang and the viewport covers the grid's remainder, and two different
  // colours would put a seam between them.
  it('reads the same variable the wrapper behind it is painted with', () => {
    let background: string | undefined;
    parse(APP_CSS).walkRules('.term-wrap', (rule) => {
      if (rule.parent?.type !== 'root') return;
      rule.walkDecls('background', (d) => void (background = d.value));
    });
    expect(background).toMatch(/^var\(--t-term-bg\b/);
  });

  it('is the only app rule that paints the viewport layer', () => {
    const paints = viewportPaints(APP_CSS);
    expect(paints.map((p) => p.selector)).toEqual([FIX_SELECTOR]);
  });
});

describe('--t-term-bg', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('style');
  });

  // The rule falls back to --t-base, which is DERIVED for the chrome and is not
  // the terminal's background on every theme — so the variable it prefers has to
  // actually be there, on the theme the terminal is drawn in.
  it.each(['catppuccin-mocha', 'solarized-light', 'gruvbox-dark'])(
    'is published by applyThemeTokens as the profile background (%s)',
    (id) => {
      const profile = getProfile(id);
      applyThemeTokens(profile);
      expect(document.documentElement.style.getPropertyValue('--t-term-bg')).toBe(hex(profile.bg));
    },
  );
});

describe('the host the rule is scoped to', () => {
  // `.term-host` is the one element every terminal pane (each pane of the main window
  // and of a detached window) opens xterm into; the rule is dead without it.
  it('is what TerminalPane opens xterm into', () => {
    const pane = readFileSync(join(__dirname, 'TerminalPane.tsx'), 'utf8');
    expect(pane).toMatch(/className="term-host"/);
  });
});

describe('the detector, proven on synthetic sheets', () => {
  const XTERM = '.xterm .xterm-viewport { background-color: #000; overflow-y: scroll; }';
  const FIX = `${FIX_SELECTOR} { background-color: var(--t-term-bg, var(--t-base)); }`;

  it('accepts the fix as shipped', () => {
    expect(problems(FIX, XTERM)).toEqual([]);
  });

  it('flags a missing rule', () => {
    expect(problems('.term-host { background: red; }', XTERM)).toEqual([
      `no \`${FIX_SELECTOR} { background-color }\` rule`,
    ]);
  });

  // The fix is (0,3,0). A rule that matches it ties, and a tie is decided by where
  // each stylesheet lands in the bundle — which is not ours to depend on.
  it('flags an xterm.css rule that ties or beats the fix on specificity', () => {
    for (const rival of ['.a .b .xterm-viewport', '.app .term-host .xterm .xterm-viewport']) {
      const sheet = `${rival} { background-color: #000; }`;
      expect(problems(FIX, sheet).join('\n'), rival).toContain('does not outrank');
    }
  });

  it('flags a fix wrapped in a media query', () => {
    const wrapped = `@media (min-width: 1px) { ${FIX} }`;
    expect(problems(wrapped, XTERM).join('\n')).toContain('at-rule');
  });

  it('flags the wrong colour and a literal colour', () => {
    const base = `${FIX_SELECTOR} { background-color: var(--t-base); }`;
    expect(problems(base, XTERM).join('\n')).toContain('not the terminal background');
    const literal = `${FIX_SELECTOR} { background-color: #111; }`;
    const out = problems(literal, XTERM).join('\n');
    expect(out).toContain('not the terminal background');
    expect(out).toContain('literal #111');
  });

  it('flags xterm.css turning the paint !important', () => {
    const hostile = '.xterm .xterm-viewport { background-color: #000 !important; }';
    expect(problems(FIX, hostile).join('\n')).toContain('!important');
  });

  it('weighs selectors the way Selectors Level 4 does', () => {
    expect(specificity('.xterm .xterm-viewport')).toBe(200);
    expect(specificity(FIX_SELECTOR)).toBe(300);
    expect(specificity('.term-wrap:hover')).toBe(200);
    expect(specificity('div.a > span')).toBe(102);
    expect(specificity('#a .b')).toBe(10_100);
    expect(() => specificity(':is(.a, .b) .c')).toThrow(/functional pseudo-classes/);
  });
});
