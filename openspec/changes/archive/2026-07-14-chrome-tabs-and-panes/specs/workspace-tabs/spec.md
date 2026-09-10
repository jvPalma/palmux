# workspace-tabs

Server-side tab registry generalizing workspace sessions: tab kinds, metadata, wire protocol,
and persistence. `packages/shared/src/protocol.ts` stays the authoritative wire contract.

## ADDED Requirements

### Requirement: Tabs have a kind and metadata

The tab registry SHALL model every workspace slot as a tab
`{ id, kind: 'terminal' | 'web' | 'dashboard' | 'editor', name?, color?, url? }` where `id` is a
numeric string (same id space and URL routing as today's sessions). Only `terminal` tabs SHALL
own a PTY; `terminal` tab behavior (spawn on first attach, replay ring, exit handling) MUST be
unchanged from the current session registry.

#### Scenario: Terminal tabs behave exactly as before

- **WHEN** a client attaches to `/ws?session=5` and no tab `5` exists
- **THEN** a `terminal` tab is created with a spawned PTY, and binary I/O, resize, replay, and
  exit behave identically to the pre-change session registry

#### Scenario: Non-terminal tab holds no PTY

- **WHEN** a `web` tab exists in the registry
- **THEN** no PTY process is spawned for it and killing it terminates no process

### Requirement: The sessions broadcast carries tab metadata

The `sessions` server message SHALL gain `tabs: TabMeta[]`
(`{ id, kind, name?, color?, url?, title? }`) while continuing to send the existing `ids` and
`titles` fields derived from the same registry, so older clients keep working.

#### Scenario: Broadcast on any tab mutation

- **WHEN** a tab is created, killed, renamed, recolored, retitled (OSC), or has its url changed
- **THEN** every connected client receives a `sessions` message whose `tabs` reflects the change

#### Scenario: Backward-compatible parsing

- **WHEN** a client built before this change receives the extended `sessions` message
- **THEN** it parses `ids`/`titles` successfully and ignores `tabs`

### Requirement: Clients can create and update tabs over the wire

The client→server protocol SHALL add `createTab { kind, url?, name?, color? }` and
`updateTab { id, name?, color?, url? }`. `createTab` SHALL assign the lowest free numeric id.
The existing `kill { id }` SHALL close tabs of any kind. Invalid payloads (unknown kind,
non-existent id, `url` on a kind that has none) SHALL be ignored without disconnecting the
client, matching the parser's current forgiving posture.

#### Scenario: Creating a web tab

- **WHEN** a client sends `createTab { kind: 'web', url: 'https://sb.example.com' }`
- **THEN** the registry adds a `web` tab at the lowest free id and broadcasts `sessions`

#### Scenario: Renaming clears with empty string

- **WHEN** a client sends `updateTab { id: '3', name: '' }`
- **THEN** tab 3's custom name is removed and display falls back to its OSC title or kind default

#### Scenario: Killing a non-terminal tab

- **WHEN** a client sends `kill { id }` for an `editor` tab
- **THEN** the tab is removed from the registry and persistence, and `sessions` is broadcast

### Requirement: WS attach to a non-terminal tab is metadata-only

`/ws?session=<id>` SHALL accept connections for tabs of any kind. For non-terminal tabs the
server SHALL send `ready`, `settings`, `extraKeys`, `sessions`, and `fonts`, SHALL NOT send
`snapshot` or binary frames, and SHALL ignore binary input and `resize` from that connection.

#### Scenario: Dashboard tab still receives broadcasts

- **WHEN** a client is attached to a `dashboard` tab and another client creates a terminal
- **THEN** the dashboard-attached client receives the updated `sessions` broadcast

### Requirement: Tab metadata persists across server restarts

The registry SHALL persist all tabs' metadata to `<configDir>/tabs.json` on every mutation
(debounced). On boot, non-terminal tabs SHALL be restored fully; `terminal` entries SHALL
restore name/color only (no PTY is resurrected — one respawns on next attach to that id).
A missing or unparsable file SHALL result in an empty registry, not a crash.

#### Scenario: Web tab survives restart

- **WHEN** the server restarts with a `web` tab persisted in `tabs.json`
- **THEN** the tab reappears in the first `sessions` broadcast with its id, url, name, and color

#### Scenario: Terminal keeps its name across restart

- **WHEN** terminal tab `2` was named "api" and the server restarts
- **THEN** attaching to `/2` spawns a fresh PTY and the `sessions` broadcast shows tab 2 named "api"

#### Scenario: Corrupt tabs.json

- **WHEN** `tabs.json` contains invalid JSON at boot
- **THEN** the server starts normally with no restored tabs
