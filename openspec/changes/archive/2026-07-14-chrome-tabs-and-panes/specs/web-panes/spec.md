# web-panes

Iframe-embedded web tabs: arbitrary URLs, configured web apps (SilverBullet), same-origin
artifact HTML serving, and the frame-refusal fallback.

## ADDED Requirements

### Requirement: A web tab embeds its URL in an iframe

Activating a `web` tab SHALL render an `<iframe>` with the tab's `url`, sandboxed with
`allow-scripts allow-same-origin allow-forms allow-popups allow-downloads`, filling the content
area below the tab strip. The iframe SHALL stay mounted while its tab exists (background tabs
keep navigation/scroll state); the terminal host SHALL remain mounted but hidden while a web
tab is active.

#### Scenario: Switching preserves both sides

- **WHEN** the user scrolls inside a web tab, switches to a terminal tab, and switches back
- **THEN** the web page's scroll/navigation state is intact and the terminal never re-attached
  or replayed

### Requirement: Web panes have a slim header with an external-open fallback

Each web pane SHALL show a slim header with the current URL, a reload button, and an
"open externally" button (opens the URL in a real browser tab). This is the required fallback
for sites that refuse framing (`X-Frame-Options`/`frame-ancestors`) — the client SHALL NOT
attempt to detect refusal heuristically.

#### Scenario: Site refuses framing

- **WHEN** a web tab points at a site that blocks embedding and shows a blank frame
- **THEN** the header's "open externally" button opens it in a new browser tab

### Requirement: URLs can be entered and changed

The new-tab flow SHALL offer "Open URL…" with a text field (https default; bare hosts get
`https://` prefixed). The pane header SHALL allow editing the URL of an existing web tab,
sending `updateTab { id, url }`.

#### Scenario: Bare host entry

- **WHEN** the user enters `sb.example.com` in Open URL…
- **THEN** a web tab is created with url `https://sb.example.com`

### Requirement: Configured web apps appear as one-tap entries

Web apps declared in `config.json` (`webApps: [{ name, url, icon? }]`, e.g. a SilverBullet instance) SHALL be delivered to the client (in `ready`) and offered as one-tap entries in the new-tab dashboard. Opening one creates a `web` tab pre-named with the app's name.

#### Scenario: SilverBullet configured

- **WHEN** `webApps` contains `{ name: 'SilverBullet', url: 'https://sb.local' }`
- **THEN** the new-tab page shows a SilverBullet entry and tapping it opens a web tab named
  "SilverBullet" at that URL

#### Scenario: Nothing configured

- **WHEN** `webApps` is absent from config.json
- **THEN** the new-tab page simply omits the section (no error, no empty placeholder noise)

### Requirement: Server serves artifact HTML same-origin

The server SHALL serve files from `<configDir>/artifacts/` at `GET /artifacts/<name>`, behind
the auth cookie and IP rules, with path traversal rejected (resolved path MUST stay inside the
artifacts dir). Same-origin serving makes generated HTML always embeddable in web tabs.

#### Scenario: Artifact renders in a tab

- **WHEN** `report.html` exists in the artifacts dir and a web tab opens `/artifacts/report.html`
- **THEN** the page renders inside the iframe

#### Scenario: Traversal rejected

- **WHEN** a request targets `/artifacts/../secret`
- **THEN** the server responds 404 without reading outside the artifacts dir

#### Scenario: Unauthenticated request

- **WHEN** a request for `/artifacts/report.html` arrives without a valid session cookie
- **THEN** it is rejected exactly like other gated routes
