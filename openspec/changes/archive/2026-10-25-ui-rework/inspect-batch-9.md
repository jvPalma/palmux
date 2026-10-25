# ui-rework — scoped code inspection 2 of batch 9 (fresh; after fix round 1)

**Why a brief.** As for batches 4–8: the cumulative uncommitted diff exceeds Codex's input limit and
no git write is allowed, so the inspection is scoped to batch 9 with the exact pre-batch snapshot.

**What to inspect: batch 9 as built.**
- **Contract:** `openspec/changes/ui-rework/apply-batch-9.md` (approved in 3 rounds; B9-01..04,
  B9-R2-01..02) and the delta `specs/browser-local-tab-selection/spec.md`.
- **The change:** `/home/user/.cache/claudex-nomcp/runs/b9-2.diff` =
  `diff -ruN ~/.cache/claudex-nomcp/prebuild-b9/src packages/client/src` plus the CLAUDE.md diff.
  Pre-batch state at `/home/user/.cache/claudex-nomcp/prebuild-b9/`. `FileTree.tsx` reads as binary
  to grep; use `grep -a`. Read full current files wherever the diff needs context.
- **Builder notes to judge:** (1) `lastStoredRef` starts null, so a window that boots and resolves a
  tab writes the shared key once — including a window that reloads on its OWN sessionStorage tab,
  which overwrites what another window last stored; the alternative was seeding the ref with the
  boot-time value. (2) The 200 cap applies to what is written, not to the in-memory set.

**Fix round 1 is in the diff; verify each, do not assume:** B9-CODE-01 a validated remembered selection
seeds the shared-key baseline at boot (only when a usable device value exists), so a reload restoring
the window's own tab no longer overwrites a newer selection; B9-CODE-02 the poll iterates the
visibility-filtered `needed` set via a ref; B9-CODE-03 every expansion write is one change applied to
the CURRENT stored set (`writeExpandedDir`, `forgetDeletedDirs`), and deletes notify every mounted
tree through a module-level subscription. This is the SECOND and last completed inspection of batch 9.

**Verdict semantics:** `APPROVED` = no unresolved material defect against the contract. `REVISE` = at
least one concrete, evidence-backed defect with file:line and a fix. Do not re-review the plan, and do
not flag pre-existing code outside the diff unless the diff makes it newly wrong.

**Scrutinise most:** the shared last-tab writer (never on broadcasts, {id, kind} compare, clear on
disappearance/chooser, delayed resolution, pop-out writes nothing); `readSelection` precedence and
the boot paths; FileTree: root loading separated from `expanded`, visibility-gated fetches, the
delete-only drop by path segment, collapse keeping descendants, the cap, and every B8 invariant
(homeOwed, no open-set pruning, live intersection for render/load/poll, `pin()` → `[newRoot]`,
nested-pin collapse); CLAUDE.md accuracy.

Proof results the coordinator measured are not evidence for you; static inspection is expected.
