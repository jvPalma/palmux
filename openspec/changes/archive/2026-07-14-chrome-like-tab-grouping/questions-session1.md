# Refinement Questions — Session 1 (chrome-like-tab-grouping)

Analyzed by 6 research agents + a codex pass. 33 findings; 30 self-resolved from the
codebase / best practice and applied directly (see `refinement-log.md` + `design.md`
D1.1–D1.10). Only the 3 genuine product decisions below were put to the owner — answered
interactively on 2026-07-14.

## Q1 — Group creation & member assembly [Critical] — ANSWERED

palmux has no multi-tab selection; the spec never defined how a group is created.

- [x] **A. Single-tab menu + grow by drag** — tab menu "New group from this tab" / "Add
      to <group>"; group starts as one, grows by drag. No new selection concept. (chosen)
- [ ] B. Ctrl/Cmd-click multi-select then "Group selected".

→ Applied as **D1.5**. A group of one is valid; a center-drop grows it.

## Q2 — Mobile scope [Important] — ANSWERED

Grouping was desktop-only; CLAUDE.md calls the mobile layer "the point of the project".

- [ ] A. Desktop-first, mobile drawer read-only headers.
- [x] **B. Mobile also collapses/expands** — drawer headers tappable, sharing the desktop
      per-device collapse state (no drag/join on mobile). (chosen)
- [ ] C. Per-device local-only groups (drop the server model).

→ Applied as **D1.6**. Drawer headers toggle the shared `palmux-collapsed-groups` set.

## Q3 — Grouped tab color [Minor] — ANSWERED (owner note)

Chrome makes a grouped tab take the group's color. palmux's design kept both.

- [ ] A. Group owns the color (Chrome-like; suppress per-tab accent while grouped).
- [ ] B. Keep both channels.
- [x] **Owner: "a group can have its own color and name, and the tabs inside it also have
      their own colors and names."** → both channels, INDEPENDENT and intentional.

→ Applied as **D1.7**. `--tab-accent` (per-tab) and `--group-accent` (cluster) are
separate CSS layers; ungroup restores nothing (the tab always kept its own color).

## Progress

| Question          | Severity  | Status          |
| ----------------- | --------- | --------------- |
| Q1 creation model | Critical  | answered → D1.5 |
| Q2 mobile scope   | Important | answered → D1.6 |
| Q3 grouped color  | Minor     | answered → D1.7 |
