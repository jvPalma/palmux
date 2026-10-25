# ui-rework — scoped code inspection of batch 4 (the implementation, not a plan)

**Why this brief exists.** The runner's `inspect` mode diffs against the base commit (`b9d266c`). The
cumulative uncommitted work since then (batches 1–4 plus the morning keyboard fixes) now exceeds
Codex's 1,048,576-character input limit (measured: 1,055,686), and the owner forbids any git write,
so no new base commit can be made. This brief scopes the inspection to batch 4 only, using the exact
pre-batch snapshot.

**What to inspect: the implementation of batch 4, as built.**
- **Contract:** `openspec/changes/ui-rework/apply-batch-4.md` (approved plan, every "review B4-Rn"
  paragraph), `openspec/changes/ui-rework/specs/mobile-drawer/spec.md`, and the "Rows entering or
  leaving" requirement of `specs/ui-primitives/spec.md`.
- **The change:** `/home/user/.cache/claudex-nomcp/runs/b4.diff` (unified diff; 22 files; 406 KB).
  It is `diff -ruN ~/.cache/claudex-nomcp/prebuild-b4/src packages/client/src` plus the CLAUDE.md
  diff. Everything in it is batch 4, including fix round 1, which made `pressClick` suppress the
  tail click per gesture.
- **Read the full current files in the repo** wherever the diff needs context. The pre-batch state
  is at `/home/user/.cache/claudex-nomcp/prebuild-b4/`.

**Verdict semantics for this brief:**
- `APPROVED`: the implementation has no unresolved material defect against the contract.
- `REVISE`: there is at least one concrete, evidence-backed defect, with file:line and a fix.
- Do not re-review the plan itself, and do not flag pre-existing code outside the diff unless the
  diff makes it newly wrong.

**Areas the coordinator wants scrutinised most:**
1. The generalized layout hold in `App.tsx`: selection OR drawer, one `closeDrawer` path, the
   picker hold that only releases on `change` / `cancel` / a confirmed return, the picker launch
   result, and that `KEYBOARD_RETURN_MS` is suppressed under a picker hold. Also that the
   pre-existing selection-hold behaviour did not regress.
2. Drag in the drawer:
   - the non-passive `touchmove` that calls `preventDefault` only when armed, with full cleanup
   - pointer capture
   - `drawer-tree` `resolveDrop`/`accepts`, the root area, header before/after
   - no tab ever lost or duplicated, and the result equal to the server's normalized order
3. The `pressClick` gesture-level tail suppression (`panes/press.ts`): the `detail === 0` pass-through,
   listener lifecycle and leaks, and interaction with `pressMove` list controls and the scrim.
4. Accessibility: keyboard and AT operability of the new drawer controls (Settings, close, the
   swipe-revealed Close), `inert` on leaving rows, and accessible names.
5. Motion and tokens: grid-rows space collapse, first-render stagger vs micro enter, tier tokens,
   no colour literals in `ui/ui.css`, and the scale baseline only going down.

Proof results the coordinator measured are not evidence for you; static inspection is expected.
