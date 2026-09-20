## ADDED Requirements

### Requirement: A `palmux` command drives a running instance from a shell

The system SHALL provide a single `palmux` command whose first argument selects a
subcommand, and whose bare-path form opens a file. The command SHALL talk to a
palmux instance that is ALREADY RUNNING on the same host; it MUST NOT start one,
and it MUST NOT open a browser window of its own. A bare invocation with no
arguments SHALL print help. `palmux serve` (and a leading `-`, which begins a
server flag) SHALL run the server, preserving the launcher behaviour that
predates this capability.

#### Scenario: Bare invocation prints help

- **WHEN** `palmux` is run with no arguments
- **THEN** it prints the command list and exits without contacting a server

#### Scenario: The server entry is still reachable

- **WHEN** `palmux --print-config` is run
- **THEN** the server entry parses the flag and prints the resolved configuration,
  exactly as before this capability existed

#### Scenario: A path is not a misspelled subcommand

- **WHEN** `palmux tabz` is run and no file named `tabz` exists
- **THEN** the command reports that the path does not exist rather than silently
  running the `tabs` subcommand

#### Scenario: A file named like a subcommand is still reachable

- **WHEN** the user runs `palmux open ./tabs` on a file named `tabs`
- **THEN** that file opens, because `open` names its argument explicitly

### Requirement: `palmux <path>` opens the file as an editor tab

The command SHALL open an absolute path, or a path relative to the invoker's
working directory, as an `editor` tab in the running instance. It SHALL reuse an
existing `editor` tab whose `url` is that path rather than creating a second tab
over the same file, and SHALL report which of the two happened. The command
SHALL refuse a path that does not exist, a path that is not a regular file, and a
directory, each with a message naming the reason; it MUST NOT create a tab in any
of those cases.

The existence check SHALL live in the server route rather than in the registry's
tab-creation path, because a text interface is where typos happen and a tab
created over a mistyped path fails silently.

#### Scenario: Opening a file creates one editor tab

- **WHEN** the user runs `palmux ~/.tmux.conf` and no tab is showing that path
- **THEN** an `editor` tab is created over that path and the command reports it
  as newly opened

#### Scenario: Opening the same file twice reuses the tab

- **WHEN** the user runs `palmux ~/.tmux.conf` again
- **THEN** no second tab is created, and the command reports that it moved to the
  tab already showing the path

#### Scenario: The dedupe covers editor tabs only

- **WHEN** a `markdown` tab and no `editor` tab shows the path
- **THEN** an `editor` tab is created, because the reuse rule is the Explorer's
  and the Explorer never creates a `markdown` tab

#### Scenario: A mistyped path creates nothing

- **WHEN** the user runs `palmux ~/.tmux.con` and that file does not exist
- **THEN** the command reports that the path does not exist, creates no tab, and
  exits non-zero

#### Scenario: A directory is refused with its own message

- **WHEN** the user runs `palmux /tmp`
- **THEN** the command reports that the path is a directory, creates no tab, and
  exits non-zero

### Requirement: The command targets the window it was run from

A shell spawned by palmux SHALL have its tab id exported into its environment, and
the command SHALL send that id so the window showing that tab navigates to the
opened file. The tab id in the environment SHALL be the id of the tab that owns
the shell's PTY.

The id MUST NOT be read inside tmux. A tmux server hands its environment to every
pane it creates, so a value read there can name a tab whose session ended — and
acting on it moves a window the user did not ask to move. Inside tmux the command
SHALL fall back to the rule for a command run from outside palmux.

Because which tab a window shows is browser-local state the server does not hold,
a command carrying a source tab SHALL be delivered to every control connection and
each client SHALL decide locally whether it matches. When no window matches — the
tab was closed, or it is showing nowhere — the tab SHALL still appear in every
strip and NO window SHALL navigate.

#### Scenario: The window that ran the command moves

- **WHEN** two windows are open on different tabs, and the user runs
  `palmux ~/.tmux.conf` from a shell inside the first window
- **THEN** the first window switches to the new editor tab and the second window
  does not move

#### Scenario: A source tab no window is showing moves nothing

- **WHEN** the command runs from a shell whose tab was since closed
- **THEN** the editor tab appears in every window's strip and no window navigates

#### Scenario: A pop-out does not navigate

- **WHEN** the pop-out window for a tab is open and a command carries that tab as
  its source
- **THEN** the pop-out does not change which tab it is showing, because it has no
  strip to move

### Requirement: A command from outside palmux targets the window in front

A client SHALL announce that its window is in front when its control connection
opens, when the window gains focus, and when its visibility returns to visible.
That announcement SHALL carry no tab id: the window states THAT it is in front,
never WHICH tab it is showing. The server SHALL hold the announcement only to
choose a target for a command that carries no source tab, and SHALL deliver such
a command to the single connection with the most recent announcement.

#### Scenario: A command from a desktop terminal moves the front window

- **WHEN** the user runs `palmux ~/.tmux.conf` from a terminal outside palmux
- **THEN** the most recently focused window switches to the new editor tab

#### Scenario: The announcement is not a selection

- **WHEN** a window is focused while showing tab `3`
- **THEN** the server learns that the window is in front, and does not learn that
  it is showing tab `3`

### Requirement: Read-only queries over the same route

The command SHALL answer `tabs`, `groups`, `settings` and `status` from the
running instance. `tabs` SHALL print the registry's own order — the order every
window's strip shows — and MUST NOT sort by id. `settings` SHALL print the
merged settings blob. No subcommand in this capability SHALL modify any state
other than creating an editor tab for a path.

#### Scenario: Listing tabs in strip order

- **WHEN** tabs have been reordered so that tab `2` precedes tab `0`, and the user
  runs `palmux tabs`
- **THEN** tab `2` is printed before tab `0`

#### Scenario: A group is shown over its members

- **WHEN** a group contains two tabs and the user runs `palmux tabs`
- **THEN** the group's header is printed once, followed by its members

#### Scenario: Status reports the instance

- **WHEN** the user runs `palmux status`
- **THEN** it prints the version, the port, the tab count and the connected-window
  count

### Requirement: The command surface is one authenticated route

The commands SHALL be served by a single route on the running instance, guarded by
the same session cookie gate as every other non-exempt route, so no new trust
model is introduced. The route SHALL refuse a request carrying an `Origin` header,
because a browser is not a palmux command. A response that is not JSON SHALL be
reported as a server that predates this capability, naming the stale process,
rather than as a parse failure.

#### Scenario: An unauthenticated request is refused

- **WHEN** the route is requested without a valid session cookie
- **THEN** it is refused by the same gate as every other non-exempt route

#### Scenario: A stale server is named as such

- **WHEN** the command reaches a server that predates this capability, which
  answers the application shell instead of a JSON body
- **THEN** the command reports that the server is running an older palmux and
  needs a restart, rather than reporting that the server sent no JSON

#### Scenario: A server that is not running is reported plainly

- **WHEN** the command runs on a host where nothing is listening on the resolved
  port
- **THEN** it reports that nothing is listening on that port and exits non-zero
