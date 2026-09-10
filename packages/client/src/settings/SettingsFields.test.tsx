// The settings FIELDS, tested directly. These assertions used to live in
// SettingsPanel.test.tsx and were never about the modal — every one of them
// reads a control that SettingsFields renders. The modal is gone (the dock is
// the desktop surface, the drawer the mobile one), so they moved here rather
// than being deleted with their host.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SettingsFields } from './SettingsFields';
import { DEFAULTS } from './settings';

afterEach(() => {
  cleanup();
});

describe('SettingsFields', () => {
  it('reflects the current value of the latency and native-selection toggles', () => {
    render(<SettingsFields settings={DEFAULTS} onChange={() => {}} />);

    // Toggles are the kit Switch now — a Radix `button role="switch"`, not a
    // native checkbox — so the state lives in aria-checked, not `.checked`. The
    // label association these assertions really care about is unchanged, which is
    // why getByLabelText still finds them.
    const latency = screen.getByLabelText(/latency overlay/i);
    expect(latency.id).toBe('set-latency');
    expect(latency.getAttribute('aria-checked')).toBe(String(DEFAULTS.latencyOverlay));

    // Native selection ships ON — the browser's own handles are the mobile default.
    const nativeSel = screen.getByLabelText(/native touch selection/i);
    expect(nativeSel.id).toBe('set-native-sel');
    expect(nativeSel.getAttribute('aria-checked')).toBe('true');
  });

  it('calls onChange with only the latency overlay field when toggled', () => {
    const onChange = vi.fn();
    render(<SettingsFields settings={DEFAULTS} onChange={onChange} />);

    fireEvent.click(screen.getByLabelText(/latency overlay/i));
    expect(onChange).toHaveBeenCalledWith({ latencyOverlay: true });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('calls onChange with only the native touch selection field when toggled', () => {
    const onChange = vi.fn();
    render(<SettingsFields settings={DEFAULTS} onChange={onChange} />);

    fireEvent.click(screen.getByLabelText(/native touch selection/i));
    expect(onChange).toHaveBeenCalledWith({ nativeTouchSelection: false });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('still renders the Vim input mode toggle', () => {
    render(<SettingsFields settings={DEFAULTS} onChange={() => {}} />);
    const vim = screen.getByLabelText(/vim input mode/i);
    expect(vim.id).toBe('set-vim');
    expect(vim.getAttribute('aria-checked')).toBe('false');
  });

  // The install row is inert until Chromium hands over a `beforeinstallprompt` —
  // it must render as a DISABLED button with the manual iOS route in the hint,
  // never as a button that does nothing when pressed.
  it('renders the install row disabled while no install prompt exists', () => {
    render(<SettingsFields settings={DEFAULTS} onChange={() => {}} />);

    const install = screen.getByTestId('install-pwa') as HTMLButtonElement;
    expect(install.disabled).toBe(true);
    expect(install.textContent).toBe('Install');
    expect(screen.getByText(/Add to Home Screen/i)).toBeTruthy();
  });
});

// ── Rows the desktop topbar used to hold ──────────────────────────────────────
//
// The topbar's ? button is gone with the rest of that action bar. Tips is the
// one of the three that nobody reaches for mid-session, so it became a row here
// rather than a sixth rail icon.
describe('shortcuts & tips', () => {
  it('renders the row only when a host can open the panel', () => {
    render(<SettingsFields settings={DEFAULTS} onChange={() => {}} />);
    expect(screen.queryByTestId('open-tips')).toBeNull();
    cleanup();
    render(<SettingsFields settings={DEFAULTS} onChange={() => {}} onOpenTips={() => {}} />);
    expect(screen.getByTestId('open-tips')).toBeTruthy();
  });

  it('opens the panel on click', () => {
    const onOpenTips = vi.fn();
    render(<SettingsFields settings={DEFAULTS} onChange={() => {}} onOpenTips={onOpenTips} />);
    fireEvent.click(screen.getByTestId('open-tips'));
    expect(onOpenTips).toHaveBeenCalledTimes(1);
  });

  // With the topbar action cluster gone, the rail is the only POINTER route to
  // Settings, Files, Dictation, the chooser AND Upload/Download. The warning has
  // to name what disappears — "panels" hid the fact that two ACTIONS go with it.
  it('names upload and download in the rail warning, not just panels', () => {
    render(<SettingsFields settings={{ ...DEFAULTS, sidebarRail: 'always' }} onChange={() => {}} />);
    const warning = screen.getByText(/command palette/i).textContent ?? '';
    expect(warning).toMatch(/upload/i);
    expect(warning).toMatch(/download/i);
    expect(warning).toMatch(/keybinding|command palette/i);
  });
});
