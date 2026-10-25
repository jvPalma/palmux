// The dock has TWO heading levels, and the stylesheets are the only place that
// is true or false.
//
// Panel title (`.dock-title`): the larger, full-colour, tight-tracked level.
// Section title: the small secondary-colour label that every Collapsible, the
// Explorer's root rows, the Dictation history label and the swatch captions
// share (ui.css `.ui-collapsible-trigger` is the kit's own).
//
// Nothing in jsdom/happy-dom resolves a cascade, so — like ui.test.tsx's colour
// guard and scale.test.ts — the sheets are read as TEXT and parsed with PostCSS.
// ui.test.tsx separately resolves the EFFECTIVE trigger style in Settings and the
// New-tab chooser; this file covers what that one cannot reach: the consumers
// that are NOT Collapsibles, the panel title, and the whole tree for a stray
// uppercase caption.

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { AtRule, parse, Rule, type Declaration, type Node as CssNode } from 'postcss';
import { describe, expect, it } from 'vitest';
import baseline from './scale-baseline.json';

const SRC = join(__dirname, '..');

interface Decl {
  file: string;
  line: number;
  selector: string;
  prop: string;
  value: string;
  /** Inside an at-rule (a media query, a keyframe): not the element at rest. */
  conditional: boolean;
}

const cssFiles = (): string[] =>
  readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.css'))
    .toSorted();

/** Every declaration of one stylesheet, one entry per selector in a list. */
function parseDecls(css: string, file: string): Decl[] {
  const out: Decl[] = [];
  parse(css).walkDecls((decl: Declaration) => {
    let conditional = false;
    let rule: Rule | null = null;
    for (let p: CssNode['parent'] = decl.parent; p; p = p.parent) {
      if (p instanceof Rule && !rule) rule = p;
      else if (p instanceof AtRule) conditional = true;
    }
    if (!rule) return;
    for (const selector of rule.selectors) {
      out.push({
        file,
        line: decl.source?.start?.line ?? 0,
        selector: selector.replace(/\s+/g, ' ').trim(),
        prop: decl.prop.toLowerCase(),
        value: decl.value.replace(/\s+/g, ' ').trim(),
        conditional,
      });
    }
  });
  return out;
}

/** Every declaration of every client stylesheet. */
const allDecls = (): Decl[] =>
  cssFiles().flatMap((file) =>
    parseDecls(
      readFileSync(join(SRC, file), 'utf8'),
      relative(SRC, join(SRC, file)).split(sep).join('/'),
    ),
  );

const DECLS = allDecls();

/** What a selector declares at rest, later declarations winning, as one map. */
function declared(selector: string): Map<string, string> {
  const merged = new Map<string, string>();
  for (const d of DECLS) {
    if (d.selector === selector && !d.conditional) merged.set(d.prop, d.value);
  }
  return merged;
}

/** The `--fs-N` steps, read from the same `:root` that declares them. */
function scaleStep(name: string): number {
  const value = DECLS.find(
    (d) => d.file === 'index.css' && d.selector === ':root' && d.prop === name,
  )?.value;
  return Number.parseFloat(value ?? 'NaN');
}

/** The compound selector a rule actually styles: what follows its last combinator. */
function subjectCompound(selector: string): string {
  let depth = 0;
  let start = 0;
  for (let i = 0; i < selector.length; i += 1) {
    const c = selector[i];
    if (c === '[' || c === '(') depth += 1;
    else if (c === ']' || c === ')') depth -= 1;
    else if (depth === 0 && (c === ' ' || c === '>' || c === '+' || c === '~')) start = i + 1;
  }
  return selector.slice(start);
}

const styles = (selector: string, className: string): boolean =>
  new RegExp(`\\.${className}(?![\\w-])`).test(subjectCompound(selector)) &&
  !selector.includes('::');

/** A pseudo-class on the subject: hover, focus-visible… the title is not at rest. */
const isState = (selector: string): boolean => /(?<!:):(?!:)[\w-]+/.test(subjectCompound(selector));

/** The type that makes a title a title. Colour is the one a STATE may change. */
const TITLE_TYPE = new Set([
  'font',
  'font-size',
  'font-weight',
  'font-family',
  'letter-spacing',
  'text-transform',
  'color',
]);

/**
 * Every declaration that restates a title's type from a rule other than its own:
 * a descendant or compound selector that out-specifies the owner splits one
 * heading style in two. A state (`:hover`) may recolour; at rest, nothing may.
 */
function restatements(
  className: string,
  isOwn: (d: Decl) => boolean,
  decls: Decl[] = DECLS,
): string[] {
  return decls
    .filter(
      (d) =>
        !isOwn(d) &&
        styles(d.selector, className) &&
        TITLE_TYPE.has(d.prop) &&
        !(d.prop === 'color' && isState(d.selector)),
    )
    .map((d) => `${d.file}:${d.line}  ${d.selector} { ${d.prop}: ${d.value} }`);
}

