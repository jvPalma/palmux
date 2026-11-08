# Validation ledger (default mode: nothing staged)

What is validated and tested, per batch. A task is ticked in tasks.md only after its gates AND the 8.2
browser check pass.

## Batch 1 — phases 1–3 (wf_67953b68-c91)

- Built by sonnet@medium (c1 phase 1, c2 phases 2–3). Reviewed by codex gpt-6-astra@xhigh: FAIL with 2
  important findings. (1) Lone-surrogate per-file url crashed the canonicaliser → fixed by the review repair
  (`parseReviewUrl` rejects `\p{Surrogate}`, plus tests). (2) `review-registry.test.ts` fixture missing
  `toggleWrap` → fixed in the main loop.
- ↻ MID-FLIGHT CORRECTION: `ConfigEditor` sets `wordWrap: 'on'` (it spread the layout options, which no
  longer carry wrap), plus a test (`ConfigEditor.test.tsx`, 40/40).
- Gates (2026-11-02): `yarn typecheck` clean; `yarn lint` 0 errors; shared scm 12/12; server
  tabs-registry/ws-tabs/ws-handlers/protocol 196/196; client phase-1 + tab-meta scope 20 files, 1238/1238;
  review-registry 3/3.
- Main-loop read of `registry.replaceTab`: one `listChanged()`, N spliced at P's index, P removed with no
  extra broadcast, guard on pinned/gone/other window, `replaces` never persisted.
- Pending: browser check (8.2).

## Batch 2 — phases 4–6 (wf_8167a19c-30f)

- Built by opus@high (b1 App routing: 4.1–4.5, 6.3, 6.4 + App halves) and sonnet@medium (b2 save-pin 4.6,
  b3 looks 5.1–5.2, b4 single-file review 6.1–6.2). Reviewed by codex gpt-6-astra@xhigh: FAIL, 6 important
  findings, all repaired by the review repair (opus), each with a test that failed before the fix:
  1. a cross-kind swap then a pin in one render landed in the focused pane → `keepReplaces` (pane-grid.ts)
     carries the hint until a render used it;
  2. double-click a.ts then click b.ts before the answer lost the keep → the kept entry moves aside under
     `<pane>~<n>` and the new file goes out as a fresh preview create;
  3. Ctrl+S pinned a hidden Edit-mode preview → the editor's `active` is `focused && mode === 'edit'`;
  4. Open review from a paused review used the active project → `openReview` takes `repo`;
  5. a stale `replaces` moved a phone's selection → client counts a swap only on the broadcast that first
     lists the new tab; ↻ MAIN LOOP: the server now drops `replaces` from the record right after the swap's
     own (synchronous) broadcast (`server.ts` replaceTab), tests updated to read the hint off the broadcast
     (tabs-registry + ws-tabs 136/136);
  6. "No more files" survived a later visit → `endedFor` clears on a file change.
- Gates (2026-11-02, after repair): `yarn typecheck` clean; `yarn lint` 0 errors; client scope
  (App, panes, session, scm, review, ui, lib) 88 files, 3906/3906.
- Main-loop read of reconcile step 0: P's TabRef swapped for N in the same leaf slot, active kept, all in the
  one pure reconcile call; returns `layout` itself when no hint applies.
- Pending: browser check (8.2), incl. a real SCM row double-click after `pressMove`.

## Phase 7 — docs

