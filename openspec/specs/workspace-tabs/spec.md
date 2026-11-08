# workspace-tabs Specification

## Purpose

A workspace slot is a tab with a kind and metadata; the sessions broadcast carries it, clients create/update tabs over the wire, WS attach to a non-terminal tab is metadata-only, and tab metadata persists across restarts.

## Requirements

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

#### Scenario: Non-terminal tab holds no PTY

- **WHEN** a `web` tab exists in the registry
- **THEN** no PTY process is spawned for it and killing it terminates no process

#### Scenario: The id is wire and storage identity, not an address

- **WHEN** a tab is created, renamed, reordered, popped out and restored after a server restart
- **THEN** every one of those paths refers to it by the same id, and the browser address is `/`
  throughout

### Requirement: The sessions broadcast carries tab metadata

The `sessions` server message SHALL gain `tabs: TabMeta[]`
(`{ id, kind, name?, color?, url?, title?, preview?, replaces? }`) while continuing to send the existing `ids` and
`titles` fields derived from the same registry, so older clients keep working. `preview` SHALL be present only as
`true`. `replaces` SHALL name the tab a `replaceTab` swapped out for this one; it is a hint for placing the tab and
SHALL NOT be persisted.

#### Scenario: Broadcast on any tab mutation

- **WHEN** a tab is created, killed, renamed, recolored, retitled (OSC), pinned, replaced, or has its url changed
- **THEN** every connected client receives a `sessions` message whose `tabs` reflects the change

#### Scenario: Backward-compatible parsing

- **WHEN** a client built before this change receives the extended `sessions` message
- **THEN** it parses `ids`/`titles` successfully and ignores `tabs`, `preview` and `replaces`

### Requirement: Clients can create and update tabs over the wire

The client→server protocol SHALL add `createTab { kind, url?, name?, color?, preview? }`,
`updateTab { id, name?, color?, url?, preview? }` and `replaceTab { id, kind, url }`. `createTab` SHALL assign the
lowest free numeric id. The existing `kill { id }` SHALL close tabs of any kind. Invalid payloads (unknown kind,
non-existent id, `url` on a kind that has none) SHALL be ignored without disconnecting the
client, matching the parser's current forgiving posture.
`createTab { preview: true }` SHALL mark the new tab a preview only for the `editor` kind with a `url` and the
`review` kind; on any other kind, a tab note included, it SHALL create a pinned tab.
`updateTab { preview: false }` SHALL pin a tab; `updateTab { preview: true }` SHALL be ignored, so a pinned
tab never becomes a preview again. An `updateTab` that sets a name or a colour SHALL also pin the tab. Creating or joining a
group pins too, and moving a tab to another window SHALL NOT pin it (the full list is in preview-tabs "Using a preview
tab pins it").
`replaceTab { id, kind, url }`, for the `editor` and `review` kinds, SHALL be one registry operation answered with one
`sessions` broadcast and one `tabCreated`:

- when tab `id` is a preview shown by the sender's window, the same kind SHALL change its url and keep its id,
  and another kind SHALL put a new preview tab with a fresh id at `id`'s position in the order, carrying
  `replaces: id`, and remove tab `id`;
- otherwise (pinned, gone, or held by another window) it SHALL create a new preview tab exactly as `createTab` with
  `preview: true` would, and leave tab `id` untouched;
- a review url another tab already holds SHALL answer that tab and change nothing.

#### Scenario: Creating a web tab

- **WHEN** a client sends `createTab { kind: 'web', url: 'https://sb.example.com' }`
- **THEN** the registry adds a `web` tab at the lowest free id and broadcasts `sessions`

#### Scenario: Renaming clears with empty string

- **WHEN** a client sends `updateTab { id: '3', name: '' }`
- **THEN** tab 3's custom name is removed and display falls back to its OSC title or kind default

#### Scenario: Killing a non-terminal tab

- **WHEN** a client sends `kill { id }` for an `editor` tab
- **THEN** the tab is removed from the registry and persistence, and `sessions` is broadcast

#### Scenario: Creating a preview editor

- **WHEN** a client sends `createTab { kind: 'editor', url: '/home/u/a.ts', preview: true }`
- **THEN** the new tab is listed with `preview: true` in the `sessions` broadcast

#### Scenario: A web tab cannot be a preview

- **WHEN** a client sends `createTab { kind: 'web', url: 'https://sb.example.com', preview: true }`
- **THEN** the tab is created pinned, with no `preview` field

#### Scenario: Pinning is one-way

- **WHEN** a client sends `updateTab { id: '4', preview: false }` and later `updateTab { id: '4', preview: true }`
- **THEN** tab 4 is pinned after the first message and stays pinned after the second

#### Scenario: Renaming pins

- **WHEN** a client sends `updateTab { id: '4', name: 'notes' }` for a preview tab
- **THEN** tab 4 is named "notes" and is no longer a preview

#### Scenario: Moving to a window keeps the preview

- **WHEN** a client sends `moveToWindow { ids: ['4'], window: 'wabc123' }` for a preview tab
- **THEN** tab 4 is held by that window and is still a preview

#### Scenario: Replacing a preview of the same kind

- **WHEN** tab 4 is a preview editor of `/home/u/a.ts` and a main window sends
  `replaceTab { id: '4', kind: 'editor', url: '/home/u/b.ts' }`
- **THEN** tab 4 shows `/home/u/b.ts`, is still a preview, one `sessions` is broadcast and the sender gets
  `tabCreated { id: '4' }`

#### Scenario: Replacing a preview of another kind

- **WHEN** the order is `[1, 4, 7]`, tab 4 is a preview editor, and a main window sends
  `replaceTab { id: '4', kind: 'review', url: 'changes-file:%2Fapp:a.ts' }`
- **THEN** exactly one `sessions` is broadcast, its order is `[1, N, 7]` where N is a new preview review with
  `replaces: '4'`, tab 4 is gone from the registry and from `tabs.json`, and the sender gets `tabCreated { id: N }`

#### Scenario: Replacing a tab pinned meanwhile

- **WHEN** tab 4 is a pinned editor of `/home/u/a.ts` and a client sends
  `replaceTab { id: '4', kind: 'editor', url: '/home/u/b.ts' }`
- **THEN** tab 4 still shows `/home/u/a.ts` and a new preview tab of `/home/u/b.ts` is created

#### Scenario: Replacing another window's preview

- **WHEN** tab 4 is a preview held by detached window `wabc123` and a main window sends `replaceTab` for it
- **THEN** tab 4 is untouched and a new preview tab is created for the main window

#### Scenario: Following a link in a pinned file tab still works

- **WHEN** tab 4 is a pinned editor of `/home/u/a.md` in Read mode and the user follows a link to `b.md`, which
  sends `updateTab { id: '4', url: '/home/u/b.md' }`
- **THEN** tab 4 shows `/home/u/b.md`

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
