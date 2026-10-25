# ui-rework — scoped code inspection 2 of batch 8 (fresh; after fix round 1)

**Why a brief.** As for batches 4–7: the cumulative uncommitted diff exceeds Codex's input limit and
no git write is allowed, so the inspection is scoped to batch 8 with the exact pre-batch snapshot.

**What to inspect: batch 8 as built.**
- **Contract:** `openspec/changes/ui-rework/apply-batch-8.md` (approved in 3 rounds; B8-01..03).
- **The change:** `/home/user/.cache/claudex-nomcp/runs/b8-2.diff` =
  `diff -ruN ~/.cache/claudex-nomcp/prebuild-b8/src packages/client/src` plus the CLAUDE.md diff
  (~40 KB). Pre-batch state at `/home/user/.cache/claudex-nomcp/prebuild-b8/`. `FileTree.tsx` reads as
  binary to grep; use `grep -a`. Read full current files wherever the diff needs context.
- **Builder notes to judge:** the header toggle no longer expands the root itself (the restore-expand
  effect owns that); and a stated race it left open — on a first run with pins arriving before HOME,
  a toggle in the milliseconds before HOME lands would store only that pin, so HOME would not
  auto-open.

**Fix round 1 is in the diff; verify each, do not assume:** B8-CODE-01 HOME's first-run default is
tracked as owed (`homeOwed`) until HOME is known; a toggle while owed is held in memory and written
merged with HOME when it lands (a deliberate trade: a remount in that window still counts as a first
run, at the cost of forgetting the held toggle; the stored format stays `{v:1, open}`); a pin, or a
toggle of HOME's own path through a pin equal to it, settles the default. B8-CODE-02 expansion is
seeded only for roots ENTERING the live-open set. The coordinator updated CLAUDE.md's Explorer
paragraph for both. This is the SECOND and last completed inspection of batch 8.

**Verdict semantics:** `APPROVED` = no unresolved material defect against the contract. `REVISE` = at
least one concrete, evidence-backed defect with file:line and a fix. Do not re-review the plan, and do
not flag pre-existing code outside the diff unless the diff makes it newly wrong.

**Scrutinise most:** the forgiving parse and swallowed storage errors; first-run vs stored behaviour
for HOME; that nothing prunes storage; that rendering, the restore-load and the poll all use the live
intersection; `pin()` storing exactly `[newRoot]`; no regression in select mode, the context menu,
delete re-reads, leaving rows or the per-root ⟳; CLAUDE.md accuracy.

Proof results the coordinator measured are not evidence for you; static inspection is expected.
