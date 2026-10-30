# Spec Delta

## REMOVED Requirements

### Requirement: A pairing renders as one fused strip button

**Reason**: Each pane has its own strip; nothing is fused. Superseded by editor groups (`editor-groups`): the two-slot pairing model is retired.

**Migration**: `editor-groups`: "Each pane has its own tab strip".

### Requirement: Fusing reorders the partner adjacent and adopts membership

**Reason**: Panes do not constrain strip order or colour-group membership. Superseded by editor groups (`editor-groups`): the two-slot pairing model is retired.

**Migration**: None needed.

### Requirement: Multiple pairings coexist

**Reason**: Pairings no longer exist. Superseded by editor groups (`editor-groups`): the two-slot pairing model is retired.

**Migration**: `editor-groups`.

### Requirement: The fused button drags as one unit

**Reason**: No fused button. Superseded by editor groups (`editor-groups`): the two-slot pairing model is retired.

**Migration**: None needed.

### Requirement: Mobile lists members individually

**Reason**: The mobile drawer lists every tab individually regardless of panes, unchanged. Superseded by editor groups (`editor-groups`): the two-slot pairing model is retired.

**Migration**: `editor-groups`: "Editor groups are desktop-only".
