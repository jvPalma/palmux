# Tasks: preview-tabs

Read `design.md` first: every decision below is made there (D1–D9, D3a and the Contract section). Paths are
under `packages/`. Run the gates in the phase's last task before ticking it. No server restart is part of
this change: the 1.3.0 restart needs the owner's OK at that moment.

**Gate form (every phase).** `yarn typecheck`, `yarn lint`, then the scoped tests of the phase, one package
at a time: `yarn workspace @palmux/<pkg> vitest run <paths relative to that package>`. Never the full suite
before phase 8.

**Order.** Phase 1 (Alt+Z) is independent of phases 2–8: it can be implemented, gated and merged first, and
needs no server restart. Phases 2–8 run in order.

## 1. Word wrap and Alt+Z (independent, ships first)

- [x] 1.1 Add the `editorWrap` setting (D7).
  - **File:** `client/src/settings/settings.ts`.
  - **Changes:** add `editorWrap: boolean`, default `true`, not in `SYNCED_KEYS`. The sanitiser turns a
    non-boolean into `true`.
  - **Test** in `settings.test.ts`: the default, the sanitising, and that it is absent from the synced
    payload.
  - **Scenario:** editor-pane "Default".
- [x] 1.2 Apply it in the editor. **Depends on:** 1.1.
  - **Files:** `client/src/panes/editor-layout.ts`, `EditorPane.tsx`, `client/src/settings/ConfigEditor.tsx`.
  - **Changes:**
    - Remove `wordWrap` from `EditorLayoutOptions` and from what `observeEditorWidth` sends; update the
      head comment of `editor-layout.ts` that says wrap is on at every width.
    - `EditorPane` sets `wordWrap` from `editorWrap` at create, and through `updateOptions` on a settings
      change, beside `codeFontSize`.
    - `ConfigEditor` spreads `editorLayoutOptions`, so it sets `wordWrap: 'on'` itself at create (D7).
  - **Tests:**
    - `editor-layout.test.ts`: the narrow and wide options carry no `wordWrap`.
    - `EditorPane.test.tsx`: create with `editorWrap: false` passes `'off'`, and a change calls
      `updateOptions({ wordWrap: 'on' })`.
  - **Scenarios:** editor-pane "Turning it off", "A width crossing keeps it", "Markdown is unaffected"
    (no markdown file changes).
- [x] 1.3 The Settings switch (D7, F13). **Depends on:** 1.1.
  - **File:** `client/src/settings/SettingsFields.tsx`.
  - **Change:** an "Editor word wrap" Switch row (`set-editor-wrap`) in the Appearance card, after Code
    font size, writing `editorWrap` through `onChange`.
  - **Test** in `SettingsFields.test.tsx`: the switch shows the value and toggling it calls `onChange({
    editorWrap: false })`.
  - **Scenario:** editor-pane "The switch in Settings".
- [x] 1.4 Add `toggleWrap` to the review registry.
  - **Files:** `client/src/review/review-registry.ts`, `ReviewPane.tsx`.
  - **Change:** `ReviewApi.toggleWrap(): 'on' | 'off' | 'split'`. It returns `'split'` with no change in
    split layout, and otherwise calls `setPreferences({ scmWrap: !wrap })` with the resolved `wrap`
    (`resolveWrap`).
  - **Test** in `ReviewPane.test.tsx`: unified with wrap on answers `'off'` and writes `scmWrap: false`;
    split answers `'split'` and writes nothing.
  - **Scenarios:** configurable-keybindings "In a unified review", "In a side-by-side review".
- [x] 1.5 Add the action (D7). **Depends on:** 1.2, 1.4.
  - **Files:** `client/src/keybindings/keybindings.ts`, `App.tsx`.
  - **Changes:**
    - Add `toggleWrap` to `ACTIONS` with label "Toggle word wrap", and to `DEFAULT_BINDINGS` as
      `{ key: 'z', alt: true }`.
    - In App's `actionHandlers`, wire it only while the active tab's kind is `editor` or `review` (so the
      palette offers it only then):
      - editor flips `editorWrap` and toasts "Word wrap on" or "Word wrap off";
      - review calls the registry's `toggleWrap()` for the active tab and toasts by its answer ("Word wrap
        on", "Word wrap off", "Side-by-side always wraps").
  - **Tests:**
    - `keybindings.test.ts`: the default chord is unique.
    - `App.test.tsx`: Alt+Z with a terminal active is not prevented and reaches xterm; with a markdown tab
      active nothing runs; with an editor active it flips the setting and toasts.
  - **Scenarios:** configurable-keybindings "In the editor", "In the markdown viewer", "On a terminal".
