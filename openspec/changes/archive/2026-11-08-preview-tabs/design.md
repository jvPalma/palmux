# Design: preview-tabs

Source: brief `openspec/brainstorms/2026-11-02-v1-3-scm-cli-preview.md`, items 7, 8 and 14. Specs: the
`preview-tabs` capability plus deltas to `workspace-tabs`, `tab-customization`, `file-browser`,
`editor-groups`, `diff-review`, `detached-windows`, `editor-pane` and `configurable-keybindings`.
Refinement session 1 (`questions-session1.md`) decided Q1–Q5 and accepted fixes F1–F18; the
"Session 1 decisions" section at the end maps each to where it is applied.

## Context

How the code works today (`release/1.3.0` at 0182f12; exact line numbers where they were checked,
symbol names otherwise):

- **Tabs are server state.** `TabMeta { id, kind, name?, color?, url?, title?, groupId?, window? }`
  (`shared/src/protocol.ts:77`, parsed by `parseTabMeta` at :461). Every main window on every device shows
  every tab with no `window` (`detached-windows` "A tab is shown by exactly one window").
- **Opening a file.** `App.openFileTab(path)` (`App.tsx:2506`):
  - it finds an `editor` tab with `url === path` in `tabsRef`;
  - a visible tab is selected; a tab held by another window gets the toast "`<name>` is open in another
    window";
  - with no tab, it sends `createTab { kind: 'editor', url: path }`.
- **Opening a review.** `App.openReview(target)` (`App.tsx:2540`) builds `reviewUrl(group, top)`
  (`shared/src/scm.ts`, `<group>:<abs top>`), parks the scroll target in `reviewScrollRef`, and selects,
  moves or creates the one review tab of that group. The server dedupes a review by its canonical url
  (`server.ts` `canonicalReviewUrl` :230, `reviewTabHolding` :422, registry `createTab` :783).
- **A create is answered after its broadcast.** The ws `createTab` handler (`server.ts:2244`) calls
  `registry.createTab`, whose `listChanged()` runs `broadcastSessions` synchronously
  (`registry.onListChanged(broadcastSessions)`, :1851), and only then sends `tabCreated { id }` to the
  sender. On the sender's socket the list therefore always arrives first. App's `tabCreated` handler
  (`App.tsx:1946`) looks the id up in `tabsRef` and clears `pendingReviewsRef` by the answered url.
- **The server knows a socket's window.** The upgrade handler reads `&window=<wid>` into `windowId`
  (`server.ts` near :1983) and passes it to `handleConnection`, so a message handler can compare a tab's
  `window` with the sender's.
- **Where a new tab goes.** It joins the focused pane (`editor-groups`, `useEditorGroups` `show`). The
  mobile layer is one virtual pane holding every tab.
- **A vanished tab moves the selection.** `reconcile` (`session/pane-grid.ts:520`) drops a tab that is gone
  or listed as another kind, re-picks the pane's active tab by the left-then-right close rule, and adds a
  tab no pane holds to the focused pane INACTIVE. The flat path (mobile) does the same through
  `workspaceController`'s `sessionsBroadcast`. A tab closed and another created therefore show the
  neighbour for at least one render, and other windows show a tab leave and another arrive.
- **Changing a tab's url.** `updateTab { id, url }` (`server.ts:832`) already changes the url of an
  editor, markdown, web or review tab. A file tab in Read mode uses it to follow a relative `.md` link
  (`PaneHost.tsx:108` → `App.changeTabUrl`). `EditorPane` reloads when its `src` changes (effect deps at
  `EditorPane.tsx:233`).
- **The review remounts per url.** `ReviewPane` renders `<ReviewView key={tab.url} …>`
  (`ReviewPane.tsx:1323`), so any url change remounts the view.
- **The review host.** `ReviewHost` (`review/review-host.ts:29`) holds the preferences, `openTick` and
  callbacks such as `openFile`; it has no tab id.
- **Double-click on a pill renames** (`SessionTabs.tsx:748`).
- **Wrap.**
  - Monaco's `wordWrap` is hard-coded `'on'` and re-sent on every narrow crossing
    (`panes/editor-layout.ts:25-47`).
  - The review has `scmWrap: boolean | null` (LOCAL, `settings.ts`), which `resolveWrap` reads
    (`ReviewPane.tsx:277`). Split layout always wraps.
  - Markdown code blocks never wrap: the `pre` scrolls sideways and `code.md-hl` forces `white-space: pre`.
- **Keybindings.** The matcher builds a chord from `normalizeKey(e.key)` (`keybindings.ts:150`), so
  Option+Z on a Mac arrives as `Ω` and matches nothing. `useKeybindings` claims a chord only when it is
  bound AND has a handler in App's `actionHandlers` (`App.tsx:2213`). Everything else reaches xterm.

