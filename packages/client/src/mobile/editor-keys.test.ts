// What the extra-keys bar does inside an editor. The bar is always present on
// mobile now — it is the only route to the drawer — so every key it shows has to
// mean something on an editor tab or the UI is lying about what it can do.

import { describe, expect, it } from 'vitest';
import { editorKeyAction } from './editor-keys';
import { NO_MODS, type KeyMods } from './key-encoder';

const mods = (over: Partial<KeyMods> = {}): KeyMods => ({ ...NO_MODS, ...over });

describe('editorKeyAction', () => {
  it('maps the keys a phone keyboard does not have', () => {
    expect(editorKeyAction('UP', mods())).toEqual({ kind: 'command', id: 'cursorUp' });
    expect(editorKeyAction('HOME', mods())).toEqual({ kind: 'command', id: 'cursorHome' });
    expect(editorKeyAction('PGDN', mods())).toEqual({ kind: 'command', id: 'cursorPageDown' });
    expect(editorKeyAction('TAB', mods())).toEqual({ kind: 'command', id: 'tab' });
  });

  it('extends the selection when SHIFT is armed', () => {
    expect(editorKeyAction('DOWN', mods({ shift: true }))).toEqual({
      kind: 'command',
      id: 'cursorDownSelect',
    });
    expect(editorKeyAction('END', mods({ shift: true }))).toEqual({
      kind: 'command',
      id: 'cursorEndSelect',
    });
  });

  it('outdents on Shift+Tab rather than inserting a tab', () => {
    expect(editorKeyAction('TAB', mods({ shift: true }))).toEqual({ kind: 'command', id: 'outdent' });
  });

  // The one place an editor and a terminal genuinely disagree: in a shell Ctrl+A
  // goes to the start of the line; in an editor it selects the buffer. The
  // surface being driven decides.
  it('gives Ctrl-combinations their EDITOR meaning', () => {
    expect(editorKeyAction('a', mods({ ctrl: true }))).toEqual({
      kind: 'command',
      id: 'editor.action.selectAll',
    });
    expect(editorKeyAction('z', mods({ ctrl: true }))).toEqual({ kind: 'command', id: 'undo' });
    expect(editorKeyAction('f', mods({ ctrl: true }))).toEqual({ kind: 'command', id: 'actions.find' });
  });

  // A control code has no editor meaning, and typing a literal ^R into a file is
  // never what the press meant — so it does nothing rather than something wrong.
  it('drops a Ctrl-combination with no editor meaning', () => {
    expect(editorKeyAction('r', mods({ ctrl: true })).kind).toBe('none');
  });

  // ALT is a terminal idiom (ESC-prefixed sequences). Guessing at an editor
  // equivalent would put unpredictable edits in a file.
  it('drops ALT entirely', () => {
    expect(editorKeyAction('LEFT', mods({ alt: true })).kind).toBe('none');
  });

  it('types a printable character', () => {
    expect(editorKeyAction('x', mods())).toEqual({ kind: 'type', text: 'x' });
    expect(editorKeyAction('|', mods())).toEqual({ kind: 'type', text: '|' });
  });

  it('types a newline for ENTER instead of running a command', () => {
    expect(editorKeyAction('ENTER', mods())).toEqual({ kind: 'type', text: '\n' });
  });

  // An unknown multi-character name is a key this map has not learned. Typing
  // its NAME into the document would be worse than ignoring the press.
  it('never types the NAME of a key it does not know', () => {
    expect(editorKeyAction('F13', mods()).kind).toBe('none');
    expect(editorKeyAction('SYSRQ', mods()).kind).toBe('none');
  });

  it('is case-insensitive about key names', () => {
    expect(editorKeyAction('esc', mods())).toEqual(editorKeyAction('ESC', mods()));
    expect(editorKeyAction('PageUp', mods())).toEqual(editorKeyAction('PGUP', mods()));
  });

  it('does nothing for an empty name', () => {
    expect(editorKeyAction('', mods()).kind).toBe('none');
  });
});
