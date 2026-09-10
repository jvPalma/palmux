# tab-grouping Delta

## MODIFIED Requirements

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