## Goals / Non-Goals

Goals:

- One preview tab per pane for files and diffs opened by a glance.
- Preview state shared by every window and device.
- **A replacement never shows a tab arriving or leaving**, in this window or any other, whatever the two
  tabs' kinds (owner, session 1 Q2: "no tabs flying, added and removed, not even for a fraction of a
  second").
- A Source Control click shows one file. The continuous review stays.
- Alt+Z toggles wrap in the editor and the review.

Non-goals:

- Previews for terminals, web, dashboard or markdown-viewer tabs.
- A per-window preview flag (the owner revised this after the cross-device evidence).
- Replacing the continuous review.
- Wrap for terminals, and wrap for markdown code blocks (session 1 Q3).
- `palmux open` and the Source Control row actions: sibling changes, which use the contract below.

## Decisions

### D1. `TabMeta.preview?: true` is a server field, and pinning is one-way

The protocol changes:

- `TabMeta.preview?: true` (absent means pinned).
- `TabMeta.replaces?: string` (D3a; never persisted).
- `CreateTabMessage.preview?: true`.
- `UpdateTabMessage.preview?: false`.
- A new client message `ReplaceTabMessage { type: 'replaceTab', id, kind: 'editor' | 'review', url }` (D3a).
- `ReadyMessage.previewTabs?: true`.

`parseTabMeta` keeps `preview` only when it is exactly `true`, and `replaces` only when it is a string.

Registry rules (`server.ts`):

- `createTab { preview: true }` sets `preview` only for `kind === 'review'` and for `kind === 'editor'` with
  a `url`. For every other kind it is dropped silently, the forgiving posture of the parser.
- `updateTab { preview: false }` deletes `preview`. `updateTab { preview: true }` is ignored.
- An `updateTab` that carries `name` or `color` (empty string included) also deletes `preview`.
- `groupCreate` deletes `preview` from every id in `ids`, and `groupUpdate` from every id in `addIds`.
  This also keeps D3a's in-place order valid: a preview is never in a group, so `normalizeOrder` never
  moves it.
- `moveToWindow` does NOT pin (session 1 Q1). A detached window keeps its preview tab, a reclaim leaves
  it a preview, and nothing about it needs persisting.
- `persist` (:468) writes `preview` when set. `tabs-store.ts` `PersistedTab` gains `preview?: true`, and
  `parsePersistedTabs` keeps it only as `true` and only on the kinds above. `replaces` is never written.
- `ready` gains `previewTabs: true` beside `detachedWindows: true` (the `ready` message in
  `handleConnection`).

Why the server, and not only the opener, checks that a tab is still a preview: another window may have
pinned it on purpose seconds earlier (a double-click, Keep open, a first keystroke). The opener's own
`dirtyRef` cannot see another window's state, and the flag in its `tabsRef` is one round trip old. The
check runs where the truth is.

Rejected alternatives:

- **A per-window client flag.** A main window shows every main tab, so a replacement in one window
  swaps the file under another device's editor. Owner decision: server field.
- **A server-side "refuse every url change on a pinned editor".** It breaks link-following in a pinned
  file tab in Read mode, which uses the same `updateTab`. Replacement goes through its own message (D3a),
  so `updateTab` keeps its meaning.
- **Pinning on `moveToWindow`.** The server cannot tell a reclaim from a drag, so a detached window's
  preview came back pinned after every slow reload, and the pin could not be persisted by `setWindow`.

### D2. The per-file review url is `<group>-file:<enc(top)>:<enc(path)>`

- **Form:** `changes-file:` or `staged-file:`, then `encodeURIComponent(top)`, `:`, and
  `encodeURIComponent(path)`. Example: `changes-file:%2Fhome%2Fu%2Fapp:src%2Fa.ts`.
- **Why the separator is safe:** `encodeURIComponent` escapes every `:`, so the first `:` after the prefix
  is the separator and nothing inside either part can collide with it.
- **Helpers in `shared/src/scm.ts`:**
  - `fileReviewUrl(group, top, path)` builds the url.
  - `parseReviewUrl(url)` returns `{ group, top, file? }` and accepts both forms.
  - `isReviewFilePath(path)` holds the rules of the server's `checkRelPath` (`scm-git.ts:295`): not blank,
    no NUL, not absolute, no empty, `.`, `..` or `.git` component.
  - A `decodeURIComponent` that throws returns `null`.
- **Server canonical form:** `canonicalReviewUrl` builds `fileReviewUrl(group, resolve(top), path)` and
  refuses a path that fails `isReviewFilePath`. Uniqueness goes through the existing `reviewTabHolding`,
  so one url has at most one tab.
- **Title:** `displayTitle` reads `<basename(path)> (Changes)` or `<basename(path)> (Staged)`.
- **A server without `previewTabs`:** its `parseReviewUrl` returns `null` for the new prefix, so it refuses
  the create. The client never sends one there (D9).
