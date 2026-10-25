// The "no glyph icons in chrome" guard.
//
// Chrome icons come from `ui/icons.tsx`. A ✕ or a 🌐 typed into JSX still works
// — it renders as whatever fallback face the platform has, at whatever weight it
// has — so nothing fails at runtime when one creeps back. The sources are read as
// TEXT instead, the way ui.test.tsx reads ui.css for colour literals.
//
// Sources are read as UTF-8, never through a tool that sniffs for binary:
// `panes/FileTree.tsx` holds a literal NUL inside a template string, so ripgrep
// and grep skip it as "binary", and it is exactly where a review round found
// glyphs a first scan had missed.

import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { ICON_NAMES } from './icons';

const SRC = join(__dirname, '..');

/** Prose and sample data, not chrome: tip text, the fake shell in the theme
 *  preview (✔ ❯ are what a real prompt prints), and the keybinding labels. */
const EXCLUDED = new Set([
  'tips/tips.ts',
  'settings/theme-preview.ts',
  'keybindings/keybindings.ts',
]);

/** The only two modules allowed to draw an `<svg>` themselves. */
const SVG_MODULES = new Set(['ui/icons.tsx', 'mobile/key-icons.tsx']);

/** Text glyphs that stand in for an icon. Emoji are caught by the property
 *  escape below; these are the non-emoji ones that read as a button face. */
const FORBIDDEN = new Set([...'✕☰⚙✓✔☑☐⬆⬇✎❯⇱↩↵⚠▶❚↗⏏⏳⟳⧉▾▴▸‹›◆◉▦⬍⬌＋●']);
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;

const FIRST_JSDOC = ts.SyntaxKind.FirstJSDocNode;
const LAST_JSDOC = ts.SyntaxKind.LastJSDocNode;

/**
 * `src` with every comment blanked out. Newlines survive so a hit reports the
 * line the editor shows.
 *
 * Found by the TypeScript PARSER, not by reading characters. Whether a `/` opens
 * a regex or divides, whether a `}` resumes a template literal, and whether a
 * `//` is JSX text are decisions only a parse makes — a bare scanner leaves all
 * three to its caller (`reScanSlashToken`, `reScanTemplateToken`,
 * `scanJsxToken`), and the character loop this replaced got the first one
 * wrong: it read `/\//`'s closing slashes as a line comment and dropped the
 * icons after them. What lies between two tokens is only whitespace and
 * comments, so a scanner run over each of those gaps collects exactly the
 * comment trivia. JSX text owns its own whitespace, so its gap never holds one.
 */
function stripComments(src: string, kind: ts.ScriptKind = ts.ScriptKind.TSX): string {
  const file = ts.createSourceFile('scan.tsx', src, ts.ScriptTarget.Latest, true, kind);
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.JSX);
  const comments: [number, number][] = [];
  const visit = (node: ts.Node): void => {
    // A JSDoc block is a child node AND the leading trivia of the token after
    // it; that token's gap blanks it, so its insides are never walked.
    if (node.kind >= FIRST_JSDOC && node.kind <= LAST_JSDOC) return;
    const children = node.getChildren(file);
    if (children.length > 0) {
      children.forEach(visit);
      return;
    }
    const gapStart = node.getFullStart();
    const gapEnd = node.getStart(file);
    if (gapEnd <= gapStart) return;
    scanner.setText(src, gapStart, gapEnd - gapStart);
    for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken;) {
      if (
        token === ts.SyntaxKind.SingleLineCommentTrivia ||
        token === ts.SyntaxKind.MultiLineCommentTrivia
      ) {
        comments.push([scanner.getTokenStart(), scanner.getTokenEnd()]);
      }
      token = scanner.scan();
    }
  };
  visit(file);
  // Offsets are UTF-16 units, as string indices are. A range can be seen twice
  // (an empty node shares the gap of the token after it), hence the cursor.
  let result = '';
  let cursor = 0;
  for (const [start, end] of comments.toSorted((a, b) => a[0] - b[0])) {
    if (start < cursor) continue;
    result += src.slice(cursor, start) + src.slice(start, end).replace(/[^\n]/g, ' ');
    cursor = end;
  }
  return result + src.slice(cursor);
}

