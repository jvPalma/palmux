# recording-indicator Specification

## Purpose

Dictation reports itself with a non-blocking bottom-centre toast that shows real input level, keeps the terminal typeable, yields space on a small screen, and states the outcome without discarding the clip.

## Requirements

### Requirement: Recording shows a non-blocking indicator

Starting dictation SHALL show a recording indicator without opening or requiring any panel. The
indicator SHALL be a floating toast anchored **bottom-centre** over the content area, on both desktop
and mobile, showing a live input-level waveform, the elapsed time, and a Stop control. It SHALL NOT
be modal: the terminal SHALL remain focusable and typeable while it is shown.

#### Scenario: Recording with no panel open

- **WHEN** the user starts dictation from a keybinding while the dock is closed
- **THEN** the toast appears bottom-centre with a waveform, elapsed time and Stop, and no panel opens

#### Scenario: The terminal stays usable

- **WHEN** the toast is showing and the user types
- **THEN** the keystrokes reach the shell and the toast does not take focus

### Requirement: The indicator reflects real input level

The waveform SHALL be driven by the actual captured input level, not by a decorative loop, so that a
muted or dead microphone is visibly distinguishable from a working one.

#### Scenario: Silent microphone

- **WHEN** recording is running but no audio is being captured
- **THEN** the waveform stays flat rather than animating, making the failure visible before the user
  finishes speaking

### Requirement: The indicator yields space on a small screen

On a narrow viewport the toast sits above the extra-keys bar and SHALL reduce to a compact form —
level indicator, time and Stop — after a short delay, so it stops covering the prompt line during a
long dictation. It SHALL NOT change anchor position between breakpoints.

#### Scenario: Long dictation on a phone

- **WHEN** recording continues past the compaction delay on a narrow viewport
- **THEN** the toast shrinks in place, still bottom-centre, and the prompt line becomes visible again

### Requirement: Stopping states the outcome without losing the clip

Stopping SHALL hand off to the existing audio-first pipeline in which the clip is written before the
model is called. When transcription fails, the indicator SHALL report that the recording was kept and
point at the history entry, rather than reporting a bare error.

#### Scenario: Transcription fails

- **WHEN** the user stops recording and the model returns an error
- **THEN** the message says the recording was kept and can be transcribed later, and a history entry
  exists holding the audio