- **Rollback to 1.2.x, and the deploy window:** an old server restores the tab as-is (restore copies `url`
  unvalidated). An old client (a window still on the 1.2 bundle after the restart) titles it "review" and
  the pane reads "This review has no valid address." The user closes it, or reloads that window. Accepted;
  documented in CLAUDE.md.

Rejected alternatives:

- **`changes:<top>#<path>`:** `#` is a valid filename character.
- **A NUL separator:** the server refuses NUL in a url.
- **A JSON payload:** longer, and it needs escaping twice.
- **A one-file mode on the group's continuous review tab:** tabs are shared across windows, so filtering
  the group tab would change every window's review, and the continuous review must stay open beside the
  preview.

### D3. Opening a preview: one routine, `openPreview`

The routine lives in `App.tsx`. Its input is `{ kind: 'editor' | 'review', url, pin }`, where `pin` is
`false` for a preview open and `true` for a pinned open.

1. **The target already has a tab** (an `editor` with that url, or a review at that canonical url, looked
   up in `tabsRef`):
   - a visible tab is shown with `setSessionId` (`show` focuses its pane);
   - a held editor gets the existing toast; a held review is moved here (`moveTabsToWindow`), as today;
   - if `pin` is true and the tab is a preview, the routine also sends `updateTab { id, preview: false }`
     (a pinned open of a previewed target pins it; this is how `palmux open` keeps a file).

   It stops here.
2. **Find the replaceable preview P.** P is a tab in the focused pane's leaf (mobile layer: every visible
   tab) with `preview` set and NOT in `dirtyRef`. If the pane's active tab is such a tab, P is the active
   tab; otherwise P is the last such tab in strip order.
3. **P exists and `pin` is false:** send `replaceTab { id: P, kind, url }` (D3a), whatever P's kind. Record
   the pending entry (below) with `replaces: P`. Nothing else changes on screen until the
   answer: no optimistic swap, because the answer is one round trip and a swap the server then refuses
   would itself be a tab flying.
4. **No P, or `pin` is true:** send `createTab { kind, url, ...(pin ? {} : { preview: true }) }`. A preview
   create also records the pending entry.

**The pending entry.** `pendingPreviewRef` is a `Map<leafId, PendingPreview>` (the mobile layer uses the
virtual pane's id), with `PendingPreview = { sentKind, sentUrl, latestKind, latestUrl, pinLatest, replaces?,
at }`. A send sets `sent* = latest* = the target` and `pinLatest = false`.

Supporting rules:

- **The answer is matched by content (F1).** The `tabCreated` handler looks the answered id up in
  `tabsRef` (the list always arrives first on the sender's socket, see Context) and applies
  a leaf's pending entry only when that tab's `kind` and `url` equal the entry's `sentKind` and `sentUrl`. If the id is not yet in
  `tabsRef` (an older or reordered server), the answer is held and re-checked on the next `sessions`
  message. Otherwise it is an answer to something else and the ref is left alone.
- **Two opens before the first answer.** A second preview open while the focused leaf has a pending entry
  sends nothing and only sets `latestKind`/`latestUrl`. A pinned open of the entry's `latestUrl` sends nothing
  and sets `pinLatest`. When the answer matches: the entry is deleted; if `latest*` differ from `sent*`, one
  `replaceTab { id: <answered id>, kind: latestKind, url: latestUrl }` follows and becomes the leaf's new
  pending entry (carrying `pinLatest`); otherwise, if `pinLatest`, `pinTab(id)`.
- **A kept open, then another preview, before the answer** (found in review, batch 2). When the entry has
  `pinLatest` and a preview open names another file, the entry moves aside under its own key
  (`<leafId>~<n>`), so its answer still pins the kept file, and the new file goes out as a fresh
  `createTab { preview: true }`, never a `replaceTab` (the pane's candidate could be the tab the kept file
  is about to land in).
- **A step-1 show while pending.** When step 1 shows an existing tab for the focused leaf, that leaf's
  entry resets `latest*` to `sent*` and `pinLatest` to `false`, so the answer only lands its own tab.
- Entries of other leaves are independent.
- **No answer.** An entry is dropped after 5 s (`PENDING_REVIEW_MS`, the existing timeout) with the toast
  "Could not open `<name>`" (F2), where `<name>` is `basename(path)` for an editor and the D2 title for a
  review.
- **Kinds.**
  - A Source Control click opens `fileReviewUrl(group, repo, path)`.
  - An Explorer file opens the file path.
  - An editor with no url (a note) is never a preview.

### D3a. `replaceTab`: the swap is one server operation and one render

This is how VS Code does it, and the reason no tab flies there. `EditorGroupModel.openEditor`
(`src/vs/workbench/common/editor/editorGroupModel.ts`, the `// Handle preview` branch) calls
`replaceEditor(this.preview, newEditor, targetIndex, …)`, which closes the old preview with
`EditorCloseContext.REPLACE` and splices the new editor into the SAME index inside one synchronous model
call, before any event reaches the tab bar. The editor's type plays no part: a text editor and a diff
editor are both an `EditorInput` in one slot. Read on `main` on 2026-11-02 as behaviour evidence; no code
is ported.