- CLAUDE.md: "Preview tabs" under Wire protocol → Tabs (D1, D3, D3a with the VS Code reference and the
  reconcile rule, D4 triggers, the race, D9 and rollback); "A Source Control click opens ONE file's diff"
  in Source Control (D2 url, D6, the header's Open review, rollback and deploy window); an `editorWrap`
  paragraph before the Monaco gutter notes; `toggleWrap` before the Source Control chords.
- README "What you get": preview tabs, one file's diff per click with Open review, Alt+Z.
- tips.ts: a "Preview tabs" tip (Tabs). `vitest run src/tips` 31/31.

## Phase 8

### 8.1 full gates (2026-11-02, after batch 2 + main-loop server fix)

`yarn typecheck` clean · `yarn lint` exit 0, 0 errors (pre-existing warnings only) · `yarn test`:
client 141 files / 4926, server 50 / 953, shared 4 / 45 (5924 total) · `yarn build` ok (precompress 190 files,
6.05 MB → 1.33 MB brotli).

### 8.2 browser e2e — isolated :44099 (scr-smoke.sh: scratch dist, config, HOME, TMUX_TMPDIR, NO_AUTH)

Playwright, two real windows (separate sessionStorage), frame log = a `requestAnimationFrame` sampler plus
a `MutationObserver` on `document.body`, both recording the strip as `[*]title[!]` (`*` preview, `!` active).
Screenshots in `.playwright-mcp/pt/`.

1. PASS — ten Explorer opens (`.gitignore` … `README.md`) left `shell | *README.md`: italic title,
   `aria-label` "README.md, preview", `title` "README.md — preview (double-click to keep open)", pill height
   28px = the pinned pill's. Pill double-click: frames `*README.md!` → `README.md!`, no rename input.
   (01-ten-opens-one-preview.png)
2. PASS — typing `#` into the `.yarnrc.yml` preview in window A: both windows went `*.yarnrc.yml!` →
   `.yarnrc.yml!`. (02-typed-pins-in-window-b.png)
3. PASS — editor preview `*CLAUDE.md` (slot 3, active) replaced by a Source Control click on CHANGELOG.md
   (cross-kind `replaceTab`). Window A frames: `shell|README.md|*CLAUDE.md!` →
   `shell|README.md|*CHANGELOG.md (Changes)!`; window B the same two states and nothing between: no frame
   with both tabs, neither, or a neighbour active. Later swaps (review → review same kind, staged review →
   editor) also changed in place. (03-scm-click-single-file.png)
4. PASS — the click showed one file (`1 file · +106 −0`) with `1 / 7`; Reviewed staged it and the SAME tab,
   still a preview, moved to `docs/notes/release-checklist.md` `1 / 6` (toast "Reviewed CHANGELOG.md · Undo").
   Restored through a Staged single-file preview + Unstage, which showed the end state "No more files in …"
   + Open review; scratch `git status` back to the start. (04-reviewed-next-file.png, 04b-unstage-end-state.png)
   ↻ MAIN LOOP: the end and edge messages printed the raw group id ("staged"); the spec says
   "No more files in Changes" → `groupName()` in ReviewPane.tsx, tests realigned, review 833/833.
5. PASS — `scm-open-review-changes` opened a pinned "Changes · palmux" tab (7 files, +117 −9, `1 / 7`); the
   group did not toggle. (05-open-review-whole-group.png)
6. PASS — editor: Alt+Z toasts "Word wrap off", again "Word wrap on". Review in Split: "Side-by-side always
   wraps"; in Unified the Wrap control went `aria-pressed` false → true with "Word wrap on". Terminal: `cat -v`
   received `^[z`, no toast.
7. PASS — window B at 390×844, mobile layer on: the drawer row `.drawer-session.preview` is italic,
   `aria-label` "CONTRIBUTING.md, preview", 28px like the rest; long-press → sheet with Keep open
   (`tab-sheet-keep-open`) first; tapping it pinned the tab in both windows and closed the sheet.
   (07a-drawer-italic.png, 07b-sheet-keep-open.png)

Extra checks: a real double-click on a Source Control row (after `pressMove`) opened `byte-size.ts (Changes)`
pinned; the desktop menu offers Keep open on a preview (`menu-keep-open`) and not on a pinned pill; a pinned
pill's double-click opens the rename field; two Enter presses on a focused Explorer row left `*LICENSE`
a preview (08-two-enters-still-preview.png); after an isolated-server restart the client reconnected and
`*LICENSE` was still a preview (`tabs.json` `preview: true`). Console: only WebGL perf warnings and the
expected connection refusals during that restart.

Not run: the wf-blackbox-tester smoke. The main loop ran every spec scenario above with frame-level
instrumentation, which a black-box tester cannot add.
