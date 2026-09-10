## Why

Markdown is the lingua franca of everything on this machine (Claude skills, notes, docs,
reference files), but palmux can only show it as raw text in a terminal or as source in an
editor tab. The user wants to READ rendered markdown in place: open a specific file by
absolute path (`/home/user/work/.claude/skills/.../courts.md`) or browse configurable
folders and click through files — without leaving the workspace.

## What Changes

- **New tab kind `markdown`**: a read-only rendered-markdown viewer pane. The file's
  absolute path rides in the tab's existing `url` metadata field (no TabMeta schema
  growth); title defaults to the filename.
- **Two ways in**: the new-tab chooser gains "Open markdown" with a path input (any
  absolute `.md` path — same shell-trust model as `/download`), and a **file browser**
  over configurable roots (`markdownRoots` in config.json, tilde-expanded like
  `fontDirs`) shown when the viewer has no file or via its breadcrumb/Browse control.
- **Server routes**: `GET /md-file?path=` (raw markdown text; cookie-gated, absolute
  path by design) and `GET /md-list?dir=` (directory listing — RESTRICTED to the
  configured roots subtree, since browsing is a UI surface, unlike explicit paths).
- **Safe rendering**: markdown → HTML client-side in a lazy chunk (terminal-only use
  downloads nothing), sanitized before injection (arbitrary files must never script the
  app). Relative links between markdown files resolve and open in the same pane;
  a refresh control re-reads the file.
- Markdown tabs persist/restart/split/reorder exactly like other non-terminal tabs.

## Capabilities

### New Capabilities

- `markdown-viewer`: the markdown tab kind, its open paths (direct path + root
  browsing), safe rendering, and its server file/list routes.

### Modified Capabilities

<!-- none archived yet; the tab-kind machinery changes are additive to the unarchived
     chrome-tabs-and-panes change and are expressed as ADDED requirements. -->

## Impact

- **Shared**: `protocol.ts` `TabKind` union + `isTabKind` gain `'markdown'`.
- **Server**: `app-config.ts` (`markdownRoots: string[]`), `server.ts` (two routes +
  registry accepts the new kind; attach stays metadata-only like editor/web),
  `tabs-store.ts` (kind whitelist).
- **Client**: `panes/MarkdownPane.tsx` (NEW: viewer + browser + breadcrumbs),
  `panes/markdown-render.ts` (NEW lazy chunk: parse + sanitize), `PaneHost.tsx`,
  `DashboardPane.tsx` (chooser entry), `session/tab-meta.ts` (icon/title),
  `useSplit.ts` `isKind`.
- **Dependencies**: `marked` + `dompurify` (client) — small, standard, justified: no
  markdown renderer exists in the bundle (the "markdown" chunk is Monaco's language
  pack) and sanitization must not be hand-rolled.
- **Docs**: tips, README, CLAUDE.md.
