# Refinement Questions — Session 1

| Field     | Value |
|-----------|-------|
| Session   | 1 |
| Date      | 2026-11-02 |
| Change ID | preview-tabs |

## Analysis Summary

Agents ran: zoom-out (PRE), spec-auditor, problem-analyst, coverage-analyst, systems-analyst, behaviour-validator, docs-checker. Every critical and important finding was verified: 34 checked, 0 refuted. No lens missing.
Total findings: 60 (0 critical, 20 important, 40 minor).
Triage: 0 defended, 18 proposed fixes, 5 questions.

## Instructions

Write your answer under each **Answer:** marker, then re-run `/opsx:refine preview-tabs`.
- Write `SKIP` to carry a question forward to the next session.
- Every proposed fix is applied unless you write `REJECT` under it.

---

## Questions

### Q1 [IMPORTANT] — Which pin triggers stay

The brief named five pin triggers: double-click on the tab, double-click on the row, the first edit, save or Ctrl+S, and Keep open. The design adds four server-side ones: rename, colour, group join and window move (D1, `design.md:75-77`). The window-move pin has a cost the design already accepts: a detached window's preview comes back pinned after every reclaim. That pin also cannot be persisted as written, because `setWindow` saves nothing, so the preview returns after a restart. Group join must pin, because D3's reorder relies on "a preview is never in a group". `groupCreate` was missing and must be added.

**Affected files**: `design.md` D1/D4, `specs/workspace-tabs`, `specs/preview-tabs`, `tasks.md` 2.1

**Options**:
- A) Keep rename, colour and group join (adding `groupCreate`). Drop the window-move pin, so a detached window keeps its preview. (Recommended)
- B) Keep only the brief's five plus group join. Rename and colour keep a tab as a preview.
- C) Keep all four. Add a `pin(ids)` registry method that saves on a window move, and decide whether a grace release pins too.

**Answer:** A


---

### Q2 [IMPORTANT] — Replacing a preview of another kind (editor ↔ single-file review)

D3 step 4 sends `kill P`, then `createTab`. The kill is unconditional. If another window pinned P in the last round trip, or has unsaved text in it, the kill destroys that tab, which breaks "a tab with unsaved text is never replaced". The new tab also usually takes P's old id with another kind, which close-navigation, `registerReview(id)` and reconcile all trip on.

**Affected files**: `design.md` D3/D4, `specs/preview-tabs` "The next preview open replaces…", `tasks.md` 3.2

**Options**:
- A) Create first. `createTab` makes a fresh id. On its `tabCreated`, send `kill { id: P, ifPreview: true }`, which the server ignores if P was pinned meanwhile, so the user then simply has both tabs. (Recommended)
- B) Kill first, as designed, with `ifPreview: true` on the kill. Document the same-id kind change and add an App test for that order.

**Answer:** nao quero saber qual, so queroi que para o user que estiver a usar o palmux, nao hajam tabs a voar, ou serem adicionadas e removidas nem por uma unica fraccao de segundos. faz zoom-out e ve como o vscode faz isso, temos acesso ao opensource codebase dele.


---

### Q3 [IMPORTANT] — Alt+Z in the markdown viewer

The design assumed markdown code blocks wrap today. In fact they never do: the `pre` scrolls sideways and `code.md-hl` forces `white-space: pre`. A default-on `editorWrap` would therefore change how every markdown file reads, and the proposed CSS would not work. The brief's item 14 covered only the editor and the review.

**Affected files**: `proposal.md`, `design.md` D7, `specs/editor-pane`, `tasks.md` 6.3

**Options**:
- A) Leave markdown out of 1.3.0. Alt+Z covers only the editor and the review. (Recommended)
- B) Make markdown code blocks follow `editorWrap`, default on. That is a new behaviour, listed in What Changes, with CSS that overrides `code.md-hl`.
- C) Markdown keeps scrolling by default and follows the setting only after a toggle, using a separate `markdownWrap` key.

**Answer:** A


---

### Q4 [IMPORTANT] — A single-file review preview with a comment draft

A review preview is never treated as dirty. Drafts live in the window's comment store (keyed by path, side, range and scope), so replacing the tab hides a draft rather than deleting it: reopening the file shows it again. The user still loses sight of it without warning.

**Affected files**: `design.md` D3/D4, `specs/preview-tabs` "Using a preview tab pins it", `tasks.md` 3.4/5.2

**Options**:
- A) Opening the comment composer pins the review preview. Reviewed and Unstage do not pin, because they move to the next file inside the same tab. (Recommended)
- B) Never pin. Document that a draft survives in the store and returns when the file is reopened.

