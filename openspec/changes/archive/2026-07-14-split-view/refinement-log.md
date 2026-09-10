# Refinement Log: split-view

## Progress Summary

| Topic                                                     | Status                                       | Session |
| --------------------------------------------------------- | -------------------------------------------- | ------- |
| Report-gating semantics (D2)                              | approved                                     | #1      |
| Control-socket ownership (D9)                             | approved                                     | #1      |
| Pane geometry / persistent layer (D5)                     | approved                                     | #1      |
| Focus-registry scope (D3)                                 | approved                                     | #1      |
| Clipboard combo / file-upload de-duplication              | approved                                     | #1      |
| Drag init vs pointerdown-preventDefault                   | approved                                     | #1      |
| Persistence hardening (kind, corrupt, settle, deep-link)  | approved                                     | #1      |
| Pop-out protocol (origin, opener-null, dedupe, boot-once) | approved                                     | #1      |
| Document PiP scope                                        | approved (deferred out)                      | #1      |
| Resize mirror policy (Q1)                                 | approved — smallest-client-wins              | #1      |
| Strip-click-while-split rule (Q2)                         | approved — Rule R                            | #1      |
| Self-split / Ctrl+\\ (Q3)                                 | approved — new terminal; no default shortcut | #1      |
| Mobile non-terminal-focus matrix (Q4)                     | approved — moot (desktop-only split)         | #1      |
| Pop-out stay-vs-leave (Q5)                                | approved — stay + mirror                     | #1      |
| Mobile split scope (Q6)                                   | approved — desktop-only                      | #1      |

## Session #1 — 2026-07-10

### Focus

First full 6-agent pass on the freshly-authored split-view change (incl. the window-pop-out
capability added just before refinement). Goal: validate the terminal de-singletonization against
the real codebase and close the gap between the split's statics (well-specified) and its dynamics
(under-specified).

### Agent Findings Summary

- **Agent 1 (Spec Completeness)**: 2 critical + 6 important. Strip-click-while-split unspecified &
  collides with chrome-tab-strip's click requirement; single-slot "focused" undefined; orphan tasks
  (mobile degrade, ⇔ control, Ctrl+\\, PiP); task 4.2 vs pop-out contradiction.
- **Agent 2 (Problem & Context)**: D2 report-gating premise logically INVALID (different PTYs; would
  hang background probes); control-socket ownership breaks pane-only/dual layouts; PaneHost is a
  global overlay not per-slot; per-instance window listeners (Ctrl+Shift+C/V, file paste) duplicate;
  D3 registry wrong shape for gestures.
- **Agent 3 (Requirements Coverage)**: 14 gaps; the four HIGH share a root — every existing
  interaction re-entering a split is undecided (strip-click, exit/collapse, popout return, back/
  forward); one decision rule resolves three at once. postMessage origin validation missing.
- **Agent 4 (System & Infrastructure)**: control-socket decision needed; useTerminal window-capture
  clipboard listener (no task touched it); SessionTabs pointerdown-preventDefault suppresses HTML5
  drag; useFileUpload/gestures per-pane; happy-dom test-infra gaps (no DragEvent, RO no-op).
- **Agent 5 (Goal & Behaviour)**: pop-out mirror scenario UNACHIEVABLE without a resize policy
  (last-writer-wins → wrapped garbage); iframe slots can't be click-focused as specced; module-level
  `lastSelection` corrupts two terminals; per-instance Ctrl+Shift+V pastes into both shells.
- **Agent 6 (Documentation)**: WS is also the app control channel (unaddressed by extraction);
  PaneApi inconsistent between D3 and task 1.3, never written as TS; TerminalPane props elided;
  postMessage protocol undocumented; stage-1 moving-map too thin for a 640-line App.tsx.

### Topics Discussed

#### Report-gating semantics [APPROVED]

- **Severity**: Critical. **Decision**: keep the per-document `hasFocus()` gate per pane; slot focus
  plays no role. **Rationale**: two split terminals are different PTYs (no in-window duplication);
  slot-gating would hang background vim/tmux/CPR probes. **Applied to**: design D2, specs/terminal-
  pane, tasks 1.4/1.8.

#### Control-socket ownership [APPROVED]

- **Severity**: Critical. **Decision**: App owns a persistent `/ws?control=1` socket for all
  app-level messages/sends; TerminalPanes own data-only sockets. **Rationale**: pane-only layouts
  would be socketless; dual terminals would double-apply broadcasts. **Applied to**: design D9,
  proposal Impact, tasks 1.2/1.3.

