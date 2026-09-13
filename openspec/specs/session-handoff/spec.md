# session-handoff Specification

## Purpose

Live-PTY handoff across a server restart — running shells survive, multi-client-aware, with a safe cold-respawn fallback.

## Requirements

### Requirement: Live-PTY handoff across a server restart

On a graceful restart signal (SIGUSR1, and self-update if enabled), the server SHALL export each live
terminal session — its PTY master file descriptor plus a manifest (`id`, name/color/group metadata,
replay ring buffer, tracked DEC/mouse mode state, shell pid, aggregated size) — and pass the fds to a
detached successor process which re-adopts them so the running shell survives with no `SIGHUP` to the
child. Reconnecting clients SHALL receive the replay ring and resume the SAME shell process, not a
fresh respawn.

#### Scenario: Shell survives a restart

- **WHEN** a long-running command is executing and the server is asked to hand off
- **THEN** after the successor takes over, reconnecting shows the same shell/process with output continuity, not a new shell

#### Scenario: Metadata and mode state preserved

- **WHEN** a session had mouse reporting / a custom title before handoff
- **THEN** those are restored to reattaching clients from the manifest

### Requirement: Handoff carries the session's geometry, and the reattaching client owns it

The manifest SHALL carry each session's `cols`/`rows` so the successor's PTY keeps a sane grid
before anyone attaches. A palmux PTY has ONE active attachment, so there is no aggregate to
compute: the first client to attach after the handoff resizes the PTY to its own grid, and an
evicted client's late resize is ignored. (This requirement previously described a
smallest-client-wins aggregate across mirrored clients; that model was removed with the move to
single-active-client, and the manifest never carried more than one geometry.)

#### Scenario: A reattaching client sets the size

- **WHEN** a session is handed off and a client attaches at a different size
- **THEN** the PTY takes that client's grid, not the pre-handoff one

### Requirement: Handoff degrades safely

If fd re-adoption fails (or is unsupported on the platform), the server SHALL fall back to today's
metadata-only cold respawn (tab identity preserved, shell restarted) rather than losing the tab or
crashing.

#### Scenario: Fallback to cold respawn

- **WHEN** the successor cannot re-adopt an inherited fd
- **THEN** the tab is restored with a fresh shell (today's behavior), no data loss beyond the live process
