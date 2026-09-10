## Context

palmux's chrome is hand-written CSS over a token layer that already works: `deriveUiTokens(profile)`
emits seven `--t-*` vars plus sixteen `--tab-c-ansi*` slots, applied pre-paint in `main.tsx` and again
on theme change, so the whole app follows the terminal palette. What does not exist is a component
layer — every button, switch and input is styled at its call site, so surfaces drift and keyboard/ARIA
behaviour is inconsistent.

Separately, three surfaces are modals (Settings, the `+` chooser, dictation history). A modal covers
the terminal, which is precisely what the user is reading while using them.

Constraints that shape every decision below:

- **The terminal is a WebGL canvas.** Anything that changes the content area's width triggers a fit and
  a PTY resize; anything that composites over the grid costs frames the user feels as input latency.
- **Per-device vs synced settings is already load-bearing.** `settings.json` is tracked by a dotfiles
  manager, and `settings.local.json` exists because a per-machine value in a synced file makes every
  pull a conflict.
- **Mobile is not a smaller desktop.** The owner rejected a bottom tab strip and a bottom sheet: the
  terminal must be full-screen at all times, and the drawer stays on the right because the swipe
  gesture already trains it.
- **The bundle is 901 KB / 264 KB gzipped** before Monaco's lazy 3.6 MB chunk.

## Goals / Non-Goals

**Goals:**

- One component kit whose entire visual surface is a function of `--t-*`, so a theme change repaints it
  with no per-component work.
- Modal-free app surfaces: a dock that takes width instead of covering the terminal.
- A tab strip that reads as Chrome's, including for groups and fused split pairings.
- A file browser with a Read / Edit toggle over one path, reusing the existing markdown and Monaco panes.
- A motion contract narrow enough that "should this animate?" has an answer without a meeting.

**Non-Goals:**

- Tailwind, PostCSS, or shadcn/ui in any form.
- Re-theming the terminal canvas itself — `useTerminal` already owns that and is out of scope.
- Changing the extra-keys layout, gestures, or the mobile drawer's position/trigger.
- A Figma library or exported design tokens. The tokens live in code and that is where they stay.
- Animating anything inside the terminal grid.

## Decisions

### D1 — Radix headless primitives, not shadcn/ui

shadcn is Radix already dressed in Tailwind and copied into the repo. Adopting it means adopting
Tailwind's colour vocabulary (`bg-background`, `text-muted-foreground`) and then teaching it to resolve
to `--t-*` through `tailwind.config`. That is a second source of colour truth with a translation layer
between them, and the failure mode is silent drift: new components correct in one system, everything
else in the other.

*Alternatives considered.* (a) Full shadcn + migrate the entire app to Tailwind — coherent, but weeks of
work for no functional gain and it discards a token system that already works. (b) Hand-roll everything
including focus trapping and roving tabindex — that is the part Radix is genuinely good at, and getting
dialog focus management wrong is a real accessibility regression. (c) Radix + our CSS — chosen.

*Consequence.* Day-one velocity is worse: each component needs its CSS written. Long-run consistency is
better because there is exactly one place colour is decided.

### D2 — The dock is layout, not an overlay

The dock is a flex sibling of the content area, so opening it narrows the terminal. This is the whole
point (a modal covers what you are reading) and it is also the main risk: the content area's width
feeds `SplitView`'s rect geometry, which feeds `fit()`, which resizes the PTY.

The resize is therefore coalesced with the same mechanism the split divider already uses: pane rects
update visually during the transition while the PTY resize is issued once on settle. Reusing
`resizePaused` rather than inventing a second deferral keeps one code path for "the content area is
mid-animation".

*Alternative considered.* An overlay dock that floats above the terminal needs no refit at all, and was
rejected because it reintroduces exactly the covering behaviour this change exists to remove.

### D3 — `sidebarRail` is per-device, and that is a hard rule

`always` on a desktop and `hidden` on a phone are both correct; a synced value is wrong on one of them.
It joins the per-device set alongside `fontSize` and `mobileMode`. Note the split now happens in two
places for two different reasons — the client withholds `fontSize`/`mobileMode` from the wire entirely,
while `themeId` travels on the wire and is split at the persistence boundary because the server needs it
at boot. `sidebarRail` needs neither the wire nor the server, so it takes the client-side route.

### D4 — Tab shape is CSS-only

