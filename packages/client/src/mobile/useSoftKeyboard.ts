// ── Soft keyboard (hidden textarea) ───────────────────────────────────────────
//
// The terminal canvas can't raise a soft keyboard, so we focus a hidden textarea
// and forward its edits to the PTY. Two hard problems handled here:
//
//   • Live typing — Android GBoard composes a whole word before committing it on
//     space. A terminal needs each character immediately, so we diff every
//     compositionupdate and emit just the delta (backspaces for the removed
//     tail + the new text).
//   • Modifier combos — an armed sticky modifier from the extra-keys bar is
//     applied to the next single character, so "arm CTRL then type b" sends ^B
//     (the tmux prefix) even on a composing keyboard.
//
// A physical keyboard focused in the textarea is also supported via keydown.

import { useEffect } from 'react';
import { NO_MODS, encodeExtraKey, type KeyMods } from './key-encoder';
import { extractPasteImage } from '../terminal/pasteFile';

// Keeps the textarea non-empty so deleteContentBackward fires even with no real
// text typed — a zero-width space, invisible and harmless.
const KB_SENTINEL = '​';

/**
 * Is this insertion a PASTE, whatever the browser chose to call it?
 *
 * `insertFromPaste` is the honest answer, and some keyboards never give it.
 * Measured on Samsung's clipboard-history panel: pasting a 3997-character,
 * 64-line clipboard entry fires NO `paste` event and NO `insertFromPaste` — it
 * arrives as ONE `beforeinput` of `inputType: 'insertText'` carrying the whole
 * text. Treated as typing, that reaches the shell as 65 lines typed by hand:
 * no bracketed paste, so the app runs them instead of inserting them.
 *
 * A LINE BREAK is the discriminator, not a length threshold. A keystroke never
 * contains one, and neither does an IME word commit or an autocorrect
 * replacement — so this cannot misfire on real typing — while multi-line
 * content is exactly the case that must not be handed over as keystrokes. A
 * long single-line paste still arrives as typing, which is what typing a long
 * command already looks like, and is harmless.
 */
export function isPaste(inputType: string, data: string): boolean {
  return inputType === 'insertFromPaste' || /[\r\n]/.test(data);
}

// DOM KeyboardEvent.key → Termux key name, for physical-keyboard special keys.
const DOM_TO_TERMUX: Record<string, string> = {
  Escape: 'ESC',
  Tab: 'TAB',
  Enter: 'ENTER',
  Backspace: 'BKSP',
  Delete: 'DEL',
  Insert: 'INS',
  ArrowUp: 'UP',
  ArrowDown: 'DOWN',
  ArrowLeft: 'LEFT',
  ArrowRight: 'RIGHT',
  Home: 'HOME',
  End: 'END',
  PageUp: 'PGUP',
  PageDown: 'PGDN',
  F1: 'F1',
  F2: 'F2',
  F3: 'F3',
  F4: 'F4',
  F5: 'F5',
  F6: 'F6',
  F7: 'F7',
  F8: 'F8',
  F9: 'F9',
  F10: 'F10',
  F11: 'F11',
  F12: 'F12',
};

export interface UseSoftKeyboardParams {
  taRef: React.RefObject<HTMLTextAreaElement | null>;
  active: boolean;
  sendInput: (text: string) => void;
  /** Snapshot + consume the armed sticky modifiers from the extra-keys bar. */
  getMods: () => KeyMods;
  isBlocked: () => boolean;
  /**
   * Send pasted TEXT the way a terminal must: newlines as `\r`, wrapped in
   * bracketed-paste while the app has it on. Routing a paste through plain
   * `sendInput` instead sent raw `\n`, which a TUI reads as Enter — a
   * multi-line paste submitted line by line instead of arriving as text.
   */
  pasteText?: (text: string) => boolean;
  /** Handle an image pasted from the soft-keyboard clipboard (→ upload flow). */
  onImage?: (file: File) => void;
}

export interface SoftKeyboardController {
  toggle: () => void;
  focus: () => void;
  /**
   * Force the IME up even if the textarea never lost focus. Android dismisses
   * the keyboard on its own (back gesture, OS chrome, a long-press context
   * menu) WITHOUT blurring, and `focus()` on an already-focused element is a
   * no-op — so the only reliable re-raise is blur-then-focus. Must be called
   * inside a user gesture.
   */
  raise: () => void;
  blur: () => void;
}

