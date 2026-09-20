## MODIFIED Requirements

### Requirement: Editor content is server-backed per tab

An `editor` tab SHALL render one of two documents, told apart by whether the tab carries a `url`:

- **Without** a `url`, it is the tab's own note under `<configDir>/notes/` (default `<tab-id>.md`).
  The client SHALL load it via `GET /pane-file?tab=<id>` (empty content when the file does not exist
  yet) and save via `PUT /pane-file?tab=<id>` (raw body).
- **With** an absolute-path `url`, it is that file on disk, loaded via `GET /file?path=<abs>` and
  saved via `PUT /file?path=<abs>`.

Both note routes SHALL be cookie-gated, reject tabs that are not `editor` kind (404), and cap the
body at `maxUploadBytes` (413). The `url` form SHALL be gated on the path being absolute, and the
save SHALL write atomically into the target's own directory after resolving symlinks.

The `url` form SHALL be reachable from a palmux command as well as from a click in the file tree, and
the rule that an existing `editor` tab over the same path is reused SHALL be owned by the SERVER, so
the two ways in cannot disagree. The command's existence and regular-file check lives in its own
route, not in the registry's tab-creation path.

#### Scenario: Content survives restart and device switch

- **WHEN** text is saved in editor tab 4, the server restarts, and a different device opens tab 4
- **THEN** the saved text loads

#### Scenario: Oversized save rejected

- **WHEN** a PUT body exceeds `maxUploadBytes`
- **THEN** the server responds 413 and the previous file content is unchanged

#### Scenario: A URL-backed tab edits the file on disk

- **WHEN** the user opens an absolute path as an editor tab and saves
- **THEN** the file on disk holds the saved text, and the tab's own note under `notes/` is untouched

#### Scenario: The two ways in agree about reuse

- **WHEN** an `editor` tab over a path exists and the same path is opened again, from the tree and
  from a command
- **THEN** both move to the existing tab rather than creating a second one over the same path