Palmux splits that call across the wire, so both halves must be atomic: the registry change and the
client's render.

**Server (`replaceTab { id: P, kind, url }`).** In one registry call, with one `listChanged()` and one
`persist`:

1. Validate `kind` (`editor` or `review`) and `url` exactly as `createTab` does (absolute path; canonical
   review url). Refused: nothing happens and nothing is answered.
2. A review url another tab already holds: answer that tab's id (`tabCreated`), change nothing. The
   client then shows it, as step 1 of D3 would have.
3. **P is still replaceable** when it exists, has `preview`, and its `window` equals the sender's socket
   window (both absent for a main window). Otherwise go to 5.
4. **Same kind:** set P's `url` (review: the canonical one) and answer `tabCreated { id: P }`. The id and
   the slot do not change.
   **Other kind:** create the new record N with a fresh id (allocated while P still exists, so N ≠ P),
   `preview: true`, P's `window`, `replaces: P`; put N at P's index in `order`; remove P exactly as
   `killTab` does for a non-terminal tab (snapshot forget, persistence) but without its own broadcast; then
   one `listChanged()`. Answer `tabCreated { id: N }`.
5. **Not replaceable** (pinned meanwhile, closed, or moved to another window): create N exactly as
   `createTab { kind, url, preview: true }` from that socket would, and answer `tabCreated { id: N }`. P is untouched. The
   user then has both tabs; nothing was destroyed and nothing flickered. This is the whole guard rule:
   there is no refusal for the client to detect (F2, F15).

`replaces` is in-memory only, never persisted, and rides only the swap's own broadcast: the registry drops it from N's record right after that (synchronous) `listChanged()`, so a later broadcast never announces a swap that already happened (found in review, batch 2). The client keeps it until a render used it (`keepReplaces`), for two broadcasts handled before one render. It is a hint, not state: a
client that does not know it (an old bundle) sees P leave and N arrive, as it would for any close and
create.

**Client (every window).** One broadcast carries P gone and N at P's index with `replaces: P`.

- **With editor groups:** `reconcile` gains one rule, applied BEFORE the drop-and-re-pick step: a listed
  tab N with `replaces === P`, where some leaf holds P, the list does not list P, and no leaf holds N,
  takes P's entry IN PLACE in that leaf (same position, `{ id: N, kind: N.kind }`), and becomes the leaf's
  `active` if P was. That leaf's close rule then has nothing to do, so the neighbour never shows. The rule
  is pure and idempotent: once N is held it never fires again.
- **Flat path (mobile layer):** the `sessions` handler, before it dispatches `sessionsBroadcast`, checks
  whether the current `sessionId` is P and the new list holds N with `replaces: P`; if so it moves the
  selection to N (`sessionIdRef` and state) in that same handler, so the controller's close-navigation
  sees no dead active tab.
- **The pane body** for P unmounts and N's mounts in the same commit (`PaneHost` mounts one body per tab).
  The pill keeps its slot because the order index is P's. Its title, italic and kind icon change, as a VS
  Code tab's label does.
- **Window-local state keyed by id** moves too where it matters: `dirtyTabs` never holds P (D3 step 2), a
  review registry entry is registered by the new pane, and the persisted window selection is written by the
  existing persist effect.

**What the user sees:**

| Case | Wire | Every window's strip |
|---|---|---|
| same kind | one `replaceTab`, one broadcast | the pill stays; its title changes |
| other kind | one `replaceTab`, one broadcast | the pill stays in its slot; title and icon change |
| P pinned meanwhile | one `replaceTab`, one broadcast | P stays; one new preview pill appears |
| no P | one `createTab`, one broadcast | one new preview pill appears |

Rejected alternatives:

- **Kill P, then create, then reorder** (the first draft). Three broadcasts: other windows saw a tab leave
  and another arrive at the end, then move; the opener showed P's neighbour between them. The kill was
  also unconditional, so a P another window had pinned a moment earlier was destroyed.
- **Create first, then a conditional kill.** Two broadcasts: the new tab appears beside P before P goes.
- **Reuse P's id with the new kind.** `reconcile` treats a listed id whose kind changed as a dead tab and
  a new one (CLAUDE.md "Mid-session, with editor groups, a kind change is a pane event"), the guard that
  stops a recycled id inheriting a pane. Bypassing it for this case would weaken it for the real one.
