## ADDED Requirements

### Requirement: Word wrap follows one device setting

The editor SHALL wrap long lines exactly when the device setting `editorWrap` is on. It SHALL default to on, live
only on this device (never synced), apply to every open editor at once with no reopen, and keep its value when the
pane crosses the narrow-width threshold. Settings SHALL offer it as an "Editor word wrap" switch. The rendered
markdown viewer SHALL NOT follow it: its code blocks keep scrolling sideways as they do today.

#### Scenario: Default

- **WHEN** a device that never changed the setting opens a file with a 300-character line
- **THEN** the line wraps

#### Scenario: Turning it off

- **WHEN** `editorWrap` is turned off while two editors are open
- **THEN** both stop wrapping without a reload, and a phone pointed at the same server still wraps

#### Scenario: A width crossing keeps it

- **WHEN** `editorWrap` is off and the editor's pane narrows below 500px
- **THEN** the gutter is trimmed and the lines still do not wrap

#### Scenario: The switch in Settings

- **WHEN** the user turns off "Editor word wrap" in Settings
- **THEN** every open editor stops wrapping

#### Scenario: Markdown is unaffected

- **WHEN** `editorWrap` is off and a markdown file in Read mode has a long paragraph and a long fenced line
- **THEN** the paragraph wraps and the fenced block scrolls sideways, as before
