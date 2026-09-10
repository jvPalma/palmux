# version-identity Specification

## Purpose

A runtime version surface (endpoint, flag, handshake field) and client-side redeploy detection across reconnects.

## Requirements

### Requirement: Runtime version surface

The server SHALL expose a build version (git tag + short SHA) via `GET /version`, a `--version` CLI
flag, and a `version` field on the client `ready` message. The `/version` route SHALL be cookie-gated
consistently with the rest of the app (or explicitly exempted only if intended).

#### Scenario: Version via CLI

- **WHEN** the binary is run with `--version`
- **THEN** it prints the build version and exits

#### Scenario: Version on ready

- **WHEN** a client completes the handshake
- **THEN** the `ready` message carries the server's version

### Requirement: Client detects a redeploy across reconnect

The client SHALL compare the version on `ready` across reconnects and, on a change, surface a
"server updated — reload" affordance (or auto-reload), so a stale client doesn't silently run against a
newer server.

#### Scenario: Redeploy detected

- **WHEN** the server version changes between two `ready` messages on the same client
- **THEN** the client surfaces a reload affordance
