# ui-rework — scoped code inspection 2 of batch 10 (fresh; after fix round 1)

**Why a brief.** As for batches 4–9: the cumulative uncommitted diff exceeds Codex's input limit and
no git write is allowed, so the inspection is scoped with the exact pre-batch snapshot.

**What to inspect: batch 10 as built.**
- **Contract:** `openspec/changes/ui-rework/apply-batch-10.md` (approved in 3 rounds; its "Design
  decision" section replaced a lock-based design: canonical `normalizePin`, listing-proven
  visibility, synchronous writes with a documented three-outcome limit).
- **The change:** `/home/user/.cache/claudex-nomcp/runs/b10-2.diff` =
  `diff -ruN ~/.cache/claudex-nomcp/prebuild-b10/src packages/client/src` plus the CLAUDE.md diff.
  Pre-batch state (= batch 9 as built and inspected) at `/home/user/.cache/claudex-nomcp/prebuild-b10/`.
  `FileTree.tsx` reads as binary to grep; use `grep -a`. Read full current files wherever needed.
- **Context:** batch 9 (last-tab fallback, persisted inner folders) is NOT yet deployed; batches 9 and
  10 ship together once this inspection approves. Judge whether batch 10 resolves
  `B9-INSPECT2-01/02` within the plan's accepted limit, and whether it breaks any batch-8/9 behaviour.
- **Fix round 1 is in the diff; verify each, do not assume:** B10-INSPECT1-01 a non-root response with
  a different `listing.path` is filed under its canonical key only and the requested key gets a
  terminal error (no copy, so no entries are rebased onto a path the server did not list);
  B10-INSPECT1-02 the two interleaving tests use a one-shot guard set before the competing write and
  assert exactly one competing write. This is the SECOND and last completed inspection of batch 10.
- **Out of scope (pre-existing, server-side, queued for the owner):** `server/files.ts` delete and
  `download.ts` trim the request path; do not report those against this batch.

**Verdict semantics:** `APPROVED` = no unresolved material defect against the contract. `REVISE` = at
least one concrete, evidence-backed defect with file:line and a fix. Do not re-review the plan, and do
not flag pre-existing code outside the diff unless the diff makes it newly wrong.

Proof results the coordinator measured are not evidence for you; static inspection is expected.