#### Pane geometry [APPROVED]

- **Decision**: one persistent rect-driven content layer, no DOM reparenting on layout change.
  **Rationale**: PaneHost is a global overlay; reparenting reloads iframes. **Applied to**: design
  D5, tasks 2.2.

#### Registry scope, listener de-dup, drag-init, persistence, pop-out protocol [APPROVED]

- Applied to design D3/D4/D7, proposal Impact, specs (terminal-pane, split-layout, split-dnd,
  window-pop-out), tasks (1.1/1.5/1.6, 4.1/4.2, 5.1–5.3), and docs/*.

### Questions Asked

6 questions in `questions-session1.md` (2 critical, 4 important) — the genuine product decisions:
resize mirror policy (Q1), strip-click rule (Q2), self-split/Ctrl+\\ (Q3), mobile non-terminal
input matrix (Q4), pop-out stay-vs-leave (Q5), mobile split scope (Q6).

### Files Updated

- `proposal.md` — server/Impact amended (control socket, resize policy, full touched-file list),
  PiP deferred.
- `design.md` — D2 corrected, D3/D5 rewritten, D9 added, D4/D7 hardened, Risks/Open-Questions.
- `specs/terminal-pane/spec.md` — report gate rewritten; clipboard-combo + instance-scoped touch
  requirements added.
- `specs/split-layout/spec.md` — single-slot focus, clamp numbers, persistence hardening, mobile
  defaults, pane-header control, new-tab/mobile-input requirements + scenarios.
- `specs/window-pop-out/spec.md` — popout-mode/return hardened, cross-window gating requirement.
- `specs/split-dnd/spec.md` — degenerate self-split scenario.
- `tasks.md` — stage 1 restructured (control socket, scaffolding, de-dup, docs refs); stages 2–5
  corrected.
- `docs/terminal-pane-extraction.md`, `docs/pane-api.md`, `docs/popout-protocol.md` — created.

### Gap Analysis

- Session start: ~50 findings (~7 critical).
- Session end: 6 open decisions (2 critical), all in questions-session1.md; every other finding
  resolved and applied. ~88% reduction.

## Session #1 answers applied — 2026-07-10

### Focus

Processed the six session-1 answers (Q1:A, Q2:A, Q3:A+no-shortcut, Q4:C, Q5:A, Q6:C).

### Decisions

- **Q1 [APPROVED]** smallest-client-wins PTY resize for mirrored windows (tmux semantics). New
  server task 5.1; design D11; window-pop-out gains a resize requirement. Amends "Server: none".
- **Q2 [APPROVED]** Rule R for strip selection while split (click a tab in the other slot → focus
  it; else replace the focused slot's tab), reused for popstate + pop-out return. design D4;
  split-layout requirement + scenarios; task 2.4.
- **Q3 [APPROVED]** the degenerate self/only-tab split spawns a NEW terminal in the empty slot;
  **no default keyboard shortcut** (Ctrl+\ collides with the user's tmux vertical-split binding) —
  any future shortcut must be user-configurable, default unset. split-dnd scenario; Non-Goals;
  tasks 3.1/3.2.
- **Q4 + Q6 [APPROVED]** split is **desktop-only** — no split while the mobile layer is active.
  Collapses the whole mobile branch: removed mobile stacked-default/degrade requirements, the
  mobile input matrix, the mobile TabSheet "Split" action, and touch DnD. design D10; new
  split-layout requirement; terminal-pane requirement reframed to desktop-shared surfaces; D3 +
  pane-api registry scope narrowed; tasks 3/4 simplified.
- **Q5 [APPROVED]** popping out a split slot's tab keeps the main split and mirrors it. design D7;
  window-pop-out requirement; task 5.3.

### Simplifications gained

Desktop-only split (Q4/Q6) removed an entire risk surface: the mobile-focus-routing matrix, the
iframe-click-focus-on-touch problem, and the cramped-phone-layout degrade rules all became moot.
The focus registry now routes only two desktop surfaces (clipboard combo + upload picker).

### Files Updated

proposal.md, design.md (D3/D4/D7/D10/D11/Non-Goals/Open-Questions), specs/{split-layout,
split-dnd,terminal-pane,window-pop-out}/spec.md, tasks.md (stages 2–6), docs/pane-api.md,
questions-session1.md (Processing Log).

### Status

All six session-1 decisions resolved and applied. No open questions remain. Ready for a
verification cycle or implementation (`/opsx:apply split-view`).
