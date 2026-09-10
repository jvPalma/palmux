## MODIFIED Requirements

### Requirement: Tabs have a kind and metadata

The tab registry SHALL model every workspace slot as a tab
`{ id, kind: 'terminal' | 'web' | 'dashboard' | 'editor', name?, color?, url? }` where `id` is a
numeric string allocated lowest-free. The id is the identity used by the wire protocol
(`/ws?session=<id>`), persistence (`tabs.json`, `sessions/<id>.json`, `notes/<id>.md`), split
pairings and pop-out addressing. The id SHALL NOT appear in the application's URL path: the
browser address is `/` and which tab a window shows is per-window client state. Only `terminal`
tabs SHALL own a PTY; `terminal` tab behavior (spawn on first attach, replay ring, exit handling)
MUST be unchanged from the current session registry.

#### Scenario: Terminal tabs behave exactly as before

- **WHEN** a client attaches to `/ws?session=5` and no tab `5` exists
- **THEN** a `terminal` tab is created with a spawned PTY, and binary I/O, resize, replay, and
  exit behave identically to the pre-change session registry

#### Scenario: The id is wire and storage identity, not an address

- **WHEN** a tab is created, renamed, reordered, popped out and restored after a server restart
- **THEN** every one of those paths refers to it by the same id, and the browser address is `/`
  throughout