const SECTION_TITLE = {
  'font-size': 'var(--fs-1)',
  'font-weight': '600',
  color: 'var(--t-subtext)',
  'letter-spacing': '0',
} as const;

describe('no uppercase caption survives', () => {
  // An uppercase tracked caption is a third heading style beside the two levels.
  // A real keycap or badge may need one: name its selector here WITH the reason,
  // so it is a decision somebody made and not a rule nobody noticed.
  const ALLOWED: Record<string, string> = {};

  it('sets no text-transform: uppercase in any client stylesheet', () => {
    const found = DECLS.filter(
      (d) => d.prop === 'text-transform' && /\buppercase\b/i.test(d.value),
    ).map((d) => `${d.file}:${d.line}  ${d.selector}`);
    expect(found.filter((f) => !Object.keys(ALLOWED).some((s) => f.endsWith(s)))).toEqual([]);
  });

  // The four places the task names, individually — so the failure says WHICH
  // heading regressed instead of only that "something somewhere" did.
  it.each([
    ['.dock-title', 'the panel title'],
    ['.ui-collapsible-trigger', 'the kit section title'],
    ['.ft-sect-trigger', 'the Explorer root header'],
    ['.dictation-group', 'the Dictation history label'],
  ])('%s (%s) is not uppercase', (selector) => {
    const transform = declared(selector).get('text-transform');
    expect(transform === undefined || transform === 'none').toBe(true);
  });
});

describe('the panel title', () => {
  const title = declared('.dock-title');

  it('is the larger, full-colour, tight-tracked level', () => {
    // `font: 650 var(--fs-4)/1.2 …`: weight, then the size step, then the line height.
    expect(title.get('font')).toMatch(/^650 var\(--fs-4\)\/[\d.]+ /);
    expect(title.get('color')).toBe('var(--t-text)');
    expect(title.get('letter-spacing')).toBe('-0.01em');
    expect(title.get('text-transform')).toBe('none');
  });

  it('is visibly larger than every section title', () => {
    expect(scaleStep('--fs-4')).toBeGreaterThan(scaleStep('--fs-1'));
    // …and a different colour, so size is not the only thing telling them apart.
    expect(title.get('color')).not.toBe(SECTION_TITLE.color);
  });
});

describe('the section title', () => {
  it.each([
    ['ui/ui.css', '.ui-collapsible-trigger'],
    ['panes/files.css', '.ft-sect-trigger'],
    ['dictation/dictation-view.css', '.dictation-group'],
    ['index.css', '.swatch-row-label'],
    ['index.css', '.dash-label'],
  ])('%s %s carries the one style', (file, selector) => {
    const own = new Map<string, string>();
    for (const d of DECLS) {
      if (d.file === file && d.selector === selector && !d.conditional) own.set(d.prop, d.value);
    }
    for (const [prop, value] of Object.entries(SECTION_TITLE)) {
      expect(own.get(prop), `${file} ${selector} ${prop}`).toBe(value);
    }
    expect(own.get('text-transform') ?? 'none').toBe('none');
  });

  // A consumer rule that restates the type and out-specifies the kit splits the
  // heading style in two — the two that did this (settings-view.css and
  // dashboard.css) are the reason this check exists. Layout is the consumer's;
  // type is the kit's. Judged on the rule's SUBJECT, not on how the selector ends,
  // so `.x .ui-collapsible-trigger:hover` and a media-query copy are caught too.
  it('is never restated on a Collapsible trigger outside the kit', () => {
    expect(restatements('ui-collapsible-trigger', (d) => d.file === 'ui/ui.css')).toEqual([]);
  });

  // The same property for the consumers that are NOT Collapsibles: a descendant
  // rule such as `.dock-panel .ft-sect-trigger { font-size: … }` would win over the
  // one that names the style, and the test above would still be green.
  it.each([
    ['ft-sect-trigger', 'panes/files.css'],
    ['dictation-group', 'dictation/dictation-view.css'],
    ['dash-label', 'index.css'],
    ['swatch-row-label', 'index.css'],
  ])('.%s is styled by its own rule in %s and by nothing that out-specifies it', (cls, file) => {
    expect(restatements(cls, (d) => d.selector === `.${cls}` && d.file === file)).toEqual([]);
    // One owner: a second sheet declaring the same selector would make "later
    // wins" depend on the bundle's import order.
    const owners = new Set(DECLS.filter((d) => d.selector === `.${cls}`).map((d) => d.file));
    expect([...owners]).toEqual([file]);
  });

  it('is a smaller step than the panel title, on the type scale', () => {
    expect(scaleStep('--fs-1')).toBe(11);
    expect(scaleStep('--fs-4')).toBe(15);
  });
});

// The panel title has the same exposure as the section titles: it is one class, so
// the first descendant rule that sets its size would split the hierarchy.
describe('the panel title is owned by one rule', () => {
  it('is restated by no other selector, in any sheet', () => {
    expect(
      restatements(
        'dock-title',
        (d) => d.selector === '.dock-title' && d.file === 'session/dock.css',
      ),
    ).toEqual([]);
    const owners = new Set(DECLS.filter((d) => d.selector === '.dock-title').map((d) => d.file));
    expect([...owners]).toEqual(['session/dock.css']);
  });
});

