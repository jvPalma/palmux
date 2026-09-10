## ADDED Requirements

### Requirement: A markdown tab renders a file read-only

A `markdown` tab kind SHALL render the markdown file at its stored absolute path as formatted HTML (headings, lists, tables, code blocks, links, images), read-only; the tab SHALL behave as a first-class non-terminal tab (persisted to tabs.json, restart-surviving, splittable, reorderable, renamable/colorable) and its default title SHALL be the file's name.

#### Scenario: Open a file by absolute path

- **WHEN** the user opens a markdown tab for `/home/user/notes/report.md`
- **THEN** the pane shows the rendered document and the tab is titled `report.md`

#### Scenario: Markdown tabs persist like other panes

- **WHEN** the server restarts while a markdown tab exists
- **THEN** the tab returns pointing at the same file, in its strip position

### Requirement: Rendered markdown can never script the app

Markdown HTML SHALL be sanitized before injection: script/style/event-handler vectors and `javascript:` URLs present in a file SHALL NOT execute or apply in the app context. External links SHALL open in a new browser tab, never navigate the workspace.

#### Scenario: A hostile file is inert

- **WHEN** a markdown file contains `<script>`, `<img onerror=…>`, or a `javascript:` link
- **THEN** the rendered pane contains none of those active vectors

#### Scenario: External links escape safely

- **WHEN** the user clicks an `https://` link in a rendered document
- **THEN** it opens in a new browser tab and the palmux window stays put

### Requirement: Configurable roots are browsable in the UI

Directories listed in `markdownRoots` (config.json, `~` expanded) SHALL be navigable inside the pane: a browser view lists subdirectories and markdown files with breadcrumbs; clicking a file opens it in the same pane. Directory LISTING SHALL be confined to the configured roots subtree (a list request outside them is refused), while direct file opens accept any absolute path (the established shell-trust model).

#### Scenario: Browse a root to a file

- **WHEN** `markdownRoots` contains `~/work/.claude/skills` and the user opens the browser view
- **THEN** they can descend into subfolders and open `process-number-rules/reference/courts.md` with one click per level

#### Scenario: Listing outside the roots is refused

- **WHEN** a `/md-list` request names a directory outside every configured root
- **THEN** the server refuses it and no entries are returned

#### Scenario: No roots configured

- **WHEN** `markdownRoots` is empty and the viewer's browser view opens
- **THEN** it explains that no roots are configured (pointing at config.json) and direct path opening still works

### Requirement: Relative links navigate within the viewer

A relative link from one markdown file to another SHALL resolve against the current file's directory and open in the SAME pane (updating the tab's path and title), with the browser view's breadcrumbs reflecting the new location.

#### Scenario: Cross-file link

- **WHEN** `index.md` links to `./reference/courts.md` and the user clicks it
- **THEN** the same pane renders `courts.md`

### Requirement: The viewer loads lazily and can refresh

The markdown parse/sanitize code SHALL live in a lazily loaded chunk (terminal-only sessions download none of it), and the pane SHALL offer a refresh control that re-reads the file from disk.

#### Scenario: Terminal-only sessions stay lean

- **WHEN** a session never opens a markdown tab
- **THEN** the markdown renderer chunk is never fetched

#### Scenario: Refresh picks up edits

- **WHEN** the file changes on disk and the user hits refresh
- **THEN** the pane shows the new content
