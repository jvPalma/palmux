## ADDED Requirements

### Requirement: The current file's header stays on screen

On a desktop, the bar above the review's list SHALL act as the header of the file at the top of the view,
at every scroll position. It SHALL show that file's path, state, added and removed line counts, position in
the group ("n / N"), the same Reviewed (Changes) or Unstage (Staged) action as the file's own header, and
Open file. On a phone the bar SHALL stay a label with the path and position only, because the review bar
already carries Reviewed.

#### Scenario: Scrolling deep into a long file

- **WHEN** the user scrolls 400 lines into a long file under review on a desktop
- **THEN** the bar above the list names that file and offers Reviewed and Open file, while the file's own
  header has scrolled away

#### Scenario: The file at the top changes

- **WHEN** scrolling brings the next file's first line to the top of the view
- **THEN** the bar names that file, with its state, counts and position

#### Scenario: Reviewed from the bar

- **WHEN** the user taps Reviewed in the bar
- **THEN** the file is staged as if Reviewed were tapped on its own header, the 6-second Undo toast appears,
  and the review moves to the next file

#### Scenario: The phone keeps its label

- **WHEN** a review is shown on a 390x844 phone
- **THEN** the bar shows only the path and the position, at its current height, and the review bar keeps
  Reviewed

### Requirement: Both file headers share one write

The bar's Reviewed or Unstage and the file's own header SHALL use one write queue, so a write started from
either shows as running on both and cannot run twice. While the file's snapshot is not loaded, the bar's
Reviewed SHALL be disabled with the same reason the file's own header gives.

#### Scenario: One queue for both headers

- **WHEN** the user taps Reviewed in the bar while the file's own header is on screen
- **THEN** both buttons show the write as running, and a second tap on either does nothing until it ends

#### Scenario: The snapshot is not loaded yet

- **WHEN** the file at the top is still a placeholder
- **THEN** the bar's Reviewed is disabled and says the file is still loading
