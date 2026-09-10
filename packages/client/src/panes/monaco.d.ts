// Monaco's package `exports` map ("./*": "./*") lets us import the lean ESM
// entry points (editor.api + only the features/languages we want, so vite never
// bundles the 7 MB ts.worker or the css/html/json workers). TypeScript can't
// resolve those deep paths under Bundler resolution, so map them here. Types for
// the API come from the package root, which declares the full monaco namespace.

declare module 'monaco-editor/esm/vs/editor/editor.api.js' {
  export * from 'monaco-editor';
}
declare module 'monaco-editor/esm/vs/editor/editor.all.js';
declare module 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution.js';