Chrome-like tabs change `.ctab`, `.ctab.fused` and the group chip rules and nothing else. No component,
no state, no protocol. This is deliberate sequencing: it is the most visible improvement in the change
and the least risky, so it ships early and independently of the dock.

The one non-obvious part is that the active tab must share the content area's background to read as
joined — which couples the strip to the content area's colour. That coupling is acceptable because both
derive from the same token.

### D5 — Read / Edit is a toggle over one pane, not two tab kinds

`markdown` and `editor` already exist as separate tab kinds. Making the file browser open one or the
other would mean the user's "open this file" produces a tab whose kind they did not choose and cannot
change. Instead the pane holds a path and a mode, reusing `MarkdownPane` and `EditorPane` as its two
renderers. Unsaved editor state lives in the pane, so toggling cannot lose it.

*Alternative considered.* Reuse the existing kinds and add a "convert this tab" action — rejected as a
worse expression of the same thing, since the tab's identity is the file, not the renderer.

### D6 — The recording toast is bottom-centre on both breakpoints

Chosen by the owner after the trade-off was stated: on a phone, bottom-centre is where the prompt line
usually is. The mitigation is compaction in place after a delay, not relocation — a control that moves
between breakpoints is harder to build muscle memory for than one that shrinks.

The waveform is driven by real input level rather than a decorative loop, because a dead microphone
that animates is worse than no indicator: it actively asserts that recording is working.

### D7 — Collapsible height via `grid-template-rows`

`0fr → 1fr` animates to intrinsic content height with no JS measurement and no hardcoded max-height.
The alternative — measuring `scrollHeight` and animating `max-height` — breaks whenever content changes
while collapsed, which is exactly what a tmux session list does.

### D8 — Motion tiers are a contract, not a suggestion

Four durations, two curves, and one prohibition (nothing inside the terminal grid). The prohibition is
the load-bearing part: a CSS transition composited over a WebGL canvas costs frames where latency is
most visible, and "it looked nice in the mock" is not worth input lag in a terminal.

## Risks / Trade-offs

- **Dock toggle storms every attached shell with SIGWINCH** → reuse `resizePaused`; assert in a test
  that one dock toggle produces at most one PTY resize per pane.
- **`sidebarRail` leaks into the synced settings file** → it must not enter `SYNCED_KEYS`; add a test
  asserting a rail change leaves the synced file byte-identical.
- **Moving `+` into the dock breaks the last-tab path** → `chooserPage` deliberately mounts no pane so a
  closed id cannot respawn. That branch stays as a page; only the popover case becomes a dock view.
- **Radix adds packages to an already-large bundle** → import per-primitive (they are separate packages
  and tree-shakeable), and record before/after gzip size in the tasks rather than assuming.
- **Chrome-like tabs must not break groups or fused pairings** → both are rendered by the same strip
  code; the spec carries a scenario for each, and they are the first thing to check visually.
- **A wider CSS surface means more places for an xterm-6-style collision** → the existing
  `xterm-css-contract` test already forbids palmux rules that position xterm-owned elements; extend it
  if the dock introduces new overlap.
- **Day-one velocity is worse than shadcn** → accepted, see D1.

## Migration Plan

Phased, each phase independently shippable and independently revertable:

1. **Kit** (`client/src/ui/`) — additive, nothing migrated. No user-visible change.
2. **Tabs** — CSS-only, no dependency on phase 1.
3. **Dock shell** + `sidebarRail` — the risky one; lands with the resize discipline and its test.
4. **Settings → dock view** — `SettingsFields` is already host-agnostic, so this is mostly wiring.
5. **New tab → dock view** + collapsible sections.
6. **Dictation view + recording toast.**
7. **`config.json` Raw / Form.**
8. **Files** — the only phase with a new server route.
9. **Mobile drawer segmented** + extra-keys token conformance.

Rollback is per phase: 1–2 are additive or CSS-only; 3 onwards each keep the previous surface reachable
until the phase's own tests pass.

## Open Questions

- Does the dock need a resizable edge in the first pass, or is a fixed width acceptable until the
  layout proves itself? A drag handle multiplies the refit path's exposure.
- Which directory does the file tree root at by default — the active terminal's cwd, the configured
  `markdownRoots`, or the home directory? The cwd is the most useful and the most surprising, since it
  changes under the user.
- Should the dock's active view be shared across split panes, or per pane? Per pane is more powerful and
  significantly more state.
