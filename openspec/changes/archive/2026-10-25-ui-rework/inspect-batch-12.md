# ui-rework — scoped code inspection 2 of batch 12 (fresh; after fix round 1)

**Why a brief.** As for batches 4–11: the cumulative uncommitted diff exceeds Codex's input limit and
no git write is allowed, so the inspection is scoped with the exact pre-batch snapshot.

**What to inspect: batch 12 as built.**
- **Contract:** `openspec/changes/ui-rework/apply-batch-12.md` (approved in 3 rounds; B12-01..07 with
  B12-03 rejected as a server change and documented as a limit; B12-R2-01..02) and the change's spec
  deltas `settings-panel`, `sidebar-dock`, `chrome-tab-strip` and the new `expanded-settings-surface`.
- **The change:** `/home/user/.cache/claudex-nomcp/runs/b12-2.diff` = client
  `diff -ruN prebuild-b12/src packages/client/src` + server (expected: no server change) + CLAUDE.md.
  Pre-batch state at `/home/user/.cache/claudex-nomcp/prebuild-b12/`. Read full current files.
- **Coordinator deviations to judge:** in Match system, a pick for the ACTIVE slot and an import that
  lands in the active slot also write `themeId` (an explicit user action that changes what the device
  shows); the plan said only a scheme change writes it. Boot, reconnect and broadcasts still never
  write it. Also: the theme sub-view draws the mode switch first, then Import, then the lists.

**Fix round 1 is in the diff; verify each, do not assume:** B12-I01 a mode generation counter bumped
on every requested or broadcast mode change, captured at import submit and required unchanged at
completion (slot switches do not bump it); B12-I02 the scrubber takes the duration on both
`loadedmetadata` and `durationchange` and stays disabled until it is finite and positive; B12-I03 a
documented window-controls-overlay exception (spec scenario + CLAUDE.md), no geometry built;
B12-I04 CLAUDE.md and the settings-panel delta list the export-writing actions including active-slot
imports. This is the SECOND and last completed inspection of batch 12.

**Verdict semantics:** `APPROVED` = no unresolved material defect against the contract. `REVISE` = at
least one concrete, evidence-backed defect with file:line and a fix. Do not re-review the plan, and do
not flag pre-existing code outside the diff unless the diff makes it newly wrong.

**Scrutinise most:** the single resolved theme id (every render path: tokens, terminals, Monaco, the
themes broadcast, `main.tsx` pre-paint); the `themeId` write rule (scheme change, active-slot
pick/import; never boot/reconnect/broadcast); import targeting and supersede-on-mode-change; the
removed rows and the always-shown rail (a stored `hidden` ignored, the type still parses); the
dictation card (overflow measurement, toggle a11y, scrubber, one clip at a time); the app menu at the
topbar's end (alignment, end-aligned dropdown, mobile/pop-out absent); CLAUDE.md and spec accuracy.

Proof results the coordinator measured are not evidence for you; static inspection is expected.
