# split-layout Delta

## MODIFIED Requirements

### Requirement: The content area shows one or two slots

On desktop the content area SHALL show either a single tab (default) or the ACTIVE pairing's two
tabs in two slots. Any tab kind MAY occupy either slot, in any pairing — including terminal +
terminal, terminal + pane, and pane + pane. A given tab id SHALL appear in at most one slot on
screen, and SHALL belong to at most one pairing overall.

#### Scenario: Editor beside a terminal

- **WHEN** the user splits an editor tab against a terminal tab
- **THEN** both render simultaneously, each in its own slot, both interactive

#### Scenario: Two terminals side by side

- **WHEN** the user splits two terminal tabs
- **THEN** both terminals are live and independently usable

### Requirement: Split layout persists per device

Pairings SHALL persist to localStorage as a VERSIONED ARRAY (`palmux-splits`, `{ v: 2, pairings }`,
each pairing `{ a, b, orientation, ratio, focused }` with slot `a` the anchor), per device (not
synced), restored on reload. A legacy single-pairing `palmux-split` blob SHALL be migrated into a
one-pairing array on first load; the legacy key is retained (not deleted) for one release for
rollback. Per pairing, a slot whose tab no longer exists OR whose current kind differs from the
persisted kind (numeric ids are recycled) SHALL be treated as dangling → that pairing dissolves
(its surviving tab remains a plain strip tab); other pairings are unaffected. Additional pairing
invariants — a tab in at most one pairing, members strip-adjacent (anchor immediately followed by
partner), members sharing group membership — SHALL be enforced on load and on every `sessions`
reconcile, dissolving (never erroring) any pairing that violates them. Unparsable or unrecognized
persisted state SHALL be discarded (start with no pairings). Two full windows sharing the key are
last-writer-wins with no live sync; popout windows neither read nor write it. On a deep link, the
URL wins: a link to a pairing member activates that pairing with the linked member's slot focused;
a link to an unpaired tab shows it full-width.

#### Scenario: Restored on reload

- **WHEN** the user reloads with two persisted pairings, one of them active
- **THEN** the active pairing re-tiles in its orientation and ratio, and the other pairing's fused
  button is present (inactive) in the strip

#### Scenario: Legacy blob migrates

- **WHEN** a device with the old `palmux-split` single-pairing blob loads the new client
- **THEN** the blob becomes the sole entry of `palmux-splits` and behaves identically

#### Scenario: Dangling tab dissolves only its pairing

- **WHEN** one of two persisted pairings references a tab closed before reload
- **THEN** that pairing dissolves (survivor remains a plain tab) while the other pairing restores

#### Scenario: Recycled id is dangling, not wrong

- **WHEN** a persisted slot recorded `{ tabId: '3', kind: 'editor' }` but tab 3 is now a terminal
- **THEN** that pairing dissolves (no semantically wrong restore)

#### Scenario: External reorder breaks adjacency

- **WHEN** another client reorders tabs so a pairing's members are no longer adjacent
- **THEN** on the next `sessions` reconcile that pairing dissolves silently; both tabs stay as
  plain strip tabs

#### Scenario: Corrupt persisted state

- **WHEN** `palmux-splits` contains unparsable JSON
- **THEN** the key is discarded and the app opens with no pairings

### Requirement: A split has exactly two slots

A pairing SHALL contain exactly two slots at all times; no operation SHALL produce a third slot, a
nested pairing, or a single-slot pairing. Fusing SHALL restructure the strip only by (a) reordering
the partner adjacent to the anchor and (b) rendering the pair as one fused button; the underlying
tab list, ids, and server-side order semantics are otherwise unchanged.

#### Scenario: Dragging a tab into an active split replaces, never adds

- **WHEN** a split is active and the user drags a strip tab onto one of its slots
- **THEN** the targeted slot's content is replaced and the pairing still has exactly two slots

#### Scenario: Fusing reorders only the partner

- **WHEN** the strip is `[t0, t1, t2, t3]`, the active tab is `t0`, and `t2` is dragged into a
  split with it
- **THEN** the order becomes `[t0, t2, t1, t3]` (one `reorderTabs`), rendered as
  `[t0⧉t2, t1, t3]` with a fused button, and the server still sees four plain tabs

### Requirement: New tabs are created outside the split

Creating a new tab SHALL never consume a pairing slot: whether via the `[+]` control or a server
`tabCreated` message while a pairing is active, the new tab SHALL be added outside every pairing and shown
full-width, with all pairings preserved (their fused buttons remain in the strip, inactive).

#### Scenario: [+] while split-focused creates an outside tab

- **WHEN** the pairing `(t0 | t1)` is active with slot A focused and the user clicks `[+]`
- **THEN** a new terminal tab `t4` is created, activated full-width, and the `t0⧉t1` fused button
  remains (inactive)

#### Scenario: Server-created tab does not consume a slot

- **WHEN** a `tabCreated` message arrives while a pairing is active
- **THEN** the created tab is activated full-width and neither slot is replaced

### Requirement: A tab can be ejected from a split slot

Each slot of the active pairing SHALL expose a control (⏏) that dissolves the pairing; ejecting
SHALL NOT close either tab — both remain in the strip as adjacent plain tabs — and the OTHER
slot's tab SHALL become the active full-width tab. Unfusing SHALL NOT reorder anything (the
members are already adjacent).

#### Scenario: Eject slot A keeps slot B full-width

- **WHEN** the active pairing is `(t0 | t1)` and the user activates eject on slot A
- **THEN** the pairing dissolves, `t1` is shown full-width and active, and `t0` and `t1` remain
  adjacent plain tabs in the strip

#### Scenario: Eject slot B keeps slot A full-width

- **WHEN** the active pairing is `(t0 | t1)` and the user activates eject on slot B
- **THEN** the pairing dissolves and `t0` is shown full-width and active

### Requirement: Closing a split tab collapses to the survivor

Closing (or losing) one member of a pairing SHALL dissolve that pairing and show the other member
full-width, rather than leaving an empty slot; other pairings are unaffected.

#### Scenario: Close one side

- **WHEN** the user closes the tab shown in slot A of the active pairing
- **THEN** the pairing dissolves and slot B's tab becomes the single active tab filling the
  content area

## REMOVED Requirements

### Requirement: Split display is scoped to its member tabs

**Reason**: Superseded by split fusion — a pairing is represented by a fused strip button, so
"hidden pairing summoned by selecting a member" no longer exists; the pairing shows exactly when
its fused button is active.
**Migration**: Display rules live in `split-fusion` ("Only the active pairing renders"); selecting
any non-member still shows that tab full-width with all pairings preserved.

### Requirement: The focused split slot is reflected in the tab strip

**Reason**: The ◧/◨ member badges are removed; the fused button's two segments carry focus state
directly (focused segment solid, other dimmed).
**Migration**: See `split-fusion` "A pairing renders as one fused strip button".
