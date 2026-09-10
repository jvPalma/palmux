# tab-grouping Specification

## Purpose

Chrome-like tab grouping: server-authoritative, contiguous, persisted groups (per-tab groupId + a groups.json sidecar) rendered as chips and clusters with an independent color/name channel, per-device collapse with safe activation, and drag gestures that compose grouping with reorder/split.

## Requirements

### Requirement: Groups are shared, persisted, and contiguous

A tab group SHALL be `{ id, name?, color }` with each tab belonging to at most one group; a group's member tabs SHALL always be contiguous in the strip order (the server normalizes any request that would fragment one). A group of ONE member is valid; only a group with ZERO members is removed. Groups and per-tab membership SHALL be server-authoritative, persisted across restarts (per-tab `groupId` in `tabs.json`, group name/color in a sidecar `groups.json`), and synced to all clients via the `sessions` broadcast. Group `color` is optional on creation; when omitted the server SHALL assign a palette default so every chip has a color.

#### Scenario: Grouping pulls members together

- **WHEN** the strip is `[t0, t1, t2, t3]` and t0 + t3 are grouped
- **THEN** the members become adjacent (e.g. `[t0, t3, t1, t2]`) under one group

#### Scenario: A group of one is valid

- **WHEN** a group is created from a single tab, or a two-member group loses one member
- **THEN** the one-member group persists and renders (chip + its member); it is NOT auto-dissolved

#### Scenario: An emptied group vanishes

- **WHEN** the last member of a group is killed or removed from it
- **THEN** the group no longer exists anywhere (broadcast + persistence)

#### Scenario: Groups survive a restart and sync across clients

- **WHEN** a named, colored group exists and the server restarts (or a second client connects)
- **THEN** the group returns with its name, color, members, and position

#### Scenario: Old server / rollback safety

- **WHEN** a server WITHOUT grouping loads a `tabs.json` that carries per-tab `groupId`
- **THEN** it ignores the `groupId` field and the sidecar `groups.json`, loading tabs unchanged

### Requirement: Group operations over the wire are forgiving

Clients SHALL create a group from a tab, rename/recolor it, move tabs in/out (with position), and dissolve it via protocol messages; the server SHALL validate every operation against live state (unknown tab/group ids ignored, never losing or duplicating a tab or group) and rebroadcast. A tab moved into a group SHALL leave any prior group (at most one group per tab); two conflicting operations resolve last-writer-wins. Old servers ignore the messages; old clients ignore the new fields.

#### Scenario: Create from a single tab

- **WHEN** a client sends create-group for `[t1]` with a name and color
- **THEN** the broadcast carries the new group (id assigned) and t1's membership

#### Scenario: Joining steals from a prior group

- **WHEN** t2 is in group G1 and a client adds t2 to group G2
- **THEN** t2 belongs only to G2 afterward, and G1 dissolves if t2 was its last member

#### Scenario: Malformed operations are inert

- **WHEN** a group operation references unknown tabs, an empty id set, or a deleted group
- **THEN** the known parts apply (or nothing does) and the tab list is never corrupted

### Requirement: The strip renders groups as chips + clusters

On desktop, each group SHALL render a GROUP BUTTON — styled like a tab: flat, squared, full strip
height, `min-width: 120px` — immediately before its first member, showing the group's name (or a
compact dot when unnamed) in the group color. A 3px bottom line in the group color SHALL run
continuously under the group button AND every member tab. The group button SHALL render ACTIVE
(solid group-color fill, luminance-flipped ink) whenever the active tab is one of its members, and
as an 8% group-color tint otherwise. A member tab SHALL ALSO keep its own name and color accent
(the group color/name and the per-tab color/name are independent, both shown — the member's fill/
tint comes from its own color, the bottom line from the group). Group colors SHALL draw from the
same 16-slot ANSI palette as tab colors. The group button SHALL offer, via its context menu,
rename, recolor, ungroup (members stay as plain tabs), and close-all. A tab SHALL be groupable via
its own context menu ("New group from this tab", and "Add to <group>" for each live group).

#### Scenario: Group button, line, and per-tab color coexist

- **WHEN** a group "work" (blue) holds a tab that is itself colored red
- **THEN** a blue tab-shaped "work" button precedes the members, the blue line runs under the
  button and every member, AND the red tab keeps its own red fill/tint — both colors visible

