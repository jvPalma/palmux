# ui-rework — apply batch 11 (group 12: a path is the path — no trimming, client or server)

Batch plan for the OpenSpec change `ui-rework`, its LAST batch. Batches 1–10 are in production.

Owner decision (2026-10-25): deploy 9+10, then finish this batch, then archive the change. This batch
fixes the open edge from batch 10's final inspection (B10-INSPECT2-01) and the pre-existing server
defect found while fixing batch 10.

## The defect class

A path segment may legitimately END (or begin) with whitespace: `report ` and `report` are two
different directories. Several places silently `.trim()` a path before using it, which retargets the
operation to a sibling:

- **Server, destructive:** `deletePath` (`packages/server/src/files.ts:~162–165`) resolves
  `path.trim()`, so deleting the row `/home/u/report ` recursively deletes `/home/u/report`.
- **Server, reads:** `listDir` (`files.ts:~95`), `download.ts:~71` (pattern), `markdown.ts:~41`
  (md-file) and `~98–111` (md-list) trim before resolving, so they read the sibling.
- **Client:** `normalizePin` (`packages/client/src/panes/explorer-pins.ts:~15–29`) trims, which also
  makes canonicalisation non-idempotent (`/work/report /.` → `/work/report ` → `/work/report`), so a pin
  or a stored Explorer record can resolve to the sibling (B10-INSPECT2-01).
- `server/file-rw.ts` already does not trim (no change).
- **Client input fields:** `App.doDownload` (`App.tsx:~904`) passes `p.trim()` to `downloadFromServer`,
  and `DashboardBody.openMarkdown` (`DashboardBody.tsx:~184–189`) trims `mdDraft` before creating the
  tab, so a typed `/tmp/report ` downloads `/tmp/report` and `/tmp/notes.md ` opens `/tmp/notes.md`
  (B11-02).
- **A worse, related server defect (B11-01, HIGH, pre-existing):** `deletePath` checks `isAbsolute`
  on the RESOLVED path, and `path.resolve` already turns a relative input into an absolute one under
  the server's cwd, so the guard can never refuse: `deletePath('packages/client')` recursively deletes
  that directory of the running checkout. `listDir` has the same shape.

## Acceptance criteria

### A. The server uses the path it was given

- `listDir`, `deletePath`, the download pattern, `md-file` and `md-list` stop trimming the value they
  resolve and operate on. **`isAbsolute` is checked on the ORIGINAL, untrimmed input BEFORE
  `resolve`/`normalize`** (B11-01), so a relative input is refused instead of being anchored to the
  server's cwd; the protected-directory refusals (`/`, `$HOME`, top-level paths), the `markdownRoots`
  confinement and the download caps still run AFTER resolution, on the untrimmed resolved path.
- **Blank input keeps each endpoint's CURRENT contract (B11-03)** — `trim()` is used only to DETECT a
  blank value, never to produce the path:
  - `listDir`: an ABSENT `dir` means HOME; a present but blank `dir` stays `400 dir is required`.
  - `md-list`: an absent OR blank `dir` returns the roots overview, as today.
  - `md-file`: a blank `path` stays `400 path must be absolute`.
  - download: a blank pattern stays its current 400.
  - `/files/delete`: a blank item stays a PER-PATH failure (`path is required`) inside the HTTP 200
    batch response, including in a mixed batch with valid paths (the client's
    `explorer-actions.ts` reads per-path outcomes and must keep doing so).
- Server tests (each written first, failing). The REQUEST STRING must END in whitespace, or trim
  changes nothing (B11-04): siblings with distinct content `report`/`report ` (dirs), `x`/`x ` (files),
  `notes.md`/`notes.md ` (files), in a temp dir:
  - listing `.../report ` lists `report `'s entries, and `.../report` lists `report`'s;
  - deleting `.../report ` deletes only `report ` and leaves `report` intact, and vice versa;
  - downloading `.../x ` returns `x `'s content, not `x`'s;
  - md-file `.../notes.md ` returns `notes.md `'s content;
  - md-list of a roots-confined `.../report ` lists exactly that directory;
  - `deletePath('packages/client')` (an EXISTING relative target, cwd = a temp dir holding it) is
    refused and the target survives; the same relative input to `listDir`, md-file and download is a
    400;
  - each blank-input contract above, including a mixed delete batch.

### B. The client keeps whitespace too, and canonicalisation is idempotent

- `normalizePin` no longer trims. It canonicalises (`//`, `.`, `..`, no trailing slash except `/`)
  and rejects a non-absolute input as `''` — a pin with LEADING whitespace is therefore rejected
  rather than silently repaired, and trailing whitespace inside the last segment is kept.
  `normalizePin(normalizePin(x)) === normalizePin(x)` for every input (property-style test over the
  tricky cases: `/work/report /.`, `/a /b/../c `, `/ /`, `/a/ /..`).
- The settings sanitiser (`settings/settings.ts:~216` `parsePins` path) keeps whatever identity
  `normalizePin` returns; a stored pin is never rewritten to a sibling by an unrelated settings save.
