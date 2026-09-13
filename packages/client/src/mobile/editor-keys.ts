// ── Extra-keys bar → Monaco ───────────────────────────────────────────────────
//
// The bar exists because a phone keyboard has no ESC, no arrows, no HOME/END and
// no TAB. Those are exactly the keys an editor needs, and until the bar became
// always-present on mobile they were unreachable on an editor tab.
//
// This maps a bar key onto a Monaco COMMAND rather than a keyboard event, and
// that is not a stylistic choice. Measured against a live editor: real key
// presses moved the cursor, a synthetic `KeyboardEvent` carrying the same `key`,
// `code` and `keyCode` moved nothing. Monaco 0.55 reads input through the
// EditContext API, so it never sees events the browser did not deliver.
// `editor.trigger()` is the supported route and the only one that works.

import type { KeyMods } from './key-encoder';

/** What to do with a bar press inside an editor. */
export type EditorKeyAction =
  | { kind: 'command'; id: string }
  | { kind: 'type'; text: string }
  | { kind: 'none' };

const NONE: EditorKeyAction = { kind: 'none' };
const cmd = (id: string): EditorKeyAction => ({ kind: 'command', id });

/** Cursor motion, with the SHIFT variant that extends the selection instead. */
const motion = (plain: string, select: string, mods: KeyMods): EditorKeyAction =>
  cmd(mods.shift ? select : plain);

/**
 * Ctrl-combinations, which is where an editor and a terminal disagree most: in a
 * shell Ctrl+A goes to the start of the line, in an editor it selects the whole
 * buffer. The editor meaning wins here because that is the surface being driven.
 */
const withCtrl = (upper: string): EditorKeyAction => {
  switch (upper) {
    case 'A':
      return cmd('editor.action.selectAll');
    case 'C':
      return cmd('editor.action.clipboardCopyAction');
    case 'V':
      return cmd('editor.action.clipboardPasteAction');
    case 'X':
      return cmd('editor.action.clipboardCutAction');
    case 'Z':
      return cmd('undo');
    case 'Y':
      return cmd('redo');
    case 'F':
      return cmd('actions.find');
    case 'HOME':
      return cmd('cursorTop');
    case 'END':
      return cmd('cursorBottom');
    default:
      // A terminal control code has no editor meaning. Doing nothing is right:
      // typing a literal ^R into a file is never what the press meant.
      return NONE;
  }
};

/**
 * Resolve a bar key to an editor action.
 *
 * `name` is the bar's own key name (`ESC`, `UP`, `a`, …) — the same string
 * `encodeExtraKey` takes, so the two paths cannot disagree about what was pressed.
 */
export function editorKeyAction(name: string, mods: KeyMods): EditorKeyAction {
  if (!name) return NONE;
  const up = name.toUpperCase();

  if (mods.ctrl) return withCtrl(up);
  // ALT is a terminal idiom (ESC-prefixed sequences). Monaco binds it to nothing
  // a bar key should reach, so it is dropped rather than guessed at.
  if (mods.alt) return NONE;

  switch (up) {
    case 'UP':
      return motion('cursorUp', 'cursorUpSelect', mods);
    case 'DOWN':
      return motion('cursorDown', 'cursorDownSelect', mods);
    case 'LEFT':
      return motion('cursorLeft', 'cursorLeftSelect', mods);
    case 'RIGHT':
      return motion('cursorRight', 'cursorRightSelect', mods);
    case 'HOME':
      return motion('cursorHome', 'cursorHomeSelect', mods);
    case 'END':
      return motion('cursorEnd', 'cursorEndSelect', mods);
    case 'PGUP':
    case 'PAGEUP':
      return motion('cursorPageUp', 'cursorPageUpSelect', mods);
    case 'PGDN':
    case 'PAGEDOWN':
      return motion('cursorPageDown', 'cursorPageDownSelect', mods);
    case 'BKSP':
    case 'BACKSPACE':
      return cmd('deleteLeft');
    case 'DEL':
    case 'DELETE':
      return cmd('deleteRight');
    // ESC dismisses the find widget and collapses a selection — the two things
    // it does in an editor. Monaco routes both through cancelSelection.
    case 'ESC':
    case 'ESCAPE':
      return cmd('cancelSelection');
    case 'ENTER':
      return { kind: 'type', text: '\n' };
    case 'TAB':
      return cmd(mods.shift ? 'outdent' : 'tab');
    default:
      break;
  }

  // A single printable character types itself; anything longer is a key name
  // this map does not know, and typing its NAME into the file would be worse
  // than doing nothing.
  return [...name].length === 1 ? { kind: 'type', text: name } : NONE;
}
