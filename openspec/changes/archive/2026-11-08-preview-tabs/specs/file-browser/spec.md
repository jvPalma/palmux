## MODIFIED Requirements

### Requirement: The dock shows a navigable file tree

The Files view SHALL render a directory tree with expandable folders and a visible current path.
Selecting a file SHALL open it in the content pane rather than inside the dock, because a dock-width
column is too narrow to read or edit a file in.
Selecting a file SHALL be a preview open (see `preview-tabs`), and a pointer double-click on the file row SHALL pin
the tab it opened. Two activations by keyboard SHALL NOT pin.

#### Scenario: Expanding a folder

- **WHEN** the user expands a folder in the tree
- **THEN** its children are listed beneath it, indented, without collapsing the rest of the tree

#### Scenario: Opening a file

- **WHEN** the user selects a file in the tree
- **THEN** the file opens in the content pane and the tree keeps its scroll position and selection

#### Scenario: Selecting another file replaces the preview

- **WHEN** the user selects `a.ts` and then `b.ts` in the tree
- **THEN** one preview tab shows `b.ts`

#### Scenario: Double-click keeps the file open

- **WHEN** the user double-clicks `a.ts` in the tree and then selects `b.ts`
- **THEN** `a.ts` stays open as a pinned tab and `b.ts` opens in a preview tab
