# Design — split-view

## Context

`App.tsx` is a single-terminal integration: one `useTerminal()` xterm, one `wsRef.current`
`WsClient` rebuilt per active session, and one set of module-level-ish refs for replay suppression
(`suppressInputRef`, `replayPendingRef`, `wsGenRef`) and DA/DSR report-gating (`lastFocusAtRef` +
`document.hasFocus()`). The mobile layer (`useSoftKeyboard`, `ExtraKeysBar`, `useMobileGestures`)
and upload all bind to that one terminal via `sendInput`/`instance`. `PaneHost` overlays
non-terminal panes on the terminal, showing exactly one thing (the active tab). The
`chrome-tabs-and-panes` change already made tabs first-class with kinds, a registry, and metadata.

Supporting "any tab beside any tab, including two terminals" means more than one live terminal can
be on screen — which the current singletons forbid. This is the core design problem.

## Goals / Non-Goals

**Goals:**

- Two slots, any tab kind in either, horizontal OR vertical, resizable divider — **desktop only**
  (refinement S1 Q4/Q6: split is unavailable while the mobile layer is active).
- Two live terminals coexisting, each fully functional; the focused one receives the desktop-shared
  input surfaces (Ctrl+Shift+C/V, upload picker).
- Drag a strip tab to a content edge to split; drag a split tab back to the strip to collapse.
- Single-slot behavior is byte-identical to today after the refactor (regression-free).
- Split layout persists per device.

**Non-Goals:**

- **Split on mobile / while the mobile layer is active** (S1 Q4/Q6). The soft keyboard, extra-keys
  bar, and touch gestures only exist in mobile mode; since split never coexists with them, they
  need no per-slot routing.
