# split-fusion Specification

## Purpose

Split pairings as first-class strip citizens: each pairing renders as ONE fused two-segment strip
button at the anchor's position, any number of pairings coexist per device, and the fuse/unfuse
lifecycle (adjacency reorder, group-membership adoption, eject, slot replacement, pair drag) keeps
the server fusion-ignorant.

## Requirements
### Requirement: A pairing renders as one fused strip button

A split pairing SHALL render in the strip as a single fused button at the anchor tab's position,
replacing both members' individual buttons (the partner has no separate strip presence). The fused
button SHALL contain two clickable segments in slot order — each `min-width: 90px` (≥180px total),
each showing its tab's icon + title with the tab's own accent per the flat strip language. The
fused button SHALL be active whenever the active tab id is EITHER member; while active, the
FOCUSED slot's segment renders solid (flipped ink) and the other segment renders dimmed
(mid-strength tint); while inactive, both segments render as 8% tints. Clicking a segment SHALL
activate the pairing (if not active) and focus that segment's slot; focus changes SHALL update the
URL per the focused-slot rule in `split-layout` (replaceState). Grouped pairings render inside
their group's span with the group's bottom line under the fused button.

#### Scenario: Fused button replaces two tabs

- **WHEN** tabs `t0` and `t1` fuse while the strip is `[t0, t1, t2]`
- **THEN** the strip renders `[t0⧉t1, t2]` — two entries, the first a fused button with a `t0`
  segment and a `t1` segment

#### Scenario: Segments show focus

- **WHEN** the pairing is active and slot A is focused
- **THEN** the `t0` segment is solid with flipped ink and the `t1` segment is dimmed; clicking the
  `t1` segment makes it solid and focuses pane B without a history push

#### Scenario: Clicking an inactive fused button re-tiles its split

- **WHEN** the active tab is `t2` and the user clicks a segment of the inactive `t0⧉t1` button
- **THEN** the pairing re-tiles in its stored orientation/ratio with the clicked segment's slot
  focused

#### Scenario: Deep link to a partner

- **WHEN** the browser navigates directly to the partner member's id (URL or back/forward)
- **THEN** the pairing shows with the partner's slot focused (the fused button is active; the
  partner is never rendered as a separate strip tab)

### Requirement: Fusing reorders the partner adjacent and adopts membership

Creating a pairing SHALL (in order): make the partner adopt the anchor's group membership if they
differ (one `groupUpdate` — join the anchor's group or leave the partner's own); reorder the
partner to sit immediately after the anchor (one `reorderTabs`); then record the pairing locally.
The server SHALL receive only these existing messages — it has no knowledge of pairings. Unfusing
SHALL send nothing (members are already adjacent and correctly grouped).

#### Scenario: Fuse across groups adopts the anchor's membership

- **WHEN** the active tab `t0` is ungrouped and grouped tab `gA1` is dropped into its split zone
- **THEN** `gA1` leaves group A (`groupUpdate`), moves adjacent to `t0` (`reorderTabs`), and the
  fused button renders outside group A

#### Scenario: Fuse into a group joins it

- **WHEN** the active tab is a member of group A and an ungrouped tab is dropped into its split
  zone
- **THEN** the dragged tab joins group A and the fused button renders inside the group's span
  under its line

#### Scenario: Server sees only plain messages

- **WHEN** any fuse or unfuse happens
- **THEN** the wire traffic is limited to existing `reorderTabs`/`groupUpdate` messages and other
  clients render normal (unfused) adjacent tabs

### Requirement: Multiple pairings coexist

The client SHALL support any number of simultaneous pairings (each tab in at most one); only the
ACTIVE pairing (fused button active) renders its split — every other pairing stays a fused button whose panes are
not mounted in the content area. Creating a new pairing SHALL NOT modify any existing pairing.
Switching the active tab between fused buttons switches which split is on screen, preserving each
pairing's orientation, ratio, and focus.

#### Scenario: Second split leaves the first intact

- **WHEN** `t0⧉t1` exists and the user (active on `tA0`) drags `tA1` into the split zone
- **THEN** `tA0⧉tA1` is created and active, and `t0⧉t1` remains fused in the strip, unchanged

#### Scenario: Switching between pairings

- **WHEN** two pairings exist and the user clicks the other fused button
- **THEN** the content area swaps to that pairing's split (its stored orientation/ratio/focus) and
  the first pairing's fused button renders inactive

### Requirement: The fused button drags as one unit

Dragging a fused button SHALL move BOTH members together: a strip reorder keeps them adjacent in
slot order (one `reorderTabs`); dropping into a group span or onto a member's center moves both
into that group (one `groupUpdate` with both ids). A fused button drag SHALL NOT activate the
content-area split/slot drop zones, and a single tab dragged ONTO a fused button's strip position
reorders around it (never inserts between the members).

#### Scenario: Reorder the pair

- **WHEN** the fused `t0⧉t1` button is dragged past `t2`
- **THEN** the order becomes `[t2, t0, t1]` — members adjacent, slot order preserved

#### Scenario: Pair joins a group by drag

- **WHEN** the fused button is dropped onto the span of group A
- **THEN** both members join group A at the drop position and the fused button renders under
  group A's line

### Requirement: Mobile lists members individually

The mobile drawer SHALL NOT render fused rows: pairing members appear as ordinary individual rows
(pairings are desktop per-device state and the mobile layer forces single-pane, per
`split-layout`). Pairing state SHALL survive a mobile-mode round trip on the same device exactly
as persisted state.

#### Scenario: Drawer shows two rows

- **WHEN** `t0⧉t1` is fused on desktop and the same device enters mobile mode
- **THEN** the drawer lists `t0` and `t1` as separate rows; leaving mobile mode restores the fused
  button and pairing
