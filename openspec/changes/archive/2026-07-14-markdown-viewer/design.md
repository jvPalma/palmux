## Context

The tab/pane machinery (chrome-tabs-and-panes, unarchived) already carries four kinds;
`editor` proves the whole path for a file-backed pane: chooser entry → `createTab` →
PaneHost render → persistence. `GET /download` (shipped) established the trust model for
absolute paths: the PTY already grants full read, so the cookie gate is the boundary.
The build's existing "markdown" chunk is Monaco's language pack — there is NO renderer.
`fontDirs` shows the config pattern for tilde-expanded directory lists
(`app-config.ts` `expandHome`).

## Goals / Non-Goals

**Goals:**

- `markdown` TabKind, path in the existing `url` field, first-class tab behavior.
- Direct-path open + roots-confined browsing; relative-link navigation; refresh.
- Sanitized rendering in a lazy chunk.

**Non-Goals:**

- Editing (that's `editor` tabs) or preview-beside-editor.
- Live file watching / auto-reload (refresh button only; follow-up if wanted).
- Rendering non-markdown formats (no HTML files — artifacts cover that — no PDFs).
- Search across roots.

## Decisions

### D1 — Path rides in `TabMeta.url`; kind gates its meaning

`web` tabs already use `url` for their target; `markdown` reuses it for the absolute
file path (server-side validation is kind-aware: web ⇒ embeddable URL, markdown ⇒
absolute path). No new protocol field, tabs-store untouched beyond the kind whitelist.
_Alternative rejected_: a dedicated `path` field — schema growth for zero expressive gain.

### D2 — Two routes, two trust levels

`GET /md-file?path=` mirrors `/download`'s posture (absolute path, cookie gate, 404/400
mapping) but returns `text/plain` content for rendering. `GET /md-list?dir=` is
STRICTER: it real-path-resolves the requested dir and requires it to be inside a
configured root (browsing is an enumeration surface the user explicitly scopes via
config; direct opens remain shell-equivalent). Listing returns
`{ dirs: string[], files: string[] }` (markdown extensions only: .md/.markdown/.mdx).

### D3 — `marked` + `dompurify`, lazily imported

`panes/markdown-render.ts` does `const { marked } = await import('marked')` etc. behind
a `renderMarkdown(text, baseDir): string` API — same lazy-chunk pattern as
`monaco-loader.ts`. DOMPurify config: forbid scripts/styles/event handlers, allow the
markdown-typical tag set; every `<a href>` gets `target="_blank" rel="noopener"` unless
it's a relative `.md` link, which is rewritten to an internal navigation handler.
Hand-rolling sanitization is the rejected alternative (a known-losing game).

### D4 — One pane, two views

`MarkdownPane` renders either the document view (breadcrumb bar: root-relative path +
Browse + refresh; body: rendered HTML) or the browser view (breadcrumbs + dir/file
list) when the tab has no path yet or Browse is clicked. Navigation mutates the tab via
the existing `updateTab { url }` control message, so the path change syncs/persists
exactly like a web tab's URL edit. Images with relative srcs resolve through
`/md-file?path=` too (rewritten at render time).

### D5 — Chooser entry with a path input

DashboardPane gains "📖 Open markdown…" alongside "Open URL…": a path input creating
`createTab({ kind: 'markdown', url: <path> })`; empty submit opens the browser view
(tab with no path). `kindIcon` 📖, `displayTitle` = basename of the path.

## Risks / Trade-offs

- **[Sanitizer misconfiguration]** → DOMPurify defaults + explicit FORBID list, plus a
  spec-pinned hostile-file test (script/onerror/javascript: all inert).
- **[Large files]** → cap `/md-file` reads (2 MB) with a clear pane message; markdown
  docs beyond that are pathological.
- **[Roots confinement bypass via symlinks]** → `realpath` both the roots and the
  requested dir before the prefix check (same guard style as artifacts traversal).
- **[Two new deps]** → both tiny, tree-shaken into the lazy chunk; versions pinned.

## Migration Plan

Additive: new kind + routes + pane. Old clients render an unknown kind's tab… check:
client `isKind` (useSplit) and PaneHost switch ignore unknown kinds — a stale client
shows the tab but no pane body; acceptable during the same-machine deploy window.
Rollback = revert diff; markdown tabs in tabs.json would be dropped by the old kind
whitelist on load (forgiving parse), harmless.

## Open Questions

- **OQ1**: default `markdownRoots` — ship `[]` (explicit opt-in) or `['~']`? Proposed:
  `[]`; the user configures deliberately, and direct paths work regardless.