/** Parse `.ts` as TS: in TSX mode `<T>x` is an element, not a cast. */
const kindOf = (file: string): ts.ScriptKind =>
  file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;

/** `line: glyph(s)` for every forbidden character left in code. */
function findGlyphs(src: string, kind?: ts.ScriptKind): string[] {
  const hits: string[] = [];
  stripComments(src, kind)
    .split('\n')
    .forEach((line, index) => {
      const found = new Set<string>();
      for (const ch of line) if (FORBIDDEN.has(ch) || PICTOGRAPHIC.test(ch)) found.add(ch);
      if (found.size > 0) hits.push(`${index + 1}: ${[...found].join(' ')}`);
    });
  return hits;
}

/** Non-test `.ts`/`.tsx` under `src`, keyed relative to it with `/` separators. */
function sources(): string[] {
  return readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .map((file) => file.split(sep).join('/'))
    .filter(
      (file) =>
        /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file) && !file.includes('node_modules/'),
    )
    .toSorted();
}

describe('the scanner itself', () => {
  it('flags an emoji and a listed glyph in code', () => {
    expect(findGlyphs(`const a = '🌐';\nconst b = '✕';`)).toEqual(['1: 🌐', '2: ✕']);
  });

  it('ignores a glyph in a line or block comment', () => {
    expect(findGlyphs(`// ✕ closes\n/* ☰ opens\n   ⟳ */\nconst a = 1;`)).toEqual([]);
  });

  it('is not fooled by `//` inside a string', () => {
    expect(findGlyphs(`const a = ['https://x.test', '✕'];`)).toEqual(['1: ✕']);
  });

  // Whether a `/` opens a regex, whether a `}` resumes a template, and whether a
  // `//` sits in JSX text are decisions only a parse can make. A character loop
  // took `/\//`'s escaped slash and closing slash for a line comment.
  it('is not fooled by a regex literal that contains or ends in a slash', () => {
    expect(findGlyphs(`const icon = /\\//.test(path) ? '🌐' : '✕';`)).toEqual(['1: 🌐 ✕']);
    expect(findGlyphs(`const a = x.split(/[/]/); const b = '✕';`)).toEqual(['1: ✕']);
  });

  it('reads JSX text as text, not as code', () => {
    expect(findGlyphs(`const a = <p>see http://x.test ✕</p>;`)).toEqual(['1: ✕']);
    expect(findGlyphs(`const a = <p>don't</p>; // the old ✕\nconst b = 1;`)).toEqual([]);
    expect(findGlyphs(`const a = <p title="it's">{/* ✕ */}☰</p>;`)).toEqual(['1: ☰']);
  });

  it('follows a template literal through its expressions', () => {
    expect(findGlyphs("const a = `${`//`}` + '✕';")).toEqual(['1: ✕']);
    expect(findGlyphs('const a = `x ${/* ✕ */ y} z`;')).toEqual([]);
    expect(findGlyphs('const a = `x ${y // ✕\n} ☰`;')).toEqual(['2: ☰']);
  });

  it('keeps an inline <svg> that follows a regex visible to the svg guard', () => {
    expect(stripComments(`const el = /\\//.test(p) && <svg />;`)).toMatch(/<svg\b/);
  });

  it('leaves the plain arrows legal in prose', () => {
    expect(findGlyphs(`const a = 'input→paint';`)).toEqual([]);
  });

  // JSX comments (`{/* ... */}`) are how the chrome explains a glyph it removed
  // ("replaces the old ⌨ Keyboard cell"); they must not trip the guard.
  it('ignores a glyph in a JSX comment but not in the JSX text beside it', () => {
    expect(findGlyphs(`<a>{/* the old ✕ */}</a>`)).toEqual([]);
    expect(findGlyphs(`<a>{/* the old ✕ */}ok ☰</a>`)).toEqual(['1: ☰']);
  });

  // Typed out here on purpose, separately from FORBIDDEN: the plan's list is the
  // contract, and a glyph quietly dropped from the set would stop being caught
  // while every other test stayed green.
  it('flags every glyph the plan lists, and the emoji it replaced', () => {
    const plan = [...'✕☰⚙✓✔☑☐⬆⬇✎❯⇱↩↵⚠▶❚↗⏏⏳⟳⧉▾▴▸‹›◆◉▦⬍⬌＋●'];
    expect(plan).toHaveLength(34);
    for (const glyph of plan) expect(findGlyphs(`const a = '${glyph}';`), glyph).toHaveLength(1);
    for (const emoji of ['🌐', '📖', '🔗', '📂', '📁', '📄', '📌', '🖼', '🔉', '🎤', '🔴', '⏳']) {
      expect(findGlyphs(`const a = '${emoji}';`), emoji).toHaveLength(1);
    }
  });
});

