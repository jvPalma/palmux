# Refinement Questions — Session 1

| Field     | Value      |
| --------- | ---------- |
| Session   | 1          |
| Date      | 2026-07-10 |
| Change ID | split-view |

## Analysis Summary

Agents ran: all 6 (spec-completeness, problem-context, requirements-coverage, system-infra,
goal-behaviour, documentation). Total findings: ~50 across the six reports.
Breakdown: ~7 critical, ~20 important, rest minor.

**Already resolved directly (no question needed)** — applied to design/specs/tasks/docs this cycle:

- D2 report-gating was WRONG (per-slot focus). Corrected: each pane keeps today's per-document
  `hasFocus()` gate; slot focus plays no role. (Two split terminals are different PTYs, so the
  duplication it guarded against can't happen in-window; and slot-gating would hang background
  vim/CPR probes.)
- App-level **control socket** (`/ws?control=1`) added (design D9) — the WS is also the tab-list/
  settings/tabCreated channel; moving it into TerminalPane would leave pane-only layouts
  socketless and terminal+terminal layouts double-applying broadcasts.
- **PaneHost** is a global overlay, not per-slot — rewrote D5 to a rect-driven persistent layer
  (no DOM reparenting → iframes/editors never reload on layout change).
- Registry scope narrowed (D3): only shared surfaces route through it; gestures/selection/
  copy-on-select/file-drop are per-pane. `touch.ts` `lastSelection` → instance-scoped.
- Ctrl+Shift+C/V (per-instance window listener in `useTerminal`) and `useFileUpload`'s doc-paste
  listener → hoisted/focus-gated (else double-paste / double-upload).
- SessionTabs `onPointerDown`+preventDefault suppresses HTML5 drag → preventDefault only on mobile.
- File-drag vs tab-drag discrimination (custom `dataTransfer` type) so file uploads don't trigger
  split drop zones.
- Persistence hardened: `{tabId,kind}` slots, recycled-id = dangling, corrupt = discard, ratio on
  settle, deep-link-wins, popout excluded; `replaceState` for focus (no history spam).
- Pop-out protocol documented (origin-validated postMessage, opener-null fallback, window-name
  dedupe, boot-once popout flag, killed-tab handling); PiP deferred out of scope.
- Docs written: `docs/terminal-pane-extraction.md`, `docs/pane-api.md`, `docs/popout-protocol.md`.
- Test scaffolding task added (react-xtermjs mock, RO mock, DnD helper, window.open spy).

The 6 questions below are the genuine PRODUCT decisions I shouldn't make for you.

## Instructions

Write your answer on the blank line after each **Answer:** marker. Letter (e.g. `B`) or freeform.
`SKIP` carries the topic to the next session. Re-run `/opsx:refine split-view` when done.

---

## Questions

### Q1 [CRITICAL] — Resize policy when two windows mirror one terminal (the pop-out case)

The marquee pop-out scenario ("both windows show the same shell") is currently **broken**: each
window sends its own `resize` to the shared PTY (last-writer-wins, server.ts), so a popup opened at
a different size snaps the PTY to its grid and the other window renders wrapped garbage — and it
stays broken until you manually resize. tmux solves this with smallest-client-wins. The original
proposal claimed "Server: none required"; fixing this properly needs a small server change.

**Affected files**: `specs/window-pop-out/spec.md`, `packages/server/src/server.ts` (resize case),
`packages/server/src/pty.ts`, `design.md` D7, `tasks.md` stage 5.

**Options**:

- A) **Smallest-client-wins** (tmux semantics) — server tracks each attached client's last size per
  session, applies `min(cols), min(rows)`, recomputes on attach/detach/resize. Both windows stay
  readable (letterboxed to the smaller). Most correct; a real (small) server change. **Recommended.**
- B) **Latest-wins + broadcast authoritative size** — server keeps last-writer-wins but tells all
  clients the current PTY size so the "losing" window renders a centered mirror instead of garbage.
  Less server work, slightly worse UX (one window letterboxed to the other's size).
- C) **Document last-writer-wins honestly** — no server change; spec says the mirror may be
  imperfect if window sizes differ. Cheapest; the advertised feature is visibly janky.

**Answer:**

---

### Q2 [CRITICAL] — What does clicking a strip tab do while split?

The single most common split interaction, currently unspecified, and the "one tab id in at most one
slot" invariant makes the naive answer illegal. Three sub-cases; I recommend one coherent rule that
also resolves pop-out-return targeting and back/forward (Q-less, I'll apply the same rule):

Rule R: _clicking a tab already shown in the OTHER slot focuses that slot; clicking any other tab
replaces the FOCUSED slot's tab._ (VSCode-like.)

**Affected files**: `specs/split-layout/spec.md`, `specs/chrome-tabs-and-panes` (a MODIFIED note),
`tasks.md` 2.4.

**Options**:

- A) **Adopt Rule R.** **Recommended** — intuitive, no duplicate-tab illegal state, and it doubles
  as the rule for popstate and pop-out-return.
- B) Clicking any tab always replaces the focused slot; clicking a tab that's in the other slot
  SWAPS the two slots. (More motion, occasionally surprising.)
- C) Something else — describe.

**Answer:**

