# split-layout

The two-slot layout: orientation, the resizable divider, focus, slot↔tab binding, single ⇄ split
transitions, and per-device persistence.

## ADDED Requirements

### Requirement: Split is a desktop-only feature

Split SHALL be available only while the mobile layer is inactive
(`!resolveMobileMode(settings.mobileMode)`). In mobile mode the client SHALL offer no split
invocation (no menu items, no drag-to-split, no orientation toggle), SHALL force the layout to a
single slot, and SHALL ignore any persisted split. (Pop-out is a separate capability and remains
available on mobile.)

#### Scenario: No split affordances on mobile

- **WHEN** the mobile layer is active
- **THEN** no split menu item, drag target, or orientation toggle is present and the content area
  shows a single slot

#### Scenario: Persisted split ignored in mobile mode

- **WHEN** a device has a persisted split but the mobile layer is active
- **THEN** the app opens single-slot and does not restore the split

### Requirement: The content area shows one or two slots

On desktop the content area SHALL show either a single tab (default) or two tabs in two slots. Any
tab kind MAY occupy either slot, in any pairing — including terminal + terminal, terminal + pane,
and pane + pane. A given tab id SHALL appear in at most one slot.

#### Scenario: Editor beside a terminal

- **WHEN** the user splits an editor tab against a terminal tab
- **THEN** both render simultaneously, each in its own slot, both interactive

#### Scenario: Two terminals side by side

- **WHEN** the user splits two terminal tabs
- **THEN** both terminals are live and independently usable

### Requirement: Split orientation is horizontal or vertical

A split SHALL support a side-by-side (vertical divider) and a stacked (horizontal divider)
orientation, switchable without remounting either pane (no lost terminal/editor/iframe state).

#### Scenario: Toggle orientation preserves state

- **WHEN** the user switches a side-by-side split to stacked
- **THEN** the layout reflows and neither pane reloads or loses its content/scroll/cursor

### Requirement: A draggable divider rebalances the split

A divider between the slots SHALL be draggable to change each slot's fraction, clamped to
0.15–0.85. Slot rects update per animation frame during the drag; a terminal slot's PTY `resize`
SHALL be sent on drag settle (pointer release / trailing debounce), not per frame, and the
persisted ratio SHALL likewise be written on settle only.

#### Scenario: Dragging the divider resizes both

- **WHEN** the user drags the divider toward one edge
- **THEN** the slots resize accordingly and, on release, a terminal slot's shell reflows to the
  new column count

#### Scenario: Clamp

- **WHEN** the user drags the divider past the 15% mark of the container
- **THEN** the ratio stops at the clamp; neither slot can be made smaller than 15%

### Requirement: Exactly one slot is focused; focus is visible

When split, exactly one slot SHALL be focused, indicated visually (e.g. an accent border). In
single-slot mode the sole slot IS the focused slot (so gating and routing rules degenerate to
today's behavior). Clicking or tapping a slot SHALL focus it. The focused slot's tab id SHALL
drive the URL path so deep links still work; focus changes SHALL use `replaceState` (never
`pushState`) so flipping focus does not pollute browser history.

#### Scenario: Focus indicator and URL

- **WHEN** the user clicks slot B
- **THEN** slot B shows the focus indicator and the URL path reflects slot B's tab id without
  adding a history entry

#### Scenario: Single-slot mode is implicitly focused

- **WHEN** no split is active and a terminal tab is shown
- **THEN** all focused-slot routing (keyboard, extra-keys, clipboard, upload) targets it, exactly
  as before this change

### Requirement: Split layout persists per device

The split (each slot as `{ tabId, kind }`, orientation, divider ratio, focused slot) SHALL persist
to localStorage (`palmux-split`) per device (not synced), restored on reload. A slot whose tab no
longer exists OR whose current kind differs from the persisted kind (numeric ids are recycled)
SHALL be treated as dangling: collapse to the surviving slot, or to single-slot if neither remains
— never error. Unparsable or unrecognized persisted state SHALL be discarded (start single-slot).
Two full windows sharing the key are last-writer-wins with no live sync; popout windows neither
read nor write it. On a deep link, the URL wins: the linked tab replaces the focused slot's tab.

#### Scenario: Restored on reload

- **WHEN** the user reloads with a persisted side-by-side split
- **THEN** the same two tabs reappear split in the same orientation and ratio

#### Scenario: Dangling tab collapses gracefully

- **WHEN** a persisted split references a tab that was closed before reload
- **THEN** the layout opens as a single slot showing the surviving tab, with no error

#### Scenario: Recycled id is dangling, not wrong

- **WHEN** a persisted slot recorded `{ tabId: '3', kind: 'editor' }` but tab 3 is now a terminal
- **THEN** that slot is treated as dangling (no semantically wrong restore)

#### Scenario: Both tabs gone

- **WHEN** neither persisted tab id exists anymore
- **THEN** the app opens single-slot on the default tab with no error

#### Scenario: Corrupt persisted state

- **WHEN** `palmux-split` contains unparsable JSON
- **THEN** the key is discarded and the app opens single-slot

### Requirement: The strip and focus obey Rule R while split

While split, clicking a strip tab that is already shown in the OTHER slot SHALL focus that slot;
clicking any other strip tab SHALL replace the FOCUSED slot's tab. The same rule SHALL govern
popstate (back/forward) and the remote-kill fallback: a target tab already in a slot focuses that
slot, otherwise it replaces the focused slot's tab — a tab id never occupies both slots.

#### Scenario: Click a tab that's in the other slot

- **WHEN** the user clicks a strip tab that is currently shown in the unfocused slot
- **THEN** focus moves to that slot; no tab is duplicated or replaced

#### Scenario: Click an unsplit tab

- **WHEN** the user clicks a strip tab not shown in either slot
- **THEN** it replaces the focused slot's tab

#### Scenario: Back/forward applies the same rule

- **WHEN** popstate lands on a tab already shown in the other slot
- **THEN** that slot is focused rather than the tab being duplicated

### Requirement: A pane-header control toggles orientation and closes the split

While split, a control (⇔ in a pane/slot header) SHALL toggle the split orientation and offer to
close the split; closing collapses to the surviving slot (which one is defined by the control).

#### Scenario: Toggle orientation from the header

- **WHEN** the user activates the header's orientation toggle
- **THEN** the split switches between side-by-side and stacked without remounting either pane

#### Scenario: Close from the header

- **WHEN** the user activates the header's close-split control
- **THEN** the split collapses to a single slot

### Requirement: New-tab while split lands in the focused slot

Creating a tab (the `+` chooser) while split SHALL open it in the FOCUSED slot, leaving the other
slot unchanged; the chooser overlay covers the content area and Escape restores the split intact.

#### Scenario: New tab lands in the focused slot

- **WHEN** the user is split and creates a new tab
- **THEN** the new tab opens in the focused slot and the other slot is unchanged

#### Scenario: Chooser dismiss restores the split

- **WHEN** the user opens the new-tab chooser while split and presses Escape
- **THEN** the split is shown again unchanged

### Requirement: Closing a split tab collapses to the survivor

Closing (or losing) the tab in one slot while split SHALL collapse the layout to the other slot as a
single tab, rather than leaving an empty slot.

#### Scenario: Close one side

- **WHEN** the user closes the tab shown in slot A of a split
- **THEN** slot B's tab becomes the single active tab filling the content area
