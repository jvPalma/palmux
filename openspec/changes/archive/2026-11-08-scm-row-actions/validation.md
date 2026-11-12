# Validation ledger — scm-row-actions (2026-11-08)

Built in one autonomous run (`/offline-worker scm-row-actions`, default mode: nothing staged, nothing
committed, prod :44040 untouched). Every task below was built test-first. Where a fix answered a review
finding, the new test was checked against a revert of that fix (it failed without the fix). Design
departures are recorded as B1–B12 in `design.md` ("Build decisions").

## Final gates (task 6.3, run after 6.2, sequentially)

| Gate | Result |
|---|---|
| `yarn typecheck` | exit 0 |
| `yarn lint` (oxlint) | exit 0, 0 errors, 1141 warnings repo-wide. The new server files add `no-await-in-loop` warnings (sequential on purpose: one lock, one write at a time, D6 step order). |
| `yarn test` | exit 0. client 143 files / 5048 tests, server 51 / 1029, shared 4 / 45. Total 6122 passed, 0 failed. |

## Reviews

| Round | Reviewer | Verdict → outcome |
|---|---|---|
| Wave A (tasks 1–4, 5.1–5.3, 6.1) | codex `gpt-6-astra` xhigh | FAIL. Findings fixed test-first (B1–B9). |
| Wave B (2.6, 3.4, 5.4–5.6) | codex `gpt-6-astra` xhigh | FAIL. Findings fixed (inline-action guard, Undo forgets both logs, repo-refusal audit, discard conflict count). |
| Re-review of the repairs | `claude-fable-5-1` xhigh | FAIL: two filter bypasses in discard and batch stage, two low findings. Fixed by an opus@xhigh fixer (B10–B12), each with a failing test first and a 720-case `checkoutBytes` ≡ `checkout-index` test. |

## Browser e2e (task 6.4)

Setup: an isolated server on :44099 with `PALMUX_CONFIG_DIR=/tmp/palmux-sra/cfg`, a scratch build in
`/tmp/palmux-sra/dist`, and a scratch repository `/tmp/palmux-sra/repo` copied with `cp -a` (46 changes: 40 new
`feature40/*.go`, 3 untracked `scratch/junk/*`, 2 modified, 1 deleted). Chromium via Playwright. Screenshots
are `/tmp/palmux-sra/01…14-*.png`.

### 1440px

| Scenario | Evidence | Result |
|---|---|---|
| Row heights (file, folder, group header) | 24px / 24px / 24px measured | PASS |
| Hover shows actions, name truncates before them | `01-desktop-hover.png` | PASS |
| Keyboard focus reveals the actions; Tab reaches open/stage/discard | `visOnFocus: true`, focus order `scm-action-open → -stage → -discard` | PASS |
| Right-click menu on a Changes file | items `scm-menu-open`, `-stage`, `-discard`; no tab opened | PASS |
| Stage all on a 40-file folder, then Undo | toast "Staged 40 files" + Undo; Undo restores all; audit `scm: stage-paths … lockMs=26 … (+30)` (`02-stage-folder.png`) | PASS |
| Discard confirm text (one file; folder with untracked files) | confirm names the files and the untracked count | PASS |
| Discard a modified file and an untracked folder | toast "Discarded 3 files"; files and `scratch/junk` gone; audit `scm: discard … receipt=d…` (`03-discard.png`) | PASS |
| Undo last discard from the project bar after a reload | button visible after reload; tap restores the bytes on disk; audit `scm: restore-discard … status=200 code=-` (`04-undo-bar.png`) | PASS |
| Open file opens a preview editor tab | one tab `cli.go`, aria-label "cli.go, preview", italic title (`06-open-file-preview.png`) | PASS |
| Review current-file bar stays while scrolling deep | Changes review, 23,992px tall: at scrollTop 0 / 2000 / 2037 the bar stays at y=72 and names `CONTRIBUTOR.md` / `feature40/f05.go` / `f06.go`; Reviewed and Open file are at y=74 (`13-review-bar-deep.png`) | PASS |
| Open file disabled on a deleted file in the bar | `CONTRIBUTOR.md` (D): `review-current-open` disabled | PASS |
| Reviewed from the bar | f06 staged, bar moves to f07, toast "Reviewed f06.go" + Undo; Undo empties Staged (`14-bar-reviewed.png`) | PASS |
| Staged file actions, Unstage | Staged row offers `open`, `unstage`; Unstage moves it back to Changes; toast counts both writes inside the 6 s log window ("Staged 1 file, unstaged 1 file") | PASS |

