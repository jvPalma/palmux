# diagnostics-and-latency Specification

## Purpose

Self-service diagnostics: a one-click report (version, sessions, captured console logs), a bounded console-capture ring buffer, and optional keydown-to-paint latency instrumentation.

## Requirements

### Requirement: One-click diagnostics report

palmux SHALL assemble a plain-text diagnostics report — including at least app/server version, ping/
reachability, active sessions/tabs, service-worker state, and captured console logs — behind a
one-click copy-to-clipboard action. The copy action MUST use a robust clipboard path that works in an
insecure (plain-HTTP LAN) context.

#### Scenario: Copy a diagnostics bundle

- **WHEN** the user invokes "diagnostics report"
- **THEN** a plain-text bundle with the listed sections is produced and copied to the clipboard

### Requirement: Console-capture ring buffer

palmux SHALL shadow `console.warn`/`console.error` into a bounded ring buffer from app start, feeding
the diagnostics report, without suppressing normal console output.

#### Scenario: Warnings captured for the report

- **WHEN** a warning is logged during the session and the user builds a diagnostics report
- **THEN** the recent warnings appear in the report (up to the ring capacity)

### Requirement: Keydown-to-paint latency instrumentation

palmux SHALL optionally measure input latency (keydown through paint phases) and surface rolling
percentile stats (e.g. p50/p95) in a debug view, off by default.

#### Scenario: Latency stats when enabled

- **WHEN** latency instrumentation is enabled and the user types
- **THEN** the debug view shows rolling p50/p95 keydown→paint figures