- [x] 1.6 Match Alt+letter by the physical key (D8).
  - **File:** `client/src/keybindings/keybindings.ts` `chordFromEvent`.
  - **Change:** the `e.code` fallback, exactly as D8 states (AltGraph excluded).
  - **Tests** in `keybindings.test.ts`:
    - `{key:'Ω', code:'KeyZ', altKey}` → `{key:'z', alt}`;
    - `{key:'@', code:'Digit2', altKey}` unchanged;
    - `{key:'€', code:'KeyE', altKey, AltGraph}` unchanged;
    - `{key:'©', code:'KeyG', ctrlKey, altKey}` unchanged.
  - **Scenarios:** configurable-keybindings "Option+Z on a Mac", "AltGr still types".
- [x] 1.7 Tips for Alt+Z. **Depends on:** 1.5.
  - **File:** `client/src/tips/tips.ts`.
  - **Change:** one keybinding-aware tip naming the bound `toggleWrap` chord, as the other chord tips do.
  - **Test** in `tips/tips.test.ts`: the tip names the bound chord.
- [x] 1.8 Gates: `yarn typecheck`, `yarn lint`, and
  `yarn workspace @palmux/client vitest run src/settings src/panes/editor-layout.test.ts src/panes/EditorPane.test.tsx src/review/ReviewPane.test.tsx src/keybindings src/tips src/App.test.tsx`.

  - **Receipt:** Batch 1 (sonnet c1; codex review FAIL→repaired): typecheck clean, lint 0 errors, client phase-1 scope 1238/1238, ConfigEditor 40/40; browser: 8.2 check 6. Ledger: validation.md Batch 1.
## 2. Shared protocol and the per-file review url

- [x] 2.1 Add the preview fields and `replaceTab` to the protocol (D1, D3a, F8).
  - **File:** `shared/src/protocol.ts`.
  - **Changes:**
    - `TabMeta.preview?: true` and `TabMeta.replaces?: string`.
    - `CreateTabMessage.preview?: true`.
    - `UpdateTabMessage.preview?: false`.
    - `ReplaceTabMessage { type: 'replaceTab'; id: string; kind: 'editor' | 'review'; url: string }`, added to
      the client-message union.
    - `ReadyMessage.previewTabs?: true`.
    - `parseTabMeta` keeps `preview` only when it is exactly `true`, and `replaces` only when it is a string.
    - `parseServerMessage` case `'ready'` copies `previewTabs: true` only when `raw['previewTabs'] === true`,
      beside `detachedWindows`.
    - The client-message parser keeps `createTab.preview` only when `true` and `updateTab.preview` only when
      `false`; it accepts `replaceTab` only with a string `id`, a `kind` of `editor` or `review` and a string
      `url`, and drops it otherwise.
  - **Tests** in `server/src/protocol.test.ts`:
    - `preview: 'yes'`, `preview: false` on TabMeta, `replaces: 4` and a `replaceTab` with `kind: 'web'` are
      dropped;
    - the valid values round-trip;
    - `ready.previewTabs` round-trips and anything but `true` is dropped (mirroring the `detachedWindows` case).
  - **Scenarios:** workspace-tabs "Creating a preview editor", "Pinning is one-way" (parser half),
    "Backward-compatible parsing".
- [x] 2.2 Add the per-file review url (D2).
  - **File:** `shared/src/scm.ts`.
  - **Changes:**
    - Add `fileReviewUrl(group, top, path)`, returning `` `${group}-file:${encodeURIComponent(top)}:${encodeURIComponent(path)}` ``.
    - Add `isReviewFilePath(path)`: not blank, no `\0`, not starting with `/`, no `''`, `.`, `..` or `.git`
      (case-insensitive) component.
    - Extend `parseReviewUrl` to return `{ group, top, file? }`. It accepts the old `<group>:<abs top>` form
      unchanged. For the new form it splits at the first `:` after the prefix, decodes both parts, returns
      `null` when decoding throws, when the decoded top is not absolute, or when `isReviewFilePath` fails.
  - **Tests** in a new `shared/src/scm.test.ts`:
    - the old form parses as before;
    - round-trip of a path holding `:`, `%`, `#`, a space and a non-ASCII name;
    - `null` for `..`, `.git/x`, an absolute path, an empty path, `%E0%A4%A` (bad escape) and a relative top.
  - **Scenarios:** diff-review "A single file can be reviewed in its own tab".
- [x] 2.3 Title a single-file review. **Depends on:** 2.2.
  - **File:** `client/src/session/tab-meta.ts`.
  - **Change:** the review title (the `displayTitle` branch for `review`) returns `<basename(file)> (Changes)`
    or `<basename(file)> (Staged)` when `parseReviewUrl` yields a `file`, and the existing title otherwise.
  - **Test** in `tab-meta.test.ts`: both groups, plus the old form unchanged.
