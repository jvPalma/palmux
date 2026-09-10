# tab-reorder Specification

## Purpose

Chrome-like tab reordering: display order is an explicit, server-authoritative property decoupled from tab id/URL, shared live across clients and persisted across restarts, with a drag-to-reorder strip that leaves split pairings intact.

## Requirements

### Requirement: Display order is decoupled from tab identity

Tab display order SHALL be an explicit property of the tab list, independent of tab ids: reordering SHALL NOT change any tab's id or URL path, and id assignment (`nextFreeId`, lowest free) SHALL NOT change. A newly created tab (any kind, including spawn-on-attach terminals) SHALL append to the END of the order regardless of its numeric id.

#### Scenario: Reordering never rewrites identity

- **WHEN** the strip `[t0, t1, t2]` is reordered to `[t2, t0, t1]`
- **THEN** each tab keeps its id and URL (`/2`, `/0`, `/1`) and only the displayed order changes

#### Scenario: A recycled low id still appends

- **WHEN** the order is `[t0, t2]` (id 1 was closed earlier) and a new terminal is created taking the lowest free id `1`
- **THEN** the order becomes `[t0, t2, t1]` — the new tab appends even though its id sorts between the others

### Requirement: Order is server-authoritative and shared

The server SHALL own the tab order: the `sessions` broadcast's `tabs` array order SHALL be the authoritative display order for every client, and the order SHALL persist across server restarts (for tabs that are themselves persisted). A client SHALL request changes via a `reorderTabs` message carrying the full desired id order; the server SHALL validate it (a permutation of known ids — unknown ids ignored, missing known ids retained) and rebroadcast.

#### Scenario: Reorder syncs to all clients

- **WHEN** one client sends `reorderTabs` with `[t2, t0, t1]`
- **THEN** the server persists the new order and every connected client's strip shows `[t2, t0, t1]`

#### Scenario: Order survives a restart

- **WHEN** the order is `[t2, t0, t1]` (all tabs persisted) and the server restarts
- **THEN** the restored tab list is in the order `[t2, t0, t1]`

#### Scenario: A malformed reorder cannot corrupt the list

- **WHEN** a `reorderTabs` message contains unknown ids, duplicates, or omits known ids
- **THEN** unknown ids and duplicates are ignored, omitted known tabs remain (appended in their prior relative order), and no tab is ever lost or duplicated

### Requirement: Strip drag reorders, Chrome-like

Dragging a tab within the strip SHALL reorder it: during the drag an insertion indicator SHALL mark the drop position, and dropping SHALL move the tab there, applied optimistically in the dragging client and confirmed by the server broadcast. This SHALL work for split-member tabs — the split pairing follows the tab and is unaffected by order. This supersedes the previous drag-back-to-strip gesture: dropping a tab on the strip SHALL NOT collapse a split (un-splitting remains the per-slot eject control).

#### Scenario: Drop between tabs moves the tab

- **WHEN** the strip is `[t0, t1, t2, t3]` and `t3` is dropped between `t0` and `t1`
- **THEN** the strip becomes `[t0, t3, t1, t2]`

#### Scenario: Reordering a split member never touches the split

- **WHEN** the split `(t0 | t1)` is on screen and member `t1` is dragged to the front of the strip
- **THEN** the strip becomes `[t1, t0, …]`, the split stays `(t0 | t1)` tiled, and focus is unchanged

#### Scenario: Strip drop no longer collapses

- **WHEN** a split is on screen and a member tab is dragged and dropped on the strip
- **THEN** the tab is reordered (or stays put) and the split is NOT collapsed

#### Scenario: Content-area drag gestures are unchanged

- **WHEN** a tab is dragged to a content-area edge (no split shown) or onto a slot (split shown)
- **THEN** the existing open-split / replace-slot behaviors apply exactly as before

### Requirement: The strip renders the broadcast order

The client strip SHALL render tabs in the order received from the server (no client-side numeric sorting); a freshly navigated id not yet present in the broadcast SHALL be appended at the end until the server includes it.

#### Scenario: Broadcast order wins over numeric order

- **WHEN** the server broadcasts tabs in the order `[t2, t0, t1]`
- **THEN** the strip renders `t2` first, not `t0`

#### Scenario: A not-yet-broadcast id appends

- **WHEN** the user navigates to `/5` before the server has broadcast a tab with id `5`
- **THEN** the strip shows the existing broadcast order with `t5` appended last
