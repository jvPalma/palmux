# Spec Delta

## MODIFIED Requirements

### Requirement: The strip renders groups as chips + clusters

On desktop, each group SHALL render as a FRAMED CLUSTER: a 1px frame in the group color enclosing a
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
