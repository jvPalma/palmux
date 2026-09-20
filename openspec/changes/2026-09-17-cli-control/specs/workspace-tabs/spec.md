## ADDED Requirements

### Requirement: Tabs can be created from a server-side command

The registry SHALL be creatable from a server-side command, not only from a
client's `createTab` message, and a tab created that way SHALL be broadcast to
every connected client exactly as a wire-created tab is. The rule that an
`editor` tab is reused when one already shows the same path SHALL be owned by the
server, so the Explorer and a server-side command cannot disagree about it.

#### Scenario: A server-created tab appears everywhere

- **WHEN** a tab is created by a server-side command while two clients are
  connected
- **THEN** both clients receive a `sessions` broadcast carrying it

#### Scenario: Reuse is decided once, on the server

- **WHEN** an `editor` tab already shows a path and a command opens the same path
- **THEN** the existing tab's id is returned and no second tab is added to the
  registry

### Requirement: The protocol carries a focus request and an activity ping

The server→client protocol SHALL add `focusTab { id, from? }`, a request that the
window identified by `from` navigate to tab `id`. `from` SHALL be omitted rather
than sent as an empty or undefined value when absent, so an absent key and an
absent origin are indistinguishable. A non-string `from` SHALL be dropped rather
than coerced, and a `focusTab` with no id SHALL be ignored.

The client→server protocol SHALL add `active`, which carries no fields. It SHALL
mean only that the sending window is in front. It MUST NOT carry a tab id.

#### Scenario: A focus request names its origin

- **WHEN** `{ type: 'focusTab', id: '5', from: '2' }` is encoded and parsed
- **THEN** both fields survive, and a request sent without `from` parses with the
  key absent

#### Scenario: A malformed origin is dropped, not coerced

- **WHEN** `{ type: 'focusTab', id: '5', from: 2 }` is parsed
- **THEN** the result is `{ type: 'focusTab', id: '5' }`

#### Scenario: An activity ping ignores a stray payload

- **WHEN** `{ type: 'active', tabId: '3' }` is parsed
- **THEN** the result is `{ type: 'active' }`, carrying no tab id

### Requirement: A shell knows which tab it belongs to

The server SHALL export the owning tab's id into every shell's environment when it
spawns a PTY. The value SHALL be the id of the tab that owns that PTY, and SHALL
survive both a handoff and a cold restore, which respawn under the same id.

#### Scenario: A shell can name its tab

- **WHEN** a terminal tab spawns a shell
- **THEN** the environment carries the tab's id

#### Scenario: A non-terminal spawn has no tab id

- **WHEN** a PTY is spawned without an owning tab
- **THEN** the variable is absent rather than empty or a placeholder
