# Handoff: palmux — split mode with N editor groups, exactly like VS Code

## Session Metadata
- Created: 2026-10-27 12:03:15
- Project: /home/user/projects/palmux
- Branch: release/1.2.0
- Session duration: ~3 days (2026-10-24 → 2026-10-27), one long session (ui-rework, release 1.1.0, Cloudflare move, the whole source-control-review change)

## Recent Commits (for context)
  - 529fe90 Add SCM status, diffs, staging, comments, review tabs, settings merge
  - 8f86a8a Add Source Control panel, review pane with comments, mobile review bar
  - 9024df5 Add source-control-review OpenSpec, SCM/review docs, settings merge docs
  - 2dc22f4 chore: release v1.1.0

## Handoff Chain

- **Continues from**: None (fresh start)
- **Supersedes**: None

> This is the first handoff for this task.

## Current State Summary

The owner's NEXT task: palmux's split mode must support MANY panes (not just 2) and behave EXACTLY like
VS Code's editor groups (owner's words: "quero que o split mode funcione com multiplas tabs, e nao apenas 2. e
que funcione EXACTAMENTE como no VSCODE"). His 43 s silent screen recording of VS Code is saved at
`~/.cache/claudex-nomcp/handoff-assets/split-groups/split-rec.mp4`, with an analysis
(`split-rec-report.md`) and 4 key frames (`split-rec-frames/`). Nothing for this task has been planned or
built yet. The previous change, `source-control-review` (OpenSpec, `openspec/changes/source-control-review/`),
is built and DEPLOYED in production; the owner committed most of it (529fe90 and the two before it). Group 15
(second phone-density pass) is built, inspected and deployed (client build `index--M71ja69.js`), but is still
UNCOMMITTED in the working tree (≈31 changed files). Only task 11.4 (owner's S26 device check) remains open
there; after it the change can be archived (`/opsx:archive`).

## Codebase Understanding

## Architecture Overview

Read `CLAUDE.md` — it is long, dense and authoritative. For this task the relevant sections are "Split view
(desktop-only) + de-singletonized terminal", "Split fusion", "A terminal pane is keyed by SLOT", "Split
gestures live on the divider", the tab strip ("The tab strip is PILLS"), tab groups, and "The URL is not the
session".

Today's split model (what must change):
- Split state is `packages/client/src/session/useSplit.ts`: an ARRAY of PAIRINGS, each exactly two `{tabId, kind}` slots +
  `row`/`column` + ratio 0.15–0.85 + focused slot, persisted to `localStorage['palmux-splits']` (`{v:2,
  pairings}`); desktop-only (forced empty in the mobile layer and pop-outs).
- Only the ACTIVE pairing is tiled. A pairing renders in the single top tab strip as ONE fused pill
  (`buildStrip` `fused` items) with a split glyph; members must stay strip-adjacent and share group
  membership (`fuseSync`, `reconcilePairings`).
- Layout is rect-driven: `SplitView` computes geometry, `PaneHost` positions every non-terminal pane by rect
  and NEVER reparents (iframes/Monaco would reload). Terminal panes (`packages/client/src/terminal/TerminalPane.tsx`) are keyed by
  SLOT; adding anything tab-specific to a React key above them remounts the pane → new `clientKeyRef` → the
  server sees a rival client → "Opened somewhere else". `SplitView.test.tsx` asserts one mount across
  sessionId changes.
- `SplitDropZones` handles drag-to-split with a claimed-half preview; `SlotDropZones` → `slotReplace`;
  `SplitDivider` resizes (and double-click swaps, hover handle rotates).
- One active client per terminal (last attach wins, `pty.ts` `attachment` + `clientKey`): the SAME terminal
  tab cannot be live in two groups at once — VS Code lets one document sit in two groups; palmux must decide
  what that means for terminals (likely: a tab lives in exactly one group, as the recording shows: dragging a
  tab MOVES it).
- Tab order, groups (`tab-groups`, server-authoritative, `groups.json`), names and colours are SERVER state,
  broadcast in `sessions`; the per-window selection is browser-local (`packages/client/src/session/window-selection.ts`).

What VS Code does (from the recording — verify frame by frame before designing):
- Editor GROUPS laid out in a grid (n columns, rows inside columns, nested); each group has ITS OWN tab
  strip; one active tab per group; one focused group.
- Dragging a tab near a group's edge shows a drop-zone overlay (left/right/top/bottom half) and dropping
  creates a NEW group there with that tab (the tab LEAVES its source group); dropping on a group's centre or
  its tab strip moves the tab into that group (with an insertion marker in the strip); on-screen hint "Hold
  Shift to drop into editor".
- Sashes between groups resize; a group whose last tab is closed/moved out disappears and its space is
  redistributed.
- Recording timeline: 00:00 one group with Untitled-1..5; 00:02 drag Untitled-2 to the right edge (overlay);
  00:05 two groups; 00:14 Untitled-3 dragged to make a third column; 00:21 nested rows/columns; 00:34 more
  drops with previews; 00:38 settles at three columns.

## Critical Files

| File | Purpose | Relevance |
|------|---------|-----------|
| `CLAUDE.md` | Architecture + decisions with measured reasons | Read the split, strip, pane-keying, tab-group sections first |
| `packages/client/src/session/useSplit.ts` | Pairing state, persistence, reconcile | Becomes a group-grid model |
| `packages/client/src/session/SplitView.tsx` (+ test) | Geometry, slot rendering, keyed-by-slot terminals | Must generalise to N groups without remounting terminals |
| `packages/client/src/panes/PaneHost.tsx` | Rect-positioned non-terminal panes, never reparented | Rects come from the new grid |
| `packages/client/src/session/SplitDropZones.tsx`, `SlotDropZones`, `SplitDivider.tsx` | Drag-to-split, slot replace, resize | Generalise to edge/centre drops per group + sashes |
| `packages/client/src/session/SessionTabs.tsx` + `tab-strip-css.test.ts` | The single top strip, fused pills, DnD | Per-group strips (VS Code) vs the global strip is THE design question |
| `packages/client/src/session/workspaceController.ts` | tabCreated/sessionsBroadcast effects incl. pairing dissolve | Must learn groups |
| `packages/client/src/App.tsx` | Integration (very large) | Wiring |
| `packages/server/src/server.ts`, `pty.ts` | Registry, order, last-attach-wins | Probably unchanged (layout is client state) |
| `openspec/specs/split-layout`, `split-fusion`, `split-dnd` | Living specs of today's split | The new change modifies/replaces these |

## Key Patterns Discovered

- Process the owner expects for every change (worked all session): OpenSpec change (`/opsx:new` → proposal,
  specs, design, tasks) → plan review loop (claudex-loop; Codex `gpt-6-astra` xhigh, but CODEX HAS NO QUOTA
  until 2026-11-01 06:10 — owner chose `claude-fable-5-1` xhigh as reviewer as an explicit override; log it) →
  build in batches via the Workflow tool (Sonnet 5.5 xhigh builders, disjoint file scopes, parallel where
  possible) → gate runner → Opus 5.5 xhigh fixers → FRESH Fable xhigh inspection per batch (diff against a
  pre-build snapshot under `~/.cache/claudex-nomcp/prebuild-*`, since nothing is committed by agents) →
  client deploy (`yarn workspace @palmux/client build`, standing OK) → report with measured before/after.
- Design rules enforced by tests: only the eight `--t-*` tokens, one size scale (`packages/client/src/ui/scale.test.ts`), four
  motion tiers, nothing animates inside the terminal grid, Radix-headless kit in `client/src/ui/`, press
  helpers (`press`/`pressClick`/`pressMove`, `consumeGesture`) for touch, ErrorBoundaries around swappable
  views.
- Isolated smoke server for real-browser checks: `~/.cache/claudex-nomcp/scr-smoke.sh build|start|stop`
  (port 44099, disposable config/HOME/TMUX/cwd, no auth, localhost only); for a git test repo rsync a copy of
  palmux into `/tmp` (no `git init`/`add` by agents).

## Work Completed

## Tasks Finished

- [x] ui-rework change archived; v1.1.0 released (owner fixed the release workflow himself)
- [x] palmux moved to `palmux.dgsl.pt` (dgsl.pt Pro zone, Lisbon edge; Access app + two WAF skip rules for that host; `allowedOrigins`; server restarted)
- [x] source-control-review: plan reviewed 5 rounds (3 Codex + 2 Fable), batches A–E + groups 12 (tree view), 13 (code font size), 14–15 (phone density) built, inspected, deployed; server restarted with owner OK; tasks 49+/51 done
- [x] Handoff written (this file); recording analysed and archived

## Files Modified

| File | Changes | Rationale |
|------|---------|-----------|
| packages/client/src/** (≈30 files, uncommitted) | Group 15 phone density: drawer 75% width, 28px session rows, 24px Source Control rows, one 20px review divider per hunk, 28px file header | Owner said group 14's trim was invisible |
| openspec/changes/source-control-review/{specs,tasks.md} | Group 15 spec numbers + tasks | Spec stays the contract |
| CLAUDE.md | Docs for groups 12–15 | Project rule: docs ship with the change |

## Decisions Made

| Decision | Options Considered | Rationale |
|----------|-------------------|-----------|
| Phone density is aggressive (rows 24–28px, drawer 75%) | Small 4px trims | Owner: "tudo o que pedi está igual" after a 36→32px pass |
| Reviewer = Fable while Codex has no quota | Wait for quota / buy credits | Owner picked option 3; logged in `~/.cache/claudex-nomcp/runs/PLAN-REVIEW-LOG.md` |
| Code font size is per device, null = follow terminal | Synced setting | Owner: per device, never in dotfiles-tracked config |

## Pending Work

## Immediate Next Steps

1. Watch the recording frame by frame (`ffmpeg -i ~/.cache/claudex-nomcp/handoff-assets/split-groups/split-rec.mp4 -vf fps=2 /tmp/split-frames/f%03d.png`, then Read the frames) and write down every VS Code behaviour shown; then read today's split code and the three living specs (`split-layout`, `split-fusion`, `split-dnd`).
2. Bring the owner the decisions that change the design BEFORE writing the OpenSpec change (one batched question): (a) per-group tab strips like VS Code vs keeping the single top strip; (b) what happens to the fused pill, tab groups (colour clusters) and strip order once each group has its own strip; (c) a terminal tab lives in exactly one group (dragging moves it) — confirm; (d) persistence per device (localStorage) like today; (e) mobile stays single-pane; (f) keyboard commands to copy (VS Code: Ctrl+\ split, Ctrl+1..9 focus group, Ctrl+K arrows move editor, etc.).
3. Create the change with `/opsx:new` (e.g. `split-editor-groups`), write proposal/specs (modifying split-layout/split-fusion/split-dnd)/design/tasks, run the plan review (Fable while Codex is out of quota, Codex again after 2026-11-01 06:10), then build in batches as above.

## Blockers/Open Questions

- [ ] Per-group tab strips vs one global strip: owner decision needed (VS Code = per group)
- [ ] Codex quota returns 2026-11-01 06:10; until then reviews/inspections are Fable (override)

## Deferred Items

- source-control-review task 11.4: owner's S26 check; then `/opsx:archive`
- Owner may want session row text 12→11px in the drawer (asked, no answer yet)
- Mac: Ctrl+Alt+letter shortcuts unreachable because Option changes `e.key` (owner to decide; fix via `e.code` for letters needs a real Mac)
- Minor lows from inspections: config.json editor ignores code font size; review divider hunk heading truncates at 390px; stepper buttons 30px on phone

## Context for Resuming Agent

## Important Context

- The user (João) speaks Portuguese, has ADHD mode always on: lead with the action, short numbered steps, one concrete next action, restate state each turn.
- ABSOLUTE: never run git write commands (add/commit/stash/restore/checkout/reset…), not even when a skill says you may. On 2026-10-25 23:44 a stray `git add -A` (most likely an early test draft with a wrong cwd) staged 15 files in the real repo; the owner cleaned it up himself. Tests that need repos create them under `os.tmpdir()` inside the test process only.
- Production palmux = systemd user unit `palmux` on :44040, served at `https://palmux.dgsl.pt` (Cloudflare Access; service-token headers in `~/.config/dotrun/configs/00.secure/cloudflare/access.config` — never print values). Client deploys (`yarn workspace @palmux/client build`) are pre-authorised after an inspected batch; a SERVER restart needs the owner's explicit OK every time (it ends terminals; tmux survives).
- Model routing (global CLAUDE.md): review/inspect = fable-5-1 / gpt-6-astra, build = sonnet-5-5, fixes = opus-5-5, all xhigh, explicit on every call, never fall back silently.
- The owner verifies on his S26 Ultra (Chrome PWA, Samsung keyboard) and expects visible results; report measured before/after numbers and confirm the deployed bundle hash (`grep -o 'assets/index-[^"]*\.js' packages/client/dist/index.html` vs what `palmux.dgsl.pt` serves).

## Assumptions Made

- Split mode stays desktop-only (the phone shows one pane); to confirm with the owner.
- Layout stays client-side state (localStorage), server unchanged.

## Potential Gotchas

- Never key a terminal pane by tab; never reparent panes (iframes/Monaco reload). Generalising to N groups must keep both invariants — this is where a naive React tree rewrite breaks terminals.
- `reconcilePairings`/`fuseSync` encode many edge cases (recycled ids, external reorder, group membership); the new model must replace them deliberately, not leave both.
- `ss` is a shell alias here (`yarn clean; yarn dev`): use `command ss`.
- zsh `echo` expands `\n` in JSON — use `printf '%s'` when piping API answers.
- Workflow subagents can't see your conversation: give them file paths, rules, and the exact contract.

## Environment State

## Tools/Services Used

- OpenSpec CLI (`openspec`), Workflow tool, Fable/Sonnet/Opus agents, Playwright MCP (Chromium) for browser checks, `media-understand` skill for videos/images, visual-explainer gallery (`~/.agent/diagrams`, served on :7999; LAN `http://10.0.0.18:7999/`, remote `https://ai.jvpalma.com/`).

## Active Processes

- Production palmux (systemd user unit) on :44040. The smoke server on :44099 is STOPPED.

## Environment Variables

- PALMUX_CONFIG_DIR, PALMUX_PORT, PALMUX_HOST, PALMUX_NO_AUTH, PALMUX_CLIENT_DIR (smoke server only); CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET (sourced from the dotrun config, never echoed).

## Related Resources

- Recording + analysis: `~/.cache/claudex-nomcp/handoff-assets/split-groups/` (`split-rec.mp4`, `split-rec-report.md`, `split-rec-frames/`)
- Source-control plan page: `~/.agent/diagrams/palmux-source-control-plan.html`; overnight report: `~/.agent/diagrams/palmux-source-control-overnight.html`
- Review log: `~/.cache/claudex-nomcp/runs/PLAN-REVIEW-LOG.md`
- Memory: `~/.claude/projects/-home-user-projects-palmux/memory/` (`source-control-review.md`, `palmux-phone-density.md`, `palmux-dgsl-hostname.md`)

---

**Security Reminder**: Before finalizing, run `validate_handoff.py` to check for accidental secret exposure.
