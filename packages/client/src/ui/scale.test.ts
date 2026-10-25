// The size scale guard (index.css `--fs-* / --sp-* / --r-* / --ctl-h`).
//
// A stylesheet value that is off the scale has no runtime symptom — 10.5px
// renders fine — so, like ui.test.tsx's colour-literal check, the stylesheets
// are read as TEXT. They are parsed with PostCSS, so a quote, a `;` inside
// url(…) or a comment cannot desynchronise the read. This is a RATCHET, not a
// migration: the baseline records how many off-scale declarations each file has
// today, the test fails when a file gets worse, and it fails when a file gets
// better until the baseline is lowered, so progress cannot quietly leak back.
//
// Lowering the baseline is a hand edit of scale-baseline.json, by design. A
// "regenerate" switch would make raising it as easy as lowering it.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { render } from '@testing-library/react';
import {
  AtRule,
  parse,
  Rule,
  type Declaration as CssDeclaration,
  type Node as CssNode,
} from 'postcss';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Button, Collapsible, IconButton, Input, Segmented, Select } from './index';
import baseline from './scale-baseline.json';

const SRC = join(__dirname, '..');

/** Terminal metrics and the extra-keys bar are tuned by hand (2026-10-24). */
const EXEMPT_SELECTORS = [
  '.ek-',
  '.extra-keys',
  '.term-',
  '.xterm',
  '.md-body',
  '.native-sel',
  '.sel-handle',
];

const FONT_PX = new Set([11, 12, 13, 15]);
const RADIUS_PX = new Set([4, 6, 10, 999]);

// The pragma is the one comment the guard reads. `body` is what follows the
// opening `/*`, so `/*scale-ok*/` and `/* scale-ok: reason */` both count.
const isPragma = (body: string): boolean => /^\s*scale-ok\b/.test(body);

// A quoted string or a comment, whichever starts first, so `"/*"` is a string and
// `/* " */` is a comment. PostCSS has already split the sheet into nodes; this is
// only for the comments it folds into a declaration's `raws` instead of a node.
const STRING_OR_COMMENT = /"(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*'|\/\*[\s\S]*?\*\//g;

const commentBodies = (text: string): string[] =>
  [...text.matchAll(STRING_OR_COMMENT)]
    .map((m) => m[0])
    .filter((m) => m.startsWith('/*'))
    .map((m) => m.slice(2));

// A comment separates tokens, so `8px/* c */3px` is two of them: it becomes a space.
const withoutComments = (text: string): string =>
  text.replace(STRING_OR_COMMENT, (m) => (m.startsWith('/*') ? ' ' : m));

interface Declaration {
  line: number;
  selector: string;
  /** Rules and at-rules the declaration sits in: 1 is directly in a rule, 2 under an at-rule. */
  depth: number;
  prop: string;
  value: string;
  pragma: boolean;
}

/**
 * A pragma opts out the declaration it shares a line with. After the `;` it is
 * a sibling node, and counts only if it starts on the line the declaration ends
 * on — one on its own line must not silently adopt whatever sits above it.
 * Inside the declaration (before the `;`, around the value or `!important`) it is
 * not a node at all, and the declaration owns it.
 */
function hasPragma(decl: CssDeclaration, endLine: number): boolean {
  const inside = [decl.raws.between, decl.raws.value?.raw, decl.raws.important]
    .flatMap((text) => commentBodies(text ?? ''))
    .some(isPragma);
  if (inside) return true;
  for (let n = decl.next(); n?.type === 'comment'; n = n.next()) {
    if (n.source?.start?.line === endLine && isPragma(n.text)) return true;
  }
  return false;
}

/**
 * Every `prop: value` with the selector chain it sits under. A declaration inside
 * `@media { .a { … } }` is still `.a`'s: at-rule preludes are left out of the
 * chain, and keyframe steps (`50%`) are kept, as they are rules of their own.
 */
function parseDeclarations(src: string): Declaration[] {
  const declarations: Declaration[] = [];
  parse(src).walkDecls((decl) => {
    const chain: string[] = [];
    let depth = 0;
    for (let p: CssNode['parent'] = decl.parent; p; p = p.parent) {
      if (p instanceof Rule) {
        chain.unshift(p.selector.replace(/\s+/g, ' ').trim());
        depth += 1;
      } else if (p instanceof AtRule) depth += 1;
    }
    const line = decl.source?.start?.line ?? 0;
    declarations.push({
      line,
      selector: chain.join(' '),
      depth,
      prop: decl.prop.toLowerCase(),
      value: withoutComments(decl.raws.value?.raw ?? decl.value).trim(),
      pragma: hasPragma(decl, decl.source?.end?.line ?? line),
    });
  });
  return declarations;
}

/**
 * Top-level tokens of a value, with each top-level `/` kept as a token of its own.
 * A quoted string is one opaque piece, and a backslash takes the character after
 * it, so an escaped quote does not close a string and a `/` in a family name
 * (`"UI/Body"`) is not a line-height separator.
 */
function tokenizeWithSlashes(value: string): string[] {
  const out: string[] = [];
  let cur = '';
  let depth = 0;
  let quote = '';
  const text = value.trim();
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] ?? '';
    if (ch === '\\') {
      cur += ch + (text[i + 1] ?? '');
      i += 1;
      continue;
    }
    if (quote) {
      cur += ch;
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (depth === 0 && (ch === '/' || /\s/.test(ch))) {
      if (cur) out.push(cur);
      cur = '';
      if (ch === '/') out.push('/');
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** Top-level tokens of a value; `/` separates too (`13px/1.4`, `10px / 5px`). */
const tokenize = (value: string): string[] => tokenizeWithSlashes(value).filter((t) => t !== '/');

type Kind = 'font' | 'radius' | 'space' | 'height';

const FUNCTION_PASS = /^(?:var|calc|env|min|max|clamp)\(/i;
const LENGTH = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[a-z]+|%)?$/i;

/**
 * A token fails only when it is a NUMBER the scale does not allow. Keywords
 * (`auto`, `inherit`), `%`, `em`/`rem` and the functions above carry no literal
 * to hold against the scale, so they pass. Every other unit fails: `3vh` of
 * padding or `1ch` of gap is a number on no scale at all, so it is a way round
 * the guard, not out of it. A height is held to the scale only when it is a px
 * literal — `50vh` is a layout decision, not a control size.
 */
function tokenPasses(kind: Kind, token: string): boolean {
  if (FUNCTION_PASS.test(token) || !LENGTH.test(token)) return true;
  const [, num = '', unit = ''] = /^([+-]?(?:\d+\.?\d*|\.\d+))([a-z%]*)$/i.exec(token) ?? [];
  const n = Number(num);
  if (n === 0) return true;
  const lower = unit.toLowerCase();
  if (kind === 'height' && lower !== 'px') return true;
  if (lower === '%' || lower === 'em' || lower === 'rem') return true;
  if (lower !== 'px') return false;
  if (kind === 'font') return FONT_PX.has(n);
  if (kind === 'radius') return RADIUS_PX.has(n);
  const abs = Math.abs(n);
  return abs === 1 || abs === 2 || (Number.isInteger(abs) && abs % 4 === 0);
}

function kindOf(prop: string): Kind | null {
  if (prop === 'font-size' || prop === 'font') return 'font';
  if (prop === 'border-radius') return 'radius';
  if (prop === 'height' || prop === 'min-height' || prop === 'max-height') return 'height';
  if (/^(?:padding|margin)(?:-|$)/.test(prop) || /^(?:row-|column-)?gap$/.test(prop)) {
    return 'space';
  }
  return null;
}

const UNIT_LITERAL = /^[+-]?(?:\d+\.?\d*|\.\d+)[a-z%]+$/i;
const ANGLE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:deg|grad|rad|turn)$/i;
const MATH_FUNCTION = /^(?:calc|min|max|clamp)\(/i;

/**
 * The size in a `font` shorthand, or null when it carries no literal to check.
 *
 * The grammar is `[style || variant || weight || stretch]? size [/ line-height]?
 * family#`, and a var() can stand for any token of that optional prefix, so the
 * first var() is not the size and neither is the first token with a unit (an
 * `oblique` style may carry an angle). What the grammar does fix: the size is
 * the token right before the `/` that opens the line-height. Without a `/`, it
 * is the first literal length or math function outside an oblique angle — the
 * prefix holds only keywords, bare weight numbers and var()s, and a family
 * name is never a length. A var() size leaves no length to find, and passes.
 */
function fontShorthandSize(value: string): string | null {
  const tokens = tokenizeWithSlashes(value);
  const slash = tokens.indexOf('/');
  if (slash > 0) return tokens[slash - 1] ?? null;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? '';
    if (/^oblique$/i.test(token) && ANGLE.test(tokens[i + 1] ?? '')) i += 1;
    else if (UNIT_LITERAL.test(token) || MATH_FUNCTION.test(token)) return token;
  }
  return null;
}

/** The tokens of a declaration that the scale applies to. */
function checkedTokens(kind: Kind, prop: string, value: string): string[] {
  // In the `font` shorthand only the size is on the scale.
  if (prop === 'font') {
    const size = fontShorthandSize(value);
    return size ? [size] : [];
  }
  const all = tokenize(value);
  return kind === 'height' ? all.filter((t) => /px$/i.test(t)) : all;
}

interface Violation {
  line: number;
  selector: string;
  declaration: string;
}

function findViolations(css: string): Violation[] {
  const found: Violation[] = [];
  for (const d of parseDeclarations(css)) {
    const kind = kindOf(d.prop);
    if (!kind || d.pragma) continue;
    if (EXEMPT_SELECTORS.some((s) => d.selector.includes(s))) continue;
    const bad = checkedTokens(kind, d.prop, d.value).filter((t) => !tokenPasses(kind, t));
    if (bad.length > 0) {
      found.push({ line: d.line, selector: d.selector, declaration: `${d.prop}: ${d.value}` });
    }
  }
  return found;
}

function cssFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.css'))
    .toSorted();
}

