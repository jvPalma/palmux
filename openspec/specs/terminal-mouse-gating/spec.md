# terminal-mouse-gating Specification

## Purpose

Uncaught SGR mouse-report sequences (including motion frames) are gated at the terminal I/O boundary and never rendered as visible text, while legitimate mouse input to a reporting application is unaffected.

## Requirements

### Requirement: Uncaught mouse-report sequences are never rendered as text

Raw SGR mouse-report sequences (`\x1b[<b;x;yM` / `\x1b[<b;x;ym`, including motion frames such as button 35) SHALL NOT be rendered as visible text in the terminal; when such a client-originated sequence is not consumed as mouse input by the active application, it SHALL be gated at the terminal I/O boundary rather than printed. Legitimate mouse input to an application that has enabled mouse reporting SHALL be unaffected.

#### Scenario: Leaking motion frames do not print

- **WHEN** a stream containing `\x1b[<35;94;41M\x1b[<35;96;41M` reaches the terminal boundary and is not consumed as mouse input
- **THEN** no `35;94;41M` (or similar) text appears on screen

#### Scenario: Mouse input still reaches a reporting app

- **WHEN** the active application has enabled mouse reporting and a mouse/touch event occurs
- **THEN** the corresponding SGR mouse sequence is delivered to the application as input, unchanged

#### Scenario: A split mouse sequence is not partially printed

- **WHEN** a mouse-report sequence arrives split across two frames
- **THEN** neither fragment is rendered as visible text
