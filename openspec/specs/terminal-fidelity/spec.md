# terminal-fidelity Specification

## Purpose

Higher-fidelity terminal features: OSC-7/OSC-133 shell integration, scrollback search, rich link detection, best-effort ligatures, and scrollback export.

## Requirements

### Requirement: Shell integration — OSC-7 cwd and OSC-133 command zones

The terminal SHALL register OSC-7 (current working directory) and OSC-133 (shell-integration prompt/
command/output marks) handlers, tracking the cwd and per-command output zones (capped), and SHALL
expose a "copy last command output" action driven by those zones. These handlers SHALL be additive on
stock xterm.js and MUST NOT affect terminals whose shell emits no such sequences.

#### Scenario: cwd tracked from OSC-7

- **WHEN** the shell emits an OSC-7 sequence on directory change
- **THEN** the tracked cwd updates and is available to features/UI that consume it

#### Scenario: Copy last output

- **WHEN** OSC-133 marks delimit a command's output and the user invokes copy-last-output
- **THEN** exactly that command's output text is copied

#### Scenario: No shell integration, no effect

- **WHEN** a shell emits no OSC-7/OSC-133
- **THEN** the terminal behaves exactly as today

### Requirement: Ctrl+F scrollback search UI

The terminal SHALL provide a search UI (over the already-loaded search addon) that finds matches in
scrollback + viewport, supports next/previous navigation, and can promote the active match into a real
selection copyable without a mouse. The search chord SHALL be governed by the `ctrlFSearch`
interception toggle.

#### Scenario: Find and navigate

- **WHEN** the user opens search and types a term
- **THEN** matches are highlighted and next/previous cycles through them

#### Scenario: Search gated by toggle

- **WHEN** `ctrlFSearch` is off
- **THEN** Ctrl+F sends the byte to the shell instead of opening search

### Requirement: Rich URL/link detection

The terminal SHALL detect links via OSC-8 hyperlinks AND a viewport regex pass, offer open-on-click,
and provide a right-click "Copy Link" affordance. The generic link handling SHALL be independent of
any proxy/OAuth rewriting (which is out of scope).

#### Scenario: OSC-8 hyperlink

- **WHEN** output contains an OSC-8 hyperlink
- **THEN** it is clickable and offers Copy Link on right-click

#### Scenario: Bare URL in output

- **WHEN** output contains a plain `https://…` URL with no OSC-8
- **THEN** the regex pass makes it clickable

### Requirement: Font ligature shaping (best-effort)

The terminal SHALL enable programming-ligature shaping where the active renderer supports it. Where
the stock renderer cannot shape ligatures, this SHALL be a documented limitation rather than a
renderer replacement, and the terminal SHALL continue to render correctly without ligatures.

#### Scenario: Ligatures where supported

- **WHEN** a ligature-capable font is active and the renderer supports shaping
- **THEN** sequences like `=>`/`!=` render as ligatures

#### Scenario: Graceful without shaping

- **WHEN** the renderer cannot shape ligatures
- **THEN** glyphs render individually and correctly; no crash, no blank cells

### Requirement: Scrollback export

The terminal SHALL support exporting current scrollback to plain text and/or HTML (via a serialize
addon) through a user action.

#### Scenario: Export scrollback to text

- **WHEN** the user invokes "export scrollback"
- **THEN** the current buffer is serialized to a downloadable text (or HTML) artifact
