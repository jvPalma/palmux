# idle-session-eviction Specification

## Purpose

Optional, configurable reaping of idle terminal sessions with no attached client; disabled by default.

## Requirements

### Requirement: Configurable idle-session eviction

The server SHALL optionally reap terminal sessions that have had no attached client for a configurable
idle timeout (config key + `PALMUX_*` env var), sweeping periodically. Eviction SHALL only apply to
terminal-kind tabs with no live client; non-terminal tabs and their metadata SHALL be unaffected. A
timeout of 0/unset SHALL disable eviction (today's behavior).

#### Scenario: Idle terminal reaped

- **WHEN** a terminal has had no attached client for longer than the configured timeout
- **THEN** its PTY is killed on the next sweep and its slot is freed

#### Scenario: Attached session never reaped

- **WHEN** a terminal has at least one attached client
- **THEN** it is never reaped regardless of age

#### Scenario: Eviction disabled by default

- **WHEN** no idle timeout is configured
- **THEN** no session is ever reaped by the sweep