/** File → violations, keyed relative to `packages/client/src` with `/` separators. */
function scanTree(): Map<string, Violation[]> {
  const result = new Map<string, Violation[]>();
  for (const file of cssFiles(SRC)) {
    const key = relative(SRC, join(SRC, file)).split(sep).join('/');
    result.set(key, findViolations(readFileSync(join(SRC, file), 'utf8')));
  }
  return result;
}

/** One message per file that is not exactly at its baseline. */
function ratchetProblems(
  scanned: Map<string, Violation[]>,
  recorded: Record<string, number>,
): string[] {
  const problems: string[] = [];
  for (const file of new Set([...scanned.keys(), ...Object.keys(recorded)])) {
    const found = scanned.get(file) ?? [];
    const allowed = recorded[file] ?? 0;
    if (found.length > allowed) {
      const lines = found.map((v) => `  ${file}:${v.line}  ${v.selector} { ${v.declaration} }`);
      problems.push(
        `${file} has ${found.length} off-scale declarations, baseline is ${allowed}. ` +
          `Use a --fs/--sp/--r step, or add a /* scale-ok */ pragma with a reason:\n${lines.join('\n')}`,
      );
    } else if (found.length < allowed) {
      problems.push(`lower the baseline for ${file} to ${found.length}`);
    }
  }
  return problems;
}