**Answer:** A


---

### Q5 [MINOR] — Ship Alt+Z (phase 6) independently

Phase 6 (Alt+Z, `editorWrap`, the Alt+letter `e.code` fallback) shares no code, protocol field or `ready` flag with preview tabs, and it needs no server restart.

**Affected files**: `proposal.md`, `tasks.md` phase 6

**Options**:
- A) Keep it in this change, renumbered as phase 1, and state that it can be implemented and merged before the rest. (Recommended)
- B) Move it to its own change, `editor-wrap-toggle`.
- C) Leave it as it is, last.

**Answer:** A


---

## Proposed Fixes

Each fix is applied on re-run unless you write `REJECT`.

### F1 — Correlate `tabCreated` by content, not by position (systems, docs-checker; IMPORTANT)
**Fix**: In D3 and task 3.2, the `tabCreated` handler looks the id up in `tabsRef` and applies `pendingPreviewRef` only when the kind and url equal the pending create's. If the answer arrives before the list, it is held until the next `sessions` message. Replace "the existing pattern" with a citation of `App.tsx:1946`. Keep the latest-url follow-up. Drop the pin merge.
**Response:**

### F2 — Exact guard-failure signal (behaviour-validator, IMPORTANT)
**Fix**: Fall back to a new preview only when P is listed WITHOUT `preview`, or when P is absent. A different url alone never triggers it. Add scenarios for: an unrelated broadcast between the send and the ack (no duplicate), P closed by another window (the open lands as a new preview), and a 5 s timeout (toast "Could not open <name>").
**Response:**

### F3 — Explain why `ifPreview` exists (zoom-out, MINOR)
**Fix**: Add to D1: it protects a tab another window pinned on purpose (double-click, Keep open) seconds earlier, which the opener's local `dirtyRef` cannot see.
**Response:**

### F4 — Specify the replacement rules (spec-auditor, coverage; IMPORTANT)
**Fix**: In `specs/preview-tabs`:
- Add "a pinned open of a target whose tab is a preview pins it" to the trigger list, with a scenario (`palmux open`).
- Replace "at most one preview tab that this window opened" with "the replaced preview is the pane's active preview, else its last preview in strip order", with a two-preview scenario.
- Add the "another window pinned it first" scenario.
- Cover a preview opened inside a detached window.
**Response:**

### F5 — Scope the living diff-review requirements to the continuous review (coverage, spec-auditor; IMPORTANT)
**Fix**: Add MODIFIED entries for "The review shows the whole group as one list", "The review follows the disk while visible", "The review is navigable…" and "Reviewing a file stages it and moves on", saying what a single-file review keeps and changes. Update the detached-windows scenario "Opening a review or file another window holds" for the per-file url. Add the rejected alternative "a one-file mode on the group tab": tabs are shared across windows, and the group review must stay open beside the preview.
**Response:**

### F6 — Review host contract (problem-analyst, docs; IMPORTANT)
**Fix**: Add `showFile(tabId, path)` and `openReview(target)` to `ReviewHost` and `DEFAULT_REVIEW_HOST` in `review/review-host.ts`. ReviewPane passes its own `tab.id`. If `showFile` gets no broadcast within 2 s, it toasts "Could not open the next file". Name the file in Impact and in task 5.2.
**Response:**

### F7 — No remount on next file (systems, IMPORTANT)
**Fix**: Task 5.1 changes ReviewView's React key from the url to `${tabId}|${group}|${top}` and passes `file` as a prop. List every url-dependent effect (scroll target, write state, end state) and what resets on a file change.
**Response:**

### F8 — Thread the new fields through every hand-written copy point (systems, problem; IMPORTANT)
**Fix**: Task 2.1: add `preview?: true` to `CreateTabSpec`, and `preview?: false` plus `ifPreview?: true` to `UpdateTabPatch` (and `kill`, if Q2 A). The ws handler forwards them. Add a socket-level ws-tabs test. Task 3.1: widen `lib/ws.ts` `sendCreateTab`/`sendUpdateTab` and App's `CreateSpec`.
**Response:**

### F9 — Complete the Impact list and fix the named hooks (problem, systems, docs; IMPORTANT)
**Fix**:
- Add to Impact: `lib/ws.ts`, `review-host.ts`, `session/tab-meta.ts`, `review-model.ts`, `FileTabPane.tsx`, `FilePane.tsx`, `PaneHost.tsx`, `session/GroupsView.tsx`, `index.css`, `tips/tips.ts`.
- Task 3.5 threads `onPinTab` through `GroupsView`.
- Task 3.4 hooks `App.onPaneDirty` (not `onDirtyChange`) and sends a pin only once per tab until the broadcast shows it pinned. The pane-move pin goes in `commitLayout`'s effect, not inside the pure `moveTab`/`splitPane`.
**Response:**