- **A server `openPreview` that picks the preview itself.** The server does not know panes or the focused
  pane. The client names P; the server only provides atomicity.

### D4. What pins a tab, and where

**Server-side pins (D1):** a name or colour change, `groupCreate` and a group join. They cover every
client, old ones included. A window move does not pin.

**Client-side pins:** each sends `updateTab { id, preview: false }` through `App.pinTab(id)`, only when the
tab in `tabsRef` has `preview`, and only once per tab until a broadcast shows it pinned
(`pinSentRef: Set<id>`; an id leaves the set when a broadcast lists it without `preview`, or when it is
gone). An id joins the set only when `sendUpdateTab` returned true; a pin that could not be sent toasts
"Not connected — try again", as `createTab` does. On every `ready`, each id still in `pinSentRef` whose tab
is still a preview is sent again (a pin sent just before a disconnect may never have arrived) (F15).

| Trigger | Where |
|---|---|
| Double-click on a preview pill | `SessionTabs.tsx:748`: `tab.preview ? onPin(tab.id) : startRename(tab)` |
| Double-click on the source row | The row's caller passes `{ preview: event.detail !== 2 }`, so the second click of a pointer double-click is a pinned open, which pins the existing preview, or the pending one when its answer lands (D3 step 1, "Two opens before the first answer"). A keyboard activation has `detail` 0, so two Enter presses never pin (F12). Explorer: `FileTreeProps.onOpenFile` becomes `(path, opts: { preview: boolean }) => void`; the row's click passes `{ preview: e.detail !== 2 }` and the context-menu Open passes `{ preview: true }`. Source Control rows activate through `pressMove`, whose action has no event, so the row also gets a native `onDoubleClick` that calls `onOpenFile(target, { preview: false })`; its first click already sent the preview open, and the second open pins it. `onOpenFile` there becomes `(target, opts?: { preview?: boolean }) => void`. |
| First dirty transition | `App.onPaneDirty(id, true)` (`App.tsx:2393`) |
| A successful save, or Ctrl+S on a clean buffer | New `onSaved?: () => void` prop on `EditorPane`, called where `onSaveError(null)` follows a 2xx save (autosave included). `save()` returns `'clean' \| 'started' \| 'queued'`, and only the two Ctrl+S paths (the Monaco command and the pane-wide handler, through `saveRef`) call `onSaved` on `'clean'`; the autosave timer, the mid-flight re-run and the `visibilitychange` flush never do. `FileTabPane` and `FilePane` pass it through, and a file editor handles Ctrl+S only while it is its pane's shown tab in a focused pane and in Edit mode (`PaneHost` passes `focused`), so a hidden preview is never pinned by a save meant for another tab. `PaneHost` wires it to a new `onPinTab(id)` prop, which `GroupsView` threads from App's `pinTab`. |
| Opening the comment composer in a review preview | The pane calls `host.pinTab(tabId)` when a draft editor opens on it (session 1 Q4). Reviewed and Unstage do NOT pin: they move to the next file in the same tab. |
| "Keep open" | Phone: a new first row in `TabSheet`, `tab-sheet-keep-open`, rendered only for a preview tab; it pins and closes the sheet. Desktop: a "Keep open" item (`menu-keep-open`, `pin` icon) first in the tab context menu's EDIT group, rendered only for a preview tab (F13). |
| A move to another pane | In App: `applyEffect`'s `'split'` case, `dropOnEdge` and `moveTabInto` call `pinTab(id)` after a commit that changed the layout. A drop on the tab's own pane (where `commitLayout` exits early) and a cross-window drop (`placeInLayout`) do not pin. The pure `pane-grid.ts` operations stay pure. `splitLone` creates a terminal, so it pins nothing (F9). |

The canonical list of what pins lives in `specs/preview-tabs` "Using a preview tab pins it"; the other
deltas state only their own surface's trigger (F17).

**The race.** Window B sends `replaceTab` while window A's first keystroke is in flight:

- **Pin first:** B's `replaceTab` finds P pinned and creates a new preview instead (D3a step 5). Nothing
  is lost.
- **Replace first:** A loses P's buffer for the keystrokes typed in that one round trip. With the same
  kind, A's editor reloads the new file; with another kind, the tab is swapped in place. The `sessions`
  handler sees that a tab that was a PREVIEW and in `dirtyRef` changed url or was replaced, and toasts
  "`<old name>` was replaced by another window before your edit was saved". It never toasts for a pinned
  tab following a link (F16). Accepted.

**One-way.** A pinned tab never becomes a preview again, as in VS Code.

### D5. How a preview looks

- `.ctab.preview .ctab-title` and `.drawer-session.preview .drawer-session-title` are `font-style: italic`
  and nothing else, so the pill's box does not move (`tab-strip-css.test.ts` holds that).