describe('scale guard — what counts as a violation', () => {
  const count = (css: string): number => findViolations(css).length;

  it('flags font-size: 10.5px, exactly once', () => {
    const found = findViolations('.a {\n  color: red;\n  font-size: 10.5px;\n}');
    expect(found).toEqual([{ line: 3, selector: '.a', declaration: 'font-size: 10.5px' }]);
  });

  it('passes the font scale and anything relative', () => {
    const steps = [11, 12, 13, 15].map((n) => `font-size: ${n}px;`).join(' ');
    expect(count(`.a { ${steps} }`)).toBe(0);
    for (const v of ['1.1em', '0.9rem', '110%', 'var(--fs-2)', 'calc(1em + 2px)', 'inherit']) {
      expect(count(`.a { font-size: ${v}; }`), v).toBe(0);
    }
    expect(count('.a { font-size: 14px; }')).toBe(1);
    expect(count('.a { font-size: 10px; }')).toBe(1);
  });

  it('checks the size inside a font shorthand and nothing else in it', () => {
    expect(count('.a { font: 600 10.5px/1.2 system-ui; }')).toBe(1);
    expect(count('.a { font: italic 600 13px/1.4 "JetBrains Mono", monospace; }')).toBe(0);
    expect(count('.a { font: inherit; }')).toBe(0);
    expect(count('.a { font: var(--font-ui); }')).toBe(0);
  });

  // `[style || variant || weight || stretch]? size [/ line-height]? family#` —
  // and a var() can stand in for any token of the optional prefix, so neither
  // "the first var()" nor "the first token with a unit" is reliably the size.
  it('finds the size behind a variable weight', () => {
    expect(count('.a { font: var(--weight) 10.5px/1.2 system-ui; }')).toBe(1);
    expect(count('.a { font: var(--style) var(--weight) 10.5px system-ui; }')).toBe(1);
    expect(count('.a { font: italic var(--weight) 13px/1.2 system-ui; }')).toBe(0);
  });

  it('passes a variable size and never checks the line-height after it', () => {
    expect(count('.a { font: 600 var(--fs-2)/1.2 system-ui; }')).toBe(0);
    expect(count('.a { font: 600 var(--fs-2)/18px system-ui; }')).toBe(0);
    expect(count('.a { font: italic var(--fs-2) system-ui; }')).toBe(0);
  });

  it('passes a functional size followed by a /line-height', () => {
    expect(count('.a { font: 600 calc(1em + 2px)/18px system-ui; }')).toBe(0);
    expect(count('.a { font: 600 clamp(11px, 2vw, 13px) / 1.2 system-ui; }')).toBe(0);
    expect(count('.a { font: min(13px, 3vw)/1 ui-monospace; }')).toBe(0);
  });

  it('reads the plain weight-size-family form', () => {
    expect(count('.a { font: 600 12px/1 ui-monospace; }')).toBe(0);
    expect(count('.a { font: 600 12.5px/1 ui-monospace; }')).toBe(1);
    expect(count('.a { font:\n    600 10.5px/1 system-ui,\n    sans-serif; }')).toBe(1);
  });

  it('skips keyword-only prefixes, and the angle an oblique style carries', () => {
    expect(count('.a { font: bold italic small-caps condensed 13px system-ui; }')).toBe(0);
    expect(count('.a { font: normal normal 600 13px/1.4 system-ui; }')).toBe(0);
    expect(count('.a { font: bolder 10.5px/1 system-ui; }')).toBe(1);
    expect(count('.a { font: oblique 10deg 13px system-ui; }')).toBe(0);
    expect(count('.a { font: oblique 10deg 14px system-ui; }')).toBe(1);
    expect(count('.a { font: caption; }')).toBe(0);
  });

  it('holds a radius to 4, 6, 10 and 999', () => {
    for (const v of ['4px', '6px', '10px', '999px', '50%', '0', 'var(--r-2)', '10px 10px 0 0']) {
      expect(count(`.a { border-radius: ${v}; }`), v).toBe(0);
    }
    expect(count('.a { border-radius: 7px; }')).toBe(1);
    expect(count('.a { border-radius: 8px; }')).toBe(1);
    expect(count('.a { border-radius: 10px 10px 0 7px; }')).toBe(1);
  });

  it('holds spacing to 1, 2 and multiples of 4 — per token, margins included', () => {
    for (const v of ['0', 'auto', '1px', '2px', '4px', '8px', '12px', '24px', '0 12px']) {
      expect(count(`.a { padding: ${v}; margin: ${v}; gap: ${v}; }`), v).toBe(0);
    }
    for (const v of ['3px', '5px', '6px', '10px', '0.5px', '18px 4px']) {
      expect(count(`.a { padding: ${v}; margin: ${v}; gap: ${v}; }`), v).toBe(3);
    }
  });

  it('fails any unit outside px, %, em and rem, whatever the property', () => {
    for (const v of ['2vh', '3vw', '1ch', '2ex', '1dvh', '4pt', '3']) {
      expect(count(`.a { padding: ${v}; margin: ${v}; gap: ${v}; }`), v).toBe(3);
    }
    expect(count('.a { font-size: 2vw; }')).toBe(1);
    expect(count('.a { border-radius: 1vmin; }')).toBe(1);
  });

  it('counts a bad token in a multi-value shorthand', () => {
    expect(count('.a { padding: 6px 10px 6px 8px; }')).toBe(1);
    expect(count('.a { margin: 0 auto 3px; }')).toBe(1);
    expect(count('.a { margin: -6px 0 0 -4px; }')).toBe(1);
    expect(count('.a { margin: -8px 0 0 -4px; }')).toBe(0);
    expect(count('.a { padding-inline-start: 5px; row-gap: 3px; column-gap: 10px; }')).toBe(3);
  });

  it('passes percentages, em/rem and the CSS functions', () => {
    const values = [
      '50%',
      '1.5em',
      '0.5rem',
      'var(--sp-2)',
      'calc(100% - 7px)',
      'env(safe-area-inset-bottom)',
      'min(7px, 3vw)',
      'max(5px, 1em)',
      'clamp(3px, 1vw, 9px)',
    ];
    for (const v of values) {
      expect(count(`.a { padding: ${v}; gap: ${v}; }`), v).toBe(0);
    }
  });

  it('checks height only as a px literal', () => {
    expect(count('.a { height: 30px; }')).toBe(1);
    expect(count('.a { min-height: 22px; max-height: 99px; }')).toBe(2);
    expect(count('.a { height: 28px; min-height: 36px; max-height: 1px; }')).toBe(0);
    for (const v of ['100%', '50vh', 'auto', '100dvh', 'calc(100% - 7px)', 'var(--ctl-h)']) {
      expect(count(`.a { height: ${v}; }`), v).toBe(0);
    }
  });

  it('ignores properties the scale does not govern and custom properties', () => {
    expect(count('.a { width: 7px; top: 3px; line-height: 17px; border-width: 3px; }')).toBe(0);
    expect(count(':root { --odd: 7px; --fs-9: 9px; }')).toBe(0);
  });

  it('skips terminal and extra-keys selectors, including in a selector list', () => {
    for (const sel of [
      '.ek-key',
      '.extra-keys-bar',
      '.term-wrap',
      '.xterm-viewport',
      '.md-body table',
      '.native-sel-row',
      '.sel-handle',
      '.a, .ek-b',
    ]) {
      expect(count(`${sel} { font-size: 10.5px; padding: 3px; }`), sel).toBe(0);
    }
    expect(count('.terminal-bar { font-size: 10.5px; }')).toBe(1);
    expect(count('.my-term-x { font-size: 10.5px; }')).toBe(1);
  });

  it('keeps tracking the selector through a nested @media block', () => {
    const css = [
      '.plain { font-size: 11px; }',
      '@media (max-width: 600px) {',
      '  .ek-key { font-size: 10.5px; }',
      '  .tab { font-size: 10.5px; }',
      '}',
      '.after { padding: 3px; }',
    ].join('\n');
    expect(findViolations(css)).toEqual([
      { line: 4, selector: '.tab', declaration: 'font-size: 10.5px' },
      { line: 6, selector: '.after', declaration: 'padding: 3px' },
    ]);
  });

  it('keeps a media-query string and a keyframe step from breaking the parse', () => {
    const css = [
      '@keyframes pulse { 50% { padding: 3px; } }',
      "@media (pointer: coarse) { .a[data-x='a;b'] { gap: 3px; } }",
      '.b { background: url(data:image/png;base64,AAAA); margin: 3px }',
    ].join('\n');
    expect(findViolations(css).map((v) => v.declaration)).toEqual([
      'padding: 3px',
      'gap: 3px',
      'margin: 3px',
    ]);
  });

  // A string closes at its own unescaped quote — in the sheet (PostCSS) and in a
  // value (the tokenizer) — so what is inside one is never structure.
  it('reads past an escaped quote in a string to the declarations after it', () => {
    const found = findViolations('.a { content: "a\\"b"; padding: 7px }');
    expect(found.map((v) => v.declaration)).toEqual(['padding: 7px']);
    expect(count(".a { content: 'a\\'b'; padding: 7px }")).toBe(1);
  });

  it('does not read a comment opener inside a string as a comment', () => {
    const css = '.a { content: "/*"; padding: 3px } .b { content: "*/"; margin: 5px }';
    expect(findViolations(css).map((v) => v.declaration)).toEqual(['padding: 3px', 'margin: 5px']);
  });

  it('keeps a slash inside a quoted font family out of the size search', () => {
    expect(count('.a { font: 10.5px "UI/Body"; }')).toBe(1);
    expect(count(".a { font: 10.5px 'UI/Body', monospace; }")).toBe(1);
    expect(count('.a { font: 10.5px "A\\"/B"; }')).toBe(1);
    expect(count('.a { font: 13px "UI/Body"; }')).toBe(0);
    expect(count('.a { font: 600 12px/1 "A/B", monospace; }')).toBe(0);
    expect(count('.a { font: 600 10.5px/1 "A/B", monospace; }')).toBe(1);
  });

  it('reads a comment between tokens as a separator, not as part of either', () => {
    expect(count('.a { padding: 8px/* c */3px; }')).toBe(1);
    expect(count('.a { padding: 8px /* 3px */ 4px; }')).toBe(0);
  });

  // A string is opaque to the tokenizer at any depth: a paren or an escaped quote
  // inside one must neither open a function nor start a second string, either of
  // which would fuse the tokens after it into one and let a bad one through.
  it('keeps a quote, a paren or an escape inside a string from fusing the tokens after it', () => {
    expect(count('.a { padding: ")" 3px; }')).toBe(1);
    expect(count('.a { padding: "(" 3px; }')).toBe(1);
    expect(count('.a { padding: var(--x, ")") 3px; }')).toBe(1);
    expect(count('.a { padding: var(--x, "(") 3px; }')).toBe(1);
    expect(count('.a { padding: \\" 3px; }')).toBe(1);
    expect(count('.a { padding: ")" 4px; }')).toBe(0);
    expect(count('.a { font: 10.5px "A)B/C"; }')).toBe(1);
  });

  it('does not end a declaration or a rule at a `;` or `}` inside a string', () => {
    const found = findViolations('.a { content: "a;b}c"; padding: 7px } .b { margin: 5px }');
    expect(found.map((x) => x.declaration)).toEqual(['padding: 7px', 'margin: 5px']);
    expect(count('.a { background: url("a;b}c.png"); padding: 7px }')).toBe(1);
  });

  it('reports a value with its comments gone and its strings untouched', () => {
    const value = (css: string): string | undefined => parseDeclarations(css)[0]?.value;
    expect(value('.a { padding: 3px/* c */5px; }')).toBe('3px 5px');
    expect(value('.a { padding: /* c */ 3px; }')).toBe('3px');
    expect(value('.a { font: 10.5px "a/* b */c"; }')).toBe('10.5px "a/* b */c"');
    expect(parseDeclarations('.a { padding: 3px /* c */ 5px; }')[0]?.value).not.toContain('/*');
  });

  it('reports a multi-line declaration on the line it starts on', () => {
    const css = [
      '.a {',
      '  color: red;',
      '  font:',
      '    600 10.5px/1 system-ui,',
      '    sans-serif;',
      '  padding: 3px;',
      '}',
    ].join('\n');
    expect(findViolations(css).map((x) => [x.line, x.declaration.split(':')[0]])).toEqual([
      [3, 'font'],
      [6, 'padding'],
    ]);
  });

  it('names a selector list that spans lines, with one space between its parts', () => {
    expect(findViolations('.a,\n.b   >   .c {\n  padding: 3px;\n}')).toEqual([
      { line: 3, selector: '.a, .b > .c', declaration: 'padding: 3px' },
    ]);
    expect(count('.a,\n.ek-b {\n  padding: 3px;\n}')).toBe(0);
  });

  it('attributes a declaration under an at-rule nested in a rule to that rule', () => {
    const css = '.a { @media (x) { padding: 3px } }';
    expect(parseDeclarations(css).map((d) => [d.selector, d.depth])).toEqual([['.a', 2]]);
    expect(count(css)).toBe(1);
    expect(count('.ek-a { @media (x) { padding: 3px } }')).toBe(0);
  });

  it('reads a property name whatever its case', () => {
    expect(count('.a { PADDING: 3px; Font-Size: 10.5px; Border-Radius: 7px; }')).toBe(3);
    expect(count('.a { PADDING: 4px; }')).toBe(0);
  });

  it('counts the rules and at-rules a declaration sits in', () => {
    const css = '.a { padding: 3px } @media (x) { .b { padding: 3px } }';
    expect(parseDeclarations(css).map((d) => [d.selector, d.depth])).toEqual([
      ['.a', 1],
      ['.b', 2],
    ]);
  });

  it('honours a /* scale-ok */ pragma after the declaration, on the same line', () => {
    expect(count('.a { font-size: 10.5px; /* scale-ok */ }')).toBe(0);
    expect(count('.a { font-size: 10.5px /* scale-ok */; }')).toBe(0);
    expect(count('.a {\n  font-size: 10.5px; /* scale-ok: matches the glyph */\n}')).toBe(0);
    expect(count('.a { font-size: 10.5px;; /* scale-ok */ }')).toBe(0);
    expect(count('.a { font-size: 10.5px; /* scale-ok */ padding: 3px; }')).toBe(1);
    expect(count('.a {\n  font-size: 10.5px;\n  /* scale-ok */\n}')).toBe(1);
    expect(count('.a {\n  /* scale-ok */\n  font-size: 10.5px;\n}')).toBe(1);
  });

  it('reads the pragma word whole: no space needed, no longer word, not mid-comment', () => {
    expect(count('.a { font-size: 10.5px; /*scale-ok*/ }')).toBe(0);
    expect(count('.a { font-size: 10.5px; /* scale-okay */ }')).toBe(1);
    expect(count('.a { font-size: 10.5px; /* not scale-ok */ }')).toBe(1);
  });

  it('finds the pragma behind other comments on the line, never past the rule', () => {
    expect(count('.a { font-size: 10.5px; /* why */ /* scale-ok */ }')).toBe(0);
    expect(count('.a { font-size: 10.5px; } /* scale-ok */')).toBe(1);
    expect(count('.a { padding: 3px; }\n.b { padding: 3px; } /* scale-ok */')).toBe(2);
  });

  it('honours a pragma anywhere inside the declaration it belongs to', () => {
    expect(count('.a { font-size: /* scale-ok */ 10.5px; }')).toBe(0);
    expect(count('.a { padding: 3px !important /* scale-ok */; }')).toBe(0);
    expect(count('.a { padding: 3px /* scale-ok */ 4px; margin: 5px; }')).toBe(1);
  });

  it('does not read a pragma out of a string', () => {
    expect(count('.a { font: 10.5px "/* scale-ok */"; }')).toBe(1);
  });

  it('puts a multi-line declaration on the line its `;` ends on', () => {
    expect(count('.a {\n  font:\n    600 10.5px/1 system-ui; /* scale-ok */\n}')).toBe(0);
    expect(count('.a {\n  font:\n    600 10.5px/1 system-ui;\n  /* scale-ok */\n}')).toBe(1);
  });

  it('does not read a declaration out of a comment', () => {
    expect(count('/* .a { font-size: 10.5px; } */ .b { color: red; }')).toBe(0);
    expect(count('.a { /* padding: 3px; */ color: red; }')).toBe(0);
  });

  it('judges the value, not the !important flag after it', () => {
    expect(count('.a { padding: 8px !important; font-size: 13px !important; }')).toBe(0);
    expect(count('.a { padding: 3px !important; font-size: 10.5px !important; }')).toBe(2);
  });

  it('holds the size in a font shorthand to the font scale, not the spacing one', () => {
    // 14px is a multiple of nothing on the spacing scale and is not a font step.
    expect(count('.a { font: 600 14px/1.2 system-ui; }')).toBe(1);
    expect(count('.a { font: 600 15px/1.2 system-ui; }')).toBe(0);
  });

  it('honours a pragma on the last declaration of a rule that has no closing semicolon', () => {
    expect(count('.a { font-size: 10.5px /* scale-ok */ }')).toBe(0);
    expect(count('.a { font-size: 10.5px }')).toBe(1);
  });
});

