# ui-rework — apply batch 10 (carried: batch 9's two remaining Explorer persistence defects)

Batch plan for the OpenSpec change `ui-rework`. Batches 1–8 are in production; batch 9 is built,
gated and inspected twice but NOT deployed: its second inspection returned two medium findings after
its inspection budget was spent, so they are carried here (the same handling as B3-F2-001 and
B4-RV2-001/002). Batch 9 and 10 deploy together once this batch's inspection approves.

## Carried findings (verbatim evidence in the log, `B9-INSPECT2-01/02`)

1. **B9-INSPECT2-01 — cross-window read-modify-write race.** `writeExpandedDir` and
   `forgetDeletedDirs` (`panes/explorer-open.ts:~157`, `~184–189`) each read the stored set, apply one
   change and write it back, with no coordination between browsing contexts. Window A reads
   `['/work/deleted']` while opening `/work/other`; window B commits the delete (`[]`); A writes
   `['/work/deleted','/work/other']` — the deleted record is back, and the same interleaving loses
   independent expansions. Web Storage provides no cross-window locking.
2. **B9-INSPECT2-02 — a non-canonical stored path loops forever.** `normalizePin`
   (`panes/explorer-pins.ts:~15–19`) only trims whitespace and trailing slashes, so a stored
   `/home/u/.` (or `//`, or `..`) survives the parse and lands in `neededDirs`. The server answers with
   `path.resolve`d `listing.path` (`server/files.ts:~98,122`), `load` files the response under that
   canonical key and deletes the requested one (`FileTree.tsx:~317–320`), and the load effect
   (`~446–448`) sees the requested key missing and fetches again — after every response.

## Design decision after review round 1 (B10-01..03)

Round 1 showed the first design (Web Locks around asynchronous writes) costs more than the defect it
cures: asynchronous writes open a remount race (B10-02), a mounted tree in ANOTHER window would still
need a cross-context delete transport (B10-03), and canonicalising only restored values splits path
identity (B10-01). The defect itself is narrow — two windows of ONE device mutating expansions within
the same instant — and its only consequence is a stale record. So instead of serialising writes, this
batch makes a stale or malformed record HARMLESS and gives paths ONE identity:

## Acceptance criteria

### A. One canonical path identity (B9-INSPECT2-02, B10-01)

- `normalizePin` (`panes/explorer-pins.ts:~15`) canonicalises with `path.resolve` semantics (POSIX):
  collapse repeated `/`, drop `.` segments, resolve `..`, no trailing slash except `/`; a path that is
  not absolute stays `''` (rejected). Every existing caller already routes through it —
  `addPin`/`removePin`/`isPinned`/`explorerRoots`, and both Explorer stores' parses — so live roots,
  restored roots and restored folders all share the identity the server uses, and pin removal and
  dedupe keep working for a pin stored as `/work/./project` (it compares equal to `/work/project`).
- Expansion writes and delete drops normalise their input through it too.
- Tests: `normalizePin` cases (`/a//b`, `/a/./b`, `/a/b/../c`, `/..`, `/`, trailing slashes, relative);
  a synced pin `/work/./project` stored open with an expanded child `/work/project/src` → after remount
  the section is open and the child row is expanded and listed; `removePin` of `/work/project` removes
  the `/work/./project` pin.

### B. A folder is fetched only when it is really on screen (B9-INSPECT2-01's consequence, B9-INSPECT2-02's loop)

- Visibility (`neededDirs`, used by the loader AND the poll) changes from "a path whose ancestors are
  expanded" to "a folder that appears as a DIRECTORY entry in its parent's `ready` listing, whose
  parent is itself visible or a live open root, and that is expanded". A record for a folder that was
  deleted (resurrected by a cross-window race or not), renamed, or stored in a form no listing ever
  produces is therefore never fetched and never polled; it stays dormant in storage, bounded by the
  200 cap. Restore loads level by level (one round trip per depth), which is the cost of using the
  listing as the proof of existence.
- Defence in depth in `FileTree.load`: when a non-root request's response reports a different
  `listing.path`, the response is filed under the canonical key AND the requested key keeps a
  terminal state, so the load effect can never refetch it in a loop. The HOME request
  (`dir === null`) keeps its special case.
- Writes stay SYNCHRONOUS read-modify-write as batch 9 left them (no locks). The known limit, stated
  in full in CLAUDE.md (B10-R2-01): when two windows of ONE device change folder expansion in the
  same instant, the later write is computed from the earlier stored set, so it can (a) bring back the
  record of a folder the other window just DELETED — harmless now, never fetched; (b) drop the other
  window's new expansion — that window re-expands it; or (c) bring back the record of a folder the
  other window just COLLAPSED while it still exists — that folder REOPENS on the next mount. (c) is a
  real reversal of a user action, accepted because it needs two windows on one device acting within
  the same storage read/write gap; the owner's setup is one installed PWA per device. A controlled
  interleaving test pins (c)'s documented outcome, so a future change to the scheme notices it.
- Tests: a stored `/home/u/.` and `/home/u//x/../y` restore as `/home/u` and `/home/u/y`; a stored
  record for a folder its parent's listing does not contain is never requested (fetch count 0 after
  several poll intervals); a mocked server answering `/a/./b` with `path: '/a/b'` is requested exactly
  once; nested restore fetches level by level and ends with the expanded folders listed; the whole
  batch-8/9 FileTree suite stays green (realign only tests that assumed parallel restore, naming them).

### C. Docs

- CLAUDE.md's Explorer persistence lines: the canonical identity, listing-proven visibility, and the
  stated cross-window limit.

## Cluster

One builder (`claude-sonnet-5-5`, xhigh): `panes/explorer-open.ts` + test, `panes/explorer-pins.ts` +
test, `panes/FileTree.tsx` + `FileTree.test.tsx`, `CLAUDE.md` (those
lines). No server change.

## Verification

- `yarn typecheck`, `yarn lint` (0 errors), `yarn test`.
- The tests in A and B; the whole batch-8/9 FileTree and App suites stay green.
- Not in scope any more: Web Locks (see the design decision above).
- Isolated smoke (`PALMUX_HOST=127.0.0.1`, `"host":"127.0.0.1"`, :44099, `command ss -ltnp`, client
  built into /tmp): seed `localStorage['palmux-explorer-expanded']` with `{"v":1,"dirs":["<HOME>/."]}`,
  open the Explorer, and count `/files/list` requests over 5 seconds (must be a handful, not a loop);
  repeat batch 9's relaunch check (last tab + an expanded folder survive a new page in the same
  context).
