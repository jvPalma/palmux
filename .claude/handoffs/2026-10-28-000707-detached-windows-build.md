# Handoff: detached-windows build (palmux)

**Created:** 2026-10-28 00:07 (Lisbon)
**Project:** /home/user/projects/palmux
**Branch:** release/1.2.0 (working tree has many unstaged changes; git is the owner's domain)
**Continues from:** 2026-10-27-120315-palmux-split-groups-vscode.md

## Current State Summary

The owner (João, pt-PT, ADHD mode always on) said "go build" for the OpenSpec change
`openspec/changes/detached-windows/`. It makes "Open in new window" a VS Code-style auxiliary window: the
tab LEAVES the main window, the detached window is a full editor-groups window without the dock, and tabs drag
between windows. Plan was approved by Fable after 4 review rounds (P1–P4 findings all applied).

Build status by batch (each: Sonnet build → Fable inspect → Opus fix → Fable re-check → client build):

| Batch | Tasks | Status |
|---|---|---|
| A | 1.1, 2.1, 2.2 (shared protocol, server ownership/lease/grace) | APPROVED (A-01/A-02 fixed) |
| B | 3.1–3.3 (session-url, ws, useEditorGroups `place`/`layoutKey`, useTabGroups `fullTabsRef`, window-selection) | APPROVED |
| C | 4.1, 4.2 (App lists, D15 guard, moveTabsToWindow, doPopout, D14) | APPROVED (C-01..C-03 fixed) |
| D | 4.3–4.5 (reclaim, self-close, chrome, legacy popout→detached, controller) | APPROVED (D-01..D-05, D-07 fixed) |
| E | 5.1, 5.2 (cross-window drag) | BUILT, Fable inspection RUNNING at handoff time |
| F | 6.1–6.4 (docs, full gates, browser e2e, restart ask) | NOT STARTED |

Client dist last built after batch D: `packages/client/dist/assets/index-DcCf3laF.js` (production :44040 serves
this checkout's dist; the server was NOT restarted, so prod runs the OLD server — "Open in new window" is hidden in
prod until restart, because the client gates it on `ready.detachedWindows`).

## Important Context

- **Hard rules:** NEVER git write commands (not even `git stash list`). NEVER start/stop/restart palmux :44040
  without the owner's explicit OK at that moment (it kills every live terminal). Never `pkill -f`, never
  `tmux kill-server`. "Deploy always" = only `yarn workspace @palmux/client build` after a finished, inspected batch.
  Never CI/CD.
- **Model routing (xhigh, pass explicitly):** build = `sonnet` (claude-sonnet-5-5), review/inspect = `fable`
  (claude-fable-5-1), fixes = `opus` (claude-opus-5-5). Delegate via the Agent tool with `model` + `effort: xhigh`.
  Never silently fall back.
- **Owner preference:** fixes test-first — failing test, fix, pass, revert the fix alone to see it fail, re-apply.
- **Snapshots** (no git): pre-batch copies at `~/.cache/claudex-nomcp/prebuild-dw-{A,C,D,E}/packages/*/src`;
  inspectors `diff -ru` against them.
- **Owner questions still unanswered:** (1) keep or veto D14 — a review held by another window is MOVED here, an
  editor FILE held elsewhere only toasts "`<name>` is open in another window"; (2) "Leave site?" beforeunload
  prompt on closing a detached window: yes/no (not implemented); (3) archive `split-editor-groups` (required before
  task 6.2's `validate --strict`); (4) production restart OK (task 6.4, ask only at the end).
- Earlier this session (already done): split-editor-groups build through 6.3 + DR4-01 fix.

## Immediate Next Steps

1. Wait for (or re-run) the Fable inspection of batch E: diff `packages/client/src` vs
   `~/.cache/claudex-nomcp/prebuild-dw-E/packages/client/src`; files App.tsx(+test), session/GroupDropOverlay,
   GroupsView, SessionTabs (+tests). Builder deviations to judge: `centreOnly` overlay prop, dirty guard on chip,
   strip lights on hover, sentinel owner `'?'` (`OTHER_WINDOW`) for the source's optimistic hold (check no flash
   back after 2 s), stub signature updates. If FIX → Opus fixer test-first → Fable re-check.
2. `yarn workspace @palmux/client build` after E is approved.
3. Batch F: 6.1 CLAUDE.md + tips (tasks.md 6.1 lists exact passages incl. the legacy `/<id>` boot change and
   D15; stale "pop-out" comments in GroupsView.tsx, useTabGroups.ts(+test), TerminalPane.tsx, tab-strip-css.test.ts,
   window-selection.ts, tips/tips.ts); 6.2 full gates (`yarn typecheck`, `npx oxlint packages`, full client
   vitest, server + shared vitest, `npx openspec validate detached-windows --strict` — needs split-editor-groups
   archived first: ASK the owner); 6.3 browser e2e on the isolated smoke server
   `~/.cache/claudex-nomcp/scr-smoke.sh` (never :44040), two windows of one Chromium context, measure real
   cross-window drag/dropEffect/dragover cadence; 6.4 ask the owner for the prod restart.
4. Report to the owner in ADHD format (state, numbered steps, one next action) and re-ask the open questions.

## Decisions Made

- D14 split: reviews move to the asking window (no unsaved state); editor files toast instead (the other window's
  dirty buffer is invisible) — coordinator call, owner may veto.
- `moveTabsToWindow` returns boolean; `place` only on true; confirms only when tabs LEAVE (`target !== myWindow`);
  `dirtyTabs` pruned only when leaving (reclaim keeps the unsaved flag).
- Legacy `/<id>` (non-popout) boot is applied inside the first `sessions` handler (like `?new=1`) so the D15 guard
  sees both lists; a legacy id held elsewhere boots as plain `/`.
- `reclaim` skips (and does not spend `firstOpenRef`) on a server without `detachedWindows`; on the first counted
  open after an upgrade it shows the claimed tab only if the window is on the New-tab page.
- Kit `ui/Dialog` `onConfirm` optional; detached `+` dialog has one Close button; dialog content
  `max-height: calc(100vh - 2 * var(--sp-4)); overflow: auto`.
- Server: claims by a spawning data attach and `createTab{window}` arm the lease (`windows.moved`); a no-op
  `moveToWindow` neither broadcasts nor restarts the grace; `ping` never un-marks a closing socket.

## Critical Files

- `openspec/changes/detached-windows/{proposal,design,tasks}.md`, `specs/detached-windows/spec.md`,
  `specs/window-pop-out/spec.md`
- `packages/shared/src/protocol.ts`, `packages/server/src/server.ts`
- `packages/client/src/App.tsx` (+ `App.test.tsx`, "detached windows" describe), `session/session-url.ts`,
  `session/useEditorGroups.ts`, `session/useTabGroups.ts`, `session/window-selection.ts`, `lib/ws.ts`,
  `session/SessionTabs.tsx`, `session/GroupsView.tsx`, `session/GroupDropOverlay.tsx`, `ui/Dialog.tsx`, `ui/ui.css`
- Memory: `~/.claude/projects/-home-user-projects-palmux/memory/detached-windows-feature.md`

## Potential Gotchas

- `yarn build` overwrites the dist production serves — only the coordinator builds, after approval.
- `ws-tabs.test.ts` "attaching with no kind to an unknown id spawns a terminal" flakes under load (zsh startup >4 s);
  pre-existing, unrelated.
- happy-dom cannot exercise real cross-window DnD; the e2e must.
- `oxfmt --check` flags old unformatted lines in App.tsx/App.test.tsx/SessionTabs.test.tsx — not ours, leave them.
