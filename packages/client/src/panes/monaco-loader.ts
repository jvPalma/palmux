// ── Monaco loader ─────────────────────────────────────────────────────────────
//
// The ONLY module that imports monaco-editor. EditorPane pulls it in via a
// dynamic import(), so vite splits monaco (and its editor worker) into lazy
// chunks — a client that never opens an editor tab downloads none of it.
// Everything is self-hosted; a CDN would break the offline bundle and PWA.

// editor.all = every core EDITOR feature (find widget, multi-cursor, link
// detection …) with NONE of the language SERVICES — importing the package root
// instead would emit a 7 MB ts.worker plus the css/html/json service workers.
import 'monaco-editor/esm/vs/editor/editor.all.js';

// GRAMMARS are a different thing from services, and cheap. Each of these is a
// monarch tokenizer of a few KB that colours text on the main thread; none of
// them pulls a worker, an IntelliSense engine or a validator. The editor used to
// carry markdown alone, so a .json read exactly like a .txt — dark background,
// white text — which is what the file browser's Read/Edit toggle is FOR.
//
// This is the list of things a terminal user actually opens from a file tree.
// Adding one is an import; the cost is in the lazy monaco chunk, which a client
// that never opens an editor still never downloads.
import 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/shell/shell.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/python/python.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/css/css.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/html/html.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/xml/xml.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/sql/sql.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/dockerfile/dockerfile.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/ini/ini.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/rust/rust.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/go/go.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/lua/lua.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/php/php.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/java/java.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/ruby/ruby.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/hcl/hcl.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/graphql/graphql.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/powershell/powershell.contribution.js';
// JSON has no basic-language contribution — its colouring lives in the language
// SERVICE, which is a worker. `json` therefore falls back to plaintext, and
// palmux maps it to the `javascript` grammar instead: a superset for every valid
// JSON document, and it costs nothing extra because javascript is already here.

import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';

let configured = false;

/** Monaco with the palmux theme registered and workers wired (idempotent). */
export function getMonaco(): typeof monaco {
  if (configured) return monaco;
  configured = true;

  (self as { MonacoEnvironment?: monaco.Environment }).MonacoEnvironment = {
    // Markdown/plaintext tokenize on the main thread; only the base editor
    // worker is ever requested for the languages we open.
    getWorker: () => new EditorWorker(),
  };

  const css = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  monaco.editor.defineTheme('palmux', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': token('--t-base', '#1e1e2e'),
      'editor.foreground': token('--t-text', '#cdd6f4'),
      'editorLineNumber.foreground': token('--t-subtext', '#9399b2'),
      'editorCursor.foreground': token('--t-accent', '#a6e3a1'),
      'editor.selectionBackground': `${token('--t-surface', '#313244')}cc`,
      'editorWidget.background': token('--t-mantle', '#181825'),
    },
  });
  return monaco;
}