- More than two slots / arbitrary grids (VSCode's full grid). Two slots only.
- Splitting the same tab id into both slots (a tab lives in one slot).
- A default keyboard shortcut for split (S1 Q3: Ctrl+\ collides with the user's tmux binding).
  Invocation is menu + drag only; any future shortcut MUST be user-configurable, default unset.
- Reordering tabs within the strip (drag-drop here is only strip→edge and slot→strip).

## Decisions

### D1 — Extract `TerminalPane`: the terminal becomes an instance, not a singleton

Move ALL per-terminal state out of `App.tsx` into `TerminalPane({ sessionId, focused, onData?, … })`:
its own `useTerminal` xterm, its own `WsClient` (built in an effect keyed on `sessionId`), its own
`suppressInput`/`replayPending`/`wsGen` refs, its own fit/resize, and its own Ctrl+Shift+C/V +
drag-drop-upload wiring. Everything that is currently one module-level concern becomes component
state, so two instances never share a socket, a suppression flag, or a fit loop.
_Alternative rejected:_ a pool/array of terminals managed in App — keeps the singletons' tangle and
spreads it across an index; a component with local state is the natural React boundary and makes the
single-slot case a trivial "render one."

### D2 — Report-gating (DA/DSR) keeps today's `document.hasFocus()` semantics, per pane

**(Corrected in refinement session #1.)** The originally proposed per-slot gate was wrong: the
same tab id never occupies both slots (Non-Goals), so two split terminals are two DIFFERENT PTYs —
they never parse the same output, and the "both answer one query" duplication cannot occur inside
one window. Worse, gating on slot focus would BREAK the unfocused terminal: anything probing the
terminal in the background slot (vim, tmux, a CPR width probe) would hang waiting for an answer
that pane is suppressing. The duplication problem only exists across WINDOWS attached to the same
session — which the existing `document.hasFocus()` + grace-window gate already handles, one gate
per document. Therefore: each `TerminalPane` carries the existing gate verbatim (component-local
`lastFocusAt` instead of App-level); slot focus plays NO part in report-gating. An unfocused slot
answers its own PTY's queries whenever the document has focus.

### D3 — Focus registry routes only the genuinely SHARED surfaces; everything touch/coordinate-local is per-pane

**(Scope corrected in refinement session #1.)** A `SplitFocusContext`
(`session/SplitFocusContext.ts`, ref-based so consumers read the focused pane at call time without
re-binding) exposes `{ focusedSlot, setFocusedSlot, register(slot, api) }` — the concrete `PaneApi`
contract is in `docs/pane-api.md`. It routes ONLY the surfaces that exist once per app:

- the soft keyboard (`#mobile-kbd` textarea stays in App; its `sendInput`/`onImage`/`isBlocked`
  callbacks become stable closures over the registry ref),
- the extra-keys bar (`send` → focused pane; armed/locked sticky modifiers survive focus changes
  and apply wherever the next key lands),
- the topbar/drawer upload picker + clipboard-paste buttons,
- the Ctrl+Shift+C/V combo: today `useTerminal` installs a window-level capture listener PER
  instance — two panes would double-paste. The combo handler is hoisted to ONE app-level listener
  that dispatches to the focused pane (each pane keeps its `attachCustomKeyEventHandler` opt-out).
- the document-level image-paste listener in `useFileUpload`: same hoist-or-focus-gate treatment.

Note (refinement S1): since split is desktop-only and the soft keyboard / extra-keys bar / gestures
exist ONLY in mobile mode, those surfaces never coexist with a split — so the registry does NOT
need to route them. On desktop it routes just the Ctrl+Shift+C/V combo and the upload picker to the
focused pane. The soft keyboard and extra-keys bar stay exactly as today (single-slot, mobile-only).

NOT routed through the registry — instantiated per pane, because their events arrive on a specific
pane's DOM host with pane-local coordinates:

- `useMobileGestures` (mobile-only; binds host+term; a tap on a pane also calls `setFocusedSlot`),
- touch selection + selection handles — `touch.ts`'s module-level `lastSelection` still becomes
  instance-scoped state (cheap correctness even though mobile split can't occur),
- copy-on-select (works in either pane regardless of focus; the initiating mousedown focuses the
  slot anyway),
- drag-drop FILE upload onto a pane (uploads to the slot dropped on, not the focused one).
  _Alternative rejected:_ per-pane extra-keys bars / keyboards — moot now (mobile has no split).

### D4 — Split state model + persistence

```
type SlotRef = { tabId: string };                 // a slot shows one tab id
type Split = { a: SlotRef; b: SlotRef;
               orientation: 'horizontal' | 'vertical';
               ratio: number;                       // 0.15–0.85, a's fraction
               focused: 'a' | 'b' } | null;         // null = single-slot (today)
```

Held in `useSplit()` (a hook) and persisted to `localStorage` (`palmux-split`), per device — like
`fontSize`/`mobileMode`, split is a per-device view concern, NOT synced (your phone and desktop want
different layouts). On load, dangling tab ids (tab gone) collapse the split to the surviving slot,
or to single-slot if both are gone. The URL still reflects the **focused** slot's tab id (so `/3`
still deep-links), keeping `session-url` semantics.

Strip-click rule (S1 Q2, "Rule R"): while split, clicking a strip tab already shown in the OTHER
slot FOCUSES that slot; clicking any other tab replaces the FOCUSED slot's tab. The same rule
governs popstate, pop-out "return to main", and the remote-kill fallback — a tab id never lands in
both slots. This one rule closes the strip-click, back/forward, and return-targeting gaps together.

Hardening (session #1): each persisted slot stores `{ tabId, kind }` — numeric ids are recycled by
`nextFreeId`, so a kind mismatch on restore (the id now belongs to a different kind of tab) is
treated as dangling rather than restoring a semantically wrong split. Unparsable or unrecognized
persisted state is discarded and the app starts single-slot (the `tabs.json`/`extra-keys.json`
forgiving posture; no version field — it's a discardable view preference). The ratio persists on
drag SETTLE (pointerup / trailing debounce), never per frame. Two full windows share the key:
last-writer-wins, no cross-window live sync — accepted and documented. Popout windows (`?popout=1`)
neither read nor write `palmux-split`. Deep link vs persisted split: the URL wins — the deep-linked
tab replaces the focused slot's tab (the other slot restores as persisted).

### D5 — One persistent content LAYER; slots are pure geometry (no DOM reparenting, ever)

**(Rewritten in refinement session #1.)** The existing `PaneHost` is a single global keep-alive
overlay (`position:absolute; inset:0`) hosting ALL non-terminal panes — it is NOT per-slot-usable,
and it must not be duplicated per slot (double-mounted iframes/editors) or portaled between slots
(moving an iframe in the DOM RELOADS it; React portal retargeting is a DOM move). Instead:

- The content area keeps ONE persistent layer hosting every live pane AND every mounted
  `TerminalPane`. Nothing in it ever reparents.
- `SplitContainer` renders only chrome — divider, focus border, drop zones — and computes RECTS.
  Each hosted pane/terminal gets its current rect (full area, slot A, slot B, or hidden) applied as
  absolute inset/size on its container. Layout changes are style updates, never DOM moves; iframe,
  editor, terminal, and WebGL state survive every orientation/ratio/focus/collapse change.
- Terminals refit via each pane's existing ResizeObserver (it observes the container, which
  resizes when its rect changes). Divider drag updates rects per rAF; PTY `resize` sends on settle.
  Orientation naming: the split model uses `'row' | 'column'` — the flex-direction of the two rects
  (`row` = side-by-side with a vertical divider = menu "Split right"; `column` = stacked = "Split
  down"). This naming is used everywhere (model, CSS, menus) to avoid the horizontal/vertical
  ambiguity.
  _Alternative rejected:_ flexbox slots owning children directly — forces reparenting on
  single⇄split transitions, which reloads iframes; the rect-driven layer costs a little geometry code
  and buys total state preservation.

### D6 — Drag-and-drop: strip→edge creates, slot→strip collapses

HTML5 drag-and-drop (not pointer math) for desktop robustness:

- Strip tab is `draggable`; on `dragstart` it carries its tab id. The content area shows four
  **edge drop zones** (left/right/top/bottom) while a drag is active; dropping on one opens a split
  with that tab in that position + the current tab in the other slot, orientation from the axis.
- A split slot's header shows the tab as a draggable chip; dragging it onto the **tab strip**
  collapses the split (that tab becomes the lone active tab; the other slot fills the area).
- Touch: HTML5 DnD is unreliable on touch, so mobile uses the explicit menu actions (right-
  click-equivalent long-press → "Split") instead of drag. Drag-to-split is a desktop affordance;
  the menu path is the universal one (satisfies "both" invocation methods without a fragile touch
  DnD polyfill).

### D10 — Split is a desktop-only feature (S1 Q4/Q6)

Split is offered ONLY when the mobile layer is inactive (`!resolveMobileMode(settings.mobileMode)`).
In mobile mode: no split menu items, no drag-to-split, no orientation toggle, split state is forced
to single-slot, and a persisted split is ignored on load. This makes the whole mobile-input-matrix
question moot (the focused-slot-is-a-pane case, iframe click-focus on touch, stacked-vs-side-by-side
degrade) — there is always exactly one slot in mobile mode, so today's routing and gating apply
unchanged. Pop-out (design D7) is a SEPARATE capability and remains available on mobile (it opens a
normal browser tab; the return path may be unavailable there — acceptable).
_Rationale:_ the user runs the mobile layer on phones where two usable slots don't fit; a ~360px
side-by-side split is ~20 columns per terminal. Desktop-only removes the entire cramped-layout and
mobile-focus-routing risk surface at no loss to the stated use case (editor beside a terminal on a
PC).

### D7 — Pop-out is `window.open` on a user gesture; tear-off is drag-release-outside

A web page cannot spawn/position native OS windows mid-drag (that's browser-chrome privilege), so:

- **Explicit action** (universal): "Open in new window" → `window.open('/<id>', 'palmux-<id>',
'popup,width=…,height=…')`. The session URL model makes this free — the popup is a full palmux
  client attached to the same PTY; both windows mirror (multi-attach already works and the
  report-gating already handles a visible-but-unfocused second window).
- **Tear-off approximation** (desktop): during a strip-tab drag, `dragend` outside the viewport
  (screenX/screenY beyond the window bounds, or no drop target) triggers `window.open` positioned
  near the release's screen coordinates (`left/top` from `dragend.screenX/Y`). `dragend` is a user
  gesture, so popup blockers allow it. If the popup is still blocked (aggressive settings), fall
  back to a toast with an "open" button (a second explicit gesture).
- **Popped-out mode**: the popup opens `/<id>?popout=1` — the client hides the strip/drawer chrome
  (single-tab window) and shows a small "⇱ return to main" button. The `popout` flag is captured
  ONCE at boot into state (`switchSession`'s `pushState(pathForSession(id))` drops the query
  string, so it must not be re-read from `location.search`). Popout windows never read or write
  split persistence and hide split/pop-out affordances. Re-invoking pop-out for an already-popped
  tab focuses the existing window (the `palmux-<id>` window name dedupes). NO drag-back-in —
  impossible across OS windows on the web; do not fake it.
- **Return protocol** (see `docs/popout-protocol.md`): the popup sends
  `window.opener.postMessage({ type: 'palmux-popout-return', tabId }, location.origin)` — never
  `'*'`. The main window's listener REQUIRES `event.origin === location.origin` and a valid shape,
  then switches to the tab (no-op if it no longer exists) — an unvalidated listener would let any
  window holding a reference drive session switches in an authenticated terminal app. If
  `window.opener` is null/closed, the return button is disabled with a "main window closed" hint.
- **Popup window features**: default `popup,width=1000,height=640`; tear-off adds
  `left/top = dragend.screenX/Y − half-size`, clamped on-screen. Caveat: `dragend` screen
  coordinates after an outside release are unreliable on some platforms (0,0/stale), and dragend's
  transient-activation status varies by browser — the flow is attempt-first, and the
  blocked/degraded fallback (toast with an explicit open button) is a first-class path, not an
  edge case.
- **Optional stretch**: Document Picture-in-Picture (Chrome desktop) for an always-on-top floating
  pane; feature-detected, never required.
- **Pop out a tab that's in a split** (S1 Q5, "stay + mirror"): the main window KEEPS the split slot
  and the popup mirrors it (subject to the D11 resize policy). Popping out never collapses the
  main window's split. "Return to main" applies Rule R (D4) to decide which slot the tab lands in.
  _Alternative rejected:_ trying to emulate tear-off with a ghost window following the cursor —
  cannot cross the real window boundary; dishonest UX. Chrome-style "leave" (collapse the source
  slot) was rejected in favor of mirror, consistent with palmux's session-is-a-URL model.

### D11 — Mirrored windows resize the PTY smallest-client-wins (S1 Q1)

Two clients attached to one session (the pop-out mirror, or the same session opened twice) currently
fight: each sends its own `resize`, last-writer-wins, so a differently-sized window renders wrapped
garbage indefinitely. Adopt tmux's policy: the server tracks each attached client's last-reported
size per session and applies `min(cols)` × `min(rows)` across all live attaches, recomputing on
attach, detach, and every client resize. Both windows stay readable (the larger letterboxes to the
smaller). This is a real (small) server change — `PtySession` gains per-client size tracking and the
`resize` handler computes the min instead of writing through. The proposal's original "Server: none
required" is amended.
_Alternative rejected:_ latest-wins + broadcasting the authoritative size so the loser letterboxes —
less server work but a worse, asymmetric mirror; smallest-client-wins is the established tmux
behavior users already expect.

### D8 — Two WebGL contexts / two PTYs — bounded and lazy

Each `TerminalPane` loads its own `WebglAddon`; browsers cap WebGL contexts (~16) so two is safe,
and the existing try/catch already falls back to the DOM renderer if a context can't be created.
Two PTYs is just two normal sessions the registry already supports. Both are bounded to two by the
two-slot limit. A non-terminal slot costs nothing extra (no xterm, no socket).

### D9 — App keeps a dedicated CONTROL socket; pane sockets are data-only

**(Added in refinement session #1 — three review agents independently flagged this as the biggest
gap.)** Today the single WsClient is BOTH the terminal data pipe AND the app control channel:
`sessions` broadcasts, `tabCreated` acks, `settings`/`extraKeys`/`fonts`/`ready(webApps,
maxUploadBytes)` all arrive on it, and all control sends (`createTab`, `kill`, `updateTab`,
settings sync) go out on it. Moving it wholly into `TerminalPane` breaks two layouts: a pane-only
view (editor+web split, or a lone dashboard) would have ZERO sockets — no tab list, no settings
sync, no way to create tabs — and a terminal+terminal split would have TWO sockets both applying
`setTabs`/`applySettings`/`tabCreated` auto-switch with racing refs.

Decision: **App owns one always-on control WsClient; TerminalPanes own per-session data sockets.**

- New (small, additive) server support: `/ws?control=1` attaches WITHOUT binding to any tab — the
  metadata-only handshake (`ready`, `settings`, `extraKeys`, `fonts`, `sessions`) plus broadcast
  membership, no PTY, no snapshot. (The metadata-only path already exists for non-terminal tabs;
  this exposes it without needing a tab id.) The proposal's "Server: none required" is amended.
- App processes app-level messages ONLY from the control socket and sends all control messages on
  it. `TerminalPane` sockets consume `ready`(size)/`snapshot`/binary/`exit` and send only
  binary input + `resize`; they ignore broadcast frames (which the server still sends to every
  socket — harmless).
- Reconnect/backoff for control and data sockets stay independent (`WsClient` per instance,
  as today).
  _Alternative rejected:_ nominating one pane's socket as control with handover on unmount —
  stateful, racy during tab switches, and still leaves the zero-terminal layout socketless.

## Risks / Trade-offs

- [The refactor breaks the delicate replay/keyboard/report-gating code] → Extract `TerminalPane`
  with single-slot behavior FIRST, pin it with new unit tests + manual live verification (no
  committed e2e suite exists — "e2e" here means driving a browser against an isolated backend),
  and only THEN enable the second slot. Report-gating semantics are deliberately UNCHANGED (D2);
  a test pins that an unfocused slot still answers its own PTY's queries and that replay
  suppression forwards no terminal-generated bytes to the PTY.
- [Two WINDOWS on one session both answer DA/DSR] → already handled by the per-document
  `hasFocus()` gate each pane carries (D2); pinned by a cross-window scenario in window-pop-out.
- [Mobile split too cramped] → desktop-first; mobile defaults to stacked 50/50 and degrades to
  single-slot with a toast rather than shipping an unusable 2-line-each layout silently.
- [Touch drag-and-drop is flaky] → don't rely on it; menu actions are the cross-platform path,
  drag is a desktop enhancement (D6).
- [Divider drag thrashes PTY resize] → debounce the fit/resize on drag (rAF) like the existing
  viewport handler; only send `resize` on settle.
- [Lost pane state on layout change] → slots keyed by tab id, panes never remount on
  orientation/ratio/focus change (D5).

## Migration Plan

Ship in stages within one change: (1) extract `TerminalPane`, single-slot only, prove regression-
free; (2) add `useSplit` + `SplitContainer` + menu invocation + divider + persistence; (3) add
drag-and-drop (desktop) + mobile stacked default. Each stage is independently testable. No data
migration; `palmux-split` appears on first split. Rollback = previous build (ignores the localStorage
key).

## Open Questions

All six session-1 questions are RESOLVED (see `refinement-log.md` S1 and `questions-session1.md`):
Q1 smallest-client-wins resize (D11), Q2 Rule R strip-selection (D4), Q3 self-split spawns a new
terminal + NO default keyboard shortcut (configurable only, D-Non-Goals), Q4/Q6 split is desktop-
only (D10), Q5 pop-out stays + mirrors (D7). Closing the focused slot's tab collapses to the
survivor (decided). Document Picture-in-Picture is deferred out of scope. No open questions remain.