- **Input fields keep the path exactly (B11-02, B11-R2-01).** `doDownload` and `openMarkdown` use
  `trim()` only to detect a blank entry and otherwise pass the string through unchanged, spaces
  included — the same identity the Explorer's own download (`FileTree.tsx:~531`) already uses. A value
  CONTAINING a line break (`\r` or `\n`, typically a terminal paste that carried the newline) is
  REFUSED with a toast ("That path contains a line break — paste it without the newline"), never
  silently stripped: `notes.md` and `notes.md\n` are different files, and stripping would pick the
  sibling. A value whose first character is whitespace is not absolute and is refused as today (the
  markdown row stays open).
  - **Where the refusal can actually happen (B11-R3-01).** A text `<input>` sanitises CR/LF out of its
    value before `onChange` runs (and `window.prompt` returns a sanitised value too), so a submit-time
    check never sees the newline. The markdown field therefore gets an `onPaste` handler that reads
    the raw clipboard text and, if it contains `\r` or `\n`, calls `preventDefault()` and shows an
    inline message under the field ("That path contains a line break — paste it without the
    newline"); `DashboardBody` has no toast callback, so the message is local to the row. The
    submit-time check stays as a second line. `doDownload` uses `window.prompt`, whose input cannot be
    intercepted: there the browser has already removed any line break, so the plan states the limit
    plainly in a comment — a path containing a line break cannot be entered in the Download prompt;
    the Explorer's own download (which passes the row path unchanged) covers it.
  - Tests: a paste event carrying `/tmp/notes.md\n` is prevented, the field keeps its previous value
    and the message shows; a trailing-space value reaches the created tab and `downloadFromServer`
    byte-for-byte.
- `explorer-open.test.ts` expectations that accept `' /x '` / `' /y '` as absolute (around lines
  63–67 and 187–191) are updated to the new rule (leading whitespace rejected, trailing kept), and new
  cases cover trailing whitespace preserved through BOTH persistence parsers and through the
  expansion and delete writers (B11-05).
- Tests: the B10-INSPECT2-01 case — a synced pin `/work/report /.` with the same stored open root and
  an expanded child restores the `report ` section (not `report`) after a settings round-trip and a
  remount, and its header requests `/work/report ` exactly; `removePin` and dedupe still compare
  canonical forms.

### C. Docs

- CLAUDE.md (B11-R2-02): each endpoint's paragraph states "the path is used exactly as given" plus
  ITS OWN blank rule — `/files/list` (absent → HOME, present-blank → 400), `/files/delete` (a blank
  item is a per-path failure inside the 200), `/download` (blank → 400), `md-file` (blank → 400),
  `md-list` (absent or blank → the roots overview) — and that `isAbsolute` is checked on the raw input
  before resolving. The Explorer paragraph's sentence saying the listing route TRIMS (around
  `CLAUDE.md:676`) is rewritten as history ("it used to trim; a trimmed request was answered with a
  sibling's listing, which is why the response-path mismatch guard exists") while keeping the guard's
  explanation, and the canonical-identity line says whitespace is significant.

## Deploy

The client change ships through the standing client deploy. The server change takes effect only after
the palmux server restarts, which ends every live terminal; the coordinator ASKS the owner before
restarting (the "deploy always" authorization covers the client build only).

**Rollout step (B11-06).** A client still running the batch-10 bundle trims pins during
`mergeServerSettings` and, on its next unrelated settings save, sends the whole synced subset back —
replacing a whitespace-significant pin everywhere. So the rollout is complete only when every open
palmux window (phone PWA, desktop windows) has reloaded onto the new bundle; the coordinator tells
the owner to Reload app on each device right after the deploy. A versioned settings contract is out of
scope: the owner's pins contain no whitespace-ending segments today, so the window of exposure is
only "a stale window saves settings after someone pins such a path".

## Cluster

One builder (`claude-sonnet-5-5`, xhigh):
`packages/server/src/{files,download,markdown}.ts` + their tests,
`packages/client/src/panes/explorer-pins.ts` + test, `packages/client/src/panes/explorer-open.test.ts`,
`packages/client/src/settings/settings.ts` + test only if the sanitiser needs it,
`packages/client/src/panes/FileTree.test.tsx` (the restore case), `App.tsx` (`doDownload` only) +
`App.test.tsx`, `panes/DashboardBody.tsx` (`openMarkdown`, the markdown field's `onPaste` and its inline
message) + its test, `CLAUDE.md` (the lines
above).

## Non-goals

- Upload filenames (already sanitised to a temp name), `/file` (already untrimmed), config parsing.

## Verification

- `yarn typecheck`, `yarn lint` (0 errors), `yarn test` (client + server + shared).
- Isolated smoke (`PALMUX_HOST=127.0.0.1`, `"host":"127.0.0.1"`, :44099, `command ss -ltnp`, server
  from the repo via tsx so it runs the NEW server code, client built into /tmp), in this order
  (B11-R2-03):
  1. create `/tmp/palmux-b11/fs/report/` and `/tmp/palmux-b11/fs/report /` with distinct files;
  2. in the browser, pin `/tmp/palmux-b11/fs` and confirm both folders list their OWN entries
     (screenshot);
  3. via HTTP, list both, then delete `report ` and confirm `report` and its file survive;
  4. a relative `POST /files/delete` with `["packages"]` is refused and nothing is removed — run with
     the SERVER PROCESS's cwd inside a fresh disposable fixture (B11-R3-02), never the repo: create
     `/tmp/palmux-b11/cwd/packages/sentinel`, launch with `cd /tmp/palmux-b11/cwd && node
     /home/user/projects/palmux/node_modules/tsx/dist/cli.mjs
     /home/user/projects/palmux/packages/server/src/index.ts` (absolute paths), and verify the
     sentinel survives and `/home/user/projects/palmux/packages` is untouched. If the guard were still
     broken, the worst case is deleting the fixture. The same disposable cwd is used for steps 1–3.