describe('chrome icons', () => {
  const files = sources();

  it('excludes only prose files that still exist', () => {
    // A renamed file would leave a stale exclusion that quietly excuses nothing,
    // and its replacement would be scanned as chrome.
    for (const file of EXCLUDED) expect(files, file).toContain(file);
    expect(EXCLUDED.size).toBe(3);
  });

  it('scans the files a binary-sniffing grep skips', () => {
    expect(files).toContain('panes/FileTree.tsx');
    expect(readFileSync(join(SRC, 'panes/FileTree.tsx'), 'utf8')).toContain('\u0000');
  });

  it('use no emoji or glyph characters outside the prose exclusions', () => {
    const offenders = files
      .filter((file) => !EXCLUDED.has(file))
      .flatMap((file) =>
        findGlyphs(readFileSync(join(SRC, file), 'utf8'), kindOf(file)).map(
          (hit) => `${file}:${hit}`,
        ),
      );
    expect(offenders).toEqual([]);
  });

  it('draw their <svg> in the two icon modules only', () => {
    const offenders = files
      .filter((file) => file.endsWith('.tsx') && !SVG_MODULES.has(file))
      .filter((file) =>
        /<svg\b/.test(stripComments(readFileSync(join(SRC, file), 'utf8'), kindOf(file))),
      );
    expect(offenders).toEqual([]);
  });
});

// `<Icon name>` takes a plain string (a config-supplied name must degrade to its
// text label), so a typo compiles and draws nothing, and the glyph scan above
// cannot see it. Every name written out in a source file has to be registered.
describe('icon names', () => {
  /** Names written as a literal, or as the branches of a ternary, in `<Icon name=…>`. */
  function namedIn(src: string, kind?: ts.ScriptKind): string[] {
    const names: string[] = [];
    for (const m of stripComments(src, kind).matchAll(/<Icon\s+name=(?:"([^"]+)"|\{([^}]*)\})/g)) {
      if (m[1] !== undefined) names.push(m[1]);
      else {
        // `cond === 'row' ? 'a' : 'b'`: only what follows the `?` is a name.
        const expr = m[2] ?? '';
        const branches = expr.includes('?') ? expr.slice(expr.indexOf('?')) : expr;
        for (const q of branches.matchAll(/['"]([^'"]+)['"]/g)) names.push(q[1] as string);
      }
    }
    return names;
  }

  it('reads literal and ternary names, and not the comparison in a condition', () => {
    expect(namedIn(`<Icon name="close" size={14} />`)).toEqual(['close']);
    expect(namedIn(`<Icon name={on ? 'check' : 'dot'} />`)).toEqual(['check', 'dot']);
    expect(namedIn(`<Icon name={o === 'row' ? 'rotate-row' : 'rotate-col'} />`)).toEqual([
      'rotate-row',
      'rotate-col',
    ]);
    expect(namedIn(`<Icon\n  name="pin"\n/>`)).toEqual(['pin']);
    expect(namedIn(`<Icon name={kindIcon(kind)} />`)).toEqual([]);
    expect(namedIn(`// <Icon name="nope" />`)).toEqual([]);
  });

  it('every name a source file writes is registered', () => {
    const used = sources().flatMap((file) =>
      namedIn(readFileSync(join(SRC, file), 'utf8'), kindOf(file)).map((name) => ({ file, name })),
    );
    // Rot guard: the regexp matching nothing would pass the check below vacuously.
    expect(used.length).toBeGreaterThan(40);
    const unknown = used.filter(({ name }) => !(ICON_NAMES as readonly string[]).includes(name));
    expect(unknown).toEqual([]);
  });
});
