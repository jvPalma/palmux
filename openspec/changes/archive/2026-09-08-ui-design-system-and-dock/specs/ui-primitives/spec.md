## ADDED Requirements

### Requirement: A shared component kit derived from theme tokens

palmux SHALL provide a component kit under `client/src/ui/` covering at minimum Button, IconButton,
Input, Switch, Segmented, Collapsible, Tooltip and Dialog. Every visual property of every component
SHALL be expressed in terms of the existing `--t-*` UI tokens (base, mantle, surface, text, subtext,
accent, accent-alt, accent-ink) and MUST NOT hard-code any color literal. Behaviour, focus management
and ARIA SHALL come from Radix headless primitives; the kit SHALL NOT introduce Tailwind, PostCSS, or
any shadcn/ui-derived styling layer, because a second token vocabulary would have to be kept obedient
to the first.

#### Scenario: A theme change repaints every control

- **WHEN** the user switches from a dark profile to a light one
- **THEN** every kit component repaints from the new tokens with no reload and no component-level
  color override

#### Scenario: No color literals in the kit

- **WHEN** the kit's stylesheet is inspected
- **THEN** it contains no hex, `rgb()` or named-color literal outside of `color-mix()` compositions of
  `--t-*` tokens

### Requirement: Surfaces carry three depth levels

Kit surfaces SHALL express depth with three background levels — crust (recessed), mantle (default) and
surface (raised) — plus a 1px border in `--t-surface`. A drop shadow SHALL be used only on surfaces
that genuinely float above the page (dialog, popover, toast) and MUST NOT be applied to inline
controls or panel rows.

#### Scenario: An inline control has no shadow

- **WHEN** a Button or Switch is rendered inside a panel row
- **THEN** it has a border and a background level but no box-shadow

### Requirement: Motion follows four tiers and never enters the terminal

Animated surfaces SHALL use exactly one of four tiers: **0ms** for keyboard-driven state (tab switch,
pane focus), **140ms ease** for micro feedback (hover, switch, button press), **240ms
cubic-bezier(.2,.9,.3,1)** for surfaces entering or leaving (dock, drawer, toast, popover, collapse),
and **380ms with a 40ms per-item stagger** for lists appearing for the first time. Exit transitions
SHALL be shorter than their matching entrances. No CSS transition or animation SHALL be applied to any
element inside the terminal grid, because xterm renders it on a WebGL canvas where compositing work
costs frames that are visible as input latency. All motion SHALL be suppressed under
`prefers-reduced-motion: reduce`.

#### Scenario: Tab switching is instant

- **WHEN** the user switches tabs with the keyboard
- **THEN** the new tab's content appears with no transition

#### Scenario: A re-render does not replay an entrance

- **WHEN** a list that has already appeared re-renders because its data changed
- **THEN** no stagger animation runs

#### Scenario: Reduced motion

- **WHEN** the OS reports `prefers-reduced-motion: reduce`
- **THEN** every kit transition and animation is reduced to an imperceptible duration and no entrance
  animation plays

### Requirement: Collapsible sections animate without measuring in JavaScript

A Collapsible SHALL animate its height with `grid-template-rows: 0fr → 1fr` rather than a measured
pixel height, so content of unknown size expands correctly without a layout read. Its open/closed
state SHALL persist per device.

#### Scenario: A section with dynamic content expands fully

- **WHEN** a collapsed section containing a list that grew since it was last opened is expanded
- **THEN** it animates open to the full current content height with no clipping and no JS measurement

#### Scenario: Collapse state survives a reload

- **WHEN** the user collapses a section and reloads the app on the same device
- **THEN** the section is still collapsed, and a different device is unaffected
