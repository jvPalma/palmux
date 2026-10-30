# Spec Delta

## MODIFIED Requirements

### Requirement: Editor font size follows the terminal

The Monaco editor's font size SHALL follow the device's code font size, a setting independent of the
terminal font size. Until the user first changes the code font size on a device, it SHALL equal that
device's terminal font size (plus the editor's existing small offset), so nothing jumps on upgrade. The
editor SHALL update live when the code font size changes, and a change of the terminal font size SHALL no
longer move an editor whose code font size was set.

#### Scenario: Editor matches terminal size

- **WHEN** the terminal font size is 14pt and the code font size was never changed on this device
- **THEN** the editor renders at the terminal size plus the editor's offset, not a fixed 13pt

#### Scenario: Live update

- **WHEN** the user changes the code font size while an editor tab is open
- **THEN** the open editor's font size updates without reopening the tab

#### Scenario: Independent of the terminal once set

- **WHEN** the code font size was set to 11 and the user then changes the terminal font size
- **THEN** the terminal changes and the editor stays at 11
