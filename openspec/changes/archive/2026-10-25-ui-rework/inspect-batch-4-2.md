# ui-rework — scoped code inspection 2 of batch 4 (fresh; the implementation after both fix rounds)

**Why a brief.** Same reason as `inspect-batch-4.md`: the cumulative uncommitted diff from `b9d266c`
exceeds Codex's input limit, and no git write is allowed, so the inspection is scoped to batch 4 with
the exact pre-batch snapshot. This is the SECOND and last completed inspection of batch 4. Inspect
it as new: earlier verdicts are not evidence.

**What to inspect: batch 4 as it stands now.**
- **Contract:** `openspec/changes/ui-rework/apply-batch-4.md` (approved plan, every "review B4-Rn"
  paragraph), `specs/mobile-drawer/spec.md`, the "Rows entering or leaving" requirement of
  `specs/ui-primitives/spec.md`, and `CLAUDE.md`'s drawer paragraphs as changed in the diff.
- **The change:** `/home/user/.cache/claudex-nomcp/runs/b4-2.diff` (unified; 21 source files plus
  CLAUDE.md; 427 KB) = `diff -ruN ~/.cache/claudex-nomcp/prebuild-b4/src packages/client/src` plus the
  CLAUDE.md diff. It contains the build, fix round 1 (per-gesture tail-click suppression in
  `panes/press.ts`) and fix round 2.
- **Read the full current files in the repo** wherever the diff needs context. The pre-batch state
  is at `/home/user/.cache/claudex-nomcp/prebuild-b4/`.

**Fix round 2 resolved the first inspection's findings; verify each, do not assume:**
- IR-01: `releaseDrawerHold` passes the drawer's `kbdWasUp` into the release path before clearing
  `drawerHoldRef`, and the next unheld frame is the release even if no frame ran under the hold. The
  same start-of-hold rule now applies to a live selection (`onSelectionChange`).
- IR-02: restoration intent is kept per source (`selection`, `drawer`, the picker carrying the
  drawer's record) and OR-ed at the final release, still gated by the viewport growth test.
- IR-03: `accepts` refuses only true no-ops (normalized order AND membership unchanged), so a
  same-parent append and a root move to the end are accepted. This deliberately overrides the DGSL
  root/same-parent rule.
- IR-04: a gesture whose source row leaves the tree ends (capture released, timer and frame
  cleared, touchmove guard off), checked after each render and again in `arm` and `up`.

**Out of scope (already queued for batch 5, `apply-batch-5.md` section B):** Theme-row focus
(B3-F2-001), the config.json dirty guard, keyboard paths of `pressMove`/`press` call sites, tail
clicks on the scrims, `pressMove`, `Segmented` and drawer-row taps, and the raw-editor focus. Report
them only if batch 4 made one of them newly worse.

**Verdict semantics:** `APPROVED` = no unresolved material defect against the contract. `REVISE` =
at least one concrete, evidence-backed defect with file:line and a fix. Do not re-review the plan,
and do not flag pre-existing code outside the diff unless the diff makes it newly wrong.

**Scrutinise most:** the hold and release state machine in `App.tsx` (selection, drawer, picker,
`KEYBOARD_RETURN_MS`, a viewport frame queued across a release, overlapping holds); the drawer
gesture state machine (`SessionDrawer.tsx`: pressed/armed/dragging/moved, the non-passive touchmove,
pointer capture, `endIfGone`); `drawer-tree.ts` `accepts`/`resolveDrop` (no tab lost or duplicated,
result equal to the server's `normalizeOrder`); and `press.ts` listener lifecycle.

Proof results the coordinator measured are not evidence for you; static inspection is expected.
