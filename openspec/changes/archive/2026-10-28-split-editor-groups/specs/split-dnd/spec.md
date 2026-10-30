# Spec Delta

## REMOVED Requirements

### Requirement: Menu actions open a split (desktop)

**Reason**: Split right/down now move the tab into a new pane. Superseded by editor groups (`editor-groups`): the two-slot pairing model is retired.

**Migration**: `editor-groups`: "Split right and Split down move the tab into a new pane".

### Requirement: Dragging a strip tab to a content edge forms a split

**Reason**: Restated per pane, without fusion. Superseded by editor groups (`editor-groups`): the two-slot pairing model is retired.

**Migration**: `editor-groups`: "Dropping a tab on a pane's edge creates a pane".

### Requirement: No split invocation while the mobile layer is active

**Reason**: Restated. Superseded by editor groups (`editor-groups`): the two-slot pairing model is retired.

**Migration**: `editor-groups`: "Editor groups are desktop-only".

### Requirement: Dragging a tab onto a slot replaces that slot

**Reason**: A centre drop moves the tab into the pane; nothing is replaced. Superseded by editor groups (`editor-groups`): the two-slot pairing model is retired.

**Migration**: `editor-groups`: "Dropping a tab in a pane's centre or strip moves it there".

### Requirement: Drop zones preview the claimed region

**Reason**: Restated per pane, with a centre region. Superseded by editor groups (`editor-groups`): the two-slot pairing model is retired.

**Migration**: `editor-groups`: "Drops preview the region they claim".