- Tooltip: on a preview only, `title={`${displayTitle(tab)} — preview (double-click to keep open)`}`.
- Accessible name: on a preview only, `aria-label={`${displayTitle(tab)}, preview`}`; a pinned pill keeps
  its content-derived name (no `aria-label`). The drawer's `.drawer-session` button gets the `preview` class
  and the same `aria-label` (no tab number).
- The italic does not depend on colour, so it reads on every theme and to a colour-blind user.

### D6. The single-file review is the review pane with a file filter

- **Parsing.** `ReviewPane` reads `file` from `parseReviewUrl(tab.url)`.
- **No remount on a file change (F7).** `ReviewView`'s React key changes from `tab.url` to
  `` `${tab.id}|${group}|${top}` `` and `file` becomes a prop. The model keeps its key `group|top`, so a url
  change that moves the tab to another file of the same group reuses the loaded snapshots. What depends on
  the url and what a file change does to it:
  - the landed-jump state (`landedRef`) and the scroll anchor: reset, and the view lands on the new
    file's header;
  - the end and gone states (below): cleared;
  - the write state (an in-flight Reviewed): kept until it settles, so its `showFile(next)` still runs;
  - open comment drafts: kept in the store, as always (they are keyed by path).
- **The filter.** The entry list is filtered to `entry.path === file` (Changes = merge + changes, as the
  continuous review lists them).
- **The bar.** In a single-file review the existing `.rv-current` bar (ReviewPane.tsx:1241-1245, `{n} / {files}`)
  shows the position from the UNFILTERED list, and Reviewed and next/previous advance through `showFile`.
  The scroll target in `reviewScrollRef` is not used for a single-file url: the url already names the file.
- **The host (F6).** `ReviewHost` and `DEFAULT_REVIEW_HOST` in `review/review-host.ts` gain:
  - `showFile(tabId, path)`: App sends `updateTab { id: tabId, url: fileReviewUrl(group, top, path) }`,
    unconditional, because the tab is the one the user is in. If another tab already holds that url, App
    selects that tab instead. If no broadcast shows the tab at that url within 2 s, App toasts "Could not
    open the next file".
  - `openReview(target)`: App's `openReview`, the continuous review scrolled to the file.
  - `pinTab(tabId)`: App's `pinTab` (D4, the composer pin).
  `ReviewPane` passes its own `tab.id`.
- **Moving on.**
  - The model computes the neighbour from the UNFILTERED list before a write.
  - `nextFile` and `prevFile` call `host.showFile(tabId, path)`.
  - `prevFile` from inside the file goes to its start first, as the continuous review does.
  - `nextChange` past the file's last change calls `showFile(next)` and lands on its first change.
- **Reviewed and Unstage** compute the next path first. On success they call `showFile(next)`. With no
  next path, the pane shows the end state.
- **States.**
  - "No more files in `<group>`" plus an Open review button (`rv-end-open-review`).
  - "No longer changed" plus Open review (`rv-gone-open-review`), when a loaded status no longer lists the
    file.
  - Both are local to the pane and clear on the next url change.
- **Toasts.** Next file at the last file toasts "No more files in `<group>`". Previous file at the first
  file toasts "First file in `<group>`".
- **What a single-file review keeps from the continuous one (F5):** rows, comments, colouring, Reviewed
  and Unstage with Undo, keybindings, the follow-the-disk poll (for its one file), the paused and removed
  states. What changes: it lists one file, its next/previous file changes its url instead of scrolling,
  and Reviewed moves on by url. The living `diff-review` requirements that say "the whole group" are
  scoped to the continuous review by MODIFIED deltas.
- **Source Control.**
  - `SourceControlView` rows keep `onOpenFile(target)`. App now routes it to
    `openFileReview(target, { preview: true })` (the Contract section).
  - Each group header gains a kit `IconButton` "Open review" (`scm-open-review-<group>`, icon `external`,
    `size="sm"`), which calls a new `onOpenReview(group)` prop → `App.openReview({ group })`.
  - The header is a kit `Collapsible`, whose `title` renders inside the Radix Trigger `<button>`, so a
    button there would nest. `ui/Collapsible.tsx` gains `actions?: ReactNode`, rendered as a sibling of the
    Trigger in a header row (`.ui-collapsible-head`, `ui/ui.css`); a click on an action never toggles the
    section. `scm-row-actions` edits `ui/Collapsible.tsx` too; this change lands first and owns the slot.

Rejected alternative: **a separate single-file pane.** It would duplicate rows, comments, writes and
keybindings, a parallel implementation.

### D7. Wrap: `editorWrap` for files, `scmWrap` for reviews, one action

- **The setting.** `editorWrap: boolean`, default `true`, is LOCAL: not in `SYNCED_KEYS`. The sanitiser
  turns anything that is not a boolean into `true`.