// A stylesheet is not the only place a caption can be uppercased: an inline style
// from a component survives every check above. Nothing in the app sets one; a
// future one must come here and say why.
describe('no component uppercases a caption inline', () => {
  it('has no textTransform: uppercase in any client source file', () => {
    const offenders = readdirSync(SRC, { recursive: true, encoding: 'utf8' })
      .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
      .filter((f) =>
        /textTransform\s*:\s*['"`]uppercase|text-transform\s*:\s*uppercase/i.test(
          readFileSync(join(SRC, f), 'utf8'),
        ),
      )
      .map((f) => f.split(sep).join('/'));
    expect(offenders).toEqual([]);
  });
});

// ui-rework 4.4. scale.test.ts holds every sheet to its baseline, and a sheet
// missing from the baseline to ZERO — so a re-introduced off-scale value in these
// three fails there. What that ratchet cannot see is a sheet that stays clean by
// opting out line by line with a `/* scale-ok */` pragma, or a baseline key left
// behind that would let one of them quietly grow back to its old count.
describe('the dock, dashboard and Explorer sheets stay on the scale', () => {
  const SHEETS = ['session/dock.css', 'panes/dashboard.css', 'panes/files.css'];

  it.each(SHEETS)('%s is scanned and has no baseline allowance', (file) => {
    expect(cssFiles().map((f) => f.split(sep).join('/'))).toContain(file);
    expect(Object.keys(baseline)).not.toContain(file);
  });

  it.each(SHEETS)('%s reached the scale without a scale-ok opt-out', (file) => {
    expect(readFileSync(join(SRC, file), 'utf8')).not.toMatch(/scale-ok/);
  });
});

describe('the restatement detector, proven on synthetic sheets', () => {
  const decls = (css: string, file = 'consumer.css'): Decl[] => parseDecls(css, file);
  const owner = (d: Decl): boolean => d.file === 'ui/ui.css';

  it('finds the subject of a selector, not its ancestors', () => {
    expect(subjectCompound('.a .b > .c:hover')).toBe('.c:hover');
    expect(subjectCompound('.a[data-x="1 2"] .b')).toBe('.b');
    expect(subjectCompound('.a > .b[data-x="1 2"]')).toBe('.b[data-x="1 2"]');
    expect(styles('.x .ui-collapsible-trigger', 'ui-collapsible-trigger')).toBe(true);
    expect(styles('.ui-collapsible-trigger .label', 'ui-collapsible-trigger')).toBe(false);
    expect(styles('.ui-collapsible-triggers', 'ui-collapsible-trigger')).toBe(false);
    expect(styles('.ui-collapsible-trigger::after', 'ui-collapsible-trigger')).toBe(false);
  });

  it('flags a consumer that restates the type, however the selector ends', () => {
    for (const selector of [
      '.dash-dock .ui-collapsible-trigger',
      '.settings-section > .ui-collapsible-trigger',
      '.x .ui-collapsible-trigger:hover',
      '.ui-collapsible-trigger.compact',
    ]) {
      for (const prop of [
        'font-size: 10px',
        'font-weight: 700',
        'letter-spacing: 0.1em',
        'text-transform: uppercase',
      ]) {
        const found = restatements(
          'ui-collapsible-trigger',
          owner,
          decls(`${selector} { ${prop}; }`),
        );
        expect(found, `${selector} { ${prop} }`).toHaveLength(1);
      }
    }
  });

  it('flags the same restatement inside a media query', () => {
    const found = restatements(
      'ui-collapsible-trigger',
      owner,
      decls('@media (max-width: 400px) { .x .ui-collapsible-trigger { font-size: 10px; } }'),
    );
    expect(found).toHaveLength(1);
  });

  it('lets a consumer lay the trigger out, and recolour it in a state', () => {
    const css = `
      .dash-dock .ui-collapsible-trigger { padding: 4px 8px; min-height: 28px; transition: color 140ms; }
      .dash-dock .ui-collapsible-trigger:hover { background: red; color: var(--t-text); }
    `;
    expect(restatements('ui-collapsible-trigger', owner, decls(css))).toEqual([]);
  });

  it('flags a colour change at rest, which a state may make and the title may not', () => {
    const found = restatements(
      'ui-collapsible-trigger',
      owner,
      decls('.dash-dock .ui-collapsible-trigger { color: red; }'),
    );
    expect(found).toHaveLength(1);
  });

  it("ignores the kit's own rules, and rules about other classes", () => {
    const css = '.ui-collapsible-trigger { font-size: var(--fs-1); }';
    expect(restatements('ui-collapsible-trigger', owner, decls(css, 'ui/ui.css'))).toEqual([]);
    expect(
      restatements('ui-collapsible-trigger', owner, decls('.other { font-size: 9px; }')),
    ).toEqual([]);
  });
});
