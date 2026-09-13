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
import { buildMonacoTheme, editorProfile, onEditorProfile } from './monaco-theme';

let configured = false;

/**
 * Register `palmux` from whatever palette App last published.
 *
 * `defineTheme` alone does not repaint a LIVE editor — Monaco re-reads the data
 * only on `setTheme` — so a change needs both, in this order.
 */
function applyTheme(): void {
  const profile = editorProfile();
  if (!profile) return; // App has not published one yet; the base default stands
  monaco.editor.defineTheme(
    'palmux',
    buildMonacoTheme(profile) as monaco.editor.IStandaloneThemeData,
  );
  monaco.editor.setTheme('palmux');
}

/** Monaco with the palmux theme registered and workers wired (idempotent). */
export function getMonaco(): typeof monaco {
  if (configured) return monaco;
  configured = true;

  (self as { MonacoEnvironment?: monaco.Environment }).MonacoEnvironment = {
    // Markdown/plaintext tokenize on the main thread; only the base editor
    // worker is ever requested for the languages we open.
    getWorker: () => new EditorWorker(),
  };

  applyTheme();
  // From here on the app's theme changes reach the editor. Registering only
  // once Monaco exists is what keeps the editor chunk out of a terminal-only
  // session: until then `setEditorProfile` just remembers the palette.
  onEditorProfile(applyTheme);
  return monaco;
}

/** True once Monaco is in memory — lets a caller skip work that would load it. */
export const monacoLoaded = (): boolean => configured;
