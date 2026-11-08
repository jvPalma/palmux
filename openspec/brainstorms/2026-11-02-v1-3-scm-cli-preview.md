# palmux 1.3.0: Source Control actions, preview tabs, `palmux` CLI commands

| Field | Value |
|---|---|
| Status | handed-off (`preview-tabs`, `scm-row-actions`, `palmux-cli-commands`) |
| Date | 2026-11-02 |
| Proposed change ids | `scm-row-actions` · `preview-tabs` · `palmux-cli-commands` (plus two fixes outside a change) |

## Objective
Make palmux's Source Control as quick to act on as VS Code's:
- You stage, unstage, discard and open files and folders straight from the list.
- The review always keeps its file actions on screen.
- Review comments reach an AI agent without copy and paste.
- From any palmux shell you can open a file, or a repo's Source Control.
- Files you only glance at stop piling up as tabs.

## Today
- **SCM list.** `scm/SourceControlView.tsx` and `scm.css` draw a tree with 28px rows and a 12px indent on a desktop, and 24px and 8px on a phone. `source-control` "The changed-files list is compact on a phone" pins "The desktop is unchanged". A row only opens the review, and no row has actions.
- **Writes.** Exactly three writes exist, all to the index: stage the token snapshot, unstage, and undo through a receipt (`server/src/scm-index.ts`, one `update-index` per path under `index.lock`). Stage hashes with `--no-filters` (`scm-index.ts:333`). Specs: `source-control` "The only git write is one file's index entry" (it SHALL NOT discard or touch the work tree) and `diff-review` "The review never edits or discards". The receipt and token cache is one shared 64 MB store with a 10-minute LRU (`scm-snapshot.ts:95-134`). The Undo toast lasts 6 s (`review/write-log.ts`).
- **Review file header.** The header is a virtualised row with Reviewed or Unstage and Open file (`review/ReviewRow.tsx`, `.rv-head`). Rows are absolutely positioned inside react-window, so `position: sticky` has nothing to stick to, and the header scrolls away. The `.rv-current` bar above the list always names the file and its "n/N".
- **Comments.** "Copy comments" exists as an icon only (`SourceControlView.tsx:675`). The export and outdated marking live in the client only (`review/export-md.ts`, `scm/copy-comments.ts`, `review/comment-placement.ts`, `review/anchor.ts`). Each comment already carries its path and range (`review-comments` "Comments export as one markdown document"). The server only stores comments (`scm-comments.ts`, fixed `FIELDS`).
- **CLI.** Only `palmux download` exists (`palmux-cli.ts`, `cli-api.ts` `POST /cli`). It finds the terminal by tty and sends on that terminal's DATA socket, with no acknowledgement. Any other `cmd` gets a 400, and there is no living spec. `serverPath` handles `~/` and relative paths. `scm-git.ts` `resolveRepo` already maps a path to its work-tree top. The `jvPalma/dev` branch at 6db54ba holds an unmerged `palmux <file>` design.
- **Tabs.** Tabs are server state, shown by every main window on every device (`detached-windows/spec.md:64`). `openFileTab` focuses a path that is already open (`App.tsx:2506`). Preview tabs do not exist.
- **Wrap.** The review has `scmWrap`. Monaco `wordWrap` is `'on'` on purpose and is re-sent on every width crossing (`panes/editor-layout.ts:25-76`). `Alt+Z` is unbound. The matcher reads `e.key` (`keybindings.ts:150`), so Option+Z on a Mac arrives as `Ω`.
- **Editor dead zone** (owner's recording, 2026-11-02). At the editor's top-right corner, overlapping elements keep swapping hover: Monaco's find widget and its tooltips, and the pane header (saved, Read, Edit). Tooltips flash and clicks do not land.

## Approach

### Change 1: `scm-row-actions`
1. **Density.** The desktop rows get denser, VS Code style, written from scale tokens (target about 22px rows and an 8px indent). The phone keeps its 24px rows. This MODIFIES "The changed-files list is compact on a phone", renamed to cover both device classes.
2. **Row actions.** On hover or keyboard focus, a row shows icons at its right edge. On a phone, the same actions sit in the row's long-press menu. Discard sits apart from Stage.

   | Group | File row | Folder row |
   |---|---|---|
   | Merge Changes | Open file | — |
   | Staged | Open file · Unstage | Unstage all under it |
   | Changes (M, D, R, untracked) | Open file · Stage · Discard | Stage · Discard all under it |
3. **Live stage and unstage** (owner). This stages what is on disk now, not the shown snapshot.
   - It runs git's own `git add` / `git restore --staged` on paths whose `check-attr` shows **no** filter, `working-tree-encoding` or `ident`. Line endings then behave exactly as in a terminal, and no filter ever runs.
   - A converted file (LFS and the like), an unmerged file or a nested repo is skipped and listed.
   - Paths go in by stdin (`--pathspec-from-file`). The cap is `STATUS_ENTRY_LIMIT` (5,000). A folder action is refused while the status is truncated.
   - The before and after entries are recorded as today, so Undo works.
   - Reviewed in the review keeps its "stage what you read" token rule.
4. **Discard with Undo** (owner).
   - **The set is fixed at confirm.** The client sends each path with the `fp` it listed. The confirm dialog names the files (or counts them) and says the Undo is lost on a restart.
   - **Before any write,** the server keeps each file's bytes with `git hash-object -w --no-filters`, so the backup is in git's object store and not in RAM. The receipt then holds only oids and modes, in a **dedicated** store that tokens cannot evict, for 10 minutes.
   - A file whose `fp` changed since the confirm (an agent writing it) is skipped and reported.
   - It refuses symlinks, special files, submodules and converted files. A tracked file is restored from the index blob. An untracked file is deleted through the same guards as `files.ts` `deletePath`.
   - **Undo is a compare-and-swap on the work tree.** It refuses with a 409 if the file now exists or differs, and it recreates missing parent folders.
   - Undo is reachable from the 6 s toast and, for the rest of the 10 minutes, from "Undo last discard" in the SCM view's menu.
   - This MODIFIES "The only git write is one file's index entry" (both the text and the "write surface" scenario) and "Git access is confined and bounded".
5. **Review header always visible.** `.rv-current` becomes the header of whichever file is on top: name, counts, Reviewed or Unstage, and Open file. It is disabled, with a reason, while that file's snapshot is not loaded. The in-list header keeps its controls, and both go through the same write queue. On a phone the bar stays a label: the review bar already has Reviewed, and "The review wastes no height on a phone" holds.
6. **Audit.** One `console.info` line goes out per discard, undo or refusal, and per folder stage or unstage: repo, count, receipt and lock time. This follows the `server.ts:1318` convention.

### Change 2: `preview-tabs`
7. **Preview tab, one per pane** (VS Code keeps one per editor group).
   - Opening from the Explorer, from the SCM click, or from Open file lands in the focused pane's preview tab. Its title is italic and carries a "Preview" title and accessible label.
   - The flag lives on the **server**, `TabMeta.preview` (owner), and rides the 1.3.0 restart behind a `ready` flag.
   - A tab is **pinned** by: a double-click on the tab, a double-click on the source row, the **first edit** (dirty) from any window, a save or Ctrl+S, or "Keep open" in the phone's tab sheet.
   - The next preview open replaces the preview. It uses `updateTab { url }` when the kind is the same, and close plus create otherwise. A file already open as a pinned tab is only focused.
   - Opening a tab that another window holds follows `detached-windows` "Opening a review or file another window holds".
8. **SCM click opens a per-file diff in the preview tab** (owner: look at one file without a 53-file list). The continuous review stays and opens from each group header.
   - The per-file tab is the review pane filtered to one file. It uses a new review-url form whose separator cannot appear in a path, set behind a `ready` flag. A rollback drops these tabs.
   - In this tab, Reviewed stages the file and loads the next file of the group.
   - A file that leaves the group shows "No longer changed", not a silent close.

### Change 3: `palmux-cli-commands`
9. **`palmux open <file>`.** The path can be absolute, `~/`, `./rel` or `rel` (against cwd). It opens a **pinned** editor tab (an explicit request) in the caller's window, through tty routing.
10. **`palmux git`.** Run from any nested folder, it calls `resolveRepo(cwd)` and gets the top: `~/dgsl/apps/frontoffice/lib` maps to `~/dgsl`. Outside a work tree it exits 1 with "not inside a git work tree". The server sends a frame to the caller's window, and **that window** adds the repo to `scmRepos` (the normal settings merge) and makes it active on its device. It then opens Source Control in the dock or the drawer. This MODIFIES "The view starts with no project" with an explicit-command carve-out.
11. **Honest exits.**
    - The browser acknowledges `open` and `git` (`opened`, `held by another window`, or an error) within 3 s. The CLI prints the outcome. With no acknowledgement it exits 1 with "no palmux window answered".
    - `/cli` replies name the commands the server supports. A CLI newer than the server then says "this server predates `palmux open`; restart it".
    - Every `/cli` command is logged with its tty and result.
12. **`palmux comments`.** It needs **no tty**: it resolves the top from cwd and prints agent-ready markdown to stdout.
    - `export-md`, `comment-placement` and `anchor` (plus a `languageOf` the server can import) move to `@palmux/shared`, so the button and the CLI produce the same text, including "(outdated)".
    - Server-side snapshot reads skip `putToken`, so a CLI loop never evicts receipts.
    - A repo with no comments prints nothing and exits 0.
13. **Comments loop.**
    - A labelled **Copy comments** sits in the review bar, and a per-file copy sits in the file header.
    - The output starts with an agent preamble ("Address these review comments…") and uses `path:Lstart-Lend` headings, a format change of the existing ranges.
    - **Resolve = delete** (owner), with the Undo toast.
    - **Clear all** asks once and names the count.
    - The store format does not change.

### Fixes outside a change
14. **Alt+Z** toggles wrap in the focused file view.
    - Editor: a new local `editorWrap`, default on and taken out of the width-driven options.
    - Review: `scmWrap`.
    - It is not active on a terminal tab.
    - For letters with Alt, the matcher falls back to `e.code`, so Option+Z works on a Mac. That is a small MODIFIED of `configurable-keybindings`, so this fix may ride Change 2.
15. **Editor top-right hover thrash.** First investigate the find widget, Monaco hovers and the pane header stacking. Acceptance: only one element owns the hover at a time, a tooltip never covers its own trigger, and every button there takes the first click, in a split pane and in Read mode.

Options rejected:
- Per-file tabs replacing the review (the owner keeps both).
- A per-window preview flag (it swaps files on other devices).
- A folder stage limited to loaded snapshots.
- Discard with no Undo.
- An in-RAM byte backup (64 MB LRU eviction).
- A stored "resolved" state.
- One big change.

## Who cares
The owner reviews AI agents' changes daily, on a desktop and on a phone. He needs fewer trips to a terminal for git, comments that flow back to the agent, and fewer tabs to close.

## Success measures
- From the SCM list, you can stage, unstage, discard (one click plus a confirm) or open a file or folder with no terminal.
- Wherever the review is scrolled inside a file, Reviewed is on screen and works with zero scrolling up (desktop).
- An Undo after a discard brings the bytes back identical, both from the toast and from the menu within 10 minutes, and it is refused with a reason if the file changed since.
- `palmux comments` gives Claude Code every comment with `path:Lstart-Lend`, and the text matches Copy comments byte for byte.
- `cd ~/dgsl/apps/frontoffice/lib && palmux git` opens the `~/dgsl` Source Control in the caller's window and exits 0. `palmux open ./x.ts` opens `x.ts` there. With no window it exits 1.
- Opening 10 files in a row from the Explorer leaves one preview tab per pane plus the pinned ones. A dirty tab is never replaced.
- Alt+Z flips wrap in the editor and in the review, and nothing reaches a terminal.

## Scope
- **In:** items 1 to 15, desktop and phone.
- **Out / follow-up:** per-hunk or per-line stage and discard; commit from palmux; `palmux tabs | groups | status | settings`; a durable discard Undo across restarts.
- **Non-goals:** replacing the continuous review; a git client (branches, commits, push); running git filters or hooks in palmux writes.

## Landscape
| Kind | Item | Relation |
|---|---|---|
| Capability | `source-control` | MODIFIED: "The only git write…", "Git access is confined and bounded", "The changed-files list is compact on a phone", "The view starts with no project"; ADDED: row actions, discard and Undo |
| Capability | `diff-review` | MODIFIED: "A review opens in the content area", "The review shows the whole group as one list", "Reviewing a file stages it and moves on", "The review is navigable…", "The review wastes no height on a phone"; ADDED: always-visible current-file header, per-file review |
| Capability | `review-comments` | MODIFIED: "Comments export as one markdown document" (shared format, CLI path), "Comments can be edited and deleted" (Resolve, Clear all) |
| Capability | new `preview-tabs` | ADDED; plus small MODIFIED entries in `workspace-tabs` (`TabMeta.preview`), `chrome-tab-strip`, `editor-groups` (which pane), `editor-pane`, `file-browser` |
| Capability | `detached-windows` | constrains preview opens of a tab another window holds |
| Capability | `configurable-keybindings` | MODIFIED: matching on `code` for Alt letters; ADDED `toggleWrap` |
| Capability | new `palmux-cli` | ADDED: `download` (existing, unspecced), `open`, `git`, `comments` |
| Active change | none | — |
| Archived decision | `2026-10-27-source-control-review` | token stage, receipts, comments outside the repo |
| Archived decision | `2026-10-28-split-editor-groups`, `2026-10-30-detached-windows` | one tab one pane; open in the focused pane; shared tabs across windows |
| Code | `scm-index.ts`, `scm-snapshot.ts`, `scm-git.ts` `resolveRepo`, `files.ts` `deletePath` | reuse |
| Code | `cli-api.ts`, `palmux-cli.ts` `serverPath`, `scripts/palmux` | extend |
| Code | `review/export-md.ts`, `comment-placement.ts`, `anchor.ts`, `panes/editor-language` | move to `@palmux/shared` |
| Code | `review/ReviewPane.tsx` (`.rv-current`), `App.tsx` `openFileTab`/`openReview`, `panes/editor-layout.ts` | change |
| Branch | `jvPalma/dev` 6db54ba | prior `palmux <file>` design to mine |

## Risks & costs
- **The first work-tree write.**
  - Mitigations: a set fixed at confirm, a backup in the object store before the write, a work-tree compare-and-swap on Undo, an audit line, and confirm text that names the restart limit.
  - Dangling backup objects are pruned by `git gc` (git's default 2 weeks), which is accepted.
- **Index lock time on a large folder:** batched over stdin, capped at 5,000, with lock time logged.
- **Restart costs, corrected.**
  - Under systemd, a restart costs every live terminal and needs the owner's OK.
  - A SIGUSR1 or self-update restart keeps the shells.
  - **Any** restart drops tokens, receipts and pending Undos.
- **Compatibility.**
  - A new client on an old server hides the row actions, preview and per-file review behind `ready` flags.
  - A new CLI on an old server says "restart it".
  - A browser on an old bundle never acknowledges, so the CLI exits 1 instead of a false 0.
  - A rollback to 1.2.x drops `preview` and the per-file review tabs.
- **Cost:** `palmux comments` reads one snapshot per commented file, with no tokens kept. The output grows with the number of comments, and there is no cap today.

## Goldfish review
- **Agents and findings.** zoom-out, spec-auditor, systems-analyst, behaviour-validator and problem-analyst. Raw: 5 critical / 39 important / 17 minor; after dedupe, about 25 distinct issues.
- **Defended.**
  - The per-file diff (zoom-out: "no stated problem"): the owner wants one file without the 53-file list, and he keeps the review. It is now stated.
  - Live stage versus "stage what you read": Reviewed keeps the token rule, and only list actions are live.
- **Fixed in this brief.**
  - Discard backup moved to the object store with a dedicated receipt store (the 64 MB LRU would have evicted it).
  - Filtered files skipped, and git's own `add`/`restore` used for the rest.
  - The set fixed at confirm, plus `fp` skips, to cover a racing agent.
  - Batching and a cap for folder actions.
  - Undo reachable after the toast.
  - `palmux comments` needs no tty, and the exporter moves to shared.
  - `palmux git` writes through the caller's window and carves out "starts with no project".
  - The CLI gets acknowledgements and the command list.
  - Audit logs, and corrected restart facts.
  - Pin on the first edit, not the save.
  - One preview per pane, close plus create across kinds, phone pin gesture.
  - Per-file url with a safe separator behind a flag.
  - The header overlay is disabled while unloaded, and the phone is unchanged.
  - The Alt+Z `code` fallback and `editorWrap` taken out of the width options.
  - Testable acceptance for the hover bug.
  - The slice count, plus Today corrections (wrap on by design, header controls exist, ranges exist).
- **Decided with the user.**
  - Discard: confirm plus Undo.
  - List stage: live.
  - Comments: the CLI, a visible button, an agent format, and resolve.
  - Resolve = delete.
  - Preview flag: server field, revised from per-window after the cross-device evidence.
  - SCM click: a per-file diff, keeping the full review.
  - Dead zone: overlapping hover elements.
  - Split: 3 changes plus fixes.

## Open questions
- The per-file review url: the exact separator and prefix (for example, an encoded payload after a new `changes-file:` prefix), and how old clients render it.
- Does the "Undo last discard" menu keep only the latest discard, or a list?
- The exact desktop row and indent tokens: verify against the VS Code reference screenshot at 1440 px.
- Does Alt+Z apply to the markdown viewer, and does the wrap state live per device (proposed) or per tab?
- Implementation order: the `preview-tabs` routing is used by the SCM click, so `scm-row-actions` (Open file) and `preview-tabs` must agree on `openFileTab`'s preview entry point.
