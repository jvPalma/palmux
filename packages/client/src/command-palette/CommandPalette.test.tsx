import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CommandPalette, fuzzyMatch, type PaletteItem } from './CommandPalette';

afterEach(cleanup);

describe('fuzzyMatch', () => {
  it('matches subsequences, empty query matches all', () => {
    expect(fuzzyMatch('nt', 'New tab')).toBe(true);
    expect(fuzzyMatch('set', 'Open settings')).toBe(true);
    expect(fuzzyMatch('xyz', 'New tab')).toBe(false);
    expect(fuzzyMatch('', 'anything')).toBe(true);
  });
});

describe('CommandPalette', () => {
  const mkItems = (run: () => void): PaletteItem[] => [
    { key: 'newTab', label: 'New tab', hint: 'Ctrl+Shift+T', run },
    { key: 'settings', label: 'Open settings', hint: 'Ctrl+,', run: () => {} },
  ];

  it('filters by query and runs the selected item on Enter', () => {
    const run = vi.fn();
    const onClose = vi.fn();
    render(<CommandPalette items={mkItems(run)} onClose={onClose} />);
    fireEvent.change(screen.getByTestId('palette-input'), { target: { value: 'new' } });
    expect(screen.queryByTestId('palette-item-settings')).toBeNull();
    fireEvent.keyDown(screen.getByTestId('palette-input'), { key: 'Enter' });
    expect(run).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('runs an item on click', () => {
    const run = vi.fn();
    render(<CommandPalette items={mkItems(run)} onClose={() => {}} />);
    fireEvent.pointerDown(screen.getByTestId('palette-item-newTab'));
    expect(run).toHaveBeenCalledOnce();
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(<CommandPalette items={mkItems(() => {})} onClose={onClose} />);
    fireEvent.keyDown(screen.getByTestId('palette-input'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  describe('vim input mode', () => {
    it('vimMode off: typing filters normally and renders no vim badge', async () => {
      const user = userEvent.setup();
      render(<CommandPalette items={mkItems(() => {})} onClose={() => {}} />);
      expect(screen.queryByTestId('palette-vim-mode')).toBeNull();

      const input = screen.getByTestId('palette-input');
      input.focus();
      await user.keyboard('new');

      expect(input).toHaveValue('new');
      expect(screen.getByTestId('palette-item-newTab')).toBeInTheDocument();
      expect(screen.queryByTestId('palette-item-settings')).toBeNull();
      expect(screen.queryByTestId('palette-vim-mode')).toBeNull();
    });

    it('vimMode on: badge starts INSERT and typing filters normally', async () => {
      const user = userEvent.setup();
      render(<CommandPalette items={mkItems(() => {})} onClose={() => {}} vimMode />);
      expect(screen.getByTestId('palette-vim-mode')).toHaveTextContent('INSERT');

      const input = screen.getByTestId('palette-input');
      input.focus();
      await user.keyboard('new');

      expect(input).toHaveValue('new');
      expect(screen.queryByTestId('palette-item-settings')).toBeNull();
      expect(screen.getByTestId('palette-vim-mode')).toHaveTextContent('INSERT');
    });

    it('vimMode on: Escape enters NORMAL mode without closing the palette', async () => {
      const user = userEvent.setup();
      const onClose = vi.fn();
      render(<CommandPalette items={mkItems(() => {})} onClose={onClose} vimMode />);

      const input = screen.getByTestId('palette-input');
      input.focus();
      await user.keyboard('{Escape}');

      expect(screen.getByTestId('palette-vim-mode')).toHaveTextContent('NORMAL');
      expect(onClose).not.toHaveBeenCalled();
    });

    it('vimMode on: a SECOND Escape (normal mode, nothing pending) closes the palette', async () => {
      // Without this, vim users have no keyboard way out of the palette at all.
      const user = userEvent.setup();
      const onClose = vi.fn();
      render(<CommandPalette items={mkItems(() => {})} onClose={onClose} vimMode />);

      const input = screen.getByTestId('palette-input');
      input.focus();
      await user.keyboard('{Escape}'); // insert → normal
      expect(onClose).not.toHaveBeenCalled();
      await user.keyboard('{Escape}'); // normal, nothing pending → close

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('vimMode on: Escape with a pending operator cancels it instead of closing', async () => {
      const user = userEvent.setup();
      const onClose = vi.fn();
      render(<CommandPalette items={mkItems(() => {})} onClose={onClose} vimMode />);

      const input = screen.getByTestId('palette-input');
      input.focus();
      await user.keyboard('abc{Escape}'); // → normal
      await user.keyboard('d'); // pending operator
      await user.keyboard('{Escape}'); // cancels the operator, palette stays

      expect(onClose).not.toHaveBeenCalled();
      expect((input as HTMLInputElement).value).toBe('abc');
    });

    it('normal mode: an unmapped letter does not type into the query', async () => {
      const user = userEvent.setup();
      render(<CommandPalette items={mkItems(() => {})} onClose={() => {}} vimMode />);

      const input = screen.getByTestId('palette-input');
      input.focus();
      await user.keyboard('new{Escape}');
      expect(input).toHaveValue('new');

      // 'z' is not a vim motion/command in this reducer, so normal mode must
      // swallow it rather than typing it into the query.
      await user.keyboard('z');

      expect(input).toHaveValue('new');
      expect(screen.getByTestId('palette-vim-mode')).toHaveTextContent('NORMAL');
    });

    it("normal mode: 'i' returns to INSERT and typing resumes", async () => {
      const user = userEvent.setup();
      render(<CommandPalette items={mkItems(() => {})} onClose={() => {}} vimMode />);

      const input = screen.getByTestId('palette-input');
      input.focus();
      await user.keyboard('{Escape}');
      expect(screen.getByTestId('palette-vim-mode')).toHaveTextContent('NORMAL');

      await user.keyboard('i');
      expect(screen.getByTestId('palette-vim-mode')).toHaveTextContent('INSERT');

      await user.keyboard('ok');
      expect(input).toHaveValue('ok');
    });

    it("normal mode: 'dd' clears the query and resets the filter", async () => {
      const user = userEvent.setup();
      render(<CommandPalette items={mkItems(() => {})} onClose={() => {}} vimMode />);

      const input = screen.getByTestId('palette-input');
      input.focus();
      await user.keyboard('new{Escape}');
      expect(screen.queryByTestId('palette-item-settings')).toBeNull();

      await user.keyboard('dd');

      expect(input).toHaveValue('');
      expect(screen.getByTestId('palette-item-newTab')).toBeInTheDocument();
      expect(screen.getByTestId('palette-item-settings')).toBeInTheDocument();
    });

    it('vimMode on, INSERT mode: arrow keys and Enter still navigate and select', async () => {
      const user = userEvent.setup();
      const run = vi.fn();
      const onClose = vi.fn();
      render(<CommandPalette items={mkItems(run)} onClose={onClose} vimMode />);

      const input = screen.getByTestId('palette-input');
      input.focus();
      await user.keyboard('{ArrowDown}{Enter}');

      // ArrowDown moved selection off "New tab" onto "Open settings", so
      // Enter must run the settings item (a no-op) rather than `run`.
      expect(run).not.toHaveBeenCalled();
      expect(onClose).toHaveBeenCalledOnce();
    });
  });
});
