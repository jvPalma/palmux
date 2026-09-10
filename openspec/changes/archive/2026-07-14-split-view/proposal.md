# Split view — two tabs side by side

## Why

palmux shows exactly one tab at a time. The natural PC (and sometimes mobile) workflow is to see
two at once — most obviously an **editor file next to its terminal session**, but also a terminal
beside a web dashboard, two editors, two shells, etc. VSCode's split editor is the mental model.
Doing this well requires lifting a single-instance assumption baked deep into the terminal code.

## What Changes

- **A split layout with two slots.** The content area can show one tab (today) or two tabs in two
  slots, split **horizontally or vertically**, with a **draggable divider** to rebalance. Any tab
  kind can occupy either slot, in any pairing — including **terminal + terminal**.
- **BREAKING (internal): the terminal is de-singletonized.** Today `App.tsx` owns one xterm and one
  `WsClient` and wires the mobile keyboard / extra-keys / gestures / upload directly to it. That
  becomes a self-contained **`TerminalPane`** component that owns its own xterm, socket, replay
  suppression, resize, and DA/DSR report-gating. App renders one or two of them. This is a pure
  refactor for the single-slot case (behavior identical) but is the enabling change for two live
  terminals.
- **Focus model.** Exactly one slot is "focused" at a time (a subtle border). The mobile soft
  keyboard, the extra-keys bar, Ctrl+Shift+C/V, and file upload all target the **focused** slot.
  Clicking/tapping a slot focuses it.
- **Two ways to open a split:** (a) right-click a tab → "Split right / Split down" (and a ⇔ button
  in a pane header), and (b) **drag a tab from the strip to the left/right/top/bottom edge** of the
  content area to drop it into a new split in that position.
- **Drag a split tab back to the strip** to collapse the split (the dragged tab returns to being a
  normal single tab; the other slot takes the whole area).
- **Layout persists** per browser (localStorage): which two tab ids are split, the orientation, and
  the divider ratio, restored on reload. The split references tab ids; if a referenced tab is gone,
  the split collapses gracefully.
- **Mobile:** split is a **desktop-only** feature (refinement S1 Q4/Q6) — while the mobile layer is
  active there is no split invocation and the content area is always a single slot. This keeps the
  soft keyboard / extra-keys / gesture surfaces exactly as today. Pop-out remains available on
  mobile (a separate capability).
- **Pop-out to a separate browser window.** Since a session is a URL backed by a server-side PTY,
  a second window on the same session already mirrors it live (like `tmux attach` twice). Build on
  that: (a) an **"Open in new window"** action (tab menu / pane header ⧉) opens `/<id>` as a
  detached popup; (b) on desktop, **dragging a tab and releasing it outside the browser window**
  pops that tab out near the release point — the achievable approximation of Chrome's tear-off
  (a web page cannot spawn true native windows mid-drag; `window.open` on the drag-release gesture
  is the honest mechanism). **No drag-back-in** — the web cannot drag content between OS windows;
  the popped window gets an explicit "return to main" affordance instead (and closing it loses
  nothing, the session lives on the server).
- **NOT changing:** the wire protocol (a second terminal is just a second `/ws` attach), auth,
  upload endpoints, the tab registry, tmux-inside-a-shell.

## Capabilities

### New Capabilities

- `terminal-pane`: extract the single-terminal wiring (xterm + per-session `WsClient` + replay
  suppression + report-gating + resize/fit) into an instance component so N can coexist; the mobile
  input layer targets the focused instance. The enabling refactor.
- `split-layout`: the two-slot layout model — orientation (horizontal/vertical), the resizable
  divider, focus, slot↔tab binding, and single-slot ⇄ split transitions; localStorage persistence.
- `split-dnd`: drag-and-drop to form and dissolve splits — dragging a strip tab to a content edge
  opens a split there; dragging a split slot's tab back to the strip collapses the split.
- `window-pop-out`: open a tab as a separate browser window — explicit "Open in new window" action
  everywhere, drag-release-outside-the-window tear-off on desktop, a "return to main" affordance in
  the popped window. (Document Picture-in-Picture is explicitly deferred out of this change.)

### Modified Capabilities

_(none — no existing OpenSpec specs; `chrome-tabs-and-panes` is a separate, already-applied change)_

## Impact

- **Client (bulk of the work):**
  - New `terminal/TerminalPane.tsx` absorbing today's `App.tsx` terminal effect, `useTerminal`
    host, the per-session socket lifecycle, replay/`suppressInput`/`hasFocus` gating, resize, and
    the Ctrl+Shift+C/V + drag-drop-upload handlers.
  - `App.tsx` shrinks to: tab/split STATE, the strip/drawer, panels, and a `SplitContainer` that
    renders one or two slots (`TerminalPane` or `PaneHost` per slot). The mobile keyboard /
    extra-keys / gestures bind to a **focused-pane registry** (a ref-based context) instead of a
    single terminal.
  - New `session/SplitContainer.tsx` (slots + divider + orientation), `session/useSplit.ts` (split
    state + persistence), drag-and-drop handlers on `SessionTabs` + content edges, `index.css`.
- **Server (small, additive):** a second terminal is a second `/ws?session=<id>` attach the
  registry already supports, plus two additions from refinement: (a) a control-only WS attach
  (`/ws?control=1`) so the app keeps its tab-list/settings/control channel when no terminal is
  mounted (design D9); (b) **smallest-client-wins** PTY resize for multiple clients on ONE session
  (the pop-out mirror) — `min(cols)`×`min(rows)` across attaches, replacing last-writer-wins so
  differently-sized windows both stay readable (design D11, S1 Q1). Report-gating is deliberately
  unchanged (design D2): each pane carries the existing per-document `hasFocus()` gate.
- **Also touched (surfaced in refinement, absent from the original list):** `panes/PaneHost.tsx`
  (becomes the rect-driven persistent layer, design D5), `terminal/useTerminal.ts` (the
  window-level Ctrl+Shift+C/V capture listener must be hoisted/focus-routed), `terminal/
useFileUpload.ts` (document-level paste listener + per-pane picker routing), `mobile/
useMobileGestures.ts` + `terminal/touch.ts` (per-pane instantiation; module-level `lastSelection`
  becomes instance-scoped), and the App visualViewport selection-restore effect (tracks the focused
  pane's instance).
- **Risks:** the terminal refactor touches the most delicate, multi-session-hardened code
  (replay-junk suppression, mobile IME, report-gating). Mitigated by extracting first with the
  single-slot behavior pinned by tests + e2e BEFORE enabling the second slot. Two WebGL contexts +
  two PTYs raise resource use — bounded to two, desktop-first.
