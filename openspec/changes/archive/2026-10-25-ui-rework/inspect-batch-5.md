# ui-rework — scoped code inspection 2 of batch 5 (fresh; the implementation after fix round 1)

**Why a brief.** The cumulative uncommitted diff from `b9d266c` exceeds Codex's input limit and no git
write is allowed, so this inspection is scoped to batch 5 with the exact pre-batch snapshot, as for
batch 4 (`inspect-batch-4.md`).

**What to inspect: batch 5 as built.**
- **Contract:** `openspec/changes/ui-rework/apply-batch-5.md` (approved after 5 review rounds; every
  "B5-Rn" paragraph), `specs/settings-panel/spec.md`, `specs/mobile-drawer/spec.md`,
  `specs/ui-primitives/spec.md`, design.md §2.
- **The change:** `/home/user/.cache/claudex-nomcp/runs/b5-2.diff` =
  `diff -ruN ~/.cache/claudex-nomcp/prebuild-b5/src packages/client/src` plus the CLAUDE.md diff. It
  contains the workflow build (clusters C1–C5; C5 is a docs step the coordinator added beyond the plan
  because the changes made CLAUDE.md text stale), its Fable review's four low findings and their
  repair, and one coordinator fix after the smoke: the drawer view switcher's `.ui-seg-item`
  min-height override was deleted (it made the switcher's outer box 42px instead of `--ctl-h`).
- **Fix round 1 (after inspection 1) is in the diff too; verify each, do not assume:** B5-I1 one writer
  of `sessionIdRef` (`showTab`) and no render-time write, so a second broadcast before the first
  close-navigation renders decides from the tab the first one chose; B5-I2 a mouse press that leaves
  the control and returns acts on nothing; B5-I3 a refused drag click is `preventDefault`-ed so a
  `<label>` cannot forward it; B5-I4 a `detail === 0` click always activates and the drag marker
  stays for the real trailing click. This is the SECOND and last completed inspection of batch 5:
  earlier verdicts are not evidence.
- **Read the full current files** wherever the diff needs context. The pre-batch state is at
  `/home/user/.cache/claudex-nomcp/prebuild-b5/`.

**Verdict semantics:** `APPROVED` = no unresolved material defect against the contract. `REVISE` = at
least one concrete, evidence-backed defect with file:line and a fix. Do not re-review the plan, and do
not flag pre-existing code outside the diff unless the diff makes it newly wrong.

**Scrutinise most:**
1. `panes/press.ts`: `consumeGesture(e, action)` lifetime (live until BOTH release and action
   return; expiry from the later), the compat mousedown/mouseup handling, `detail === 0` pass-through,
   `pressMove`'s new `onClick` and `draggedOn`, `pressKbdMove` on `<button>`, listener cleanup.
2. Every call site that changed helper (SessionDrawer rows/Close/scrim, TabSheet, NewTabChooser,
   DashboardTab, DashboardBody, Segmented, SettingsFields Theme row + label, ThemeBrowser entries,
   the dock back control): exactly one activation per pointer / Enter / Space / AT / label click, no
   touch pointerdown `preventDefault` inside a scroller, `#mobile-kbd` focus kept.
3. `App.tsx`: B2 dirty-config confirm on every dock-leaving path and on an explicit `mobileMode`
   change; B5 focus on entering/leaving Raw; B6 pending-restore settle rule inside the viewport
   effect without regressing the selection/drawer/picker holds; B7 latest tabs/groups snapshot and
   conditional membership in the drop commits.
4. Scale: `ui/scale-baseline.json` is `{}`, kit heights on `--ctl-h` with the Segmented wrapper
   subtraction, pragmas each naming the box, no snap beyond one step except the stated kit-height
   change, no colour literal in `ui/ui.css`, motion on tiers.
5. CLAUDE.md: the changed paragraphs match the code.

Proof results the coordinator measured are not evidence for you; static inspection is expected.
