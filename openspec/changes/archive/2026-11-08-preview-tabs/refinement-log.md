# Refinement Log: preview-tabs

## Progress Summary

| Topic | Status | Session |
|-------|--------|---------|
| Pin triggers (rename, colour, group, window move) | in-progress | #1 |
| Kind-change replacement order | in-progress | #1 |
| Markdown wrap | in-progress | #1 |
| Review preview with a comment draft | in-progress | #1 |
| Alt+Z phase independence | in-progress | #1 |
| tabCreated correlation, guard-failure signal, review host, remount, field threading | in-progress (proposed fixes F1–F11) | #1 |

## Session #1 -- 2026-11-02

### Focus
The first full review of the change written by ff from the v1.3.0 brainstorm.

### Agent Findings Summary
- **Zoom Out (PRE)**: no abort. Six findings. Extra pin triggers go beyond the brief. Some D3 machinery could be trimmed. Alt+Z can ship on its own. Markdown wrap and the single-file url form need a stated reason.
- **Spec Auditor**: missing scenarios for the replacement rules, living diff-review and detached-windows wording that the change leaves stale, and overlap with scm-row-actions on `.rv-current`.
- **Problem Analyst**: the markdown wrap premise is wrong (blocks never wrap today). The review host has no tab id. The Impact list is incomplete.
- **Coverage Analyst**: comment drafts in a review preview are not covered. The single-file review contradicts the living spec. A `groupCreate` does not pin.
- **Systems Analyst**: the window-move pin is not persisted. The url key remounts the view. A kind change recycles the id. `tabCreated` is matched by position. The gates use the wrong commands. Field-copy points are missing.
- **Behaviour Validator**: an unconditional kill in the kind-change path, and an ambiguous guard-failure signal that can produce duplicate previews.
- **Docs Checker**: no concrete correlation mechanism for `tabCreated`. ReviewHost shape and line numbers are missing.
- **Triage**: 0 defended, 18 proposed fixes, 5 questions (60 findings: 0 critical, 20 important, 40 minor; 34 verified, 0 refuted).
- **Zoom Out (POST)**: n/a this session.
- **Readiness gate**: not run (it runs after the answers are applied).

### Questions Asked
5 questions in `questions-session1.md` (4 important, 1 minor).

### Files Updated
- `questions-session1.md` -- created.

### Gap Analysis
- Session start: 60 findings.
- Session end: pending answers.

## Session #2 — 2026-11-02 (answers applied + gate)

- **Answers applied** from `questions-session1.md`: Q1 A, Q2 owner rule (no tab may appear or vanish, even
  for a frame; follow VS Code) → new D3a atomic `replaceTab` + in-place reconcile, Q3 A (markdown out),
  Q4 A (composer pins), Q5 A (Alt+Z phase 1, independent). No fix rejected.
- **Stage C, zoom-out POST (prune):** 3 findings, all applied: dropped `dblclick`/`lastPreviewOpenRef`/500 ms
  (callers pass `{ preview: event.detail !== 2 }`); dropped the `reviewScrollRef` write for single-file urls;
  `.rv-current` already exists, so no cross-change ownership.
- **Stage D, readiness gate:** 1 critical, 7 important, 6 minor, all decided in design/tasks:
  - critical: the pending entry is `Map<leafId, { sent*, latest*, pinLatest, replaces?, at }>`, matched on
    `sent*` (D3);
  - `ready.previewTabs` parsed in `parseServerMessage` (2.1);
  - SCM double-click: native `onDoubleClick` → `onOpenFile(target, { preview: false })` (D4, 4.4);
  - `Collapsible.actions` slot for the header's Open review (D6, 6.3);
  - ConfigEditor keeps `wordWrap: 'on'` (D7, 1.2);
  - `save()` returns `'clean' | 'started' | 'queued'`; only Ctrl+S calls `onSaved` on clean (D4, 4.6);
  - `pinSentRef` joins only on a sent pin; re-send every preview id on `ready` (D4, 4.1);
  - exact `title`/`aria-label` on previews only (D5, 5.1, 5.2);
  - minors: named pin call sites, TabRecord fields + `replaces` emit + `restoreStore.forget`, `.md` Read mode
    keeps the toggle, `pin` icon, toast name, scenario links, 8.2 command.
- `openspec validate preview-tabs --strict`: valid. Status: implementation-ready; implementation started.
