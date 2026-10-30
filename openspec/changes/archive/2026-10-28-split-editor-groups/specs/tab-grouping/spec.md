# Spec Delta

## MODIFIED Requirements

### Requirement: The strip renders groups as chips + clusters

On desktop, each group SHALL render as a FRAMED CLUSTER in every pane strip that holds one of its members (a group may span panes; each pane draws its own cluster around the members it holds): a 1px frame in the group color enclosing a
leading GROUP CHIP and every member pill. The chip shows the group's name (or a compact dot when
unnamed) on a group-color fill with luminance-flipped ink. The chip's fill SHALL NOT change when a
member becomes active — the member pill carries the active treatment, never the chip. A member tab
SHALL ALSO keep its own name and colour dot (the group color/name and the per-tab color/name are
independent, both shown). Group colors SHALL draw from the same 16-slot ANSI palette as tab colors.
The group chip SHALL offer, via its context menu, rename, recolor, ungroup (members stay as plain
tabs), and close-all. A tab SHALL be groupable via its own context menu ("New group from this tab",
and "Add to <group>" for each live group).

#### Scenario: Group button, line, and per-tab color coexist

- **WHEN** a group "work" (blue) holds a tab that is itself colored red
- **THEN** a blue frame encloses a blue "work" chip and every member, AND the red tab shows its own
  red dot — both colors visible

#### Scenario: Group button activates with its member

- **WHEN** a member of "work" becomes the active tab
- **THEN** that member pill takes the active treatment and the "work" chip keeps exactly the fill it
  had before

#### Scenario: Create and add from the tab menu

- **WHEN** the user picks "New group from this tab", then on another tab picks "Add to work"
- **THEN** both tabs are members of the same group, pulled contiguous

#### Scenario: Ungroup keeps the tabs

- **WHEN** the group chip menu's Ungroup is used
- **THEN** the members remain as ordinary pills in place (keeping their own colors) and the frame
  and chip disappear

#### Scenario: Close-all is kind-aware

- **WHEN** the group chip menu's Close all is used on a group containing a dirty editor tab
- **THEN** the confirmation warns about the unsaved editor (never bulk-kills it silently); on
  accept, every member is closed

#### Scenario: A group spanning two panes

- **WHEN** group "work" holds tabs 1 and 2, tab 1 is in pane A and tab 2 is in pane B
- **THEN** A's strip and B's strip each show a "work" chip and frame around their own member

### Requirement: Collapse is per-device view state with safe activation

Clicking a chip (desktop) or tapping a group header (mobile drawer) SHALL toggle the group collapsed (members hidden, chip/header remains) or expanded, using a shared per-device `localStorage` set — not synced. Collapsing a group SHALL first, in every pane whose active tab is a member, activate that pane's nearest tab OUTSIDE the group (the one immediately before the group's members in that pane's strip, else immediately after); collapse SHALL be refused (with a toast) when any such pane has no tab outside the group. Any activation of a hidden member — via URL/popstate, `tabCreated`, a pane drop, close-navigation, reconcile, or boot — SHALL auto-expand its group.

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

- **WHEN** a collapsed group's member becomes active via a pane drop or close-navigation onto it
- **THEN** the group auto-expands and the tab is visible/active (never active-but-hidden)

#### Scenario: Collapse protects every pane

- **WHEN** panes A and B both show a member of group "work" and A also holds a tab outside it, but B does not
- **THEN** collapsing "work" is refused with a toast and nothing changes

## REMOVED Requirements

### Requirement: Drag gestures compose grouping with reorder

**Reason**: It binds split pairings to group membership; pairings are retired.

**Migration**: "Drag gestures compose grouping with reorder and panes".

## ADDED Requirements

### Requirement: Drag gestures compose grouping with reorder and panes

Dropping a tab into a group's span (between two members, or on a member's centre) SHALL join it there via one
`groupUpdate` carrying membership AND order; dragging a member past the span's boundary SHALL remove it from the
group; dragging the GROUP chip SHALL move the whole group as one `reorderTabs` block. Moving a tab between panes
SHALL NOT change its membership, and pane drop regions SHALL ignore the chip's drag payload.

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
- **THEN** all members move together (order inside the group preserved), and no pane drop
  region activates
