# ui-rework — scoped code inspection 2 of batch 6 (fresh; after fix round 1)

**Why a brief.** As for batches 4–5: the cumulative uncommitted diff exceeds Codex's input limit and
no git write is allowed, so the inspection is scoped to batch 6 with the exact pre-batch snapshot.

**What to inspect: batch 6 as built.**
- **Contract:** `openspec/changes/ui-rework/apply-batch-6.md` (approved after 3 rounds; B6-01..05),
  `specs/mobile-drawer/spec.md` requirement "Drawer rows and groups wear the desktop strip's pills".
- **The change:** `/home/user/.cache/claudex-nomcp/runs/b6-2.diff` =
  `diff -ruN ~/.cache/claudex-nomcp/prebuild-b6/src packages/client/src` plus the CLAUDE.md diff
  (~70 KB). The pre-batch state is at `/home/user/.cache/claudex-nomcp/prebuild-b6/`; read the full
  current files wherever the diff needs context.
- **One stated deviation from the plan, to be judged on its merits:** the frame segments sit on
  `.drawer-leaf`, not `.drawer-leaf-inner`. The builder's evidence: `.drawer-leaf-inner` is the grid
  item, so while the leaf's track runs between `1fr` and `0fr` the item is fr × the leaf's height (on
  a 40px row half-way, the leaf is 20px and the item 10px) and a border on it stops short of the slot
  — a visible gap during every enter and leave. `.drawer-leaf` is as tall as the slot at every moment
  and equally stationary under a drag; nothing sits on the dragged `.drawer-row`. The coordinator also
  corrected CLAUDE.md's token-location sentence after the build.

**Fix round 1 is in the diff; verify each, do not assume:** B6-CODE-001 a leaving row bridges
whichever LIVE group has survivors on both sides (its own or another's), drawing that group's colour
through `--group-frame` while its chip keeps its own; B6-CODE-002 the header's before/after lines carry
a 2px `--group-ink` band and its focus ring is `--group-ink`. This is the SECOND and last completed
inspection of batch 6: earlier verdicts are not evidence.

**Verdict semantics:** `APPROVED` = no unresolved material defect against the contract. `REVISE` = at
least one concrete, evidence-backed defect with file:line and a fix. Do not re-review the plan, and do
not flag pre-existing code outside the diff unless the diff makes it newly wrong.

**Scrutinise most:** `frameClasses` (non-leaving positions, trailing vs interior leaving, a run of
leaving rows, fold/unfold); the `--ring`/`--lift` shadow composition with armed, lifted, revealed and
drop states; colour sources (`tabColorValue` → accent, `tabColorInk` → ink, fallbacks); that no
gesture behaviour changed; scale guard still empty; no colour literal; motion on tiers.

Proof results the coordinator measured are not evidence for you; static inspection is expected.
