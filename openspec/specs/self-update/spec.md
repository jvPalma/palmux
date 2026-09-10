# self-update Specification

## Purpose

Opt-in, integrity-verified self-update: signed bundle download, atomic staging with rollback, and a coordinated restart notice.

## Requirements

### Requirement: Opt-in self-update with integrity verification

palmux SHALL provide an opt-in self-update from GitHub Releases that is disabled by default. When
enabled it SHALL be channel-aware (stable/prerelease), poll on a floor-clamped interval, download the
release bundle, and — before staging — verify a checksum AND a detached signature. An update that
fails verification SHALL be rejected and MUST NOT be applied.

#### Scenario: Disabled by default

- **WHEN** self-update is not explicitly enabled
- **THEN** the server never downloads or swaps a binary/bundle

#### Scenario: Unverified update rejected

- **WHEN** a downloaded release fails checksum or signature verification
- **THEN** the update is discarded and the running version is unchanged

### Requirement: Atomic staging with rollback

An applied update SHALL stage atomically and retain the previous bundle so a failed post-update
health-check triggers an automatic rollback to the prior version. Where the deployment runs from
source (`tsx`), self-update SHALL be a no-op (git is the update path).

#### Scenario: Rollback on failed health-check

- **WHEN** a verified update is applied but the new version fails its health-check
- **THEN** the previous bundle is restored automatically

#### Scenario: No-op on source deployment

- **WHEN** the server runs from source rather than the `bin/` bundle
- **THEN** self-update does nothing

### Requirement: Coordinated update restart notice

When an enabled self-update triggers a restart, the server SHALL notify connected clients so the
disconnect is presented as an intentional update (distinct from a lost connection), coordinating with
live-PTY handoff so shells survive.

#### Scenario: Clients told it's an update

- **WHEN** an auto-update restart occurs
- **THEN** clients show an "updating / reconnecting" state and their shells survive via handoff