### F10 — Coordinate with scm-row-actions on `.rv-current` (spec-auditor, IMPORTANT)
**Fix**:
- In "Shared files": scm-row-actions owns the `.rv-current` header and its `n / N` format. In a single-file review, the bar's Reviewed advances through `showFile`.
- The group header's Open review button uses the kit's `sm` size.
- Add a note to task 5.2.
**Response:**

### F11 — Phase gates (systems, IMPORTANT)
**Fix**: Every gate (1.4, 2.4, 3.6, 4.3, 5.4, 6.7) becomes `yarn workspace @palmux/<pkg> vitest run <package-relative paths>`, plus `yarn typecheck` and `yarn lint`.
**Response:**

### F12 — Double activation is a pointer double-click only (coverage, MINOR)
**Fix**: Pinning from a row needs a real double-click (`detail === 2`) on that row. Two Enter presses do not pin. Add a scenario. Rename on a pinned tab is unchanged. Reword the clashing tab-customization scenario as "on a pinned tab".
**Response:**

### F13 — Keyboard and screen-reader route to pin, and a visible wrap control (behaviour, MINOR)
**Fix**:
- Add "Keep open" to the desktop tab context menu (preview tabs only).
- The pill's accessible name ends in ", preview".
- Add an "Editor word wrap" switch to Settings → Appearance.
- `toggleWrap` shows in the command palette only for an editor or review tab. Add a task and a scenario.
**Response:**

### F14 — Mark user-visible changes BREAKING (coverage, MINOR)
**Fix**: In the proposal, mark three changes BREAKING:
- A Source Control click now opens a single-file preview.
- A double-click on a preview pill pins it.
- Editor wrap becomes a toggle.
**Response:**

### F15 — Compatibility and failure gaps (systems, behaviour, MINOR)
**Fix**:
- `previewSupportedRef` defaults to `false` until the first `ready`, and is re-read on every `ready`.
- A pin sent while the control socket is down is re-sent on reconnect if the tab is still dirty.
- An old client never pins, so its tab stays a preview for new clients. Document that, and also that an old bundle shows `changes-file:` tabs as "This review has no valid address" during the deploy window.
- If the kind-change create is refused, P is left untouched (with Q2 A this is automatic).
**Response:**

### F16 — Narrow the dirty-replaced toast (behaviour, MINOR)
**Fix**: The toast fires only when a tab that was a PREVIEW and dirty changes url because of a remote replace, never on a pinned tab following a link. The cross-window replace order stays as designed.
**Response:**

### F17 — One canonical home for the pin rules (spec-auditor, MINOR)
**Fix**:
- The full trigger list lives only in `specs/preview-tabs`.
- The other deltas (workspace-tabs, editor-groups, file-browser, tab-customization) state only their own surface's trigger and point to preview-tabs.
- Add the missing scenarios for colour and group join, and for `ready.previewTabs`.
- Add `preview` to the `sessions` broadcast field list.
- The Alt+letter requirement keeps D8's AltGraph exclusion.
**Response:**

### F18 — Fix the Why text and set the landing order (problem, MINOR)
**Fix**:
- The Why says a Source Control click today opens the group review scrolled to the file, and the problem is the other 52 files around it.
- Review wrap is reachable from the bar and its overflow menu, both by pointer.
- State that this change lands before scm-row-actions and palmux-cli-commands.
- Replace the approximate `~line` references with symbol names.
**Response:**

---

## Defended

None. The verifier refuted no finding.

---

## Processing Log (filled automatically on re-run)

- [x] All answers parsed (Q1 A, Q2 owner text → `replaceTab` in place, Q3 A, Q4 A, Q5 A)
- [x] Specs updated (preview-tabs, workspace-tabs, editor-groups, diff-review, detached-windows (new), tab-customization, file-browser, editor-pane, configurable-keybindings)
- [x] Design decisions recorded (D1, D3, new D3a, D4, D6, D7, D9; "Session 1 decisions" table)
- [x] Tasks updated (Alt+Z moved to phase 1; phases renumbered 1–8)
- [x] Docs updated (no `docs/` folder; CLAUDE.md work stays task 7.1)
- [x] Proposed fixes applied (rejected: none)
- [x] Reopened defended items carried forward (none)
- [x] Refinement log appended
