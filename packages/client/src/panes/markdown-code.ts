// ── Syntax highlighting for fenced code blocks ────────────────────────────────
//
// The viewer emitted `<pre><code class="language-ts">` and nothing coloured it —
// measured: zero spans inside a rendered code block. The question this answers is
// whether palmux could reuse VS Code's markdown preview instead: it cannot.
// That preview is not part of Monaco. It is a separate VS Code extension
// (`markdown-language-features`) running markdown-it inside a webview, and
// `monaco-editor` does not ship it.
//
// What IS reachable is the thing underneath it: Monaco's own tokenizer, via
// `monaco.editor.colorize()`. That buys the same 23 monarch grammars already in
// the lazy chunk, coloured by the SAME `palmux` theme the editor uses — one
// source of colour for the editor and the viewer, no new dependency, and a
// palette change repaints both. A highlighter with its own theme would have
// re-created the very bug this batch is fixing, one layer over.
//
// The cost is honest and bounded: a markdown document containing a fenced block
// pulls the monaco chunk. A document without one does not, and neither does a
// terminal-only session.

import { languageOf } from './editor-language';

/** `language-ts` → `ts`; anything else → null (nothing to colour with). */
export function langFromClass(className: string): string | null {
  for (const c of className.split(/\s+/)) {
    if (c.startsWith('language-')) {
      const id = c.slice('language-'.length).trim().toLowerCase();
      return id || null;
    }
  }
  return null;
}

/**
 * Map a fence's language word onto a grammar palmux actually bundles.
 *
 * A fence says `sh`, `zsh` or `console`; the grammar is called `shell`. Reusing
 * `languageOf`, which already resolves a FILENAME to a bundled grammar, keeps
 * one table instead of two that drift — so `ts` is looked up as `x.ts`.
 */
export function grammarFor(lang: string): string | null {
  const direct: Record<string, string> = {
    sh: 'shell',
    zsh: 'shell',
    bash: 'shell',
    console: 'shell',
    shell: 'shell',
    json: 'javascript', // no basic-language grammar; a superset colours it
    jsonc: 'javascript',
    text: '',
    plaintext: '',
    txt: '',
  };
  if (lang in direct) return direct[lang] || null;
  const byExt = languageOf(`x.${lang}`);
  return byExt === 'plaintext' ? null : byExt;
}

/**
 * Colour every fenced block in `root`, in place.
 *
 * Loads Monaco only when there is something to colour. Each block is replaced by
 * Monaco's own markup, which carries inline colours from the active theme — so
 * this must run AFTER the theme is registered, which `getMonaco()` guarantees.
 * A block whose language has no grammar is left exactly as it was rather than
 * being mangled into plaintext spans.
 */
export async function highlightCodeBlocks(root: ParentNode): Promise<void> {
  const blocks = [...root.querySelectorAll('pre > code[class*="language-"]')];
  const work = blocks
    .map((el) => {
      const lang = langFromClass(el.className);
      const grammar = lang ? grammarFor(lang) : null;
      return grammar ? { el, grammar } : null;
    })
    .filter((x): x is { el: Element; grammar: string } => x !== null);
  if (work.length === 0) return;

  const { getMonaco } = await import('./monaco-loader');
  const monaco = getMonaco();
  await Promise.all(
    work.map(async ({ el, grammar }) => {
      try {
        // textContent, not innerHTML: the block has already been sanitized and
        // colorize re-escapes what it emits.
        const html = await monaco.editor.colorize(el.textContent ?? '', grammar, {});
        el.innerHTML = html;
        el.classList.add('md-hl');
      } catch {
        // A grammar that fails to tokenize leaves the plain text in place. A
        // half-coloured block is worse than an uncoloured one.
      }
    }),
  );
}