### 390x844, touch emulation (`hasTouch`, `isMobile`, CDP `Input.dispatchTouchEvent`)

| Scenario | Evidence | Result |
|---|---|---|
| Row heights (file, folder, group header) | 24px / 24px / 24px measured in the drawer | PASS |
| No inline actions on a phone | 0 `.scm-actions` rendered (`09-mobile-scm.png`) | PASS |
| Long-press opens the menu; its release opens no review | menu `open / stage / discard` during the 700ms hold and after release; session list unchanged; drawer stays open (`10-mobile-longpress-menu.png`) | PASS |
| Vertical swipe from a row scrolls and opens no menu | Radix viewport scrollTop 563 → 280; 0 menus; no tab opened; `pointercancel` fired (the browser took the pan), no `touchmove` prevented (`11-mobile-swipe-scrolled.png`). An earlier finger-up swipe showed no movement only because the list was at its bottom (563/563). | PASS. D3's long-press fallback is not needed. |
| Plain tap on a row opens its review and closes the drawer | review of `internal/cli/cli.go`, the review bar shown, drawer closed (`12-mobile-tap-review.png`) | PASS |

## Not verified here

- The 501 for git < 2.26 (`gitVersion()`): only the version parse is unit-tested, because this host runs 2.43.
- macOS, Firefox and a real Android device: Chromium touch emulation only.
- The server routes are not in prod. Shipping them needs a server restart, which ends every live terminal
  under systemd, so it waits for the owner's OK.

## What would invalidate this

- A git release that changes `--pathspec-from-file`, `restore --staged`, `update-index --index-info` or
  `convert.c`'s eol rules. `checkoutBytes` is a port of 2.43, and the 720-case equivalence test is what would
  catch the drift.
- A Radix ContextMenu upgrade that changes its long-press timing or its touch-action. The swipe and
  long-press checks would have to be re-run.
- A scratch repository unlike real ones (no LFS, no `.gitattributes` in the e2e fixture). The filter paths are
  covered by unit tests against real git, not by the browser run.

## After `/opsx:verify` (2026-11-08, owner's answers W1–W7, S1)

Each fix was written test-first and the new test failed before the fix.

| Item | What changed | Evidence |
|---|---|---|
| W1 audit fields | `restore-discard` lines carry `restored=`, `kept=` and `ms=`; refusal lines carry `requested=` and `ms=` | `scm-routes.test.ts` (3 tests red, then green; a new partial-Undo test logs `restored=1 kept=1 status=409 code=conflict`) |
| W2 skipped file named | one skip is named (`skipped link.ts (a symbolic link)`), mixed reasons are counted per reason | `review-writes.test.ts` 4 cases, `SourceControlView.test.tsx` "changed nothing" |
| W3 | accepted as is (owner) | — |
| W4 spec | group headers keep the 11px section-title type; the requirement and both scenarios say so | `openspec validate` valid |
| W5 tests | restore through a folder swapped for a link writes nothing outside the project (409 `conflict`); the `/scm` route list is closed (13 routes) | `scm-discard.test.ts`, `scm-routes.test.ts` "the write surface" |
| W6 expired Undo | a 410 on a `d` receipt says "This Undo has expired" and forgets the project bar's receipt | `review-writes.test.ts` 2 cases |
| W7 header height | measured 32px on a phone (trigger 24, `sm` button 32); kit `IconButton size="xs"` → 24px on a phone and 24px on a desktop, measured in Chromium at 390x844 and 1440x900 (`/tmp/palmux-sra/16-…`, `17-…`) | `SourceControlView.test.tsx` "Open review button no taller than the header" |
| S1 | one `SCM_STATUS_LABEL` (shared); `scm-discard.ts` uses `scm-index.ts`'s `isFailure`, `readEntries` and `BATCH_MAX_BUFFER`; the eol port moved to `scm-eol.ts`, sharing `statsAreBinary` with the snapshot reader | typecheck; the 720-case `checkoutBytes` test unchanged and green |
| B13 (found here) | the batch stage's private index copy takes the index's own times: a same-size edit in the second of the last index write was answered "Nothing staged" (a flaky audit test, `done=3` of 13) | `scm-index.test.ts` "racily clean" (red without the fix, deterministic: times moved into 2020) |

Gates after these fixes, run sequentially: `yarn typecheck` exit 0; `yarn lint` exit 0 (1141 warnings, unchanged);
`yarn test` exit 0, client 143 files / 5052 tests, server 51 / 1033, shared 4 / 45, total 6130 passed, 0 failed.
