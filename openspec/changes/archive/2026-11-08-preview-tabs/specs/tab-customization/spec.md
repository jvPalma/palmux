## MODIFIED Requirements

### Requirement: Tabs can be renamed

Any tab SHALL be renameable. Desktop: double-click the tab enters inline rename (Enter commits,
Escape cancels); the right-click context menu SHALL also offer Rename. Mobile: long-press a
drawer row opens a sheet with a rename field. Committing sends `updateTab { id, name }`;
committing an empty name clears the override.
A double-click on a PREVIEW tab SHALL pin it instead and SHALL NOT enter rename; a second double-click,
on the now pinned tab, enters rename as above. Rename from the context menu SHALL work on a preview tab
too, and committing it pins the tab. The rest of what pins is listed in `preview-tabs` only.

#### Scenario: Inline rename commits on Enter

- **WHEN** the user double-clicks a pinned tab, types "build", and presses Enter
- **THEN** `updateTab` is sent with name "build" and the tab title updates on all clients

#### Scenario: Escape cancels

- **WHEN** the user is in inline rename and presses Escape
- **THEN** no `updateTab` is sent and the previous title remains

#### Scenario: Double-click on a preview tab pins it

- **WHEN** the user double-clicks a preview tab
- **THEN** `updateTab { id, preview: false }` is sent, no rename field opens, and a second double-click
  opens the rename field