// The scale the guard enforces has to EXIST for a migrated value to point at.
// A `var(--sp-2)` that resolves to nothing passes the guard (every `var()` does)
// and lays out as `0`, so the tokens are pinned from the stylesheet itself.
const SCALE_TOKENS: Record<string, string> = {
  '--fs-1': '11px',
  '--fs-2': '12px',
  '--fs-3': '13px',
  '--fs-4': '15px',
  '--fs-mono': '13px',
  '--sp-1': '4px',
  '--sp-2': '8px',
  '--sp-3': '12px',
  '--sp-4': '16px',
  '--sp-5': '20px',
  '--sp-6': '24px',
  '--r-1': '4px',
  '--r-2': '6px',
  '--r-3': '10px',
  '--r-pill': '999px',
  '--ctl-h': '28px',
};

/** Custom properties declared under exactly this selector, in a stylesheet. */
function declaredUnder(css: string, selector: string): Map<string, string> {
  return new Map(
    parseDeclarations(css)
      .filter((d) => d.selector.replaceAll('"', "'") === selector)
      .map((d) => [d.prop, d.value]),
  );
}

describe('scale guard — the scale tokens (index.css :root)', () => {
  const indexCss = readFileSync(join(SRC, 'index.css'), 'utf8');

  it('declares every step in the same :root that holds the --t-* colours', () => {
    const root = declaredUnder(indexCss, ':root');
    expect(root.has('--t-base'), 'the :root that holds the colour tokens').toBe(true);
    for (const [name, value] of Object.entries(SCALE_TOKENS)) {
      expect(root.get(name), name).toBe(value);
    }
  });

  it('raises only --ctl-h, to 36px, under :root[data-mobile=true]', () => {
    const mobile = declaredUnder(indexCss, ":root[data-mobile='true']");
    expect([...mobile.entries()]).toEqual([['--ctl-h', '36px']]);
  });

  it('keys the touch height on the attribute everywhere, never on a media query or .app.mobile', () => {
    const declarations: { file: string; selector: string; depth: number }[] = [];
    for (const file of cssFiles(SRC)) {
      for (const d of parseDeclarations(readFileSync(join(SRC, file), 'utf8'))) {
        if (d.prop !== '--ctl-h') continue;
        declarations.push({ file, selector: d.selector.replace(/"/g, "'"), depth: d.depth });
      }
    }
    expect(declarations).toEqual([
      { file: 'index.css', selector: ':root', depth: 1 },
      { file: 'index.css', selector: ":root[data-mobile='true']", depth: 1 },
    ]);
  });

  it('is accepted by the guard it feeds, step for step', () => {
    for (const [name, value] of Object.entries(SCALE_TOKENS)) {
      const probe = name.startsWith('--fs-')
        ? `font-size: ${value}`
        : name.startsWith('--r-')
          ? `border-radius: ${value}`
          : name === '--ctl-h'
            ? `height: ${value}; min-height: ${value}`
            : `padding: ${value}; margin: ${value}; gap: ${value}`;
      expect(findViolations(`.a { ${probe}; }`), `${name} (${value})`).toEqual([]);
    }
    // And the mobile step, which is not in :root and so not in the table above.
    expect(findViolations('.a { height: 36px; }')).toEqual([]);
  });

  it('keeps the font and radius allow-lists equal to the declared steps', () => {
    const px = (name: string): number => Number.parseFloat(SCALE_TOKENS[name] ?? 'NaN');
    expect(new Set(['--fs-1', '--fs-2', '--fs-3', '--fs-4'].map(px))).toEqual(FONT_PX);
    expect(FONT_PX.has(px('--fs-mono'))).toBe(true);
    expect(new Set(['--r-1', '--r-2', '--r-3', '--r-pill'].map(px))).toEqual(RADIUS_PX);
  });
});

const v = (selector: string, declaration: string): Violation => ({
  line: 1,
  selector,
  declaration,
});

describe('scale guard — the ratchet', () => {
  it('passes a file exactly at its baseline', () => {
    const scanned = new Map([['a.css', [v('.a', 'padding: 3px')]]]);
    expect(ratchetProblems(scanned, { 'a.css': 1 })).toEqual([]);
  });

  it('fails a file above its baseline and names the offending values', () => {
    const scanned = new Map([['a.css', [v('.a', 'padding: 3px'), v('.b', 'font-size: 10.5px')]]]);
    const [problem, ...rest] = ratchetProblems(scanned, { 'a.css': 1 });
    expect(rest).toEqual([]);
    expect(problem).toContain('a.css has 2 off-scale declarations, baseline is 1');
    expect(problem).toContain('.a { padding: 3px }');
    expect(problem).toContain('.b { font-size: 10.5px }');
  });

  it('fails a file below its baseline until the baseline is lowered', () => {
    const scanned = new Map([['a.css', [v('.a', 'padding: 3px')]]]);
    expect(ratchetProblems(scanned, { 'a.css': 3 })).toEqual(['lower the baseline for a.css to 1']);
  });

  it('holds a file missing from the baseline to zero', () => {
    const scanned = new Map([['new.css', [v('.a', 'padding: 3px')]]]);
    expect(ratchetProblems(scanned, {})[0]).toContain('new.css has 1 off-scale declarations');
    expect(ratchetProblems(new Map([['new.css', []]]), {})).toEqual([]);
  });

  it('passes a clean stylesheet whether its entry is 0 or absent', () => {
    const clean = new Map([['clean.css', []]]);
    expect(ratchetProblems(clean, { 'clean.css': 0 })).toEqual([]);
    expect(ratchetProblems(clean, {})).toEqual([]);
  });

  it('fails a baseline entry for a stylesheet that no longer exists', () => {
    expect(ratchetProblems(new Map(), { 'gone.css': 2 })).toEqual([
      'lower the baseline for gone.css to 0',
    ]);
  });
});

describe('scale guard — the real tree', () => {
  it('scans every stylesheet under packages/client/src', () => {
    const files = [...scanTree().keys()];
    expect(files).toContain('index.css');
    expect(files).toContain('ui/ui.css');
    expect(files).toContain('settings/theme-browser.css');
  });

  it('is exactly at the committed baseline', () => {
    expect(ratchetProblems(scanTree(), baseline)).toEqual([]);
  });

  // A clean stylesheet needs no entry: absent counts as zero, which is what lets
  // the ratchet end at an EMPTY baseline (tasks.md 6.1). A new stylesheet still
  // cannot start dirty — the ratchet holds a file missing from the baseline to 0.

  // The two ratchet directions again, against REAL parses rather than hand-built
  // ones: a parser that mis-reads a real file would pass the synthetic cases above
  // and still never trip here. The violation is a controlled one appended to each
  // real file, not one of its own, so this keeps working once a file is clean.
  it('fails every real stylesheet that gains one off-scale rule, naming its line', () => {
    for (const file of cssFiles(SRC)) {
      const key = file.split(sep).join('/');
      const real = readFileSync(join(SRC, file), 'utf8');
      const n = findViolations(real).length;
      const fixtureLine = real.split('\n').length + 1;
      const scanned = new Map([
        [key, findViolations(`${real}\n.scale-fixture { padding: 3px; }\n`)],
      ]);
      const problems = ratchetProblems(scanned, { [key]: n });
      expect(problems, key).toHaveLength(1);
      expect(problems[0], key).toContain(
        `${key} has ${n + 1} off-scale declarations, baseline is ${n}`,
      );
      expect(problems[0], key).toContain(`${key}:${fixtureLine}  .scale-fixture { padding: 3px }`);
    }
  });

  it('fails every real stylesheet whose baseline is one too high, until it is lowered', () => {
    for (const [key, found] of scanTree()) {
      expect(ratchetProblems(new Map([[key, found]]), { [key]: found.length + 1 })).toEqual([
        `lower the baseline for ${key} to ${found.length}`,
      ]);
    }
  });

  it('attributes every real declaration to a rule, except the @font-face descriptors', () => {
    // A declaration with no rule around it can neither be exempted by selector nor
    // reported under one. PostCSS throws on a stray brace or quote, so what this
    // still catches is a declaration written outside any rule.
    const FONT_FACE = new Set(['font-family', 'font-style', 'font-weight', 'font-display', 'src']);
    const orphans: string[] = [];
    for (const file of cssFiles(SRC)) {
      for (const d of parseDeclarations(readFileSync(join(SRC, file), 'utf8'))) {
        if (!d.selector && !FONT_FACE.has(d.prop)) orphans.push(`${file}:${d.line} ${d.prop}`);
      }
    }
    expect(orphans).toEqual([]);
  });
});

// ── The settings panel's own sheets (apply batch 3, task 3.6) ─────────────────
//
// The ratchet above would catch a regression here by itself, but only as "file X
// has N declarations, baseline is 0" — and it would accept a sheet that reached
// zero by opting out line by line. This names what batch 3 promised.
describe('scale guard — the settings panel', () => {
  const SETTINGS_SHEETS = [
    'settings/settings-view.css',
    'settings/theme-browser.css',
    'settings/config-editor.css',
  ];

  it('has no off-scale declaration in any of its three sheets', () => {
    const tree = scanTree();
    for (const file of SETTINGS_SHEETS) {
      expect(tree.has(file), `${file} is not scanned`).toBe(true);
      expect(
        tree.get(file)?.map((v) => `${v.selector} { ${v.declaration} }`),
        file,
      ).toEqual([]);
    }
  });

  it('got there on the scale, not by opting out with a pragma', () => {
    for (const file of SETTINGS_SHEETS) {
      const css = readFileSync(join(SRC, file), 'utf8');
      expect(
        parseDeclarations(css)
          .filter((d) => d.pragma)
          .map((d) => `${d.selector} ${d.prop}`),
        file,
      ).toEqual([]);
    }
  });

  it('holds no baseline entry for them, since a clean sheet needs none', () => {
    const keys = Object.keys(baseline);
    for (const file of SETTINGS_SHEETS) expect(keys, file).not.toContain(file);
    expect(keys.filter((key) => key.startsWith('settings/'))).toEqual([]);
  });

  // The `.settings-form` block of index.css is the one part of that sheet batch 3
  // owns: the drawer's gutter rule lives in another section, with the drawer.
  it('leaves nothing off-scale in the .settings-form section of index.css', () => {
    const stray = (scanTree().get('index.css') ?? []).filter((v) =>
      /^\.settings-(?:form|section)\b/.test(v.selector),
    );
    expect(stray.map((v) => `${v.selector} { ${v.declaration} }`)).toEqual([]);
  });

  it('retired the theme picker: its stylesheet, its component, its test and its baseline key', () => {
    for (const gone of [
      'settings/theme-picker.css',
      'settings/ThemePicker.tsx',
      'settings/ThemePicker.test.tsx',
    ]) {
      expect(existsSync(join(SRC, gone)), gone).toBe(false);
    }
    expect(Object.keys(baseline)).not.toContain('settings/theme-picker.css');
    // And what replaced it is scanned, so it cannot start dirty.
    expect(existsSync(join(SRC, 'settings/theme-browser.css'))).toBe(true);
    expect(scanTree().has('settings/theme-browser.css')).toBe(true);
  });
});

// ── Kit control heights (apply batch 5, B5-R6 / B5-R8) ───────────────────────
//
// The literal guard above cannot see `min-height: var(--mbtn-h, 30px)`: a function
// value carries no number to hold against the scale. So the kit sat 2px off the
// control height on a desktop and 6px under the touch target on a phone, outside
// the drawer and Settings (which each patched their own copy). This resolves what
// REACHES a rendered kit element, once every sheet has had its say, and holds the
// box a user sees to `--ctl-h`.

/** The specificity of a selector as [ids, classes + attributes + pseudo-classes, types]. */
function specificityOf(selector: string): [number, number, number] {
  const total: [number, number, number] = [0, 0, 0];
  let rest = selector;
  let previous: string;
  // Repeated, so `:not(:is(.a))` is read from the inside out. `:where()` weighs nothing.
  do {
    previous = rest;
    rest = rest.replace(/:(not|is|has|where)\(([^()]*)\)/g, (_, name: string, args: string) => {
      if (name !== 'where') {
        const best = args
          .split(',')
          .map(specificityOf)
          .reduce((a, b) => (b[0] - a[0] || b[1] - a[1] || b[2] - a[2] > 0 ? b : a));
        total[0] += best[0];
        total[1] += best[1];
        total[2] += best[2];
      }
      return ' ';
    });
  } while (rest !== previous);
  const attributes = rest.match(/\[[^\]]*\]/g)?.length ?? 0;
  rest = rest.replace(/\[[^\]]*\]/g, ' ');
  total[0] += rest.match(/#[\w-]+/g)?.length ?? 0;
  total[1] += attributes + (rest.match(/\.[\w-]+|(?<!:):(?!:)[\w-]+/g)?.length ?? 0);
  total[2] += rest.match(/::[\w-]+|(?:^|[\s>+~])[a-z][\w-]*/gi)?.length ?? 0;
  return total;
}

interface SizeDeclaration {
  selector: string;
  prop: string;
  value: string;
  specificity: [number, number, number];
  important: boolean;
  order: number;
  /** Inside an at-rule (a media query), which this test does not evaluate. */
  conditional: boolean;
}

const SIZE_PROPS = /^(?:(?:min-|max-)?(?:height|width)|padding|border)$/;

/** Every size declaration of every sheet, in the given load order. */
function sizeDeclarations(files: string[]): SizeDeclaration[] {
  const out: SizeDeclaration[] = [];
  let order = 0;
  for (const file of files) {
    parse(readFileSync(join(SRC, file), 'utf8')).walkRules((rule) => {
      if (rule.parent instanceof AtRule && rule.parent.name.endsWith('keyframes')) return;
      const conditional = (() => {
        for (let p = rule.parent; p && p.type !== 'root'; p = p.parent) {
          if (p instanceof AtRule) return true;
        }
        return false;
      })();
      rule.walkDecls(SIZE_PROPS, (decl) => {
        order += 1;
        for (const selector of rule.selectors) {
          // A state or a pseudo-element is not the control at rest.
          if (
            /::|:(?:before|after|hover|active|focus|focus-visible|focus-within)\b/.test(selector)
          ) {
            continue;
          }
          out.push({
            selector,
            prop: decl.prop.toLowerCase(),
            value: decl.value.replace(/\s+/g, ' ').trim(),
            specificity: specificityOf(selector),
            important: decl.important,
            order,
            conditional,
          });
        }
      });
    });
  }
  return out;
}

const reaches = (el: Element, selector: string): boolean => {
  try {
    return el.matches(selector);
  } catch {
    return false;
  }
};

/** The declaration of `prop` that wins on `el`: importance, then specificity, then order. */
function winnerOn(el: Element, all: SizeDeclaration[], prop: string): SizeDeclaration | null {
  let best: SizeDeclaration | null = null;
  for (const d of all) {
    if (d.prop !== prop || d.conditional || !reaches(el, d.selector)) continue;
    if (!best) {
      best = d;
      continue;
    }
    const rank =
      Number(d.important) - Number(best.important) ||
      d.specificity[0] - best.specificity[0] ||
      d.specificity[1] - best.specificity[1] ||
      d.specificity[2] - best.specificity[2] ||
      d.order - best.order;
    if (rank > 0) best = d;
  }
  return best;
}

/**
 * A length in px, given the control height. `var(--ctl-h)`, any other scale step,
 * and a `calc()` of two lengths resolve; anything else (`var(--mbtn-h, 30px)`,
 * `auto`) is null, so a value this cannot read fails loudly instead of passing.
 */
function lengthPx(value: string | undefined, ctl: number): number | null {
  if (value === undefined) return null;
  const steps: Record<string, string> = { ...SCALE_TOKENS, '--ctl-h': `${ctl}px` };
  const flat = value
    .replace(/var\((--[\w-]+)\)/g, (whole, name: string) => steps[name] ?? whole)
    .replace(/\s+/g, ' ')
    .trim();
  const lone = /^(-?\d+(?:\.\d+)?)px$/.exec(flat);
  if (lone) return Number(lone[1]);
  const sum = /^calc\((-?\d+(?:\.\d+)?)px ([+-]) (\d+(?:\.\d+)?)px\)$/.exec(flat);
  if (!sum) return null;
  return sum[2] === '+' ? Number(sum[1]) + Number(sum[3]) : Number(sum[1]) - Number(sum[3]);
}

describe('scale guard — the length resolver the kit-height proof stands on', () => {
  it('reads the control height and the scale steps, and refuses the rest', () => {
    expect(lengthPx('var(--ctl-h)', 36)).toBe(36);
    expect(lengthPx('calc(var(--ctl-h) - var(--sp-1))', 28)).toBe(24);
    expect(lengthPx('calc(var(--ctl-h) - 6px)', 36)).toBe(30);
    expect(lengthPx('30px', 28)).toBe(30);
    expect(lengthPx('var(--mbtn-h, 30px)', 28)).toBeNull();
    expect(lengthPx('auto', 28)).toBeNull();
    expect(lengthPx(undefined, 28)).toBeNull();
  });

  it('lets the higher specificity win, and the later rule at a tie', () => {
    const el = document.createElement('button');
    el.className = 'a b';
    const winner = (...rules: [string, string][]): string | undefined =>
      winnerOn(
        el,
        rules.map(([selector, value], order) => ({
          selector,
          prop: 'height',
          value,
          specificity: specificityOf(selector),
          important: false,
          order,
          conditional: false,
        })),
        'height',
      )?.value;
    expect(winner(['.a.b', '2px'], ['.a', '1px'])).toBe('2px');
    expect(winner(['.a', '1px'], ['.b', '2px'])).toBe('2px');
    expect(winner(['.b', '2px'], ['.a', '1px'])).toBe('1px');
    expect(winner(['.a:not(.x)', '2px'], ['.a', '1px'])).toBe('2px');
  });
});

// Which rules are about a kit control, and what box each must draw (read statically,
// by the last describe of the kit-height section).
const KIT_CONTROL =
  /\.ui-(?:seg-item|seg|btn|icon-btn|input|select-trigger|collapsible-trigger)(?![\w])/;
const HEIGHT_PROPS = /^(?:min-|max-)?height$/;
const WIDTH_PROPS = /^(?:min-|max-)?width$/;

/** The last compound of a selector: what the rule is ABOUT, not what it sits in. */
const subjectOf = (selector: string): string => {
  let flat = selector;
  let previous: string;
  do {
    previous = flat;
    flat = flat.replace(/:(?:not|is|where|has)\([^()]*\)/g, '');
  } while (flat !== previous);
  return (
    flat
      .trim()
      .split(/\s*[>+~]\s*|\s+/)
      .pop() ?? ''
  );
};

/** The box a kit control subject must draw, at a given `--ctl-h`. */
const boxOf = (subject: string, ctl: number): number => {
  if (/\.ui-seg-item\b/.test(subject)) return ctl - 6;
  return /-sm\b/.test(subject) ? ctl - 4 : ctl;
};

const KIT_SHEETS = readdirSync(SRC, { recursive: true, encoding: 'utf8' })
  .filter((file) => file.endsWith('.css'))
  .map((file) => file.split(sep).join('/'))
  .toSorted();
const OTHER_SHEETS = KIT_SHEETS.filter((file) => file !== 'ui/ui.css');
const KIT_LOAD_ORDERS: [string, string[]][] = [
  ['before every other stylesheet', ['ui/ui.css', ...OTHER_SHEETS]],
  ['after every other stylesheet', [...OTHER_SHEETS, 'ui/ui.css']],
];

/** Every place this test renders the kit. FilePane's header is mirrored, not mounted (Monaco). */
const KIT_CONTEXTS: [string, (kit: ReactNode[]) => ReactNode][] = [
  ['the kit on its own', (kit) => createElement('div', null, ...kit)],
  ['the mobile drawer', (kit) => createElement('div', { className: 'drawer' }, ...kit)],
  [
    "FilePane's header",
    (kit) =>
      createElement(
        'div',
        { className: 'pane-frame fp-frame' },
        createElement('div', { className: 'pane-header fp-head' }, ...kit),
      ),
  ],
];

const kitControls = (): ReactNode[] => [
  createElement(Button, { 'data-testid': 'k-btn' }, 'Go'),
  createElement(Button, { size: 'sm', 'data-testid': 'k-btn-sm' }, 'Go'),
  createElement(IconButton, { label: 'One', 'data-testid': 'k-icon' }, 'x'),
  createElement(IconButton, { label: 'Two', size: 'sm', 'data-testid': 'k-icon-sm' }, 'x'),
  createElement(Input, { 'aria-label': 'Filter', 'data-testid': 'k-input' }),
  createElement(Select, {
    'aria-label': 'Pick',
    value: 'a',
    onChange: () => {},
    options: [{ value: 'a', label: 'A' }],
    'data-testid': 'k-select',
  }),
  createElement(Segmented, {
    label: 'View',
    value: 'a',
    onValueChange: () => {},
    options: [
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B' },
    ],
    'data-testid': 'k-seg',
  }),
  // `children` is a required prop, which createElement's positional children do not satisfy.
  // oxlint-disable-next-line react/no-children-prop
  createElement(Collapsible, { title: 'Section', children: 'Body', 'data-testid': 'k-coll' }),
];

const ctlStep = (mobile: boolean): number =>
  Number.parseFloat(
    declaredUnder(
      readFileSync(join(SRC, 'index.css'), 'utf8'),
      mobile ? ":root[data-mobile='true']" : ':root',
    ).get('--ctl-h') ?? 'NaN',
  );

describe('scale guard — kit control heights', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('data-mobile');
  });

  it('reads --ctl-h as 28px on a desktop and 36px under the mobile class', () => {
    expect([ctlStep(false), ctlStep(true)]).toEqual([28, 36]);
  });

  it('measures border-box, which is what makes a height the whole box', () => {
    expect(declaredUnder(readFileSync(join(SRC, 'index.css'), 'utf8'), '*').get('box-sizing')).toBe(
      'border-box',
    );
  });

  describe.each(KIT_CONTEXTS)('in %s', (_, mount) => {
    describe.each(KIT_LOAD_ORDERS)('with ui.css loaded %s', (__, order) => {
      it.each([false, true])(
        'draws every control exactly the control height tall (mobile: %s)',
        (mobile) => {
          if (mobile) document.documentElement.setAttribute('data-mobile', 'true');
          const ctl = ctlStep(mobile);
          const small = ctl - 4;
          const { getByTestId } = render(mount(kitControls()));
          const all = sizeDeclarations(order);
          const px = (el: Element, prop: string): number | null | undefined => {
            const won = winnerOn(el, all, prop);
            return won ? lengthPx(won.value, ctl) : undefined;
          };

          // [test id, property, the px the box must be]. `undefined` from px() is an
          // unset property; null is a value this cannot read, which is never accepted.
          const sizes: [string, string, number][] = [
            ['k-btn', 'min-height', ctl],
            ['k-btn-sm', 'min-height', small],
            ['k-icon', 'height', ctl],
            ['k-icon', 'width', ctl],
            ['k-icon-sm', 'height', small],
            ['k-icon-sm', 'width', small],
            ['k-input', 'min-height', ctl],
            ['k-select', 'height', ctl],
            ['k-seg', 'min-height', ctl],
            ['k-coll-trigger', 'min-height', ctl],
          ];
          const wrong = sizes
            .map(([id, prop, want]) => [id, prop, want, px(getByTestId(id), prop)] as const)
            .filter(([, , want, got]) => got !== want)
            .map(
              ([id, prop, want, got]) =>
                `${id} ${prop}: ${got === null ? 'unreadable' : (got ?? 'unset')}, want ${want}`,
            );
          expect(wrong).toEqual([]);

          // The box is the larger of `height` and `min-height` (a floor above the
          // height wins), so a stray floor on ANY control — an icon button's or the
          // Select trigger's included — makes it taller than the line above says.
          // A `max-height` would cap it, and a `min-width` above the width makes a
          // square icon button wide.
          const boxes: [string, number][] = [
            ['k-btn', ctl],
            ['k-btn-sm', small],
            ['k-icon', ctl],
            ['k-icon-sm', small],
            ['k-input', ctl],
            ['k-select', ctl],
            ['k-seg', ctl],
            ['k-coll-trigger', ctl],
          ];
          for (const [id, want] of boxes) {
            const el = getByTestId(id);
            const height = px(el, 'height');
            const floor = px(el, 'min-height');
            expect(
              height === null || floor === null ? Number.NaN : Math.max(height ?? 0, floor ?? 0),
              `${id} box height`,
            ).toBe(want);
            expect(px(el, 'max-height'), `${id} max-height`).toBeUndefined();
          }
          for (const id of ['k-icon', 'k-icon-sm']) {
            const el = getByTestId(id);
            const width = px(el, 'width');
            const minWidth = px(el, 'min-width');
            expect(
              minWidth === null ? Number.NaN : (minWidth ?? 0),
              `${id} min-width`,
            ).toBeLessThanOrEqual(width ?? Number.NaN);
            expect(px(el, 'max-width'), `${id} max-width`).toBeUndefined();
          }

          // The Segmented's OUTER box is the control height: its items sit inside the
          // wrapper's padding and border, so they are that much shorter than the whole.
          const seg = getByTestId('k-seg');
          const item = getByTestId('k-seg-a');
          const border = lengthPx(winnerOn(seg, all, 'border')?.value.split(' ')[0] ?? '', ctl);
          const pad = lengthPx(winnerOn(seg, all, 'padding')?.value ?? '', ctl);
          expect(border, 'the wrapper border width').not.toBeNull();
          expect(pad, 'the wrapper padding').not.toBeNull();
          expect((px(item, 'min-height') ?? NaN) + 2 * (border ?? NaN) + 2 * (pad ?? NaN)).toBe(
            ctl,
          );
        },
      );

      it('has no media query that can reach a kit control height', () => {
        const { container } = render(mount(kitControls()));
        const conditional = sizeDeclarations(order).filter(
          (d) =>
            d.conditional &&
            /^(?:min-|max-)?(?:height|width)$/.test(d.prop) &&
            [...container.querySelectorAll('*')].some((el) => reaches(el, d.selector)),
        );
        expect(conditional.map((d) => `${d.selector} { ${d.prop}: ${d.value} }`)).toEqual([]);
      });
    });
  });

  // `--mbtn-h` was the extra-keys key height, and the kit borrowed it with a 30px
  // fallback: a second control height that matched neither device class. It is
  // DECLARED nowhere either: the one declaration was `.drawer { --mbtn-h: 30px }`,
  // which is what held the drawer's kit controls at 30px, and a re-added pin would
  // do that again without any rule reading it by name here.
  it('neither reads nor declares --mbtn-h outside the extra-keys bar', () => {
    const users: string[] = [];
    for (const file of KIT_SHEETS) {
      for (const d of parseDeclarations(readFileSync(join(SRC, file), 'utf8'))) {
        if (!d.value.includes('--mbtn-h') && d.prop !== '--mbtn-h') continue;
        if (EXEMPT_SELECTORS.some((s) => d.selector.includes(s))) continue;
        users.push(`${file}:${d.line} ${d.selector} { ${d.prop}: ${d.value} }`);
      }
    }
    expect(users).toEqual([]);
  });

  // The mounted cases above prove the contexts this test builds. Contexts it does
  // not build (the chooser in the drawer, a dialog, the dock) are covered here, by
  // reading every rule whose SUBJECT is a kit control, in every sheet, whatever it
  // sits in: its height must be the control's own at both device classes.
  describe('in every stylesheet, whatever the rule sits in', () => {
    interface KitSizeRule {
      file: string;
      selector: string;
      prop: string;
      value: string;
      subject: string;
    }

    const kitSizeRules = (): KitSizeRule[] => {
      const found: KitSizeRule[] = [];
      for (const file of KIT_SHEETS) {
        parse(readFileSync(join(SRC, file), 'utf8')).walkRules((rule) => {
          if (rule.parent instanceof AtRule && rule.parent.name.endsWith('keyframes')) return;
          for (const selector of rule.selectors) {
            const subject = subjectOf(selector);
            if (!KIT_CONTROL.test(subject)) continue;
            const iconButton = /\.ui-icon-btn\b/.test(subject);
            rule.walkDecls((decl) => {
              const prop = decl.prop.toLowerCase();
              // A width is a control height only for the square icon button.
              if (!HEIGHT_PROPS.test(prop) && !(iconButton && WIDTH_PROPS.test(prop))) return;
              found.push({
                file,
                selector: selector.replace(/\s+/g, ' ').trim(),
                prop,
                value: decl.value.replace(/\s+/g, ' ').trim(),
                subject,
              });
            });
          }
        });
      }
      return found;
    };

    // Kit-control size rules that live OUTSIDE ui.css, each with its reason. A new
    // one is the shape of the drawer overrides this batch deleted: a second place
    // that decides a control's height, which then drifts from the kit's.
    const OUTSIDE_THE_KIT = new Set([
      // Settings wants an exact box where the kit sets a floor (`min-height`):
      // Button, Input and the Segmented's wrapper. The Select trigger is already
      // an exact `height` in the kit, so Settings says nothing about it.
      'settings/settings-view.css .settings-view .ui-btn height',
      'settings/settings-view.css .settings-view .ui-input height',
      'settings/settings-view.css .settings-view .ui-seg height',
    ]);

    it('holds every kit control height to the control height, at 28px and at 36px', () => {
      const wrong: string[] = [];
      for (const r of kitSizeRules()) {
        const key = `${r.file} ${r.selector} ${r.prop}`;
        for (const ctl of [28, 36]) {
          const want = boxOf(r.subject, ctl);
          const got = lengthPx(r.value, ctl);
          if (got !== want) {
            wrong.push(`${key}: ${r.value} is ${got ?? 'unreadable'} at ${ctl}px, want ${want}`);
            break;
          }
        }
      }
      expect(wrong).toEqual([]);
    });

    it('lets no stylesheet but the kit (and the reviewed few) size a kit control', () => {
      const outside = kitSizeRules()
        .filter((r) => r.file !== 'ui/ui.css')
        .map((r) => `${r.file} ${r.selector} ${r.prop}`);
      expect(outside.filter((key) => !OUTSIDE_THE_KIT.has(key))).toEqual([]);
      // Both ways: an entry whose rule is gone would document a rule nobody has.
      expect([...OUTSIDE_THE_KIT].filter((key) => !outside.includes(key))).toEqual([]);
    });

    // A rule outside the kit that states the kit's own value changes nothing, and
    // that is how a correction outlives what it corrected: Settings kept beating a
    // 30px `min-height` floor (and restating the corner beside it) after the kit
    // had moved to --ctl-h. So what a consumer says about a kit control's height
    // or corner must differ from what the kit says for that control.
    it('lets no rule outside the kit restate the kit’s own height or corner', () => {
      const SHAPE = /^(?:(?:min-|max-)?height|border-radius)$/;
      const kit = new Map<string, string>();
      parse(readFileSync(join(SRC, 'ui/ui.css'), 'utf8')).walkRules((rule) => {
        if (rule.parent?.type !== 'root') return;
        for (const selector of rule.selectors) {
          rule.walkDecls(SHAPE, (d) => {
            kit.set(`${selector} ${d.prop}`, d.value.replace(/\s+/g, ' ').trim());
          });
        }
      });
      const restated: string[] = [];
      for (const file of OTHER_SHEETS) {
        parse(readFileSync(join(SRC, file), 'utf8')).walkRules((rule) => {
          for (const selector of rule.selectors) {
            const subject = subjectOf(selector);
            if (!KIT_CONTROL.test(subject)) continue;
            rule.walkDecls(SHAPE, (d) => {
              // A Button with no size class is `md`, so the kit speaks for it there too.
              const own = [subject, `${subject}-md`].map((s) => kit.get(`${s} ${d.prop}`));
              if (own.includes(d.value.replace(/\s+/g, ' ').trim())) {
                restated.push(`${file} ${selector} { ${d.prop}: ${d.value} }`);
              }
            });
          }
        });
      }
      expect(restated).toEqual([]);
    });

    it('reads what a selector is about, not what it sits in', () => {
      expect(subjectOf('.drawer .ui-btn:not(.ui-btn-sm)')).toBe('.ui-btn');
      expect(subjectOf('.settings-view .srow-control > .ui-input')).toBe('.ui-input');
      expect(subjectOf('.ui-icon-btn svg')).toBe('svg');
      expect(KIT_CONTROL.test(subjectOf('.ui-icon-btn svg'))).toBe(false);
      expect(boxOf('.ui-btn-sm', 28)).toBe(24);
      expect(boxOf('.ui-icon-btn-sm', 36)).toBe(32);
      expect(boxOf('.ui-seg-item', 36)).toBe(30);
      expect(boxOf('.ui-seg', 36)).toBe(36);
    });

    it('sees the rules it claims to: the drawer overrides are gone, the kit rules are read', () => {
      const keys = kitSizeRules().map((r) => `${r.file} ${r.selector} ${r.prop}`);
      expect(keys).toContain('ui/ui.css .ui-btn-md min-height');
      expect(keys).toContain('ui/ui.css .ui-icon-btn-sm width');
      expect(keys).toContain('ui/ui.css .ui-seg-item min-height');
      expect(keys).toContain('settings/settings-view.css .settings-view .ui-seg height');
      expect(keys.filter((key) => /^index\.css \.drawer\b/.test(key))).toEqual([]);
    });
  });
});

