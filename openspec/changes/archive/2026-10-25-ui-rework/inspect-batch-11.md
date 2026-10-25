# ui-rework — scoped code inspection 1 of batch 11 (a path is the path; the last batch)

**Why a brief.** As for batches 4–10: the cumulative uncommitted diff exceeds Codex's input limit and
no git write is allowed, so the inspection is scoped with the exact pre-batch snapshot.

**What to inspect: batch 11 as built (client AND server).**
- **Contract:** `openspec/changes/ui-rework/apply-batch-11.md` (approved in 4 rounds; B11-01..06,
  B11-R2-01..03, B11-R3-01..02).
- **The change:** `/home/user/.cache/claudex-nomcp/runs/b11.diff` = client
  `diff -ruN prebuild-b11/src packages/client/src` + server
  `diff -ruN prebuild-b11/server-src packages/server/src` + the CLAUDE.md diff. Pre-batch state at
  `/home/user/.cache/claudex-nomcp/prebuild-b11/` (`src/` client, `server-src/` server). `FileTree.tsx`
  reads as binary to grep; use `grep -a`. Read full current files wherever needed.
- **Notes to judge:** the builder also added a toast guard to `doDownload` for a value that arrives
  with a line break (unreachable through `window.prompt` in Chromium, which strips it; Firefox turns
  it into a space); the coordinator reworded a stale "the route trims" comment in `FileTree.tsx`
  after the build. The server change takes effect only after a restart the owner must approve; until
  then a new client meets the old trimming server (the mismatch guard covers it).

**Verdict semantics:** `APPROVED` = no unresolved material defect against the contract. `REVISE` = at
least one concrete, evidence-backed defect with file:line and a fix. Do not re-review the plan, and do
not flag pre-existing code outside the diff unless the diff makes it newly wrong.

**Scrutinise most:** every server path endpoint (raw-input `isAbsolute` before resolve, no trim of the
used value, blank contracts per endpoint, refusals after resolution, the mixed delete batch); no
remaining path trim on a path that reaches a filesystem call; `normalizePin` idempotence and
leading/trailing rules through every caller; the paste guard; CLAUDE.md accuracy.

Proof results the coordinator measured are not evidence for you; static inspection is expected.