- **The editor.** `wordWrap` leaves `EditorLayoutOptions`, so a width crossing no longer re-sends it.
  `EditorPane` sets `wordWrap: editorWrap ? 'on' : 'off'` at create, and on a settings change through
  `updateOptions`, the path `codeFontSize` already takes. The Settings config editor (`ConfigEditor.tsx`)
  spreads the same layout options, so it now sets `wordWrap: 'on'` itself and keeps wrapping as today.
- **A `.md` file in Read mode** is an `editor` tab, so Alt+Z still flips `editorWrap` and toasts; the
  setting applies to the Edit view and the rendered view does not change.
- **Markdown is out of 1.3.0** (session 1 Q3). Its code blocks never wrap today, so a toggle there would be
  a new behaviour, not a toggle of an existing one.
- **Settings (F13).** Settings → Appearance gains an "Editor word wrap" Switch (`set-editor-wrap`), so the
  setting has a pointer and screen-reader route besides the chord.
- **The action.** `toggleWrap` is labelled "Toggle word wrap" with default `{ key: 'z', alt: true }`. It
  is added to `ACTIONS` and `DEFAULT_BINDINGS` and is wired in `actionHandlers` only while the active
  tab's kind is `editor` (a file or a note) or `review`. Otherwise the chord falls through to xterm (ESC z).
  The command palette offers it under the same rule.
- **What it does:**
  - editor: `updateSettings({ editorWrap: !editorWrap })`, then a toast "Word wrap on" or
    "Word wrap off";
  - review: a new `ReviewApi.toggleWrap(): 'on' | 'off' | 'split'`; in split layout it changes nothing
    and App toasts "Side-by-side always wraps"; otherwise it sets `scmWrap = !resolvedWrap`. The review's
    wrap stays reachable by pointer from the bar's Wrap control and its overflow menu.
- **Wrap state is per device, not per tab.** It matches `scmWrap`, and a toggle that changed only one tab
  would be lost on the next tab.
- **It ships first (session 1 Q5).** This decision, D8 and their tasks (phase 1 of `tasks.md`) share no
  code, protocol field or `ready` flag with the rest and need no server restart, so they can be
  implemented and merged before phases 2–8.

### D8. Alt+letter matches the physical key

`chordFromEvent` takes the key from `e.code` when ALL of these hold:

- `e.altKey && !e.ctrlKey`;
- `!e.getModifierState('AltGraph')`;
- `normalizeKey(e.key)` is not a single `[a-z0-9]`;
- `e.code` matches `/^Key[A-Z]$/`.

The key is then `e.code.slice(3).toLowerCase()`.

Effects:

- **Ctrl+Alt chords** (every existing Alt default) keep matching on `key`.
- **AltGr characters** are untouched: they report `AltGraph`, or a `Digit`/punctuation code.
- **The keybinding editor** records chords through the same function, so recording Option+Z records
  Alt+Z.

### D9. Compatibility gate

`App` keeps `previewSupportedRef`, `false` until the first `ready` and re-read from every `ready`
(`msg.previewTabs === true`). When it is false:

- `openFileTab(path, { preview: true })` behaves as `{ preview: false }`;
- `openFileReview` calls `openReview(target)`, the continuous review scrolled to the file;
- the group header's Open review button stays, because it is the continuous review;
- no `preview` field and no `replaceTab` message is ever sent.

| Client | Server | Result |
|---|---|---|
| new | new | full behaviour |
| new | old | 1.2 behaviour, no new message or field |
| old | new | `parseTabMeta` drops `preview` and `replaces`, so tabs read as pinned, and a replacement made by a new window shows there as a close plus a create. An old client never pins, so a tab it opens from a new client's preview stays a preview for new clients until something pins it. |

## Contract for scm-row-actions and palmux-cli-commands

```ts
/** Open a file in an editor tab. Returns 'held' when another window holds that file's tab, else 'opened'. */
openFileTab(path: string, opts?: { preview?: boolean }): 'opened' | 'held';

/** Open one file's diff in a single-file review tab. */
openFileReview(target: ScmOpenTarget, opts?: { preview?: boolean }): 'opened' | 'held';
```

`openFileTab`:

- `preview` defaults to `false`.
- `{ preview: true }` is a preview open (D3).
- `{ preview: false }` is a pinned open: it shows an existing tab and pins it if it was a preview, or it
  creates a pinned tab. It never replaces a preview.
- It returns synchronously:
  - `'held'` exactly when another window holds that file's editor tab (the existing toast still shows);
  - `'opened'` otherwise: an existing tab was shown, or a create or replace was sent.

`openFileReview`:

- It opens `fileReviewUrl(target.group, activeRepo, target.path)`.
- A held review is moved here, so it never returns `'held'`.
- Without `ready.previewTabs`, both functions ignore `preview`, and `openFileReview` falls back to
  `openReview(target)`.

