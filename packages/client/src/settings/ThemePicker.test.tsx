// The theme picker. What matters here is that each option paints itself in ITS
// OWN palette — a picker whose swatches obeyed the current theme would show you
// the current theme once per row, which is exactly the failure the native
// <select> had and the reason this component exists.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ColorProfile } from './themes';
import { ThemePicker } from './ThemePicker';

const ramp = (base: number): number[] => Array.from({ length: 16 }, (_, i) => base + i * 0x010101);

const DARK: ColorProfile = {
  id: 'dark-one',
  name: 'Dark One',
  fg: 0xcdd6f4,
  bg: 0x1e1e2e,
  ansi16: ramp(0x101010),
  cursor: 0xa6e3a1,
};
const LIGHT: ColorProfile = {
  id: 'light-one',
  name: 'Light One',
  fg: 0x333333,
  bg: 0xfafafa,
  ansi16: ramp(0x202020),
};
const DARK2: ColorProfile = { ...DARK, id: 'dark-two', name: 'Dark Two' };

const PROFILES = [DARK, LIGHT, DARK2];

afterEach(cleanup);

const open = () => fireEvent.click(screen.getByTestId('set-theme'));

describe('ThemePicker', () => {
  it('shows the selected theme name on the closed trigger', () => {
    render(<ThemePicker profiles={PROFILES} value="light-one" onChange={vi.fn()} />);
    expect(screen.getByTestId('set-theme')).toHaveTextContent('Light One');
  });

  it('groups by brightness, registry order preserved inside each group', () => {
    render(<ThemePicker profiles={PROFILES} value="dark-one" onChange={vi.fn()} />);
    open();
    const groups = screen.getAllByRole('group');
    expect(groups).toHaveLength(2);
    expect(groups[0]).toHaveTextContent('Dark');
    expect(within(groups[0]!).getAllByRole('option').map((o) => o.textContent)).toHaveLength(2);
    expect(groups[1]).toHaveTextContent('Light');
    expect(within(groups[1]!).getAllByRole('option')).toHaveLength(1);
  });

  // The whole point. Each swatch is painted from ITS profile, not the app's.
  it('paints every swatch in its own background, foreground and cursor', () => {
    render(<ThemePicker profiles={PROFILES} value="dark-one" onChange={vi.fn()} />);
    open();
    const dark = screen.getByTestId('theme-swatch-dark-one');
    expect(dark.style.background).toBe('#1e1e2e');
    expect(dark.style.color).toBe('#cdd6f4');

    const light = screen.getByTestId('theme-swatch-light-one');
    expect(light.style.background).toBe('#fafafa');
    expect(light.style.color).toBe('#333333');

    // The cursor block uses the profile's explicit cursor colour, which nothing
    // else in the swatch shows and a palette can get wrong on its own.
    const cursor = dark.querySelector('.tp-swatch-cursor') as HTMLElement;
    expect(cursor.style.background).toBe('#a6e3a1');
  });

  it('falls back to the foreground when a profile declares no cursor', () => {
    render(<ThemePicker profiles={[LIGHT]} value="light-one" onChange={vi.fn()} />);
    open();
    const cursor = screen
      .getByTestId('theme-swatch-light-one')
      .querySelector('.tp-swatch-cursor') as HTMLElement;
    expect(cursor.style.background).toBe('#333333');
  });

  it('draws the preview lines with several distinct colours from that palette', () => {
    render(<ThemePicker profiles={PROFILES} value="dark-one" onChange={vi.fn()} />);
    open();
    const lines = screen.getByTestId('theme-swatch-dark-one').querySelectorAll('.tp-swatch-line');
    expect(lines).toHaveLength(2);
    const colours = new Set(
      [...lines].flatMap((l) => [...l.querySelectorAll('span')].map((s) => s.style.color)),
    );
    // A swatch painting one colour would prove nothing about the palette.
    expect(colours.size).toBeGreaterThan(5);
  });

  it('reports the chosen id', () => {
    const onChange = vi.fn();
    render(<ThemePicker profiles={PROFILES} value="dark-one" onChange={onChange} />);
    open();
    fireEvent.click(screen.getByTestId('theme-opt-light-one'));
    expect(onChange).toHaveBeenCalledWith('light-one');
  });

  // Radix marks the CURRENT value with `data-state="checked"` and moves
  // `aria-selected` with the highlighted item instead — the way a native select
  // announces, and the ring in theme-picker.css keys off the same attribute. So
  // that is the contract to pin, not aria-selected.
  it('marks the current option as checked, and only that one', () => {
    render(<ThemePicker profiles={PROFILES} value="dark-two" onChange={vi.fn()} />);
    open();
    expect(screen.getByTestId('theme-opt-dark-two')).toHaveAttribute('data-state', 'checked');
    expect(screen.getByTestId('theme-opt-dark-one')).toHaveAttribute('data-state', 'unchecked');
    expect(screen.getAllByRole('option').filter((o) => o.dataset.state === 'checked')).toHaveLength(
      1,
    );
  });

  it('renders a group only when it has members', () => {
    render(<ThemePicker profiles={[DARK, DARK2]} value="dark-one" onChange={vi.fn()} />);
    open();
    expect(screen.getAllByRole('group')).toHaveLength(1);
    expect(screen.queryByText('Light')).toBeNull();
  });
});