- [x] 2.4 Gates: `yarn typecheck`, `yarn lint`,
  `yarn workspace @palmux/shared vitest run src/scm.test.ts`,
  `yarn workspace @palmux/server vitest run src/protocol.test.ts` and
  `yarn workspace @palmux/client vitest run src/session/tab-meta.test.ts`.

  - **Receipt:** Batch 1 (sonnet c2): shared scm 12/12 incl. the lone-surrogate repair; typecheck/lint clean. Ledger: validation.md Batch 1.
## 3. Server registry

- [x] 3.1 Apply the D1 rules in the registry and the ws handlers. **Depends on:** 2.1.
  - **File:** `server/src/server.ts`.
  - **`TabRecord`** gains `preview?: true` and `replaces?: string`.
  - **`CreateTabSpec`** gains `preview?: true`, and the registry's update patch type gains `preview?: false`.
  - **ws handlers** (`case 'createTab'` at :2244, `case 'updateTab'`) forward `preview` into the registry
    calls, which today copy only named fields.
  - **Registry `createTab`:** sets `preview` only for `review`, and for `editor` with a `url`.
  - **Registry `updateTab`:** `preview: false` deletes it, and `preview: true` is ignored; a carried `name`
    or `color` (empty string included) deletes it.
  - **`groupCreate`:** deletes `preview` on every id in `ids`. **`groupUpdate`:** on every `addIds` id.
  - **`moveToWindow`:** leaves `preview` alone (session 1 Q1).
  - **Output:** `tabs()` emits `preview: true` and `replaces` when set (the `sessions` broadcast then carries
    them: preview-tabs "Another device sees the preview").
  - **Tests:**
    - `server/src/tabs-registry.test.ts`, one per rule, including that `moveToWindow` keeps a preview, and
      link-following on a pinned editor still changing its url.
    - `server/src/ws-tabs.test.ts`: a `createTab { preview: true }` and an `updateTab { preview: false }` sent
      over a real socket reach the registry (the field-threading check).
  - **Scenarios:** workspace-tabs "Creating a preview editor", "A web tab cannot be a preview", "Pinning is
    one-way", "Renaming pins", "Moving to a window keeps the preview"; preview-tabs "Colouring pins",
    "Joining a group pins" (server half).
- [x] 3.2 Add `replaceTab` (D3a). **Depends on:** 3.1, 2.2.
  - **File:** `server/src/server.ts`.
  - **Registry:** a new `replaceTab(id, { kind, url }, senderWindow: string | undefined): string | null`:
    1. validates `kind` and `url` as `createTab` does (absolute path; `canonicalReviewUrl` for a review),
       returning `null` when refused;
    2. a review url `reviewTabHolding` finds → returns that id, no change;
    3. replaceable = the record exists, has `preview`, and `record.window === senderWindow`;
    4. same kind → sets `url`, one `listChanged()`, returns `id`;
       other kind → allocates N while `id` still exists, creates N with `preview: true`, `window` copied,
       `replaces: id`, splices N into `order` at `id`'s index, removes `id` with `killTab`'s non-terminal
       teardown (snapshot forget, persistence) WITHOUT its own `listChanged()`, then one `listChanged()` and
       one `persist`; returns N;
    5. not replaceable → the same path as `createTab({ kind, url, preview: true, window: senderWindow })`.
    `replaces` is never written by `persist`.
  - **ws handler** `case 'replaceTab'`: calls it with the socket's own window (the `window` parameter of
    `handleConnection`); the other-kind path calls `restoreStore.forget(N)` when restore is on, as `createTab`
    does; runs `deps.windows.moved(windowId)` for a new id in a detached window as `createTab`
    does, and answers `tabCreated { id }` to the sender when the result is not `null`.
  - **Tests:**
    - `tabs-registry.test.ts`: same kind keeps the id; other kind with order `[1, 4, 7]` gives `[1, N, 7]`
      with exactly ONE `onListChanged` call, `replaces: '4'`, 4 gone from `tabs()` and from the persisted
      file; a pinned or absent `id` creates a new preview and leaves 4 untouched; a different `window`
      creates instead; a held review url answers the holder.
    - `ws-tabs.test.ts`: over a socket, the sender receives one `sessions` and then `tabCreated { id: N }`.
  - **Scenarios:** workspace-tabs "Replacing a preview of the same kind", "Replacing a preview of another
    kind", "Replacing a tab pinned meanwhile", "Replacing another window's preview"; preview-tabs "Another
    window pinned it first", "The preview was closed by another window" (server half).
- [x] 3.3 Persist and restore the flag. **Depends on:** 3.1.
  - **Files:** `server/src/tabs-store.ts`, plus `server.ts` `persist` (:468) and the restore loop.
  - **Changes:**
    - `PersistedTab.preview?: true`;
    - `parsePersistedTabs` keeps it only as `true` on `review` and url-bearing `editor` entries;
    - `persist` writes it when set (never `replaces`), and the restore copies it.
  - **Tests** in `tabs-registry.test.ts`: a persisted preview editor restores with `preview: true`, and a
    `preview: true` on a `web` entry is dropped.
  - **Scenario:** preview-tabs "A preview survives a restart".
