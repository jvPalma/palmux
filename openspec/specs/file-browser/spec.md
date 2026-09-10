# file-browser Specification

## Purpose

A read-only server listing of any absolute directory, rendered as a navigable tree in the dock, with a Read / Edit toggle over one file path so viewing and editing never diverge into two surfaces.

## Requirements

### Requirement: The server lists a directory

palmux SHALL expose an authenticated, read-only endpoint that lists the entries of an absolute
directory path, returning for each entry its name, whether it is a directory, its size and its
modification time, and whether it is a symlink. The endpoint SHALL follow the same trust model already
stated for `/download`: absolute paths are permitted because the session cookie is the boundary and
the shell behind it can already read anything. It SHALL NOT expose any write operation.

#### Scenario: Listing a directory

- **WHEN** an authenticated client requests a listing of an absolute directory path
- **THEN** the response enumerates its entries with name, kind, size, mtime and symlink flag

#### Scenario: A path that is not a directory

- **WHEN** the requested path is a file, does not exist, or is not readable
- **THEN** the endpoint answers a readable error status rather than falling through to the SPA shell

#### Scenario: Unauthenticated request

- **WHEN** the endpoint is requested without a valid session cookie
- **THEN** it is refused by the same gate as every other non-exempt route

### Requirement: The dock shows a navigable file tree

The Files view SHALL render a directory tree with expandable folders and a visible current path.
Selecting a file SHALL open it in the content pane rather than inside the dock, because a dock-width
column is too narrow to read or edit a file in.

#### Scenario: Expanding a folder

- **WHEN** the user expands a folder in the tree
- **THEN** its children are listed beneath it, indented, without collapsing the rest of the tree

#### Scenario: Opening a file

- **WHEN** the user selects a file in the tree
- **THEN** the file opens in the content pane and the tree keeps its scroll position and selection

### Requirement: A file opens with a Read / Edit toggle over one path

Opening a file SHALL present a single pane with a **Read / Edit** toggle rather than two different tab
kinds. In Read mode a markdown file SHALL render formatted; in Edit mode the same file SHALL open in
the Monaco editor. Toggling SHALL NOT create a second tab and SHALL preserve unsaved edits for the
duration of the pane's life. A file with no meaningful rendered form SHALL open in Edit mode with the
Read option unavailable rather than showing an empty reader.

#### Scenario: Toggling a markdown file

- **WHEN** the user opens a `.md` file and switches from Read to Edit and back
- **THEN** the same pane shows the editor and then the rendered document, with no new tab created

#### Scenario: Unsaved edits survive the toggle

- **WHEN** the user types into Edit mode, switches to Read, and switches back
- **THEN** the unsaved text is still present

#### Scenario: A file with no rendered form

- **WHEN** the user opens a `.ts` file
- **THEN** it opens in Edit mode and the Read option is not offered
