// ── Which grammar a path resolves to ──────────────────────────────────────────
//
// Extracted from EditorPane so a NON-component module can use it: the markdown
// viewer maps a fence's language word (```ts) onto the same bundled grammars,
// and importing a React pane to reach a lookup table would be the wrong
// dependency. One table, two callers, no drift.

/**
 * Extension → Monaco language id, for the grammars `monaco-loader` actually
 * registers. Anything absent resolves to `plaintext`, which is what an
 * unregistered id would silently do anyway — naming it keeps that explicit.
 *
 * Two entries are deliberate substitutions rather than matches. `json` has no
 * basic-language grammar (its colouring lives in the language SERVICE, which is
 * a worker palmux does not load), so it borrows `javascript` — a superset of
 * every valid JSON document. `toml` has no grammar at all, and `ini` gets its
 * comments, sections and key/value pairs close enough to be worth having.
 */
const LANGUAGE_BY_EXT: Record<string, string> = {
  md: 'markdown',
  markdown: 'markdown',
  json: 'javascript',
  jsonc: 'javascript',
  json5: 'javascript',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  cfg: 'ini',
  conf: 'ini',
  properties: 'ini',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  fish: 'shell',
  ps1: 'powershell',
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  pyi: 'python',
  rb: 'ruby',
  php: 'php',
  java: 'java',
  go: 'go',
  rs: 'rust',
  lua: 'lua',
  c: 'cpp',
  h: 'cpp',
  cc: 'cpp',
  cpp: 'cpp',
  hpp: 'cpp',
  css: 'css',
  scss: 'css',
  less: 'css',
  html: 'html',
  htm: 'html',
  vue: 'html',
  svelte: 'html',
  xml: 'xml',
  svg: 'xml',
  plist: 'xml',
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql',
  tf: 'hcl',
  tfvars: 'hcl',
  hcl: 'hcl',
};

/** Files whose NAME carries the language, with no extension to read. */
const LANGUAGE_BY_NAME: Record<string, string> = {
  dockerfile: 'dockerfile',
  containerfile: 'dockerfile',
  '.bashrc': 'shell',
  '.bash_profile': 'shell',
  '.zshrc': 'shell',
  '.profile': 'shell',
  '.env': 'ini',
  '.gitconfig': 'ini',
  '.editorconfig': 'ini',
  '.tmux.conf': 'shell',
};

export const languageOf = (path: string): string => {
  const name = (path.split('/').pop() ?? '').toLowerCase();
  const byName = LANGUAGE_BY_NAME[name];
  if (byName) return byName;
  // A leading dot is part of the NAME, not an extension — `.zshrc` must not be
  // looked up as the extension `zshrc`, which is the same trap the file icons hit.
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1) : '';
  return LANGUAGE_BY_EXT[ext] ?? 'plaintext';
};