// ── The end state (apply batch 5, 6.1) ───────────────────────────────────────
//
// With the baseline at zero the ratchet has nothing left to lower, so the only
// way back into off-scale values is the two doors it leaves open: a pragma and a
// new exempt selector. Both are held here, so using either is a decision made in
// this file where a reviewer sees it, not a line that slips through a stylesheet.
describe('scale guard — the end state', () => {
  const pragmas = (): (Declaration & { file: string })[] =>
    cssFiles(SRC).flatMap((file) =>
      parseDeclarations(readFileSync(join(SRC, file), 'utf8'))
        .filter((d) => d.pragma)
        .map((d) => Object.assign(d, { file: file.split(sep).join('/') })),
    );

  it('has an empty baseline: every stylesheet is on the scale, or opts out with a pragma', () => {
    expect(baseline).toEqual({});
  });

  it('opts out only with a reason after the colon', () => {
    const bare: string[] = [];
    for (const file of cssFiles(SRC)) {
      for (const body of commentBodies(readFileSync(join(SRC, file), 'utf8')).filter(isPragma)) {
        const text = body.replace(/\*\/$/, '').trim();
        if (!/^scale-ok: \S[\s\S]{14,}\S$/.test(text)) bare.push(`${file}  /*${body}`);
      }
    }
    expect(bare).toEqual([]);
  });

  // Each one is a box measured against another fixed box, never a spacing choice
  // (plan A, rule 2). Adding to this list is the review a pragma now needs.
  it('opts out only the declarations reviewed as geometry, not rhythm', () => {
    expect(
      pragmas()
        .map((d) => `${d.file}  ${d.selector}  ${d.prop}`)
        .toSorted(),
    ).toEqual([
      'dictation/dictation-view.css  .rec-toast-bar  border-radius',
      'dictation/dictation-view.css  .rec-toast-wave  gap',
      'index.css  .ctab-dot  height',
      'index.css  .dh-text  max-height',
      'index.css  .drawer-dot  height',
      'index.css  .drawer-row.drop-before::before, .drawer-row.drop-after::after  border-radius',
      'index.css  .menu-group-dot  height',
      'ui/ui.css  .ui-switch-thumb  height',
    ]);
  });

  it('shields only a declaration that really is off the scale', () => {
    const dead = pragmas().filter((d) => {
      const kind = kindOf(d.prop);
      return !kind || checkedTokens(kind, d.prop, d.value).every((t) => tokenPasses(kind, t));
    });
    expect(dead.map((d) => `${d.file}:${d.line}  ${d.selector} { ${d.prop}: ${d.value} }`)).toEqual(
      [],
    );
  });

  it('does not grow the selectors the guard skips', () => {
    expect(EXEMPT_SELECTORS).toEqual([
      '.ek-',
      '.extra-keys',
      '.term-',
      '.xterm',
      '.md-body',
      '.native-sel',
      '.sel-handle',
    ]);
  });
});