export function useSoftKeyboard(params: UseSoftKeyboardParams): SoftKeyboardController {
  const { taRef, active, sendInput, getMods, isBlocked, pasteText, onImage } = params;

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;

    ta.value = KB_SENTINEL;
    const resetKbd = () => {
      ta.value = KB_SENTINEL;
    };

    // Apply an armed sticky modifier to a single character (CTRL+c → ^C).
    // Consume the modifier ONLY for a single-code-point insert; a multi-char
    // insert (paste, suggestion-strip tap, multi-char IME delta) leaves it
    // armed so it still applies to the user's next real keystroke.
    const sendText = (data: string) => {
      if ([...data].length === 1) {
        const mods = getMods();
        if (mods.ctrl || mods.alt || mods.shift) {
          sendInput(encodeExtraKey(data, mods));
          return;
        }
      }
      sendInput(data);
    };

    // `composed` mirrors the current IME composition; `committed` tracks word
    // chars sent via insertText. GBoard commits digits/punctuation immediately
    // and then re-includes them in the following word's composition — without
    // this, typing "4" then "p" sends 4, then "4p" → "44p".
    let composed = '';
    let committed = '';

    const onBeforeInput = (e: Event) => {
      const ie = e as InputEvent;
      if (!active || isBlocked()) {
        ie.preventDefault();
        return;
      }
      // Image paste from the keyboard clipboard (e.g. a screenshot): a text
      // textarea can't hold it, so grab it here and hand it to the upload flow.
      if (ie.inputType === 'insertFromPaste' && ie.dataTransfer) {
        const img = extractPasteImage(ie.dataTransfer);
        if (img) {
          ie.preventDefault();
          onImage?.(img);
          return;
        }
      }
      switch (ie.inputType) {
        case 'insertText':
        case 'insertReplacementText': // autocorrect / suggestion-strip taps
        case 'insertFromPaste': {
          // `||`, not `??`: a paste leaves `data` EMPTY rather than null in some
          // engines, and `'' ?? x` keeps the empty string — the clipboard text
          // would never be read at all.
          const data = ie.data || ie.dataTransfer?.getData('text') || '';
          if (!data) {
            // Nothing readable on either channel. Do NOT preventDefault: letting
            // the textarea take it is recoverable, silently eating it is not.
            return;
          }
          // A paste is never a keystroke: it goes through the pane's paste path
          // (\n → \r + bracketed paste) so its line breaks survive as text, and
          // it never consumes an armed sticky modifier.
          if (isPaste(ie.inputType, data) && pasteText) pasteText(data);
          else sendText(data);
          // Remember single committed word chars; a following composition may
          // re-include them. Whitespace / multi-char input ends the word.
          committed = data.length === 1 && !/\s/.test(data) ? committed + data : '';
          break;
        }
        case 'insertLineBreak':
          // Enter honours an armed modifier like every other key. It did not,
          // and a raw capture from a phone caught it: with CTRL armed the wire
          // carried a bare 0x0d. ALT+Enter is the one that changes bytes
          // (ESC CR, xterm's altSendsEscape); CTRL+Enter still resolves to CR,
          // but it must go through the encoder so the modifier is CONSUMED
          // rather than left armed to leak onto the next keystroke.
          sendInput(encodeExtraKey('ENTER', getMods()));
          committed = '';
          break;
        // Backspace must honour an armed sticky modifier exactly like every
        // other key: CTRL+BKSP → ^W, ALT+BKSP → ESC DEL. Sending a bare \x7f
        // here (as this did) both deleted a single character and LEFT the
        // modifier armed, so it leaked onto the next keystroke.
        case 'deleteContentBackward':
          sendInput(encodeExtraKey('BKSP', getMods()));
          committed = '';
          break;
        case 'deleteWordBackward': {
          // The keyboard already asked for a word delete; a modifier only
          // chooses WHICH word semantics. Unmodified stays ^W.
          const mods = getMods();
          sendInput(mods.ctrl || mods.alt ? encodeExtraKey('BKSP', mods) : '\x17');
          committed = '';
          break;
        }
        case 'insertCompositionText':
        case 'deleteCompositionText':
          return; // IME handles via compositionupdate/end
        default:
          return; // unknown edit: don't preventDefault
      }
      ie.preventDefault();
    };

    // Incremental composition forwarding.
    const sendCompositionDelta = (next: string) => {
      if (!active || isBlocked()) {
        composed = next;
        committed = '';
        return;
      }
      // If this composition re-includes chars already committed via insertText
      // (GBoard does this for digits/punctuation), treat them as already sent.
      if (composed === '' && committed && next.startsWith(committed)) {
        composed = committed;
      }
      committed = '';
      let i = 0;
      const max = Math.min(composed.length, next.length);
      while (i < max && composed[i] === next[i]) i++;
      const removed = composed.length - i;
      const added = next.slice(i);
      // A backspace pressed DURING a composition (the common case — GBoard
      // composes almost every word) arrives here as a one-character shrink, not
      // as deleteContentBackward. Honour an armed modifier so CTRL/ALT+BKSP
      // kills a word mid-word too. The shell then holds one fewer word than the
      // composition does; that divergence is harmless (the composition only
      // ever tracks the current word) and further typing still appends cleanly.
      // An armed modifier belongs to the DELETE, whatever else the delta
      // carries. Gating on `removed === 1 && !added` meant a delta that removed
      // and added in one step (a keyboard replacing the tail) sent a bare DEL
      // and then handed the modifier to the inserted character instead —
      // measured as `7f` followed by `18` (^X) for a CTRL-armed "b"→"x".
      const mods = removed > 0 ? getMods() : NO_MODS;
      const spentOnDelete = removed > 0 && (mods.ctrl || mods.alt);
      if (spentOnDelete) {
        sendInput(encodeExtraKey('BKSP', mods));
        // Only the first removal is modified; the rest are plain erases.
        for (let k = 1; k < removed; k++) sendInput('\x7f');
      } else {
        for (let k = 0; k < removed; k++) sendInput('\x7f'); // erase removed tail
      }
      // `sendText` reads the modifiers itself, and inside one key's event burst
      // `takeMods` replays the snapshot it just consumed — correct for one key
      // seen twice, wrong here, where the delete and the insert are two. Send
      // the added text raw once the modifier has gone to the delete.
      if (added) {
        if (spentOnDelete) sendInput(added);
        else sendText(added);
      }
      composed = next;
    };

    const onCompStart = () => {
      composed = '';
    };
    const onCompUpdate = (e: Event) => {
      sendCompositionDelta((e as CompositionEvent).data ?? '');
    };
    const onCompEnd = (e: Event) => {
      sendCompositionDelta((e as CompositionEvent).data ?? '');
      composed = '';
      committed = '';
      setTimeout(resetKbd, 0);
    };

    // Physical keyboard focused in the textarea: encode special / control keys
    // that don't emit a beforeinput event. Printables fall through to beforeinput.
    const onKeyDown = (e: KeyboardEvent) => {
      if (!active || isBlocked() || e.isComposing) return;
      const mods: KeyMods = {
        ctrl: e.ctrlKey,
        alt: e.altKey || e.metaKey,
        shift: e.shiftKey,
      };
      const termux = DOM_TO_TERMUX[e.key];
      if (termux) {
        // A named key ALSO has to see the bar's sticky modifier, which is not a
        // physical one — `e.ctrlKey` is false however orange the CTRL key looks.
        // Without this the soft keyboard's Backspace left here as a bare DEL and
        // `preventDefault()` below stopped the mods-aware `beforeinput` path from
        // ever running. `e.isComposing` is what hid it: while a composition is
        // live this handler returns above and the composition path (which does
        // read the bar) sends the right bytes — so CTRL+Backspace appeared to
        // work exactly once after typing a letter, and never again, because that
        // one backspace empties the one-character composition. Measured on a
        // phone as `6d 08` then `7f 7f 7f`.
        const sticky = getMods();
        mods.ctrl ||= sticky.ctrl;
        mods.alt ||= sticky.alt;
        mods.shift ||= sticky.shift;
        const out = encodeExtraKey(termux, mods);
        if (out) {
          sendInput(out);
          e.preventDefault();
        }
        return;
      }
      // Ctrl/Alt + single char (e.g. Ctrl+C) — no beforeinput fires for these.
      if ((mods.ctrl || mods.alt) && [...e.key].length === 1) {
        const out = encodeExtraKey(e.key, mods);
        if (out) {
          sendInput(out);
          e.preventDefault();
        }
      }
    };

    ta.addEventListener('beforeinput', onBeforeInput);
    ta.addEventListener('compositionstart', onCompStart);
    ta.addEventListener('compositionupdate', onCompUpdate);
    ta.addEventListener('compositionend', onCompEnd);
    ta.addEventListener('keydown', onKeyDown);
    return () => {
      ta.removeEventListener('beforeinput', onBeforeInput);
      ta.removeEventListener('compositionstart', onCompStart);
      ta.removeEventListener('compositionupdate', onCompUpdate);
      ta.removeEventListener('compositionend', onCompEnd);
      ta.removeEventListener('keydown', onKeyDown);
    };
  }, [taRef, active, sendInput, getMods, isBlocked, pasteText, onImage]);

  // Dismiss the keyboard when the mobile layer turns off.
  useEffect(() => {
    if (!active && taRef.current && document.activeElement === taRef.current) {
      taRef.current.blur();
    }
  }, [active, taRef]);

  return {
    toggle: () => {
      const ta = taRef.current;
      if (!ta) return;
      if (document.activeElement === ta) ta.blur();
      else ta.focus({ preventScroll: true });
    },
    focus: () => taRef.current?.focus({ preventScroll: true }),
    raise: () => {
      const ta = taRef.current;
      if (!ta) return;
      if (document.activeElement === ta) ta.blur();
      ta.focus({ preventScroll: true });
    },
    blur: () => taRef.current?.blur(),
  };
}
