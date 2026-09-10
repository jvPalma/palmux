## 1. Kind plumbing + server routes

- [x] 1.1 `shared/protocol.ts`: add `'markdown'` to `TabKind` + `isTabKind`; kind-aware `url` validation note (markdown ⇒ absolute path) where createTab/updateTab are gated in `server.ts`.
- [x] 1.2 `app-config.ts`: `markdownRoots: string[]` (default `[]`, `expandHome`, validated like `fontDirs`); `--print-config` shows it.
- [x] 1.3 `server.ts`: `GET /md-file?path=` (absolute path, 2 MB cap, text/plain; 400/404/413 mapping like `/download`) and `GET /md-list?dir=` (realpath-confined to `markdownRoots`, returns `{ dirs, files }`, markdown extensions only).
- [x] 1.4 Registry/tabs-store: accept the new kind (persist, restart round-trip, metadata-only ws attach like editor/web).
- [x] 1.5 Server tests: routes (content, cap, confinement incl. a symlink escape attempt, no-roots refusal), kind round-trip through the store, createTab validation (markdown without absolute path rejected).

## 2. Renderer + pane

- [x] 2.1 Add `marked` + `dompurify` (pinned); `panes/markdown-render.ts` lazy chunk: `renderMarkdown(text, currentPath)` → sanitized HTML with relative-`md`-link rewriting to internal navigation, relative image srcs via `/md-file`, external links `target=_blank rel=noopener`.
- [x] 2.2 `panes/MarkdownPane.tsx`: document view (breadcrumbs, Browse, refresh, rendered body) + browser view (roots → dirs/files via `/md-list`, no-roots hint); navigation updates the tab via `updateTab { url }`.
- [x] 2.3 Wire the kind: `PaneHost` case, `DashboardPane` "Open markdown…" (path input; empty → browser view), `tab-meta.ts` icon (📖) + title (basename), `useSplit` `isKind`.
- [x] 2.4 Client tests: `markdown-render` (hostile file inert: script/onerror/javascript:; relative link rewrite; external link attrs), `MarkdownPane` (load/refresh/browse/navigate with mocked fetch), chooser creates the right spec.

## 3. Docs + verification

- [x] 3.1 tips + README (viewer, roots config, direct path) + CLAUDE.md (kind list, routes, trust model note).
- [x] 3.2 `yarn typecheck` + `yarn test` green.
- [x] 3.3 Live e2e on isolated `:44041`: open by path (a real skills reference file), browse a configured root, click a relative link, hostile-file check, split a markdown pane beside a terminal, restart persistence. Never prod `:44040`.
- [x] 3.4 `openspec validate markdown-viewer --strict`.