---

### Q3 [IMPORTANT] — "Split" on the active/only tab, and the Ctrl+\ shortcut

Splitting needs two tabs. What happens when the user invokes "Split right/down" on the tab that's
already the sole content, drags the only tab to an edge, or has just one tab open? And does the
VSCode-style `Ctrl+\` shortcut ship (design left it open, task 3.3 says "optional")?

**Affected files**: `specs/split-dnd/spec.md`, `tasks.md` 3.3.

**Options** (pick one for the degenerate case):

- A) **Spawn a new terminal in the empty slot** — matches VSCode "split", and gives `Ctrl+\`
  ("split with current") a clean meaning. **Recommended.** (Implies: yes, ship `Ctrl+\` = split
  current tab with a new terminal, `Ctrl+Shift+\` = close split.)
- B) **Disable/no-op** — the split action is unavailable until a second tab exists (grey out the
  menu item; a toast if attempted). Simpler, less magical. (`Ctrl+\` then only works with ≥2 tabs.)
- C) Prompt the new-tab chooser into the second slot (pick what goes there).

Also: ship `Ctrl+\` at all? (yes with A / defer / no) —

**Answer:**

---

### Q4 [IMPORTANT] — Mobile input surfaces when the focused slot is NOT a terminal (but the other slot is)

In a terminal+editor split on mobile, when the editor slot is focused: what happens to the
extra-keys bar and soft keyboard? Today both hide whenever no terminal is the active tab — but now
a live terminal is visible in the other slot. And web-pane slots can't even be click-focused
(iframes swallow clicks), so focus for a web slot needs a mechanism (window-blur detection or a
first-click overlay — I'll implement whichever fits the choice).

**Affected files**: `specs/terminal-pane/spec.md`, `specs/split-layout/spec.md`, `docs/pane-api.md`.

**Options**:

- A) **Extra-keys bar + keyboard follow the focused slot**: focused pane → keyboard targets it;
  focused non-terminal → bar hides, keyboard releases, the visible terminal gets nothing until you
  focus it. Clean and predictable. **Recommended.**
- B) **Bar always targets the (one) visible terminal regardless of focus** — the extra-keys bar
  never disappears while any terminal is on screen; focusing the editor still lets you fire CTRL+C
  at the terminal. Handy but the "where does my key go" model is murkier.
- C) On mobile, disallow terminal + non-terminal splits entirely (mobile split is terminal+terminal
  or pane+pane only) — sidesteps the matrix. Most restrictive.

**Answer:**

---

### Q5 [IMPORTANT] — Popping out a tab that's currently in a split: does the main window keep it?

Chrome tear-off REMOVES the tab from the source window. palmux's model (server session, multi-
attach mirror) lets it STAY and mirror. Which do you want when you pop out a tab that occupies a
split slot?

**Affected files**: `specs/window-pop-out/spec.md`, `specs/split-layout/spec.md`.

**Options**:

- A) **Stay + mirror** — the main window keeps the split slot; the popup mirrors it (subject to the
  Q1 resize policy). Consistent with palmux's "a session is a URL" model. **Recommended.**
- B) **Leave** — popping out collapses that slot in the main window (Chrome-like); the popup is now
  the only view. Cleaner single-owner mental model, but throws away the split you had.

**Answer:**

---

### Q6 [IMPORTANT] — Mobile split scope (side-by-side on a phone is reachable and likely unusable)

The mobile default is stacked 50/50, degrading to single-slot when "too short". But "Split right"
from the mobile sheet + the orientation toggle let a user force SIDE-BY-SIDE on a ~360px phone
(~20 columns per terminal). Where's the line?

**Affected files**: `specs/split-layout/spec.md`, `tasks.md` 4.4.

**Options**:

- A) **Stacked-only on mobile** — touch devices get vertical splits only; the orientation toggle
  and "Split right" are hidden/absent on mobile; degrade to single-slot when either slot would be
  below a threshold (e.g. < 6 rows). Simplest usable rule. **Recommended.**
- B) **Allow both, degrade per-axis** — permit side-by-side but auto-convert to stacked (or
  single-slot + toast) when a slot would be below N columns / M rows. More flexible, more edge
  cases to get right.
- C) **Desktop-only split** — no split on mobile at all; pop-out is the mobile multi-view story.
  (You said earlier you'd accept desktop-only — this is the minimal-risk option.)

**Answer:**

---

## Processing Log

- [x] All answers parsed — Q1:A, Q2:A, Q3:A (+no default shortcut), Q4:C, Q5:A, Q6:C
- [x] Specs updated — split-layout (desktop-only, Rule R), split-dnd (self-split=new terminal,
      no mobile split), terminal-pane (desktop-shared surfaces), window-pop-out (smallest-client-
      wins resize, stay+mirror)
- [x] Design decisions recorded — D10 (desktop-only), D11 (resize), D4 Rule R, D3 simplified,
      Non-Goals (no default shortcut), Open Questions closed
- [x] Tasks updated — stage 3/4 collapsed (mobile split removed), server resize task added (5.1),
      desktop-only gating throughout
- [x] Docs updated — pane-api.md (registry scope narrowed to desktop surfaces)
- [x] Refinement log appended
