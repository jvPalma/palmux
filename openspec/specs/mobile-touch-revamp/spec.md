# mobile-touch-revamp Specification

## Purpose

A simplified mobile touch model: context-aware tap resolution, native-preferred text selection, removal of the inert horizontal swipe, and armed-modifier correctness across multi-character inserts.

## Requirements

### Requirement: Context-aware touch tap resolution

On touch, a tap on the terminal SHALL resolve by context into one of: forward an SGR mouse click when
a mouse-reporting app owns the terminal; open a link under a link cell; walk a single-row highlight to
a tapped row inside an OSC-133 output zone (menu-row tap, never auto-submitting); or walk the caret via
arrow sequences on a plain readline row — extending today's raise-keyboard-or-forward-mouse behavior.
Pinch-to-zoom SHALL be preserved.

#### Scenario: Tap forwards a mouse click under mouse reporting

- **WHEN** tmux/vim owns the mouse and the user taps a cell
- **THEN** an SGR click is forwarded to that cell

#### Scenario: Tap a readline row walks the caret

- **WHEN** a plain readline prompt is active and the user taps mid-line
- **THEN** the caret walks toward the tapped column via arrow sequences (no submit)

#### Scenario: Pinch-zoom still works

- **WHEN** the user pinches with two fingers
- **THEN** the font size zooms as before

### Requirement: Prefer native touch text-selection; keep custom only if native is infeasible

palmux SHALL prefer the browser/OS **native** text-selection and its native selection controls/handles
for selecting terminal text on touch, over a palmux-drawn handle UI. If native selection is genuinely
infeasible for the terminal renderer in use (e.g. the GPU/canvas renderer produces no selectable DOM
text and switching to a DOM-selectable rendering would regress GPU rendering), the existing custom
long-press selection SHALL be **kept as-is** — it MUST NOT be removed without a working replacement.

#### Scenario: Native selection when feasible

- **WHEN** native touch selection of terminal text is feasible for the active renderer
- **THEN** the user selects/copies via the OS-native selection and handles, and no palmux-drawn handle UI is used

#### Scenario: Fallback keeps the current feature

- **WHEN** native touch selection is not feasible for the active renderer
- **THEN** the existing custom long-press selection continues to work (it is not removed), so the user can still select and copy

### Requirement: Horizontal swipe-to-switch is removed

The horizontal swipe gesture on the terminal SHALL be removed entirely (it is currently inert). No
horizontal swipe SHALL switch sessions or trigger navigation; the drawer-open affordance (its own
button/edge) is unaffected.

#### Scenario: Horizontal swipe does nothing

- **WHEN** the user swipes horizontally across the terminal
- **THEN** no session switch and no navigation occurs

### Requirement: Armed modifier preserved across multi-character insert

An armed one-shot extra-keys modifier SHALL be preserved (not silently consumed) when the next input
is a multi-character insert (paste, suggestion-strip tap, multi-char IME delta); it SHALL apply only
to a single-character insert and otherwise remain armed.

#### Scenario: Multi-char insert keeps the armed modifier

- **WHEN** the user arms Ctrl and then a multi-character string is inserted
- **THEN** Ctrl stays armed and applies to the following single keystroke, not consumed by the multi-char insert

#### Scenario: Single-char insert consumes the armed modifier

- **WHEN** the user arms Ctrl and types a single character
- **THEN** the modifier applies to that character and disarms