- [x] 3.4 Accept the per-file review url, and announce the flag. **Depends on:** 2.2, 3.1.
  - **File:** `server/src/server.ts`.
  - **Changes:**
    - `canonicalReviewUrl` (:230) returns `fileReviewUrl(group, resolve(top), file)` for a parsed `file`.
    - Uniqueness keeps going through `reviewTabHolding`.
    - The `ready` message in `handleConnection` gains `previewTabs: true` beside `detachedWindows: true`.
  - **Tests** in `server/src/ws-tabs.test.ts`:
    - `createTab` with `changes-file:%2Fa%2F..%2Fapp:x.ts` stores `changes-file:%2Fapp:x.ts`;
    - a second create of the same url answers the first id;
    - `ready` carries `previewTabs: true`.
  - **Scenarios:** diff-review "The same file twice", preview-tabs "The server announces support".
- [x] 3.5 Gates: `yarn typecheck`, `yarn lint`, and
  `yarn workspace @palmux/server vitest run src/tabs-registry.test.ts src/ws-tabs.test.ts src/ws-handlers.test.ts src/protocol.test.ts`.

  - **Receipt:** Batch 1: server tabs-registry/ws-tabs/ws-handlers/protocol 196/196; main loop later moved `replaces` to ride only the swap's broadcast (136/136). Browser: 8.2 checks 3 and the restart. Ledger: validation.md Batch 1–2.
## 4. Client open routing and pin triggers

- [x] 4.1 Wire the new fields and gate on server support (D9, F8, F15). **Depends on:** 2.1.
  - **Files:** `client/src/lib/ws.ts`, `client/src/App.tsx`.
  - **Changes:**
    - `lib/ws.ts`: widen `sendCreateTab` with `preview?: true` and `sendUpdateTab` with `preview?: false`;
      add `sendReplaceTab(id, kind, url)`. App's `CreateSpec` gains `preview?: true`.
    - App: `previewSupportedRef`, `false` until the first `ready`, set from every `ready`
      (`msg.previewTabs === true`).
    - App: `pinTab(id)` sends `updateTab { id, preview: false }` only when `tabsRef` lists the tab with
      `preview` and the id is not in `pinSentRef`; it adds the id only when the send returned true, and
      otherwise toasts "Not connected — try again". The `sessions` handler removes an id from `pinSentRef`
      when the list shows it without `preview` or not at all. On every `ready`, each id still in `pinSentRef`
      whose tab is still a preview is sent again.
  - **Tests** in `App.test.tsx`: no `preview` field and no `replaceTab` is sent before the first `ready` or
    against a `ready` without the flag; two `pinTab` calls send one message; a pin lost to a reconnect is
    re-sent on `ready`.
  - **Scenarios:** preview-tabs "An older server".
- [x] 4.2 Place a replacing tab in place (D3a). **Depends on:** 2.1.
  - **Files:** `client/src/session/pane-grid.ts`, `App.tsx`.
  - **Changes:**
    - `reconcile`: before step 1 (drop and re-pick), for each listed tab N with `replaces: P` where some leaf
      holds P, the list does not list P and no leaf holds N, replace P's `TabRef` in that leaf IN PLACE with
      `{ id: N, kind: N.kind }` and set `active = N` if it was P. Keep reconcile pure and returning the SAME
      object when nothing changed.
    - App's `sessions` handler (the flat path, mobile layer): before it dispatches `sessionsBroadcast`, if
      `sessionIdRef.current` is P and the new list holds N with `replaces: P`, write `sessionIdRef` and set
      the selection to N in the same handler.
    - The same handler toasts "`<old name>` was replaced by another window before your edit was saved" when a
      tab that was a PREVIEW and in `dirtyRef` changed url or was replaced (F16); never for a pinned tab.
  - **Tests:**
    - `pane-grid.test.ts`: pane `[2, 4, 6]` with 4 active and a list holding 9 with `replaces: '4'` and no 4
      gives `[2, 9, 6]` with 9 active in ONE call; a second call returns the same object; N held already, P
      still listed, or P in no leaf → the ordinary rules apply.
    - `App.test.tsx`: with the mobile layer on, the selection goes P → N with no render showing the
      neighbour; the dirty-preview toast fires, and a pinned tab following a link does not toast.
  - **Scenarios:** editor-groups "A replaced preview keeps its place", "A replaced tab this window does not
    hold"; preview-tabs "Another kind is swapped in place", "Another window sees one swap" (client half).
