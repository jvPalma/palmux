## MODIFIED Requirements

### Requirement: The server lists a directory

palmux SHALL expose an authenticated, read-only endpoint that lists the entries of an absolute
directory path, returning for each entry its name, whether it is a directory, its size and its
modification time, and whether it is a symlink. The endpoint SHALL follow the same trust model already
stated for `/download`: absolute paths are permitted because the session cookie is the boundary and
the shell behind it can already read anything. **This listing endpoint** SHALL NOT expose any write
operation.

The prohibition is scoped to the listing endpoint, stated here because a route that opens a file by
path also exists. Opening a path validates that it exists and is a regular file and then creates a
tab; it writes no file, creates no directory, and does not alter the path it was given. That
distinction is the point of naming the scope: a reader who finds a mutating route alongside this
requirement must be able to tell whether it violates the requirement, and "expose no write operation"
answered about the wrong endpoint is not an answer.

#### Scenario: Listing a directory

- **WHEN** an authenticated client requests a listing of an absolute directory path
- **THEN** the response enumerates its entries with name, kind, size, mtime and symlink flag

#### Scenario: A path that is not a directory

- **WHEN** the requested path is a file, does not exist, or is not readable
- **THEN** the endpoint answers a readable error status rather than falling through to the SPA shell

#### Scenario: Unauthenticated request

- **WHEN** the endpoint is requested without a valid session cookie
- **THEN** it is refused by the same gate as every other non-exempt route

#### Scenario: Opening a path is not a write

- **WHEN** a file is opened by path from a command
- **THEN** the path's contents, size and modification time are unchanged, and no file or directory
  is created

#### Scenario: A path that is not a regular file is refused

- **WHEN** an open request names a directory
- **THEN** it is refused with a message naming that reason, and no tab is created

### Requirement: A file can be opened without the tree

A file SHALL be openable by path from a palmux command, producing the same single surface a click in
the tree produces: one `editor` tab over that path with the Read / Edit toggle. Opening a path
already open in an `editor` tab SHALL move to that tab rather than creating a second one. The tree
and the command SHALL NOT be able to disagree about this rule, because the server owns it.

#### Scenario: The command and the tree produce the same surface

- **WHEN** a file is opened from a command rather than a click in the tree
- **THEN** it is an `editor` tab over that path offering the same Read / Edit toggle

#### Scenario: A path already open is not opened twice

- **WHEN** a file is opened by path while an `editor` tab already shows it
- **THEN** that tab is reused and no second tab over the same path is created
