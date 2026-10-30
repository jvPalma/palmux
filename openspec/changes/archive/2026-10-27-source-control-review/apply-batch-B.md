# Batch B — client: kit scroll primitives, projects, status store, Source Control view

Change: `source-control-review`. Tasks: **4.1 (done by the planner: `react-window@2.3.3` and
`@radix-ui/react-scroll-area@^1.4.0` are installed in `packages/client`), 4.2, 5.1, 5.2, 5.3, 5.4, and the
tips half of 5.5**. CLAUDE.md edits of tasks 4.3 and 5.5 are deferred to a docs pass after batch A, because
batch A is editing CLAUDE.md in parallel. Contract: `design.md` D3, D4, D11, D13; specs `ui-primitives`,
`sidebar-dock`, `source-control` (view, projects, live list, active project, unmerged group). Server routes
(`/scm/repo`, `/scm/status`, comments) are being built in parallel by batch A to the wire types in
`packages/shared/src/scm.ts` / `scm-comments.ts`: code against those types and mock `fetch` in tests.

Batch A owns, and batch B must NOT touch: `packages/server/**`, `packages/shared/**`,
`packages/client/src/session/tab-meta.ts`, `packages/client/src/panes/PaneHost.tsx`, `CLAUDE.md`.
If a typecheck or test failure comes from those files, report it; do not fix it.

## Streams (sequential: B1 then B2)

**B1 — kit**
- `packages/client/src/ui/ScrollArea.tsx` (Radix ScrollArea, vertical by default, a `fill` option for flex
  columns, the thumb from the tokens) and `packages/client/src/ui/VirtualList.tsx` (a thin wrapper over
  react-window 2.3.3 `List`: `rowCount`, `rowHeight` number or function or the `useDynamicRowHeight`
  result, `rowComponent`, `rowProps`, `overscanCount`, `onRowsRendered`, `listRef`, `className`, `style`;
  thin token-coloured scrollbar via `scrollbar-width`/`scrollbar-color`, matching the ScrollArea thumb).
  Export both from `ui/index.ts`. Rules in `ui/ui.css`.
- Icons the later batches need, added to `ui/icons.tsx` if missing: `git-branch` (rail and drawer),
  `check`, `undo`, `arrow-up`, `arrow-down`, `comment`, `copy` — drawn to the set's existing stroke.
- Tests: `ui/scroll.test.tsx` (10,000 rows mount fewer than 100 row elements; a growing row pushes the next
  ones down; scrollbar rules hold no colour literal), and `ui.test.tsx` / `scale.test.ts` /
  `icons.test.tsx` stay green.

**B2 — projects, status store, view, rail**
- `packages/client/src/settings/settings.ts` (+ `settings.test.ts`): `scmRepos: string[]` in
  `SYNCED_KEYS`, canonicalised with `normalizePin` (from `panes/explorer-pins.ts`), forgiving sanitiser;
  local (never synced) `scmActiveRepo: string`, `scmLayout: 'auto'|'split'|'unified'` (default `auto`),
  `scmAlgorithm` (default `histogram`), `scmWrap: boolean | null` (null = follow the width rule).
- `packages/client/src/scm/scm-api.ts` — typed fetch wrappers for `/scm/repo`, `/scm/status` (and the
  comments list the view needs for Copy comments is batch D; do not build it here).
- `packages/client/src/scm/status-store.ts` — the D3/D4 store: one per window, only subscribers whose repo
  equals the active project count, visible ones only, `document.visibilityState`, one request in flight,
  next after `max(1000, 3 × tookMs)` capped at 10 s, immediate refresh on return to visible, exposes
  the latest `ScmStatus`, `commentsRev` and `attrEpoch` for later batches; `useScmStatus(repo, visible)`
  via `useSyncExternalStore`. Fake-timer tests for every spec scenario of "The list stays live" and "Only
  the active project is read" at store level.
- `packages/client/src/scm/SourceControlView.tsx` + `scm.css` — the dock/drawer body: empty state with Add
  project; project selector (add via `/scm/repo` with the refusal message shown, switch, remove; the list
  is the synced setting, the selection the local one); Merge Changes (conflicted), Staged Changes and
  Changes groups as kit `Collapsible`s, each row file icon (`file-icons.ts`) + name + directory (dim) +
  status letter, rows activated with `pressMove` (they live in a scroller), the truncation notice; the
  list renders through `VirtualList` when a group is long (over 200 rows) and plain rows otherwise. A row
  activation calls `onOpenFile({ group, path, oldPath })`. Component tests for each `source-control` view
  scenario.
- `packages/client/src/session/DockPanel.tsx` (+ its test): `DockView` gains `scm`, `DOCK_VIEWS` order New
  tab, Explorer, Source Control, Dictation, Settings (rail order spec), icon `git-branch`, testid
  `dock-rail-scm`; `readDockView` accepts it.
- `packages/client/src/App.tsx`: render `SourceControlView` when `dockView === 'scm'`, passing `visible`
  and an `onOpenFile` that opens the group's review tab: if a tab whose url is
  `reviewUrl(group, activeRepo)` is live, select it; otherwise send `createTab { kind: 'review', url }`
  (the scroll-to-file handoff is batch C; leave a clearly named hook point). Keep every existing behaviour.
- `packages/client/src/tips/tips.ts`: a tip for Source Control (open it from the rail).

## Gates (one runner, sequential)
- `cd packages/client && npx tsc -p tsconfig.json --noEmit`
- `cd packages/client && npx vitest run src/ui src/scm src/settings src/session/DockPanel src/tips src/App.test.tsx`
- `cd /home/user/projects/palmux && npx oxlint packages/client`
A failure located in a batch-A file is reported, not fixed.
