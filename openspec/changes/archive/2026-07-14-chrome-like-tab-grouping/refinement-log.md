# Refinement Log: chrome-like-tab-grouping

## Progress Summary

| Topic                                        | Status   | Session |
| -------------------------------------------- | -------- | ------- |
| Join/leave wire mechanism (D1.1)             | approved | #1      |
| Persistence sidecar / rollback (D1.2)        | approved | #1      |
| Centralized auto-expand (D1.3)               | approved | #1      |
| Group-id format + isGroupId (D1.4)           | approved | #1      |
| Group creation model (D1.5)                  | approved | #1      |
| Mobile collapse scope (D1.6)                 | approved | #1      |
| Group vs per-tab color (D1.7)                | approved | #1      |
| Nearest-outside / refusal / close-all (D1.8) | approved | #1      |
| Concurrent membership (D1.9)                 | approved | #1      |
| Chip-drag isolation (D1.10)                  | approved | #1      |
| Contract docs authored (0.1–0.3)             | approved | #1      |

## Session #1 — 2026-07-14

### Focus

First-pass refinement of the whole proposal: 6 research perspectives + a codex pass
(codex hit CLI/stdin friction; the 6 agents independently reached the same conclusions).
33 findings (5 critical, 25 important, 11 minor). 3 were genuine product decisions
(asked); the rest self-resolved from the codebase / best practice.

### Agent Findings Summary

- **Agent 1 (Spec Completeness)**: join/leave requirement described an UNACHIEVABLE
  mechanism (plain reorder can't move membership); group-of-one lifecycle, collapse-
  refusal, concurrent-conflict, color-optionality all lacked scenarios.
- **Agent 2 (Problem & Context)**: mobile is the project's north star yet grouping was
  desktop-only read-only; double-accent diverges from Chrome — both flagged for the owner.
- **Agent 3 (Requirements Coverage)**: join/leave callback surface undefined; OQ1/OQ2
  dangling; docs/ absent vs the split-view precedent.
- **Agent 4 (System & Infra)**: CRITICAL — `tabs.json` is a bare array, cannot hold a
  `groups` key; group-id has no validator; groupId serialization sites unenumerated;
  strip drop handlers gate on TAB_DND_TYPE only (chip drag would be ignored).
- **Agent 5 (Goal & Behaviour)**: CRITICAL — the "funnels through selectTab" auto-expand
  claim is false (split/boot/close bypass it → active-but-hidden tab); creation affordance
  missing entirely; join/leave boundary rule breaks for singletons/first-position/collapsed.
- **Agent 6 (Documentation)**: no docs/*.md for a highly stateful feature; three needed.

### Topics Discussed

All ten decisions above are recorded in `design.md` §"Refinement Session 1 Decisions"
(D1.1–D1.10) with Context/Decision/Rationale, and applied to proposal/spec/tasks/docs.
Three were USER-DECIDED (see Questions Asked); seven self-resolved.

### Questions Asked

3 product questions (asked interactively, recorded in `questions-session1.md`):

1. **Group creation model** → single-tab menu + grow by drag (no multi-select). [D1.5]
2. **Mobile scope** → drawer headers ALSO collapse/expand (shared per-device state). [D1.6]
3. **Grouped tab color** → group color/name and per-tab color/name are INDEPENDENT, both
   shown (deliberate divergence from Chrome). [D1.7]

### Files Updated

- `proposal.md` — What Changes + Impact (sidecar persistence, two ops, creation UI,
  mobile collapse, two-channel color, docs list).
- `design.md` — corrected D2 + D3; appended D1.1–D1.10 + resolved OQ1/OQ2.
- `specs/tab-grouping/spec.md` — rewrote the join/leave requirement to the achievable
  `groupUpdate{addIds/removeIds, order}` contract; added scenarios (group-of-one,
  create-from-tab, join-steals, collapse-refused, mobile-collapse, hidden-member-expand,
  center-drop-join, two-color coexistence, split-blind).
- `tasks.md` — added phase 0 (docs), sidecar store, isGroupId, join/leave protocol,
  creation UI, centralized auto-expand, kind-aware close-all, mobile collapse.
- `docs/group-model.md`, `docs/collapse-state-machine.md`, `docs/dnd-decision-table.md` —
  authored (the implementation contract).

### Gap Analysis

- Session start: 33 gaps (5 critical).
- Session end: 0 blocking gaps — all 5 criticals resolved (3 self, incl. the two false
  design claims corrected; creation was the user-decided one). Proposal is
  implementation-ready.
