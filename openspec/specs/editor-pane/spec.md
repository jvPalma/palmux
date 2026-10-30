# editor-pane Specification

## Purpose

Editor tabs host Monaco with server-backed per-tab content, explicit save plus autosave with a dirty indicator, and state preserved across tab switches.

## Requirements

### Requirement: Editor tabs host the Monaco editor

An `editor` tab SHALL render the Monaco editor (the VS Code editor component) with its standard
keybindings — multi-cursor, find/replace (Ctrl+F/Ctrl+H), line moves (Alt+↑/↓), etc. — themed
to match the app. Monaco SHALL be loaded as a lazy chunk on first editor-tab activation; no
Monaco code loads for clients that never open one. All assets are self-hosted (no CDN).

#### Scenario: Lazy load

- **WHEN** a client session uses only terminal tabs
- **THEN** no Monaco chunk is fetched

#### Scenario: VS Code shortcuts work

- **WHEN** the user presses Ctrl+F inside an editor tab
- **THEN** Monaco's find widget opens (the browser's find is not triggered)

### Requirement: Editor content is server-backed per tab

Each editor tab SHALL bind to a file under `<configDir>/notes/` (default `<tab-id>.md`). The
client SHALL load it via `GET /pane-file?tab=<id>` (empty content when the file doesn't exist
yet) and save via `PUT /pane-file?tab=<id>` (raw body). Both routes SHALL be cookie-gated,
reject tabs that are not `editor` kind (404), and cap the body at `maxUploadBytes` (413).

#### Scenario: Content survives restart and device switch

- **WHEN** text is saved in editor tab 4, the server restarts, and a different device opens tab 4
- **THEN** the saved text loads

#### Scenario: Oversized save rejected

- **WHEN** a PUT body exceeds `maxUploadBytes`
- **THEN** the server responds 413 and the previous file content is unchanged

### Requirement: Explicit save plus autosave, with a dirty indicator

Ctrl+S SHALL save immediately (suppressing the browser save dialog). Edits SHALL also autosave
debounced (~2s idle). While unsaved changes exist the tab SHALL show a dirty indicator (dot
replacing the ✕, Chrome/VS Code style); closing a dirty editor tab SHALL warn before discarding.

#### Scenario: Ctrl+S

- **WHEN** the user edits and presses Ctrl+S
- **THEN** the content PUTs to the server, the dirty dot clears, and no browser dialog opens

#### Scenario: Closing dirty warns

- **WHEN** the user clicks ✕ on an editor tab with unsaved changes
- **THEN** a confirmation is shown before the tab closes

### Requirement: Editor state persists across tab switches

Switching away from an editor tab and back SHALL preserve the unsaved buffer, cursor position,
selection, and undo history (the pane stays mounted; the Monaco model is not recreated).

#### Scenario: Undo history survives a switch

- **WHEN** the user types in an editor, switches to a terminal, returns, and presses Ctrl+Z
- **THEN** the last edit is undone

### Requirement: Editor font size follows the terminal

The Monaco editor's font size SHALL follow the device's code font size, a setting independent of the
terminal font size. Until the user first changes the code font size on a device, it SHALL equal that
device's terminal font size (plus the editor's existing small offset), so nothing jumps on upgrade. The
editor SHALL update live when the code font size changes, and a change of the terminal font size SHALL no
longer move an editor whose code font size was set.

#### Scenario: Editor matches terminal size

- **WHEN** the terminal font size is 14pt and the code font size was never changed on this device
- **THEN** the editor renders at the terminal size plus the editor's offset, not a fixed 13pt

#### Scenario: Live update

- **WHEN** the user changes the code font size while an editor tab is open
- **THEN** the open editor's font size updates without reopening the tab

#### Scenario: Independent of the terminal once set

- **WHEN** the code font size was set to 11 and the user then changes the terminal font size
- **THEN** the terminal changes and the editor stays at 11