- [x] 4.3 Add `openPreview` (D3) and the two contract functions. **Depends on:** 4.1, 4.2, 2.2.
  - **File:** `client/src/App.tsx`.
  - **Changes:**
    - Implement `openPreview({ kind, url, pin })`, steps 1–4 of D3, with `pendingPreviewRef:
      Map<leafId, PendingPreview>` exactly as D3 "The pending entry" defines it (the mobile layer uses the
      virtual pane's id).
    - Find P from the hook's `layout` (`useEditorGroups` already returns it): the leaf
      `leaves(layout).find((l) => l.id === layout.focused)` from `session/pane-grid.ts`, its `tabs` in strip
      order (filter `visibleTabsRef` by membership), excluding ids in `dirtyRef`, and its `active`. In the
      mobile layer the hook's `layout` is the one virtual leaf, so the same code applies.
    - Step 3 sends `replaceTab` for either kind; step 4 sends `createTab`.
    - The `tabCreated` handler (`App.tsx:1946`) matches `pendingPreviewRef` by content (F1): the answered
      tab's `kind` and `url` in `tabsRef` must equal an entry's `sentKind`/`sentUrl`; an id not yet listed is
      held and re-checked on the next `sessions`. On a match, apply D3 "Two opens before the first answer".
    - Drop `pendingPreviewRef` after `PENDING_REVIEW_MS` (5 s) with the toast "Could not open `<name>`".
    - Rewrite `openFileTab(path, opts?: { preview?: boolean }): 'opened' | 'held'` on top of it; add
      `openFileReview(target, opts?)`, which falls back to `openReview(target)` (and its `reviewScrollRef`
      write) without support.
  - **Tests** in `App.test.tsx`, each against a fake control socket that records sends:
    - same kind and other kind each send exactly one `replaceTab` and no `kill`, `createTab` or
      `reorderTabs`;
    - an already-open pinned target sends nothing and is shown; a pinned open of a previewed target pins it;
    - two opens before `tabCreated` end in one tab showing the second url;
    - an unrelated `sessions` (a rename) between send and answer creates no second tab;
    - no answer in 5 s toasts and sends nothing more;
    - a pinned open of the previewed or pending url sends one `updateTab { preview: false }`, before or after
      `tabCreated`;
    - `openFileTab` returns `'held'` for a held editor;
    - a dirty preview is never P; with two previews in the pane the active one is P, else the last;
    - two panes keep separate previews (preview-tabs "Each pane keeps its own preview"); a terminal from `+`
      sends no `preview` ("A new terminal is never a preview"); ten opens leave one preview ("Browsing ten
      files").
  - **Scenarios:** preview-tabs "Preview opens land in the focused pane's preview tab", "The next preview
    open replaces the preview in place", "Which preview is replaced"; editor-groups "A preview open reuses
    the pane's preview".
- [x] 4.4 Route the callers per the Contract table. **Depends on:** 4.3.
  - **Files:** `client/src/App.tsx`, `panes/FileTree.tsx`, `scm/SourceControlView.tsx`.
  - **Changes:**
    - `FileTreeProps.onOpenFile` becomes `(path: string, opts: { preview: boolean }) => void`. The file row's
      click passes `{ preview: event.detail !== 2 }`; the context-menu Open passes `{ preview: true }`. App's
      dock and drawer handlers call `openFileTab(p, opts)`; the drawer still closes first.
    - SourceControlView's `onOpenFile` becomes `(target, opts?: { preview?: boolean }) => void`. A row's
      `pressMove` activation calls it with no options (a preview open); the row also gets a native
      `onDoubleClick` that calls it with `{ preview: false }` (D4). App calls `openFileReview(t, { preview:
      opts?.preview ?? true })`.
    - `reviewHost.openFile` → `openFileTab(p, { preview: true })`.
  - **Tests:** `App.test.tsx`: an Explorer open sends `createTab` with `preview: true`, a Source Control open
    sends `createTab { kind: 'review', url: 'changes-file:…', preview: true }`; `FileTree.test.tsx`: a
    double-click's second click passes `preview: false`, Enter passes `preview: true`;
    `SourceControlView.test.tsx`: a `dblclick` on a row calls `onOpenFile(target, { preview: false })`.
    Confirm in the 8.2 browser check that `dblclick` still fires on an SCM row after `pressMove`.
  - **Scenarios:** file-browser "Selecting another file replaces the preview", "Double-click keeps the file
    open"; diff-review "Opening two files of one group"; preview-tabs "Two Enter presses do not pin".
- [x] 4.5 Pin triggers in App (D4, F9). **Depends on:** 4.1.
  - **File:** `client/src/App.tsx`.
  - **Changes:**
    - `onPaneDirty(id, true)` (`App.tsx:2393`) calls `pinTab(id)`.
    - `applyEffect`'s `'split'` case, `dropOnEdge` and `moveTabInto` call `pinTab(id)` after a commit that
      changed the layout. A same-pane drop and `placeInLayout` (cross-window) do not pin. `splitLone`
      creates a terminal and pins nothing. The `pane-grid.ts` functions stay pure.
  - **Tests** in `App.test.tsx`: a dirty transition pins; Split right of a preview in a two-tab pane pins;
    Split right on a lone tab sends no pin; a cross-window move sends no pin.
  - **Scenarios:** preview-tabs "The first edit pins in every window", "Moving to another pane", "Moving to
    another window keeps the preview"; editor-groups "Split right pins a preview".
- [x] 4.6 Pin on save (D4, F9). **Depends on:** 4.5.
  - **Files:** `client/src/panes/EditorPane.tsx`, `FileTabPane.tsx`, `FilePane.tsx`, `PaneHost.tsx`,
    `session/GroupsView.tsx`, `App.tsx`.
  - **Changes:**
    - Add `onSaved?: () => void` to `EditorPane`. It is called after a 2xx save (beside the existing
      `onSaveError(null)`, autosave included). `save()` returns `'clean' | 'started' | 'queued'`, and only
      the two Ctrl+S paths (the Monaco command and the pane-wide handler through `saveRef`) call `onSaved`
      on `'clean'`.
    - `FileTabPane` and `FilePane` pass it through. `PaneHost` takes a new `onPinTab(id)` prop and wires it;
      `GroupsView` threads `onPinTab` from App, which passes `pinTab`.
  - **Tests** in `EditorPane.test.tsx`: `onSaved` fires after a save, fires on Ctrl+S with a clean buffer,
    does not fire on a refused save, does not fire on a
    `visibilitychange` flush of a clean buffer, and fires after an autosave 2xx. `GroupsView.test.tsx`: `onPinTab` reaches `PaneHost`.
  - **Scenario:** preview-tabs "Ctrl+S on an unchanged buffer".
- [x] 4.7 Gates: `yarn typecheck`, `yarn lint`, and
  `yarn workspace @palmux/client vitest run src/App.test.tsx src/panes src/session/pane-grid.test.ts src/session/useEditorGroups.test.ts src/session/GroupsView.test.tsx src/scm`.

  - **Receipt:** Batch 2 (opus b1, sonnet b2; codex review FAIL, 6 findings repaired with failing-first tests): typecheck clean, lint 0 errors, client scope 88 files 3906/3906. Browser: 8.2 checks 1–3, extras. Ledger: validation.md Batch 2.
## 5. How a preview looks, desktop and phone

- [x] 5.1 The strip pill and its menu (D5, F13). **Depends on:** 4.1.
  - **File:** `client/src/session/SessionTabs.tsx`.
  - **Changes:**
    - The pill gets the `preview` class when `tab.preview`.
    - On a preview only: `title={`${displayTitle(tab)} — preview (double-click to keep open)`}` and
      `aria-label={`${displayTitle(tab)}, preview`}`. A pinned pill gets neither (unchanged).
    - `onDoubleClick` (:748) becomes `tab.preview ? onPin(tab.id) : startRename(tab)`, with a new
      `onPin(id)` prop wired by App to `pinTab`.
    - The context menu gains "Keep open" (`menu-keep-open`) as the first item of the EDIT group, before
      Rename (`menu-rename`, :853), with the `pin` icon, rendered only for a preview tab, calling `onPin`. Rename is unchanged.
  - **Styles** in `client/src/index.css`: `.ctab.preview .ctab-title { font-style: italic; }`.
  - **Tests:**
    - `SessionTabs.test.tsx`: double-click on a preview calls `onPin` and opens no rename field; a
      double-click on a pinned pill renames; the class, title and label are set; "Keep open" shows only for
      a preview and calls `onPin`.
    - `tab-strip-css.test.ts`: the preview rule declares only `font-style`.
  - **Scenarios:** preview-tabs "Double-click on the pill", "Keep open on a desktop", "Italic on the strip",
    "A screen reader hears it"; tab-customization "Double-click on a preview tab pins it", "Inline rename
    commits on Enter".
- [x] 5.2 The drawer row and the sheet. **Depends on:** 4.1.
  - **Files:** `client/src/session/SessionDrawer.tsx`, `TabSheet.tsx`, and `client/src/index.css` (beside
    the `.drawer-session-title` rule).
  - **Changes:**
    - Rows: the `.drawer-session` button gets the `preview` class and `aria-label={`${displayTitle(tab)},
      preview`}` (no tab number), plus `.drawer-session.preview .drawer-session-title { font-style: italic; }`.
    - `TabSheet`: a first row "Keep open" (`tab-sheet-keep-open`), rendered only for a preview tab, which
      calls a new `onPin` prop and closes the sheet. App wires it where it renders `TabSheet`.
  - **Tests:**
    - `SessionDrawer.test.tsx`: the class and the label.
    - `TabSheet.test.tsx`: the row is shown only for a preview, and tapping it pins and closes.
  - **Scenario:** preview-tabs "Keep open on a phone".
- [x] 5.3 Gates: `yarn typecheck`, `yarn lint`, and `yarn workspace @palmux/client vitest run src/session`.

  - **Receipt:** Batch 2 (sonnet b3): same gate run 3906/3906. Browser: 8.2 checks 1 and 7 (italic only, 28px pills, aria/title, Keep open menu + sheet). Ledger: validation.md Batch 2.
## 6. The single-file review

- [x] 6.1 The filter, the key and the position (D6, F7). **Depends on:** 2.2.
  - **Files:** `client/src/review/ReviewPane.tsx`, `review-model.ts`.
  - **Changes:**
    - Read `file` from `parseReviewUrl(tab.url)`.
    - `ReviewView`'s key (:1323) changes from `tab.url` to `` `${tab.id}|${group}|${top}` ``, and `file` is
      passed as a prop.
    - Filter the entry list to that path before building rows. The model key stays `group|top`.
    - On a `file` change: reset `landedRef` and the scroll anchor and land on the new file's header, clear the end and gone states, keep an in-flight write until
      it settles.
    - Feed the existing `.rv-current` bar (`ReviewPane.tsx:1241-1245`) the position `n` and total `N` from the
      unfiltered list.
  - **Tests** in `ReviewPane.test.tsx`:
    - a 53-entry status shows one file's rows, fetches one file and reports position 3 of 53;
    - changing the tab url to another file of the group swaps the rows with ONE mount of `ReviewView`;
    - a file joining the group keeps the one file and counts one more.
  - **Scenarios:** diff-review "One file only", "A single-file review lists one file", "A file joins the
    group while a single-file review is open".
- [x] 6.2 The host, moving through the group, and the composer pin (D6, D4, F6, session 1 Q4).
  **Depends on:** 6.1, 4.1.
  - **Files:** `client/src/review/review-host.ts`, `ReviewPane.tsx`, `review-registry.ts`, `App.tsx`.
  - **Host:** `ReviewHost` and `DEFAULT_REVIEW_HOST` gain `showFile(tabId, path)`, `openReview(target)` and
    `pinTab(tabId)` (no-ops in the default). App implements:
    - `showFile`: `updateTab { id: tabId, url: fileReviewUrl(group, top, path) }`, unconditional; or it
      selects the tab that already holds that url (moving it here when another window holds it); with no
      broadcast showing the tab at that url within 2 s, the toast "Could not open the next file";
    - `openReview`: App's `openReview`;
    - `pinTab`: App's `pinTab`.
    `ReviewPane` passes its own `tab.id`.
  - **Navigation:**
    - In single-file mode `nextFile` and `prevFile` use the unfiltered neighbour and call `showFile`.
    - `prevFile` from inside the file goes to its start first.
    - At the ends: the toasts "No more files in `<group>`" and "First file in `<group>`".
    - `nextChange` past the file's last change calls `showFile(next)` and lands on its first change.
  - **Reviewed and Unstage** compute the next path first and call `showFile(next)` on success; they do not
    pin. With no next path they show the end state, with `rv-end-open-review`.
  - **"No longer changed":** shown with `rv-gone-open-review` when a loaded status lacks the file.
  - **Open review:** both buttons call `host.openReview({ group, path })`.
  - **Composer pin:** when a draft editor opens in a review whose tab is a preview, call
    `host.pinTab(tabId)` once.
  - **Tests** in `ReviewNav.test.tsx` and `ReviewWrites.test.tsx`, one per scenario, plus: opening the
    composer calls `pinTab` once; Reviewed calls `showFile` and not `pinTab`; `App.test.tsx`: `showFile` with
    no broadcast in 2 s toasts.
  - **Scenarios:** every scenario of diff-review "A single-file review moves through its group", "The review
    bar in a single-file review", "Reviewed keeps a preview a preview"; preview-tabs "The comment composer
    pins a review preview", "Reviewed keeps the preview".
- [x] 6.3 Source Control's group header (D6, F10). **Depends on:** 4.4.
  - **Files:** `client/src/scm/SourceControlView.tsx`, `App.tsx`, `client/src/ui/Collapsible.tsx`,
    `client/src/ui/ui.css`.
  - **Changes:**
    - `Collapsible` gains `actions?: ReactNode`, rendered as a sibling of the Radix Trigger in a
      `.ui-collapsible-head` row (D6), so no button nests in the Trigger.
    - Each group header gets a kit `IconButton` "Open review" (`scm-open-review-<group>`, `external` icon,
      `size="sm"`, `pressMove`), calling a new `onOpenReview(group)` prop.
    - App passes `(group) => openReview({ group })` in the dock and in the drawer; the drawer closes
      first.
  - **Tests:**
    - `SourceControlView.test.tsx`: the button calls `onOpenReview('changes')` and does not toggle the
      group.
    - `ui/ui.test.tsx` (or the kit's Collapsible test): clicking an action does not toggle the section, and
      the Trigger contains no nested button.
    - `App.test.tsx`: it opens the continuous review url.
  - **Scenarios:** diff-review "Opening the whole group", "Two windows open the same group at once",
    "Staged and unstaged versions", "An older server".
  - **Coordination:** `scm-row-actions` edits this file too. Touch only the header, the new prop and the
    row's click options (4.4).
- [x] 6.4 Held reviews across windows (detached-windows delta). **Depends on:** 4.3.
  - **File:** `client/src/App.tsx`.
  - **Change:** none expected beyond D3 step 1 (a held review url of either form is moved here); confirm it
    with tests.
  - **Tests** in `App.test.tsx`: a single-file review url held by another window is moved here and shown; a
    preview open never names a P outside this window's visible tabs.
  - **Scenarios:** detached-windows "A single-file review held by the main window moves", "A preview open in
    a detached window stays in it"; preview-tabs "A preview in a detached window".
- [x] 6.5 Gates: `yarn typecheck`, `yarn lint`, and
  `yarn workspace @palmux/client vitest run src/review src/scm src/App.test.tsx`.

  - **Receipt:** Batch 2 (sonnet b4, opus b1): same gate run 3906/3906; main loop `groupName()` label fix, review 833/833. Browser: 8.2 checks 3–5. Ledger: validation.md Batch 2 + 8.2.
## 7. Docs

- [x] 7.1 Update CLAUDE.md.
  - **File:** `CLAUDE.md`.
  - **Changes:**
    - Add a "Preview tabs" paragraph under "Wire protocol" → Tabs: D1, D3 and D3a (the in-place
      `replaceTab`, the VS Code reference, the reconcile rule), D4's trigger table, the race, and rollback.
    - In "Source Control", describe the single-file review and its url form (D2), the header's Open review,
      and the rollback and deploy-window cost.
    - In the Monaco notes, replace the "wordWrap is on at every width" claim with `editorWrap`.
    - Name `toggleWrap` among the chords.
- [x] 7.2 Update the README and tips.
  - **Files:** `README.md`, `client/src/tips/tips.ts`.
  - **README:** preview tabs (italic, double-click or edit to keep), the single-file diff and the group's
    Open review, and Alt+Z.
  - **Tips:** one tip for preview tabs (the Alt+Z tip is task 1.7).
  - **Test:** `yarn workspace @palmux/client vitest run src/tips` passes.

  - **Receipt:** CLAUDE.md, README and the tips edit; `vitest run src/tips` 31/31. Ledger: validation.md Phase 7.
## 8. Integration

- [x] 8.1 Run the full gates: `yarn typecheck`, `yarn lint`, `yarn test` and `yarn build`. Report the counts.
  **Depends on:** every task above.
  - **Receipt:** typecheck clean · lint 0 errors · test 4926 + 953 + 45 = 5924 (re-run after the last fix: same) · build ok. Ledger: validation.md 8.1.
- [x] 8.2 Check it in a browser against an isolated server, never :44040: build the client into a scratch
  dir (`npx vite build --outDir /tmp/palmux-pt/dist` from `packages/client`), then run the server with
  `PALMUX_NO_AUTH=1 PALMUX_HOST=127.0.0.1 PALMUX_PORT=44099 PALMUX_CONFIG_DIR=$(mktemp -d)
  PALMUX_CLIENT_DIR=/tmp/palmux-pt/dist HOME=<scratch>` and stop it by its pid. Record each check in the
  receipt written next to this task:
  1. Ten Explorer opens leave one italic tab, and a double-click keeps it.
  2. Typing in a preview pins it in a second window.
  3. An editor preview replaced by a Source Control click stays in its strip slot: record every render of
     the strip and the pane (a `MutationObserver` on the strip and a frame log) and confirm no frame holds
     both tabs, neither, or the neighbour as active, in this window and in a second window.
  4. A Source Control click shows one file with its position; Reviewed loads the next one.
  5. Open review shows the whole group.
  6. Alt+Z flips wrap in the editor and the review, and in a terminal it types.
  7. At 390×844 the drawer row is italic and "Keep open" pins.

  - **Receipt:** All 7 checks PASS on isolated :44099 with a rAF + MutationObserver frame log in two windows; extras and restart PASS. Screenshots `.playwright-mcp/pt/`. Receipt: validation.md 8.2.