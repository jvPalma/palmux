# DnD decision table — chips, join/leave, chip-block move

How grouping composes with the EXISTING `SessionTabs` reorder DnD (design D1.1, D1.5,
D1.10). Referenced by spec Requirement "Drag gestures compose grouping with reorder" and
tasks 4.x.

## The render-index problem (D4)

Today `SessionTabs` renders `list: TabMeta[]` and computes drop positions as an index
INTO that tab list (`dropIndex === tabIndex` → drop-before; `=== list.length` → append;
midpoint math in `onDragOver`). Chips are NEW render entries interleaved before each
group's first member. **Chips are NOT tabs and MUST NOT shift the tab-index math.**

Model: keep a single `TabMeta[] list` (visible tabs, collapsed members already filtered
out). Render a chip element BEFORE the element whose tab is a group's first visible
member — the chip is a sibling with no bearing on `tabIndex`. `dropIndex` stays an index
into `list` (tabs only). The insertion indicator and `reorderIds` are unchanged.

## Drop decision table

Let the drop resolve to an insertion index `i` in `list` (0..len), `L = list[i-1]`
(tab left of the gap, or null), `R = list[i]` (tab right, or null), and `Gx = groupIdOf(x)`.
"Drop ON a tab's center" is a distinct case captured first.

| drop location                                                   | condition                       | outcome                          | wire                                            |
| --------------------------------------------------------------- | ------------------------------- | -------------------------------- | ----------------------------------------------- |
| ON a member tab's CENTER                                        | target ∈ group G                | JOIN dragged into G at that slot | `groupUpdate{ id:G, addIds:[d], order }`        |
| gap, interior                                                   | `L,R` both ∈ same group G       | JOIN into G at `i`               | `groupUpdate{ id:G, addIds:[d], order }`        |
| gap, front edge                                                 | `R ∈ G`, `L ∉ G` (or null)      | dragged lands OUTSIDE, before G  | `reorderTabs(order)` (+ `removeIds` if `d ∈ G`) |
| gap, back edge                                                  | `L ∈ G`, `R ∉ G` (or null)      | dragged lands OUTSIDE, after G   | `reorderTabs(order)` (+ `removeIds` if `d ∈ G`) |
| gap, ungrouped↔ungrouped                                        | `L,R ∉ any group`               | plain reorder                    | `reorderTabs(order)`                            |
| a MEMBER dragged to a gap that is NOT interior to its own group | `d ∈ G`, drop not interior to G | LEAVE G, land there              | `groupUpdate{ id:G, removeIds:[d], order }`     |

Notes:

- `order` in a `groupUpdate` is the full desired strip order with `d` at index `i`. The
  server sets membership + order, then `normalizeOrder` (stable) keeps `d` at `i` — no
  bounce (see group-model.md examples).
- **Group of one is growable** thanks to the "ON a member center" row: a lone member has
  no gap-interior, but a center-drop still joins it. (Design D1.5.)
- **Front-edge of a member's own group == leave-via-front**: dropping a member at its
  group's first-member index is treated as LEAVE (front edge), not reorder-to-front. This
  is intentional; document it so it's not "fixed" as a bug.

## Insertion-indicator color (preview the outcome)

While dragging, color the insertion bar/target by the row that WILL fire:

- JOIN outcomes → the GROUP's `--group-accent`.
- reorder / LEAVE outcomes → the normal `--t-accent` bar.
  So the user sees join-vs-not before releasing.

## Chip-block drag (design D1.10)

- The chip is `draggable` with payload type `application/x-palmux-group` carrying the
  group id. It uses its OWN `onDragStart/onDragOver/onDrop` handlers.
- It MUST NOT call the tab `onDrag`/`setDragTabId` path — `SplitDropZones`/`SlotDropZones`
  render on `dragTabId !== null`, so routing a chip drag through it would wrongly show
  split/slot zones. (They also gate on `TAB_DND_TYPE` and so already ignore the group
  payload for the drop itself — but keeping `dragTabId` null is what suppresses their
  appearance.)
- Dropping the chip at insertion index `i` composes ONE `reorderTabs(order)` that moves
  the whole member block to `i`, inner order preserved. `normalizeOrder` keeps them
  contiguous regardless.
- Chip CLICK (collapse toggle) vs chip DRAG: rely on the native HTML5 drag threshold — a
  press-release without crossing it is a click; a drag past it starts the block move.

## Strip drop-handler wiring

`SessionTabs`' strip-level `onDragOver`/`onDrop` currently accept only `TAB_DND_TYPE`.
They must ALSO accept `application/x-palmux-group` (branch on which type is present: tab
reorder/join/leave vs. group-block move). The content-area `SplitDropZones`/`SlotDropZones`
stay tab-only — do NOT teach them the group type.

## Optimistic updates (avoid one-broadcast flicker)

`App.doReorder`/the new group handlers apply optimistically before the round-trip:

- block move → move all member ids together in local `tabs`.
- join/leave → optimistically set/clear the dragged tab's `groupId` in local `tabs` so the
  cluster framing appears immediately; the authoritative next `sessions` broadcast
  reconciles. (Cosmetic; self-correcting.)