`openReview(target)` is unchanged and opens the continuous review.

Callers:

| Caller | Call |
|---|---|
| Explorer (`FileTree` `onOpenFile`, dock and drawer) | `openFileTab(path, { preview: event.detail !== 2 })` |
| Source Control row click (`SourceControlView` `onOpenFile`) | `openFileReview(target, { preview: event.detail !== 2 })` |
| `scm-row-actions` "Open file" | `openFileTab(<abs path>, { preview: true })` |
| `palmux-cli-commands` `palmux open` | `openFileTab(path, { preview: false })` |
| `reviewHost.openFile` (the review's own Open file) | `openFileTab(path, { preview: true })` |

**Shared files.** `SourceControlView.tsx` is also edited by `scm-row-actions`. This change adds only the
group-header button and the `onOpenReview` prop. The row's click target and its `onOpenFile` signature do
not change, apart from passing the click's `detail` with it. The `.rv-current` bar already exists; this
change only feeds it the position from the unfiltered list.

**Spec ownership.** This change owns the `diff-review` requirement "A review opens in the content area";
`scm-row-actions` should not MODIFY it too.

**Landing order.** This change lands before `scm-row-actions` and `palmux-cli-commands`, which call the
contract above. Phase 1 (Alt+Z) can land before everything else.

## Risks / Trade-offs

- **The cross-window replace race (D4).** At most one round trip of keystrokes is lost, and that window
  toasts. Accepted.
- **Another window's preview changes under you.** Main windows share tabs, so window B can replace a
  preview that window A is showing. This is the cost of a shared flag, which the owner chose. A preview
  holds no unsaved text by construction, and the swap happens in place in A too.
- **`replaces` is a hint an old client ignores.** A window still on the 1.2 bundle shows a kind-change
  replacement as a close plus a create. It cannot send one itself (D9), so this lasts only until it
  reloads.
- **Rollback** leaves single-file review tabs that read "This review has no valid address." The user
  closes them by hand.
- **Server restart.** This ships with the 1.3.0 restart. Under systemd it costs every live terminal and
  needs the owner's OK at that moment. Phase 1 (Alt+Z) needs none.

## Migration / Observability / Cost

- **Migration:** none. `tabs.json` gains an optional `preview` field. An old server ignores the unknown
  field on restore and treats the tab as pinned.
- **Observability:** the server logs nothing new. `sessions` already shows the flag. A `replaceTab` that
  found P not replaceable is visible as a create in the broadcast, by design.
- **Cost:**
  - A preview replace of either kind is one `replaceTab`, one broadcast and one `tabCreated`.
  - An Alt+Z toggle is one settings write. `editorWrap` is local, so nothing reaches the server.

## Flagged for the owner

1. **Pin is one-way**, and a rename, colour or group join pins too (as in VS Code). A window move does not.
2. **Wrap is per device, not per tab**, and markdown is out of 1.3.0.
3. **Per-file url** `changes-file:<enc(top)>:<enc(path)>`; a rollback leaves those tabs unreadable until
   closed.
4. **Double-click on a preview pill pins instead of renaming**; rename stays in the context menu and on a
   second double-click.
5. **`replaceTab` is a new message** so a replacement is one operation in place, instead of a kill and a
   create.
6. **Which preview is replaced** when a pane holds several (after a reconcile added another window's):
   the active one, else the last in strip order.
7. **End of group:** Reviewed on the last file shows "No more files"; next file there only toasts.

## Session 1 decisions

| Item | Decision | Applied in |
|---|---|---|
| Q1 | A: rename, colour, `groupCreate` and group join pin; a window move does not | D1, D4; specs workspace-tabs, preview-tabs; task 3.1 |
| Q2 | Owner: no tab may appear or vanish, even for a frame; follow VS Code → `replaceTab` | D3, D3a; specs workspace-tabs, preview-tabs, editor-groups; tasks 2.1, 3.2, 4.2, 4.3 |
| Q3 | A: markdown out of 1.3.0 | D7; proposal; spec editor-pane |
| Q4 | A: opening the comment composer pins a review preview; Reviewed and Unstage do not | D4, D6; spec preview-tabs; task 6.2 |
| Q5 | A: Alt+Z is phase 1 and can merge on its own | D7; proposal; tasks phase 1 |
| F1–F18 | all accepted (no REJECT) | F1/F2 D3; F3 D1; F4 spec preview-tabs; F5 D6, specs diff-review, detached-windows; F6/F7 D6; F8 tasks 2.1, 3.1, 3.2, 4.1; F9 proposal Impact, D4; F10 D6, Contract; F11 every gate; F12 D4; F13 D4, D7; F14 proposal; F15 D3a, D4, D9; F16 D4; F17 specs; F18 proposal, Context |
