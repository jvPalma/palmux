# Spec Delta

## REMOVED Requirements

### Requirement: Split is a desktop-only feature

**Reason**: Restated for N panes. Superseded by editor groups (`editor-groups`): the two-slot pairing model is retired.

**Migration**: `editor-groups`: "Editor groups are desktop-only".

### Requirement: The content area shows one or two slots

**Reason**: Panes are a layout tree of any size. Superseded by editor groups (`editor-groups`): the two-slot pairing model is retired.

**Migration**: `editor-groups`: "The content area is a grid of panes".

### Requirement: Split orientation is horizontal or vertical

**Reason**: Orientation is per tree branch, chosen by the drop side; there is no toggle. Superseded by editor groups (`editor-groups`): the two-slot pairing model is retired.

**Migration**: `editor-groups`: "Dropping a tab on a pane's edge creates a pane".

### Requirement: A draggable divider rebalances the split

**Reason**: Restated per sash. Superseded by editor groups (`editor-groups`): the two-slot pairing model is retired.

**Migration**: `editor-groups`: "Sashes resize adjacent panes".

### Requirement: Exactly one slot is focused; focus is visible

**Reason**: Restated per pane; the URL no longer carries the tab (see `browser-local-tab-selection`). Superseded by editor groups (`editor-groups`): the two-slot pairing model is retired.

**Migration**: `editor-groups`: "Exactly one pane is focused".

### Requirement: Split layout persists per device

**Reason**: The layout is saved per window with a device fallback; old stores are ignored. Superseded by editor groups (`editor-groups`): the two-slot pairing model is retired.

**Migration**: `editor-groups`: "The layout persists per window". Old `palmux-splits`/`palmux-split` values are ignored; a window starts with one pane.

### Requirement: A pane-header control toggles orientation and closes the split

**Reason**: No orientation toggle or close-split control exists in VS Code's model. Superseded by editor groups (`editor-groups`): the two-slot pairing model is retired.

**Migration**: Move tabs between panes; a pane closes with its last tab.

### Requirement: Closing a split tab collapses to the survivor

**Reason**: Restated: a pane whose last tab leaves disappears. Superseded by editor groups (`editor-groups`): the two-slot pairing model is retired.

**Migration**: `editor-groups`: "An empty pane disappears".

### Requirement: A split has exactly two slots

**Reason**: Panes are unbounded. Superseded by editor groups (`editor-groups`): the two-slot pairing model is retired.

**Migration**: `editor-groups`: "The content area is a grid of panes".

### Requirement: New tabs are created outside the split

**Reason**: Reversed: a new tab opens in the focused pane. Superseded by editor groups (`editor-groups`): the two-slot pairing model is retired.

**Migration**: `editor-groups`: "New tabs open in the focused pane".

### Requirement: A tab can be ejected from a split slot

**Reason**: No eject; moving the tab out of a pane is the operation. Superseded by editor groups (`editor-groups`): the two-slot pairing model is retired.

**Migration**: Drag the tab to another pane or edge.
