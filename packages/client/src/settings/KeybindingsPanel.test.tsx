import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { KeybindingsPanel } from './KeybindingsPanel';
import { DEFAULT_BINDINGS, formatChord, loadBindings } from '../keybindings/keybindings';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('KeybindingsPanel', () => {
  it('rebinds an action to a captured chord and persists it', () => {
    render(<KeybindingsPanel onClose={() => {}} />);
    const btn = screen.getByTestId('kb-rebind-newTab');
    expect(btn.textContent).toBe(formatChord(DEFAULT_BINDINGS.newTab));

    fireEvent.click(btn);
    expect(btn.textContent).toBe('press keys…');
    fireEvent.keyDown(window, { key: 'n', ctrlKey: true, altKey: true });

    expect(btn.textContent).toBe('Ctrl+Alt+N');
    expect(loadBindings().newTab).toEqual({ key: 'n', ctrl: true, alt: true });
  });

  it('reports a conflict and does not apply it', () => {
    render(<KeybindingsPanel onClose={() => {}} />);
    fireEvent.click(screen.getByTestId('kb-rebind-tips'));
    // Ctrl+, is already bound to "settings" → conflict.
    fireEvent.keyDown(window, { key: ',', ctrlKey: true });
    expect(screen.getByTestId('kb-conflict').textContent).toContain('already bound');

    fireEvent.keyDown(window, { key: 'Escape' }); // cancel capture
    expect(screen.getByTestId('kb-rebind-tips').textContent).toBe(
      formatChord(DEFAULT_BINDINGS.tips),
    );
    expect(loadBindings().tips).toEqual(DEFAULT_BINDINGS.tips);
  });

  it('resets to defaults', () => {
    render(<KeybindingsPanel onClose={() => {}} />);
    fireEvent.click(screen.getByTestId('kb-rebind-newTab'));
    fireEvent.keyDown(window, { key: 'n', ctrlKey: true });
    expect(loadBindings().newTab).toEqual({ key: 'n', ctrl: true });

    fireEvent.click(screen.getByText('Reset to defaults'));
    expect(screen.getByTestId('kb-rebind-newTab').textContent).toBe(
      formatChord(DEFAULT_BINDINGS.newTab),
    );
    expect(loadBindings().newTab).toEqual(DEFAULT_BINDINGS.newTab);
  });
});
