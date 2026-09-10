# trzsz-transfer Specification

## Purpose

In-band trzsz file transfer bridged transparently — coexisting with HTTP upload/download and passing through when absent.

## Requirements

### Requirement: In-band trzsz file transfer

The terminal SHALL provide an in-band file-transfer pipeline compatible with trzsz: a byte-stream
middleware in the PTY data path that detects the trzsz protocol, swallows/rewrites its control bytes
before they reach the visible terminal, and bridges transferred files to the browser (download to the
user, upload from the user) — working over the existing PTY connection without a separate HTTP round
trip. This SHALL coexist with palmux's existing out-of-band HTTP upload/download.

#### Scenario: Receive a file via trz

- **WHEN** the user runs `trz`/`tsz` in the shell and the client detects the trzsz handshake
- **THEN** the transfer proceeds in-band and the file is delivered to/from the browser without corrupting terminal output

#### Scenario: Non-trzsz traffic unaffected

- **WHEN** normal terminal output flows with no trzsz handshake
- **THEN** the middleware passes bytes through unchanged
