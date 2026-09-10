// Soft-keyboard backspace must honour the extra-keys bar's armed modifiers.
// It used to emit a bare \x7f for every delete inputType, so CTRL/ALT+Backspace
// erased ONE character and left the modifier armed for the next keystroke.

import { useRef } from 'react';
import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useSoftKeyboard } from './useSoftKeyboard';
import { NO_MODS, type KeyMods } from './key-encoder';

const Host = ({
  sendInput,
  mods,
  pasteText,
}: {
  sendInput: (t: string) => void;
  mods: KeyMods;
  pasteText?: (t: string) => boolean;
}) => {
  const taRef = useRef<HTMLTextAreaElement>(null);
  useSoftKeyboard({
    taRef,
    active: true,
    sendInput,
    getMods: () => mods,
    isBlocked: () => false,
    ...(pasteText ? { pasteText } : {}),
  });
  return <textarea ref={taRef} id="mobile-kbd" />;
};

const setup = (mods: KeyMods = NO_MODS, pasteText?: (t: string) => boolean) => {
  const send = vi.fn();
  const { container } = render(
    <Host sendInput={send} mods={mods} {...(pasteText ? { pasteText } : {})} />,
  );
  return { send, ta: container.querySelector('textarea')! };
};

const beforeInput = (ta: HTMLTextAreaElement, inputType: string) =>
  fireEvent(ta, new InputEvent('beforeinput', { inputType, bubbles: true, cancelable: true }));

describe('backspace with sticky modifiers', () => {
  it('unmodified backspace still sends DEL', () => {
    const { send, ta } = setup();
    beforeInput(ta, 'deleteContentBackward');
    expect(send).toHaveBeenCalledWith('\x7f');
  });

  it('CTRL+backspace sends ^H — the shell binds that to its full-word kill', () => {
    const { send, ta } = setup({ ...NO_MODS, ctrl: true });
    beforeInput(ta, 'deleteContentBackward');
    expect(send).toHaveBeenCalledWith('\x08');
  });

  it('ALT+backspace sends ESC DEL (kill back to the word boundary)', () => {
    const { send, ta } = setup({ ...NO_MODS, alt: true });
    beforeInput(ta, 'deleteContentBackward');
    expect(send).toHaveBeenCalledWith('\x1b\x7f');
  });

  it('an unmodified deleteWordBackward keeps sending ^W', () => {
    const { send, ta } = setup();
    beforeInput(ta, 'deleteWordBackward');
    expect(send).toHaveBeenCalledWith('\x17');
  });

  it('ALT+deleteWordBackward switches to the word-boundary kill', () => {
    const { send, ta } = setup({ ...NO_MODS, alt: true });
    beforeInput(ta, 'deleteWordBackward');
    expect(send).toHaveBeenCalledWith('\x1b\x7f');
  });
});

describe('backspace mid-composition', () => {
  // happy-dom's CompositionEvent init drops `data`, so build the event by hand.
  const compose = (ta: HTMLTextAreaElement, ...steps: string[]) => {
    ta.dispatchEvent(new Event('compositionstart', { bubbles: true }));
    for (const data of steps) {
      const ev = new Event('compositionupdate', { bubbles: true });
      Object.defineProperty(ev, 'data', { value: data });
      ta.dispatchEvent(ev);
    }
  };

  it('a one-character shrink with no modifier erases one character', () => {
    const { send, ta } = setup();
    compose(ta, 'bar', 'ba');
    expect(send).toHaveBeenLastCalledWith('\x7f');
  });

  it('a one-character shrink with CTRL armed kills the whole word', () => {
    // GBoard composes almost every word, so this — not deleteContentBackward —
    // is the path a mid-word CTRL+Backspace actually takes.
    const { send, ta } = setup({ ...NO_MODS, ctrl: true });
    compose(ta, 'bar', 'ba');
    expect(send).toHaveBeenLastCalledWith('\x08');
  });
});

describe('clipboard paste', () => {
  // The keyboard hands a paste over as a beforeinput with a DataTransfer;
  // happy-dom's InputEvent init drops it, so attach it by hand.
  const paste = (ta: HTMLTextAreaElement, text: string) => {
    const ev = new InputEvent('beforeinput', {
      inputType: 'insertFromPaste',
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(ev, 'dataTransfer', { value: { getData: () => text } });
    fireEvent(ta, ev);
  };

  it('routes pasted text through the pane paste path, not raw sendInput', () => {
    // Raw sendInput sent the newlines as \n, which a TUI reads as Enter — the
    // paste submitted line by line instead of arriving as multi-line text.
    const pasteText = vi.fn(() => true);
    const { send, ta } = setup(NO_MODS, pasteText);

    paste(ta, 'line one\nline two');

    expect(pasteText).toHaveBeenCalledWith('line one\nline two');
    expect(send).not.toHaveBeenCalled();
  });

  it('never consumes an armed modifier on a single-character paste', () => {
    const pasteText = vi.fn(() => true);
    const { send, ta } = setup({ ...NO_MODS, ctrl: true }, pasteText);

    paste(ta, 'c');

    expect(pasteText).toHaveBeenCalledWith('c');
    expect(send).not.toHaveBeenCalled();
  });

  it('falls back to sendInput when no paste path is wired', () => {
    const { send, ta } = setup();
    paste(ta, 'hello');
    expect(send).toHaveBeenCalledWith('hello');
  });
});

describe('a paste the browser does not call a paste', () => {
  // Measured on Samsung's clipboard-history panel: pasting a 3997-character,
  // 64-line entry fires NO paste event and NO insertFromPaste. It arrives as
  // ONE beforeinput of inputType 'insertText' carrying the whole text.
  const insertText = (ta: HTMLTextAreaElement, data: string) => {
    const ev = new InputEvent('beforeinput', {
      inputType: 'insertText',
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(ev, 'data', { value: data });
    fireEvent(ta, ev);
  };

  it('routes multi-line insertText through the paste path, not as typing', () => {
    // As typing it reaches the shell as N lines typed by hand — no bracketed
    // paste, so the app RUNS them instead of inserting them.
    const pasteText = vi.fn(() => true);
    const { send, ta } = setup(NO_MODS, pasteText);

    insertText(ta, 'line one\nline two\nline three');

    expect(pasteText).toHaveBeenCalledWith('line one\nline two\nline three');
    expect(send).not.toHaveBeenCalled();
  });

  it('still treats ordinary typing as typing', () => {
    // The discriminator is a LINE BREAK, not length: a keystroke never has one,
    // and neither does an IME word commit or an autocorrect replacement.
    const pasteText = vi.fn(() => true);
    const { send, ta } = setup(NO_MODS, pasteText);

    insertText(ta, 'a');
    insertText(ta, 'palavra');

    expect(pasteText).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith('a');
    expect(send).toHaveBeenCalledWith('palavra');
  });

  it('keeps applying an armed modifier to a single keystroke', () => {
    const pasteText = vi.fn(() => true);
    const { send, ta } = setup({ ...NO_MODS, ctrl: true }, pasteText);

    insertText(ta, 'c');

    expect(pasteText).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith('\x03'); // ^C
  });

  it('does not swallow a paste it cannot read', () => {
    // Silently eating it is the worst outcome: no text, no error, no clue.
    const { send, ta } = setup();
    const ev = new InputEvent('beforeinput', {
      inputType: 'insertFromPaste',
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(ev, 'data', { value: '' });
    fireEvent(ta, ev);

    expect(send).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false); // the textarea still gets a chance
  });
});
