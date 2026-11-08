# Proposal: preview tabs, a per-file diff, and Alt+Z word wrap

Source brief: `openspec/brainstorms/2026-11-02-v1-3-scm-cli-preview.md` (items 7, 8 and 14). Its owner
decisions are kept here, plus the refinement decisions of `questions-session1.md`.

## Why

Every file you open from the Explorer or from Source Control becomes a tab that stays, so a few minutes of
browsing leaves a strip full of tabs you only glanced at. A Source Control click today opens the group's
continuous review scrolled to that file, so the one file you wanted sits among the other 52 files of the
group (the owner's case). And there is no keyboard way to turn line wrapping on or off: the editor always
wraps, and the review's wrap is reachable only by pointer, from its bar's Wrap control or the bar's overflow
menu.

## What Changes

- **Alt+Z toggles word wrap in the focused file view.** It ships first and on its own (phase 1 of
  `tasks.md`): it shares no code, protocol field or flag with the rest and needs no server restart.
  - **BREAKING (behaviour):** editor wrap becomes a per-device setting, `editorWrap`, on by default and
    also offered as an "Editor word wrap" switch in Settings.
  - The review flips its existing Wrap setting; a side-by-side review always wraps and says so.
  - On a terminal tab Alt+Z still reaches the shell. The markdown viewer is out of scope: its code blocks
    keep scrolling sideways.
  - An Alt+letter chord that the OS turns into a symbol (Option+Z gives `Ω` on a Mac) matches by the
    physical key; AltGr characters are unchanged.
- **Preview tabs**, VS Code style. A file opened from the Explorer, a Source Control file click, or an
  "Open file" action lands in the focused pane's **preview tab**. Its title is italic and it is labelled
  "preview" for assistive technology. The next preview open in that pane replaces it, so browsing ten
  files leaves one tab.
- **A replacement happens in place, in one step** (owner, session 1: no tab may appear or vanish, even for
  a frame). One new message, `replaceTab`, swaps the preview atomically on the server: the same kind keeps
  its id, another kind (editor ↔ single-file review) takes the old tab's exact strip position, and one
  broadcast tells every window. Each window's layout puts the new tab in the old one's place and keeps it
  active, so no neighbour shows in between. This is how VS Code's `EditorGroupModel.replaceEditor` works.
- A preview tab becomes a normal (pinned) tab when you:
  - **BREAKING (behaviour):** double-click it in the strip (a double-click on a pinned tab still renames);
  - double-click the row you opened it from;
  - make the first edit in it, from any window;
  - save it (Ctrl+S included);
  - choose "Keep open" in the phone's tab sheet or the desktop tab menu;
  - open the comment composer in a review preview;
  - rename it, colour it, or create or join a group with it;
  - move it to another pane.

  Moving it to another window keeps it a preview, and so do Reviewed and next file in a review preview.
- **The preview flag is server state** (`TabMeta.preview`, owner decision). Every window and device shows
  the same tab as a preview. An edit anywhere pins it for everyone. A tab with unsaved text is therefore
  never replaced, and the flag survives a reload and a restart.
- **A preview is replaced only while it is still a preview.** The server checks it at the moment of the
  swap; if another window pinned it a moment earlier, the open lands in a new preview tab and nothing is
  lost.
- **BREAKING (behaviour): a Source Control click opens that one file's diff** in the preview tab: a
  single-file review. The continuous review of the whole group stays fully supported and opens from a new
  button on each group header. In a single-file review:
  - Reviewed stages the file and loads the next file of the group in the same tab;
  - next and previous file move through the group the same way;
  - a file that leaves the group shows "No longer changed" and does not close silently.
- **Compatibility.** A client meeting a server without preview support (no `previewTabs` in `ready`)
  behaves exactly as today: pinned tabs, and a click opens the continuous review.

## Capabilities

### New Capabilities

- `preview-tabs`: the preview tab of a pane. Which opens are previews, the in-place replacement rule, what
  pins a tab (the canonical list), how a preview is drawn on desktop and phone, and how it behaves across
  windows and devices.

### Modified Capabilities

- `workspace-tabs`: `createTab` and `updateTab` carry `preview`, a new `replaceTab` message swaps a preview
  atomically, `sessions` carries `preview` and `replaces`, and a rename, colour or group join pins a tab.
- `tab-customization`: a double-click on a preview tab pins it instead of starting a rename.
- `file-browser`: opening a file from the tree opens it as a preview.
- `editor-groups`: a preview open goes to the focused pane's preview tab, and reconcile puts a replacing tab
  in the replaced tab's place.
- `diff-review`: a Source Control click opens a single-file review; the continuous review opens from the
  group header; the "whole group" requirements are scoped to the continuous review; a single-file review
  moves through its group.
- `detached-windows`: opening a held review covers the single-file url, and a preview open never replaces
  another window's preview.
- `editor-pane`: word wrap becomes a per-device setting instead of always on.
- `configurable-keybindings`: a new `toggleWrap` action (Alt+Z), and Alt+letter chords match the
  physical key when the OS produced a symbol.

## Impact

- **Objective, in plain words:** files you glance at stop piling up as tabs, one click shows one file's
  diff, and Alt+Z turns line wrapping on or off.
- **Who it affects:** the owner on a desktop (strip, panes, detached windows) and on a phone (drawer rows,
  tab sheet). Users of an older client see preview tabs as normal tabs.
- **Code:**
  - shared: `protocol.ts` (`TabMeta.preview`, `TabMeta.replaces`, `CreateTabMessage.preview`,
    `UpdateTabMessage.preview`, `ReplaceTabMessage`, `ReadyMessage.previewTabs`) and `scm.ts` (the
    per-file review url).
  - server: `server.ts` registry (`createTab`, `updateTab`, new `replaceTab`, `persist`, restore,
    `groupCreate`, `groupUpdate`), its ws handlers (`createTab`, `updateTab`, `replaceTab`, `ready`) and
    `tabs-store.ts`.
  - client, routing and state: `App.tsx` (open routing, pin triggers, `sessions` and `tabCreated`
    handlers), `lib/ws.ts`, `session/pane-grid.ts` (`reconcile`), `session/tab-meta.ts`,
    `session/GroupsView.tsx`, `panes/PaneHost.tsx`.
  - client, surfaces: `session/SessionTabs.tsx`, `SessionDrawer.tsx`, `TabSheet.tsx`, `panes/FileTree.tsx`,
    `scm/SourceControlView.tsx`, `review/ReviewPane.tsx`, `review/review-model.ts`,
    `review/review-host.ts`, `review/review-registry.ts`, `panes/editor-layout.ts`, `panes/EditorPane.tsx`,
    `panes/FileTabPane.tsx`, `panes/FilePane.tsx`, `settings/settings.ts`, `settings/SettingsFields.tsx`,
    `keybindings/keybindings.ts`, `index.css`, `tips/tips.ts`.
- **Server restart:** needed for phases 2–8, and it ships with the rest of 1.3.0. Under systemd it costs
  every live terminal and needs the owner's OK at that moment. Phase 1 needs none.
- **Landing order:** phase 1 (Alt+Z) can land first. This change lands before `scm-row-actions` and
  `palmux-cli-commands`, which call its contract.
- **Rollback to 1.2.x:** the `preview` flag is dropped, so preview tabs become pinned. A single-file review
  tab shows "This review has no valid address." and can be closed. The same message shows in a window still
  on the 1.2 bundle during the deploy, until it reloads.
- **Main risks:**
  - A window can replace a preview tab one round trip before another window's first keystroke pins it.
    The few keystrokes typed in that window are lost, and that window says so in a toast. Accepted.
  - A window still on the 1.2 bundle shows a kind-change replacement as a close plus a create, because it
    ignores `replaces`. It lasts until that window reloads.
- **Success measures:**
  - Opening 10 files in a row from the Explorer leaves one preview tab per pane plus the pinned ones.
  - A replacement of either kind is one broadcast, and no window renders a tab added, removed or a
    neighbour shown for it.
  - A tab with unsaved text is never replaced, in any window.
  - A Source Control click shows only that file.
  - Alt+Z flips wrap in the editor and the review, and nothing reaches a terminal.
- **Out of scope:**
  - `palmux open` and the Source Control row actions: other changes. They use the contract in
    `design.md`.
  - A preview tab for terminals, web, dashboard or markdown tabs.
  - Wrap for terminals and for the markdown viewer.
- **Non-goals:**
  - Replacing the continuous review.
  - A per-window preview flag: the owner revised that decision after evidence that it would swap files on
    other devices.
