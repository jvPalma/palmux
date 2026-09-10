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

### Requirement: Handoff is multi-client aware

Because a palmux PTY may have multiple simultaneously attached clients, the handoff manifest SHALL
carry the aggregated (smallest-client-wins) size rather than a single client geometry, and the
successor SHALL recompute size as clients reattach — preserving palmux's multi-client mirroring.

#### Scenario: Size recomputed after reattach

- **WHEN** two clients were attached at different sizes before handoff and one reattaches after
- **THEN** the PTY size reflects the reattached client(s) via smallest-client-wins, not a stale single geometry

### Requirement: Handoff degrades safely

If fd re-adoption fails (or is unsupported on the platform), the server SHALL fall back to today's
metadata-only cold respawn (tab identity preserved, shell restarted) rather than losing the tab or
crashing.

#### Scenario: Fallback to cold respawn

- **WHEN** the successor cannot re-adopt an inherited fd
- **THEN** the tab is restored with a fresh shell (today's behavior), no data loss beyond the live process