#### Scenario: Group button activates with its member

- **WHEN** a member of "work" becomes the active tab
- **THEN** the "work" button renders solid blue with flipped ink; activating a non-member returns
  it to the 8% tint

#### Scenario: Create and add from the tab menu

- **WHEN** the user picks "New group from this tab", then on another tab picks "Add to work"
- **THEN** both tabs are members of the same group, pulled contiguous

#### Scenario: Ungroup keeps the tabs

- **WHEN** the group button menu's Ungroup is used
- **THEN** the members remain as ordinary tabs in place (keeping their own colors) and the group
  button disappears

#### Scenario: Close-all is kind-aware

- **WHEN** the group button menu's Close all is used on a group containing a dirty editor tab
- **THEN** the confirmation warns about the unsaved editor (never bulk-kills it silently); on
  accept, every member is closed

### Requirement: Collapse is per-device view state with safe activation

Clicking a chip (desktop) or tapping a group header (mobile drawer) SHALL toggle the group collapsed (members hidden, chip/header remains) or expanded, using a shared per-device `localStorage` set — not synced. Collapsing a group that contains the active tab SHALL activate the nearest tab OUTSIDE the group first (the tab immediately before the group's first member, else immediately after its last, matching close-navigation); collapse SHALL be refused (with a toast) when no tab exists outside the group. Any activation of a hidden member — via URL/popstate, `tabCreated`, split re-tiling, close-navigation, reconcile, or boot — SHALL auto-expand its group.

#### Scenario: Collapse hides members on this device only

- **WHEN** a group is collapsed on the desktop
- **THEN** its tabs vanish from this strip (chip stays) while another device's strip is unaffected

#### Scenario: Mobile drawer collapses too

- **WHEN** the user taps a group header in the mobile drawer
- **THEN** that group's member rows fold/unfold, sharing the same per-device collapse state as desktop

#### Scenario: Active tab is protected

- **WHEN** the active tab's group is collapsed
- **THEN** the nearest outside tab activates and the group then collapses

#### Scenario: Collapse refused when the group is the whole strip

- **WHEN** every tab belongs to one group and the user clicks its chip
- **THEN** the group does NOT collapse (members stay visible) and a toast explains why

#### Scenario: Hidden member activation expands (any path)

- **WHEN** a collapsed group's member becomes active via back/forward, a split re-tile, or close-navigation onto it
- **THEN** the group auto-expands and the tab is visible/active (never active-but-hidden)

### Requirement: Drag gestures compose grouping with reorder

Dragging a tab into a group's span (between two members, or onto a member tab's center) SHALL join
it to that group at the drop position via a single `groupUpdate` carrying membership AND the new
strip order; dragging a member past the group's boundary SHALL remove it from the group and place
it there; dragging the GROUP BUTTON SHALL move the entire group as one unit (a plain `reorderTabs`
block move). All existing gestures (reorder outside groups, drag-to-split, drag-onto-slot) SHALL
keep working. A split pairing's members SHALL always share the same group membership: fusing
across memberships makes the dragged tab ADOPT the anchor's membership (see `split-fusion`), and a
later membership change that separates a pairing's members SHALL dissolve that pairing. The
content-area split/slot drop zones SHALL ignore the group-button drag payload.

#### Scenario: Drop into the span joins at the drop position

- **WHEN** an ungrouped tab is dropped between two members of a group
- **THEN** it lands there as a member (membership + position set atomically; it does not bounce out)

#### Scenario: Drop on a member center joins (grows a group of one)

- **WHEN** a tab is dropped on the center of a lone group member
- **THEN** it joins that member's group (so a one-member group is growable by drag)

#### Scenario: Drag out leaves

- **WHEN** a member is dragged past the group's last tab and dropped outside the span
- **THEN** it exits the group (groupId cleared) and sits outside it, the group intact

#### Scenario: Group-button drag moves the unit

- **WHEN** the group button is dragged to another strip position
- **THEN** all members move together (order inside the group preserved), and no split/slot drop
  zone activates

#### Scenario: Membership change that splits a pairing dissolves it

- **WHEN** one member of a fused pairing is moved into a different group (e.g. dragged out of the
  shared group from another client)
- **THEN** the pairing dissolves on the next reconcile (both tabs remain as plain strip tabs) and
  no ghost fused button remains
