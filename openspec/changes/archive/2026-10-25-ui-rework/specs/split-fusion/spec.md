# Spec Delta

## MODIFIED Requirements

### Requirement: A pairing renders as one fused strip button

A split pairing SHALL render in the strip as a single fused PILL at the anchor tab's position,
replacing both members' individual pills (the partner has no separate strip presence). The fused
pill SHALL lead with a split glyph and contain two clickable segments in slot order separated by a
visible seam — each segment with its own minimum width, each showing its tab's colour dot and title.
The split glyph and the seam SHALL be visible whether or not the pairing is active, so a pairing never
reads as two ordinary tabs. The fused pill SHALL be active whenever the active tab id is EITHER
member; while active it takes the active pill treatment and the FOCUSED slot's segment is raised
within it with full-strength text, while the other segment stays unraised with subdued text. Colour
SHALL NOT mark focus. Clicking a segment SHALL activate the pairing (if not active) and focus that
segment's slot; focus changes SHALL update the URL per the focused-slot rule in `split-layout`
(replaceState). Grouped pairings render inside their group's frame.

#### Scenario: Fused button replaces two tabs

- **WHEN** tabs `t0` and `t1` fuse while the strip is `[t0, t1, t2]`
- **THEN** the strip renders `[t0⧉t1, t2]` — two entries, the first a fused pill with a split glyph,
  a `t0` segment and a `t1` segment

#### Scenario: Inactive pairing still reads as a split

- **WHEN** the active tab is `t2` and `t0⧉t1` is inactive
- **THEN** the fused pill still shows its split glyph and the seam between `t0` and `t1`

#### Scenario: Segments show focus

- **WHEN** the pairing is active and slot A is focused
- **THEN** the `t0` segment is raised with full-strength text and the `t1` segment is unraised with
  subdued text; clicking the `t1` segment raises it and focuses pane B without a history push

#### Scenario: Clicking an inactive fused button re-tiles its split

- **WHEN** the active tab is `t2` and the user clicks a segment of the inactive `t0⧉t1` pill
- **THEN** the pairing re-tiles in its stored orientation/ratio with the clicked segment's slot
  focused

#### Scenario: Deep link to a partner

- **WHEN** the browser navigates directly to the partner member's id (URL or back/forward)
- **THEN** the pairing shows with the partner's slot focused (the fused pill is active; the
  partner is never rendered as a separate strip tab)
