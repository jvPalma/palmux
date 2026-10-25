// The settings FIELDS, tested directly. These assertions used to live in
// SettingsPanel.test.tsx and were never about the modal — every one of them
// reads a control that SettingsFields renders. The modal is gone (the dock is
// the desktop surface, the drawer the mobile one), so they moved here rather
// than being deleted with their host.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { parse, type AtRule, type Root } from 'postcss';
import { SettingsFields, type SettingsFieldsProps } from './SettingsFields';
import { reloadApp } from './app-reload';
import { DEFAULTS, type ClientSettings } from './settings';
import { allProfiles, registerDynamicThemes, type ColorProfile } from './themes';
import { Icon } from '../ui/icons';

// The reload itself is the one thing here that navigates the page away.
vi.mock('./app-reload', () => ({ reloadApp: vi.fn(() => Promise.resolve()) }));

afterEach(() => {
  cleanup();
  vi.mocked(reloadApp).mockClear();
});

/** The drawn shapes of a registered icon, to compare against what a control
 *  rendered. Rendered into a detached node so `screen` never sees it. */
const iconPaths = (name: string): string | undefined => {
  const host = document.createElement('div');
  render(<Icon name={name} />, { container: host });
  return host.querySelector('svg')?.innerHTML;
};

/** Every optional row switched on, so the whole field list is in the DOM. */
const FULL: SettingsFieldsProps = {
  settings: DEFAULTS,
  onChange: () => {},
  onOpenKeybindings: () => {},
  onOpenTips: () => {},
  onOpenDictationHistory: () => {},
  onImportTheme: () => {},
  onEditConfig: () => {},
  appVersion: '1.2.3',
};

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
  // Files, Dictation, the chooser AND Upload/Download. The warning has to name
  // what disappears — "panels" hid the fact that two ACTIONS go with it.
  it('names upload and download in the rail warning, not just panels', () => {
    render(<SettingsFields settings={{ ...DEFAULTS, sidebarRail: 'always' }} onChange={() => {}} />);
    const warning = screen.getByText(/command palette/i).textContent ?? '';
    expect(warning).toMatch(/upload/i);
    expect(warning).toMatch(/download/i);
    expect(warning).toMatch(/keybinding|command palette/i);
  });

  // Settings is the one entry hiding the rail does NOT cost a pointer route: the
  // topbar's app menu keeps it. The hint must say so, and must not list settings
  // among what goes away — in either state of the preference.
  it('tells the user Settings stays in the app menu while the rail is shown', () => {
    render(
      <SettingsFields settings={{ ...DEFAULTS, sidebarRail: 'always' }} onChange={() => {}} />,
    );
    const hint = screen.getByText(/command palette/i).textContent ?? '';
    expect(hint).toMatch(/settings stays in the app menu/i);
    const lost = /only route to ([^;]*)/i.exec(hint)?.[1] ?? '';
    expect(lost).toMatch(/files/i);
    expect(lost).not.toMatch(/settings/i);
  });

  it('tells the user Settings is in the app menu once the rail is hidden', () => {
    render(
      <SettingsFields settings={{ ...DEFAULTS, sidebarRail: 'hidden' }} onChange={() => {}} />,
    );
    const hint = screen.getByText(/command palette/i).textContent ?? '';
    expect(hint).toMatch(/settings is in the app menu/i);
    expect(hint).not.toMatch(/settings[^;]*reachable from the command palette/i);
    expect(hint).toMatch(/upload and download/i);
  });
});

// ── Reload app ────────────────────────────────────────────────────────────────
//
// The row used to flip to a disabled "Reloading…" BEFORE calling reload and never
// flip back. That was harmless while reload was unconditional; a host that can
// refuse (unsaved editors) turns it into a button stuck on "Reloading…" with
// nothing reloading.
describe('Reload app row', () => {
  const reloadButton = () => screen.getByTestId('reload-app') as HTMLButtonElement;
  const mount = (onReloadApp?: () => Promise<boolean>) =>
    render(<SettingsFields settings={DEFAULTS} onChange={() => {}} onReloadApp={onReloadApp} />);
  /** Click and let the host's promise settle. */
  const press = async () => {
    await act(async () => {
      fireEvent.click(reloadButton());
    });
  };

  it('reloads unconditionally when the host supplies nothing', async () => {
    mount();
    await press();
    expect(reloadApp).toHaveBeenCalledTimes(1);
    expect(reloadButton()).toBeDisabled();
    expect(reloadButton()).toHaveTextContent('Reloading…');
  });

  it('asks the host instead of reloading itself when one is supplied', async () => {
    const onReloadApp = vi.fn(() => Promise.resolve(true));
    mount(onReloadApp);
    await press();
    expect(onReloadApp).toHaveBeenCalledTimes(1);
    expect(reloadApp).not.toHaveBeenCalled();
    expect(reloadButton()).toHaveTextContent('Reloading…');
  });

  it('is not busy while the host is still deciding', async () => {
    let answer: (proceed: boolean) => void = () => {};
    mount(() => new Promise<boolean>((resolve) => (answer = resolve)));
    await press();
    expect(reloadButton()).not.toBeDisabled();
    expect(reloadButton()).toHaveTextContent('Reload');
    await act(async () => answer(true));
    expect(reloadButton()).toBeDisabled();
    expect(reloadButton()).toHaveTextContent('Reloading…');
  });

  it('stays usable after a cancel, and the retry proceeds without a remount', async () => {
    const onReloadApp = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    mount(onReloadApp);

    await press();
    expect(reloadButton()).not.toBeDisabled();
    expect(reloadButton()).toHaveTextContent('Reload');

    await press();
    expect(onReloadApp).toHaveBeenCalledTimes(2);
    expect(reloadButton()).toBeDisabled();
    expect(reloadButton()).toHaveTextContent('Reloading…');
  });

  it('stays usable after the host throws', async () => {
    const onReloadApp = vi
      .fn<() => Promise<boolean>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(true);
    mount(onReloadApp);

    await press();
    expect(reloadButton()).not.toBeDisabled();

    await press();
    expect(onReloadApp).toHaveBeenCalledTimes(2);
    expect(reloadButton()).toBeDisabled();
  });
});

// ── Layout: sections as cards, rows as a label and a control column ───────────
//
// happy-dom lays nothing out, so what is pinned here is the STRUCTURE the
// stylesheet hangs its two columns on, and (further down) the stylesheet's own
// promises, read as text. The measured heights and shared edges are a browser's
// to check.
describe('layout', () => {
  it('puts every section’s rows in one card', () => {
    render(<SettingsFields {...FULL} />);
    for (const title of ['appearance', 'terminal', 'keys', 'app']) {
      const content = screen.getByTestId(`settings-section-${title}-content`);
      const cards = content.querySelectorAll('.set-card');
      expect(cards, title).toHaveLength(1);
      // The card holds rows and nothing else, so a hairline between them is a
      // rule between siblings.
      const children = [...cards[0]!.children];
      expect(children.length, title).toBeGreaterThan(0);
      for (const child of children) expect(child.classList.contains('srow'), title).toBe(true);
    }
  });

  it('gives every row exactly one control, in the fixed column', () => {
    render(<SettingsFields {...FULL} />);
    const rows = document.querySelectorAll('.srow');
    expect(rows.length).toBeGreaterThan(15);
    for (const row of rows) {
      expect(row.querySelectorAll('.srow-control'), row.textContent ?? '').toHaveLength(1);
    }
  });

  it('keeps every control inside a `.srow-control`, section headers aside', () => {
    render(<SettingsFields {...FULL} />);
    const controls = document.querySelectorAll(
      "input, button:not(.ui-collapsible-trigger):not(.srow-link), [role='switch'], [role='combobox'], [role='group']",
    );
    expect(controls.length).toBeGreaterThan(15);
    for (const control of controls) {
      const name = control.getAttribute('data-testid') ?? control.outerHTML.slice(0, 60);
      expect(control.closest('.srow-control'), name).not.toBeNull();
    }
  });

  it('has no native select anywhere in the panel', () => {
    render(<SettingsFields {...FULL} />);
    expect(document.querySelectorAll('select')).toHaveLength(0);
    cleanup();
    render(<SettingsFields {...FULL} subView="themes" />);
    expect(document.querySelectorAll('select')).toHaveLength(0);
  });

  it('lets a stacked row span the whole card', () => {
    render(<SettingsFields {...FULL} />);
    const row = screen.getByTestId('set-theme-import').closest('.srow');
    expect(row).toHaveClass('srow-stacked');
    // Its field and its button are one control group, not two columns.
    expect(row?.querySelectorAll('.srow-control')).toHaveLength(1);
    expect(within(row as HTMLElement).getByTestId('set-theme-import-add')).toBeInTheDocument();
  });

  // A sentence that long in the label column was a 180px strip of one-word lines.
  // It is a note under the row, across the whole of it, and the label stays short.
  it('puts the sidebar-rail warning in a full-width note, not in the label column', () => {
    render(<SettingsFields {...FULL} />);
    const note = screen.getByText(/command palette/i);
    expect(note).toHaveClass('srow-note');
    const row = note.closest('.srow');
    expect(row?.querySelector('.srow-label')).toHaveTextContent(/^Sidebar rail$/);
    expect(row?.querySelector('.srow-label')).not.toContainElement(note);
    expect(row?.querySelector('.srow-control')).toContainElement(
      screen.getByTestId('set-sidebar-rail'),
    );
    // Spans both columns of the row's grid.
    let span = '';
    parse(cssText('settings/settings-view.css')).walkRules('.settings-view .srow-note', (rule) => {
      rule.walkDecls('grid-column', (d) => {
        span = d.value;
      });
    });
    expect(span).toBe('1 / -1');
  });

  // The section title is the kit's: the form restates none of its type. (What the
  // trigger renders is held by ui.test.tsx, which resolves the cascade.)
  it('titles each section with the kit’s collapsible trigger', () => {
    render(<SettingsFields {...FULL} />);
    for (const title of ['Appearance', 'Terminal', 'Keys', 'App']) {
      const trigger = screen.getByTestId(`settings-section-${title.toLowerCase()}-trigger`);
      expect(trigger).toHaveClass('ui-collapsible-trigger');
      expect(trigger).toHaveTextContent(title);
    }
  });
});

// ── Font: the kit Select ──────────────────────────────────────────────────────
describe('Font row', () => {
  const trigger = () => screen.getByTestId('set-font');

  it('is the kit Select, labelled by its row', () => {
    render(<SettingsFields settings={DEFAULTS} onChange={() => {}} />);
    expect(trigger()).toHaveClass('ui-select-trigger');
    expect(trigger()).toHaveAttribute('role', 'combobox');
    expect(trigger().id).toBe('set-font');
    expect(trigger().closest('.srow-control')).not.toBeNull();
    expect(screen.getByText('Font').closest('label')).toHaveAttribute('for', 'set-font');
  });

  it('shows the current font by its label, with the whole of it as the title', () => {
    render(
      <SettingsFields
        settings={{ ...DEFAULTS, fontFamily: '"Fira Code", ui-monospace, Menlo, monospace' }}
        onChange={() => {}}
      />,
    );
    expect(trigger()).toHaveTextContent('Fira Code');
    expect(trigger()).toHaveAttribute('title', 'Fira Code');
  });

  it('lists the presets and the families the server found, and reports a pick', () => {
    const onChange = vi.fn();
    render(<SettingsFields settings={DEFAULTS} onChange={onChange} fontFamilies={['Iosevka']} />);
    fireEvent.click(trigger());
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options).toContain('Fira Code');
    expect(options).toContain('System monospace');
    expect(options).toContain('Iosevka');

    fireEvent.click(screen.getByRole('option', { name: 'Iosevka' }));
    expect(onChange).toHaveBeenCalledWith({ fontFamily: '"Iosevka", ui-monospace, monospace' });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  // A hand-edited settings.json can hold any string; the current value must still
  // show, as its own text, rather than an empty box that reads as "nothing chosen".
  it('shows a custom font stack as its own text', () => {
    render(
      <SettingsFields
        settings={{ ...DEFAULTS, fontFamily: 'Comic Mono, monospace' }}
        onChange={() => {}}
      />,
    );
    expect(trigger()).toHaveTextContent('Comic Mono, monospace');
  });

  // Radix cannot hold an item whose value is '' and throws on one, which in the
  // dock is a panel lost to its error boundary.
  it('survives an empty font family', () => {
    expect(() =>
      render(<SettingsFields settings={{ ...DEFAULTS, fontFamily: '' }} onChange={() => {}} />),
    ).not.toThrow();
    expect(trigger()).toBeInTheDocument();
  });
});

// ── Long values truncate inside their control ─────────────────────────────────
describe('long values', () => {
  const LONG: ColorProfile = {
    id: 'user:cobalt-next-minimal',
    name: 'Cobalt Next Minimal',
    fg: 0xffffff,
    bg: 0x193549,
    ansi16: Array.from({ length: 16 }, (_, i) => i * 0x101010),
  };
  beforeEach(() => registerDynamicThemes([LONG]));
  afterEach(() => registerDynamicThemes([]));

  it('puts the full theme name in the Theme button’s title and truncates its label', () => {
    render(
      <SettingsFields
        settings={{ ...DEFAULTS, themeId: 'user:cobalt-next-minimal' }}
        onChange={() => {}}
      />,
    );
    const button = screen.getByTestId('set-theme');
    expect(button).toHaveAttribute('title', 'Cobalt Next Minimal');
    const name = button.querySelector('.srow-theme-name');
    expect(name).toHaveTextContent('Cobalt Next Minimal');
    expect(name).toHaveClass('srow-theme-name');
    expect(button).toHaveClass('srow-theme');
  });

  it('names the current theme to a screen reader, which a label alone would hide', () => {
    render(
      <SettingsFields
        settings={{ ...DEFAULTS, themeId: 'user:cobalt-next-minimal' }}
        onChange={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: 'Theme: Cobalt Next Minimal' })).toBe(
      screen.getByTestId('set-theme'),
    );
  });

  it('shows the id of a theme that is no longer registered, rather than nothing', () => {
    render(<SettingsFields settings={{ ...DEFAULTS, themeId: 'user:gone' }} onChange={() => {}} />);
    expect(screen.getByTestId('set-theme')).toHaveTextContent('user:gone');
  });

  it('truncates the build string and carries it whole as a title', () => {
    const build = 'build 1.2.3-rc.4+abcdef0123456789abcdef0123456789';
    render(
      <SettingsFields
        settings={DEFAULTS}
        onChange={() => {}}
        appVersion="1.2.3-rc.4+abcdef0123456789abcdef0123456789"
      />,
    );
    const value = screen.getByTitle(build);
    expect(value).toHaveClass('srow-value');
    expect(value).toHaveTextContent(build);
  });

  // A hint that is a SENTENCE wraps; only the build string is a value.
  it('leaves an ordinary hint wrapping', () => {
    render(<SettingsFields settings={DEFAULTS} onChange={() => {}} />);
    const hint = screen.getByText('clears caches and service worker');
    expect(hint).toHaveClass('srow-sub');
    expect(hint).not.toHaveClass('srow-value');
  });
});

// ── Edit config.json ──────────────────────────────────────────────────────────
describe('Edit config.json row', () => {
  it('exists only when a host can open the editor', () => {
    render(<SettingsFields settings={DEFAULTS} onChange={() => {}} />);
    expect(screen.queryByTestId('edit-config')).toBeNull();
    expect(screen.queryByText('Edit config.json')).toBeNull();
    cleanup();
    render(<SettingsFields settings={DEFAULTS} onChange={() => {}} onEditConfig={() => {}} />);
    expect(screen.getByTestId('edit-config')).toHaveTextContent('Edit config.json');
  });

  it('opens the editor on click', () => {
    const onEditConfig = vi.fn();
    render(<SettingsFields settings={DEFAULTS} onChange={() => {}} onEditConfig={onEditConfig} />);
    fireEvent.click(screen.getByTestId('edit-config'));
    expect(onEditConfig).toHaveBeenCalledTimes(1);
  });

  // The form the editor closes back to is a new one, so it cannot remember the
  // row that opened the editor: the host hands focus back through this.
  it('hands its host the row', () => {
    const ref = createRef<HTMLButtonElement>();
    render(
      <SettingsFields
        settings={DEFAULTS}
        onChange={() => {}}
        onEditConfig={() => {}}
        editConfigRef={ref}
      />,
    );
    expect(ref.current).toBe(screen.getByTestId('edit-config'));
  });

  it('is the last row of the form, a link with a chevron at the control column’s edge', () => {
    render(<SettingsFields settings={DEFAULTS} onChange={() => {}} onEditConfig={() => {}} />);
    const rows = [...document.querySelectorAll('.srow')];
    const row = screen.getByTestId('edit-config');
    expect(rows.at(-1)).toBe(row);
    expect(row.tagName).toBe('BUTTON');
    expect(row).toHaveClass('srow-link');
    const control = row.querySelector('.srow-control');
    expect(control?.querySelectorAll('svg')).toHaveLength(1);
    expect(control?.textContent).toBe('');
  });
});

// ── Theme: a button that opens an in-place browser ────────────────────────────
describe('theme sub-view', () => {
  const [A, B] = allProfiles().filter((p) => p.id !== DEFAULTS.themeId);
  if (!A || !B) throw new Error('the registry needs two themes besides the default');

  /** The host's side of `onChange`: apply the change, so the form re-renders with it. */
  const mount = (spy = vi.fn(), extra: Partial<SettingsFieldsProps> = {}) => {
    const Host = () => {
      const [settings, setSettings] = useState<ClientSettings>(DEFAULTS);
      return (
        <SettingsFields
          settings={settings}
          onChange={(partial) => {
            spy(partial);
            setSettings((s) => ({ ...s, ...partial }));
          }}
          {...extra}
        />
      );
    };
    render(<Host />);
    return spy;
  };

  it('shows the form first, with the Theme row as a button and no list', () => {
    mount();
    expect(screen.queryByTestId('theme-browser')).toBeNull();
    expect(screen.getByTestId('set-theme').tagName).toBe('BUTTON');
    expect(screen.getByTestId('set-theme')).toHaveTextContent(
      allProfiles().find((p) => p.id === DEFAULTS.themeId)?.name ?? '',
    );
  });

  it('opens the browser in place of the form, with a back control and a title', () => {
    mount();
    fireEvent.click(screen.getByTestId('set-theme'));
    expect(screen.getByTestId('theme-browser')).toBeInTheDocument();
    // In place: the sections are gone, not stacked underneath.
    expect(screen.queryByTestId('settings-section-appearance')).toBeNull();
    const back = screen.getByTestId('settings-themes-back');
    expect(back).toHaveTextContent('Settings');
    expect(back.querySelectorAll('svg')).toHaveLength(1);
    expect(screen.getByRole('heading', { name: 'Theme' })).toBeInTheDocument();
    // Every theme is listed, each in its own palette.
    for (const p of allProfiles()) {
      expect(screen.getByTestId(`theme-opt-${p.id}`)).toBeInTheDocument();
    }
  });

  it('marks the current theme with the check, and nothing else', () => {
    mount();
    fireEvent.click(screen.getByTestId('set-theme'));
    expect(
      screen.getByTestId(`theme-opt-${DEFAULTS.themeId}`).querySelector('.tb-check'),
    ).not.toBeNull();
    expect(document.querySelectorAll('.tb-check')).toHaveLength(1);
  });

  it('applies a theme on tap and keeps the list open for the next', () => {
    const spy = mount();
    fireEvent.click(screen.getByTestId('set-theme'));

    fireEvent.click(screen.getByTestId(`theme-opt-${A.id}`));
    expect(spy).toHaveBeenLastCalledWith({ themeId: A.id });
    expect(screen.getByTestId('theme-browser')).toBeInTheDocument();
    expect(screen.getByTestId(`theme-opt-${A.id}`).querySelector('.tb-check')).not.toBeNull();

    fireEvent.click(screen.getByTestId(`theme-opt-${B.id}`));
    expect(spy).toHaveBeenLastCalledWith({ themeId: B.id });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('theme-browser')).toBeInTheDocument();
    // The check moved; it did not copy.
    expect(document.querySelectorAll('.tb-check')).toHaveLength(1);
    expect(screen.getByTestId(`theme-opt-${B.id}`).querySelector('.tb-check')).not.toBeNull();
  });

  it('goes back to the form, whose Theme row then shows the last pick', () => {
    mount();
    fireEvent.click(screen.getByTestId('set-theme'));
    fireEvent.click(screen.getByTestId(`theme-opt-${A.id}`));
    fireEvent.click(screen.getByTestId(`theme-opt-${B.id}`));
    fireEvent.click(screen.getByTestId('settings-themes-back'));

    expect(screen.queryByTestId('theme-browser')).toBeNull();
    expect(screen.getByTestId('settings-section-appearance')).toBeInTheDocument();
    expect(screen.getByTestId('set-theme')).toHaveTextContent(B.name);
    expect(screen.getByTestId('set-theme')).toHaveAttribute('title', B.name);
  });

  it('opens from the keyboard', async () => {
    mount();
    screen.getByTestId('set-theme').focus();
    await userEvent.keyboard('{Enter}');
    expect(screen.getByTestId('theme-browser')).toBeInTheDocument();
  });

  describe('when a host lifts the back stack', () => {
    it('shows the sub-view it is told to and reports the way in and the way out', () => {
      const onSubViewChange = vi.fn();
      const { rerender } = render(
        <SettingsFields
          settings={DEFAULTS}
          onChange={() => {}}
          subView={null}
          onSubViewChange={onSubViewChange}
        />,
      );
      fireEvent.click(screen.getByTestId('set-theme'));
      expect(onSubViewChange).toHaveBeenLastCalledWith('themes');
      // Controlled: the host has not changed `subView`, so nothing opened.
      expect(screen.queryByTestId('theme-browser')).toBeNull();

      rerender(
        <SettingsFields
          settings={DEFAULTS}
          onChange={() => {}}
          subView="themes"
          onSubViewChange={onSubViewChange}
        />,
      );
      expect(screen.getByTestId('theme-browser')).toBeInTheDocument();
      fireEvent.click(screen.getByTestId('settings-themes-back'));
      expect(onSubViewChange).toHaveBeenLastCalledWith(null);
      // Same again: the host decides, and has not.
      expect(screen.getByTestId('theme-browser')).toBeInTheDocument();
    });

    it('lets the host return to the form without the form being told', () => {
      const { rerender } = render(
        <SettingsFields settings={DEFAULTS} onChange={() => {}} subView="themes" />,
      );
      rerender(<SettingsFields settings={DEFAULTS} onChange={() => {}} subView={null} />);
      expect(screen.queryByTestId('theme-browser')).toBeNull();
      expect(screen.getByTestId('set-theme')).toBeInTheDocument();
    });
  });
});

// ── The stylesheets' own promises, read as text ───────────────────────────────
//
// happy-dom neither lays out nor cascades, so these read the real stylesheets
// (PostCSS, so a comment or a string cannot desynchronise the read) the way
// ui.test.tsx and press-consumers.test.tsx do. What they cannot prove — that the
// controls MEASURE 28px at 1440 and 36px at 390, that a click draws no ring —
// is a browser's to check.
const SRC = join(__dirname, '..');
const cssText = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');

type Specificity = number;
/** Enough of Selectors 4 for the selectors these sheets use: ids, then classes /
 *  attributes / pseudo-classes, then types — no `:not()` nesting is relied on. */
const specificityOf = (selector: string): Specificity => {
  const ids = selector.match(/#[\w-]+/g)?.length ?? 0;
  const classes = selector.match(/\.[\w-]+|\[[^\]]*\]|(?<!:):(?!:)[\w-]+/g)?.length ?? 0;
  const types = selector.match(/(?:^|[\s>+~])[a-z][\w-]*/gi)?.length ?? 0;
  return ids * 10_000 + classes * 100 + types;
};

interface Decl {
  selector: string;
  value: string;
  specificity: Specificity;
  order: number;
  conditional: boolean;
}

/** Load order: the tokens, the kit, then the panel — the order main.tsx and the
 *  component imports give them. The result is the same either way round because
 *  the panel's selectors out-specify the kit's, which is what the test is for. */
const SHEETS = ['index.css', 'ui/ui.css', 'settings/settings-view.css'];

function declarationsOf(prop: string): Decl[] {
  const out: Decl[] = [];
  let order = 0;
  for (const file of SHEETS) {
    parse(cssText(file)).walkRules((rule) => {
      let conditional = false;
      for (let p = rule.parent; p && p.type !== 'root'; p = p.parent) {
        if (p.type === 'atrule') conditional = true;
      }
      rule.walkDecls(prop, (decl) => {
        order += 1;
        for (const selector of rule.selectors) {
          out.push({
            selector,
            value: decl.value.replace(/\s+/g, ' ').trim(),
            specificity: specificityOf(selector),
            order,
            conditional,
          });
        }
      });
    });
  }
  return out;
}

const matches = (el: Element, selector: string): boolean => {
  // A pseudo-element or a pointer/focus state is not the control at rest.
  if (/::|:(?:hover|active|focus|focus-visible|focus-within|disabled)\b/.test(selector)) {
    return false;
  }
  try {
    return el.matches(selector);
  } catch {
    return false;
  }
};

function winnerOn(el: Element, prop: string): Decl | null {
  let best: Decl | null = null;
  for (const d of declarationsOf(prop)) {
    if (!matches(el, d.selector)) continue;
    // A declaration inside a media query is not evaluated here: refuse to guess.
    if (d.conditional) throw new Error(`${d.selector} sets ${prop} inside an at-rule`);
    if (
      !best ||
      d.specificity > best.specificity ||
      (d.specificity === best.specificity && d.order > best.order)
    ) {
      best = d;
    }
  }
  return best;
}

/** A length in px, with `--ctl-h` resolved to `ctl`. Throws on anything it cannot
 *  read, naming the declaration — which is how a 30px kit floor winning shows up. */
function px(decl: Decl | null, ctl: number): number {
  if (!decl) throw new Error('no declaration reaches the element');
  const value = decl.value.replace(/var\(--ctl-h\)/g, `${ctl}px`);
  const plain = /^(\d+(?:\.\d+)?)px$/.exec(value);
  if (plain) return Number(plain[1]);
  const less = /^calc\((\d+(?:\.\d+)?)px - (\d+(?:\.\d+)?)px\)$/.exec(value);
  if (less) return Number(less[1]) - Number(less[2]);
  throw new Error(`${decl.selector} { ${decl.value} } is not a length this test can read`);
}

describe.each([
  ['desktop', undefined, 28],
  ['mobile', 'true', 36],
] as const)('control height on %s', (_, mobile, expected) => {
  beforeEach(() => {
    if (mobile) document.documentElement.dataset['mobile'] = mobile;
  });
  afterEach(() => {
    delete document.documentElement.dataset['mobile'];
  });

  const mount = () =>
    render(
      <SettingsFields
        settings={DEFAULTS}
        onChange={() => {}}
        onOpenKeybindings={() => {}}
        onImportTheme={() => {}}
      />,
    );

  // `--ctl-h` is read off the stylesheet the way the cascade resolves it for
  // :root, so a mobile value that stopped reaching the root would fail here
  // rather than leaving every assertion below comparing 28 to 28.
  it('resolves --ctl-h from the stylesheet', () => {
    expect(px(winnerOn(document.documentElement, '--ctl-h'), 0)).toBe(expected);
  });

  const SINGLE_BOX = {
    'an Input': 'set-size',
    'a Button': 'open-keybindings',
    'the Select trigger': 'set-font',
    'the Theme button': 'set-theme',
  } as const;

  it.each(Object.entries(SINGLE_BOX))('sets %s to exactly the control height', (_name, testId) => {
    mount();
    const el = screen.getByTestId(testId);
    expect(px(winnerOn(el, 'height'), expected), `${testId} height`).toBe(expected);
    // A `min-height` above the height would draw a taller box than `height` says
    // (the kit's floor was 30px once); unset, or at most the control height, is fine.
    const floor = winnerOn(el, 'min-height');
    expect(floor ? px(floor, expected) : 0, `${testId} min-height`).toBeLessThanOrEqual(expected);
  });

  it('sizes a Segmented’s outer box to the control height, its items to fit inside', () => {
    mount();
    const seg = screen.getByTestId('set-cursor');
    expect(px(winnerOn(seg, 'height'), expected)).toBe(expected);
    // The box adds its own padding and border around the items on both sides.
    const padding = px(winnerOn(seg, 'padding'), expected);
    const border = Number(/^(\d+(?:\.\d+)?)px/.exec(winnerOn(seg, 'border')?.value ?? '')?.[1]);
    expect(Number.isFinite(border)).toBe(true);
    for (const item of seg.querySelectorAll('.ui-seg-item')) {
      const min = px(winnerOn(item, 'min-height'), expected);
      expect(min + 2 * (padding + border), item.textContent ?? '').toBe(expected);
    }
  });

  it('gives a Switch a hit area as tall as the control, without changing the row', () => {
    mount();
    const switchRule = parse(cssText('settings/settings-view.css'));
    let hit: { height?: string; position?: string; top?: string } | undefined;
    switchRule.walkRules('.settings-view .ui-switch::before', (rule) => {
      hit = {};
      rule.walkDecls((d) => {
        if (d.prop === 'height' || d.prop === 'position' || d.prop === 'top') {
          hit![d.prop] = d.value;
        }
      });
    });
    expect(hit, 'no hit-area rule on the switch').toBeDefined();
    // Out of flow, so the row's layout box is unchanged.
    expect(hit?.position).toBe('absolute');
    expect(px({ selector: '::before', value: hit?.height ?? '' } as Decl, expected)).toBe(expected);
    // Centred on the visible 24px pill, so it overhangs it equally top and bottom.
    expect(hit?.top).toBe('calc(50% - var(--ctl-h) / 2)');
    // And there is a switch for it to belong to.
    expect(document.querySelectorAll('.ui-switch').length).toBeGreaterThan(0);
  });
});

describe('focus rings', () => {
  const SETTINGS_SHEETS = [
    'settings/settings-view.css',
    'settings/theme-browser.css',
    'settings/config-editor.css',
  ];

  it('draws no ring from a plain :focus rule in the settings stylesheets', () => {
    for (const file of SETTINGS_SHEETS) {
      parse(cssText(file)).walkRules((rule) => {
        for (const selector of rule.selectors) {
          expect(selector, `${file}: ${selector}`).not.toMatch(/:focus(?![-\w])/);
        }
      });
    }
  });

  it('draws no ring from a plain :focus rule in the kit either', () => {
    parse(cssText('ui/ui.css')).walkRules((rule) => {
      if (!rule.selectors.some((s) => /:focus(?![-\w])/.test(s))) return;
      rule.walkDecls((d) => {
        expect(d.prop, `${rule.selector} { ${d.prop} }`).not.toMatch(/^(?:outline|box-shadow)/);
      });
    });
  });

  // A reset would erase the keyboard ring; an editable input's border change is
  // a second cue and not a reset.
  it('resets no outline anywhere in the settings stylesheets', () => {
    for (const file of SETTINGS_SHEETS) {
      parse(cssText(file)).walkDecls(/^outline(?:-style|-width)?$/, (d) => {
        expect(
          d.value,
          `${file}: ${d.parent && 'selector' in d.parent ? d.parent.selector : ''}`,
        ).not.toMatch(/^(?:none|hidden|0(?:px)?)\b/);
      });
    }
  });

  it('rings the section header, the Theme button’s kit base and every theme entry on :focus-visible', () => {
    const kit = cssText('ui/ui.css');
    expect(kit).toMatch(/\.ui-collapsible-trigger:focus-visible/);
    expect(kit).toMatch(/\.ui-btn:focus-visible/);
    expect(kit).toMatch(/\.ui-input:focus-visible/);
    expect(cssText('settings/theme-browser.css')).toMatch(/\.tb-item:focus-visible/);
    expect(cssText('settings/settings-view.css')).toMatch(/\.srow-link:focus-visible/);
  });

  // A mouse click on a button does not match :focus-visible, so the header shows
  // no ring — provided nothing in the markup stands in for the pseudo-class.
  it('gives a clicked section header no focus class of its own', async () => {
    render(<SettingsFields settings={DEFAULTS} onChange={() => {}} />);
    const trigger = screen.getByTestId('settings-section-terminal-trigger');
    const before = trigger.className;
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger.className).toBe(before);
    expect(trigger.hasAttribute('data-focus-visible')).toBe(false);
  });

  it('leaves an editable input to the browser’s own ring', () => {
    // No `outline` declaration on any input class in the panel: the native
    // :focus-visible ring (and the kit's) is what shows.
    const sheet = parse(cssText('settings/settings-view.css'));
    sheet.walkRules((rule) => {
      if (!rule.selectors.some((s) => /ui-input|srow-num/.test(s))) return;
      rule.walkDecls(/^outline/, (d) => {
        throw new Error(`${rule.selector} sets ${d.prop}`);
      });
    });
    render(<SettingsFields settings={DEFAULTS} onChange={() => {}} />);
    expect(screen.getByTestId('set-scrollback')).toHaveClass('ui-input');
  });
});

describe('truncation', () => {
  const bodyOf = (file: string, selector: string): string => {
    let body = '';
    parse(cssText(file)).walkRules((rule) => {
      if (rule.selectors.includes(selector)) body += rule.nodes.map((n) => n.toString()).join(';');
    });
    return body;
  };

  it.each([
    ['settings/settings-view.css', '.settings-view .srow-theme-name'],
    ['settings/settings-view.css', '.settings-view .srow-value'],
    ['settings/theme-browser.css', '.tb-swatch-name'],
    ['settings/theme-browser.css', '.tb-swatch-line'],
  ])('keeps %s %s on one line, ending in an ellipsis', (file, selector) => {
    const body = bodyOf(file, selector);
    expect(body, `${selector} not found`).not.toBe('');
    expect(body).toContain('overflow: hidden');
    expect(body).toContain('text-overflow: ellipsis');
    expect(body).toContain('white-space: nowrap');
  });

  it('lets the Theme label shrink below its text, or the ellipsis never shows', () => {
    expect(bodyOf('settings/settings-view.css', '.settings-view .srow-theme-name')).toContain(
      'min-width: 0',
    );
  });
});

// ── The drawer's header is the back control there ─────────────────────────────
describe('sub-view back control inside the drawer', () => {
  // SessionDrawer lifts the sub-view so ITS header pops it. The form's own
  // `‹ Settings` would be the same control twice, one under the other, so the
  // stylesheet drops it inside the drawer's settings body — and only there.
  it('is hidden by the stylesheet inside .drawer-settings-body and nowhere else', () => {
    const hiders: string[] = [];
    parse(cssText('settings/settings-view.css')).walkRules((rule) => {
      rule.walkDecls('display', (d) => {
        if (d.value === 'none' && rule.selector.includes('.set-back')) hiders.push(rule.selector);
      });
    });
    expect(hiders).toEqual(['.drawer-settings-body .settings-view .set-back']);
  });

  it('still renders the control, so the dock (and any other host) has its back', () => {
    render(<SettingsFields settings={DEFAULTS} onChange={() => {}} subView="themes" />);
    expect(screen.getByTestId('settings-themes-back')).toBeInTheDocument();
  });
});

// ── The chevrons and the back control are the shared icons ────────────────────
describe('icons', () => {
  it('has two different chevrons to tell apart, or the checks below prove nothing', () => {
    expect(iconPaths('chevron-right')).toBeTruthy();
    expect(iconPaths('chevron-left')).toBeTruthy();
    expect(iconPaths('chevron-right')).not.toBe(iconPaths('chevron-left'));
  });

  it('ends the Theme button in chevron-right', () => {
    render(<SettingsFields {...FULL} />);
    const svgs = screen.getByTestId('set-theme').querySelectorAll('svg');
    expect(svgs).toHaveLength(1);
    expect(svgs[0]?.innerHTML).toBe(iconPaths('chevron-right'));
  });

  it('ends the Edit config.json row in chevron-right', () => {
    render(<SettingsFields {...FULL} />);
    const svgs = screen.getByTestId('edit-config').querySelectorAll('svg');
    expect(svgs).toHaveLength(1);
    expect(svgs[0]?.innerHTML).toBe(iconPaths('chevron-right'));
  });

  it('starts the theme sub-view’s back control with chevron-left', () => {
    render(<SettingsFields {...FULL} subView="themes" />);
    const svgs = screen.getByTestId('settings-themes-back').querySelectorAll('svg');
    expect(svgs).toHaveLength(1);
    expect(svgs[0]?.innerHTML).toBe(iconPaths('chevron-left'));
  });
});

// ── Rows: what the stylesheet promises about their geometry ───────────────────
//
// happy-dom lays nothing out, so a row's 44px, its fixed control column and its
// vertical centring cannot be MEASURED here (a browser does that: 1440px and
// 390px, every control sharing both edges). What can be pinned is the rules that
// produce them, read from the real sheets, and the markup they hang on.
describe('row geometry', () => {
  const VIEW = 'settings/settings-view.css';

  /** The declarations of the rule(s) whose selector list contains `selector`. */
  const rule = (file: string, selector: string): Record<string, string> => {
    const out: Record<string, string> = {};
    let found = false;
    parse(cssText(file)).walkRules((r) => {
      if (!r.selectors.includes(selector)) return;
      found = true;
      r.walkDecls((d) => {
        out[d.prop] = d.value.replace(/\s+/g, ' ').trim();
      });
    });
    expect(found, `${file}: no rule for ${selector}`).toBe(true);
    return out;
  };

  /** A `--sp-N` step as index.css declares it, so the arithmetic below is the sheet's own. */
  const spacing = (name: string): number => {
    const m = new RegExp(`${name}:\\s*(\\d+(?:\\.\\d+)?)px`).exec(cssText('index.css'));
    if (!m) throw new Error(`${name} is not declared in index.css`);
    return Number(m[1]);
  };
  const lengthOf = (value: string): number =>
    px(
      {
        selector: 'row geometry',
        value: value.replace(/var\((--sp-\d)\)/g, (_, name: string) => `${spacing(name)}px`),
        specificity: 0,
        order: 0,
        conditional: false,
      },
      28,
    );

  it('lays a row out as a flexible label column and one fixed control column, centred', () => {
    const row = rule(VIEW, '.settings-view .srow');
    expect(row['display']).toBe('grid');
    expect(row['grid-template-columns']).toBe('minmax(0, 1fr) var(--set-control)');
    // Centred whether or not the label carries a hint line under it.
    expect(row['align-items']).toBe('center');
  });

  it('declares the control column once, as a length, and lets the drawer set its own', () => {
    expect(rule('index.css', '.settings-form')['--set-control']).toMatch(/^\d+px$/);
    expect(rule('index.css', '.drawer-settings-body .settings-form')['--set-control']).toBe('55%');
  });

  // 28px of control and two 8px paddings is exactly the 44px floor, so a row with
  // no hint and a row with one both meet it with the control centred in either.
  it('floors a row at the control height plus its own padding: 44px on desktop', () => {
    const row = rule(VIEW, '.settings-view .srow');
    const [vertical] = (row['padding'] ?? '').split(' ');
    expect(lengthOf(vertical ?? '')).toBe(8);
    expect(lengthOf(row['min-height'] ?? '')).toBe(28 + 2 * lengthOf(vertical ?? ''));
  });

  // A border is height: without taking its pixel back from the padding, every row
  // after the first would be 45px beside a first row of 44.
  it('takes the hairline’s pixel back from the padding, so every row is the same height', () => {
    const first = rule(VIEW, '.settings-view .srow');
    const next = rule(VIEW, '.settings-view .srow + .srow');
    expect(next['border-top']).toBe('1px solid var(--t-surface)');
    const [vertical] = (first['padding'] ?? '').split(' ');
    const border = lengthOf(/^(\S+)/.exec(next['border-top'] ?? '')?.[1] ?? '');
    expect(lengthOf(next['padding-top'] ?? '') + border).toBe(lengthOf(vertical ?? ''));
    // The first row has no rule above it, and the last has none below.
    expect(first['border-top']).toBeUndefined();
    expect(first['border-bottom']).toBeUndefined();
  });

  it('draws the card as base on the panel, a 1px surface border and the card radius', () => {
    const card = rule(VIEW, '.settings-view .set-card');
    expect(card['background']).toBe('var(--t-base)');
    expect(card['border']).toBe('1px solid var(--t-surface)');
    expect(card['border-radius']).toBe('var(--r-3)');
    // A row's hover tint must not square off the card's corners.
    expect(card['overflow']).toBe('hidden');
  });

  it('fills the control column with the text-like controls, and not with a Switch', () => {
    for (const control of ['.ui-input', '.ui-btn', '.ui-seg', '.ui-select-trigger']) {
      const body = rule(VIEW, `.settings-view .srow-control > ${control}`);
      expect(body['width'], control).toBe('100%');
      // A flex item cannot shrink below its text otherwise, and nothing truncates.
      expect(body['min-width'], control).toBe('0');
    }
    let grouped = '';
    parse(cssText(VIEW)).walkRules((r) => {
      if (r.selectors.includes('.settings-view .srow-control > .ui-btn')) grouped = r.selector;
    });
    expect(grouped).not.toContain('ui-switch');
    // The column itself pushes whatever does not fill it to the right edge.
    const column = rule(VIEW, '.settings-view .srow-control');
    expect(column['justify-content']).toBe('flex-end');
    expect(column['min-width']).toBe('0');
  });

  it('collapses a stacked row to one column', () => {
    expect(rule(VIEW, '.settings-view .srow-stacked')['grid-template-columns']).toBe(
      'minmax(0, 1fr)',
    );
  });

  // The hint lives INSIDE the label, so a row with one is still two cells and a
  // taller label cell, never a third column or a second grid row for the control.
  it('keeps a hint inside the label: every row is a label cell and a control cell', () => {
    render(<SettingsFields {...FULL} />);
    const hinted = screen.getByText('terminal zoom, this device');
    expect(hinted).toHaveClass('srow-sub');
    expect(hinted.closest('.srow-label')).not.toBeNull();

    for (const row of document.querySelectorAll('.srow')) {
      const cells = [...row.children].map((c) => c.className.split(' ')[0]);
      // A note (the sidebar-rail warning) is the one optional third cell.
      expect(cells.slice(0, 2), row.querySelector('.srow-label')?.textContent ?? '').toEqual([
        'srow-label',
        'srow-control',
      ]);
      expect(cells.length, row.textContent ?? '').toBeLessThanOrEqual(3);
      if (cells.length === 3) expect(cells[2]).toBe('srow-note');
    }
  });
});

// ── Section titles: the form restates none of the kit's type ──────────────────
describe('section titles', () => {
  const TYPE = /^(?:font|font-size|font-weight|font-style|letter-spacing|text-transform|color)$/;

  it.each(['settings/settings-view.css', 'settings/config-editor.css'])(
    'sets no type or colour on a Collapsible trigger in %s',
    (file) => {
      const offenders: string[] = [];
      parse(cssText(file)).walkRules((rule) => {
        if (!rule.selectors.some((s) => s.includes('ui-collapsible-trigger'))) return;
        rule.walkDecls(TYPE, (d) => {
          offenders.push(`${rule.selector} { ${d.prop}: ${d.value} }`);
        });
      });
      // What remains on the trigger here is layout (height, padding) and nothing else.
      expect(offenders).toEqual([]);
    },
  );

  // The kit draws it; the form must not take it away.
  it('still sizes the trigger to the control height, so a header is as easy to hit as a row', () => {
    render(
      <SettingsFields
        settings={DEFAULTS}
        onChange={() => {}}
        onOpenKeybindings={() => {}}
        onImportTheme={() => {}}
      />,
    );
    const triggers = document.querySelectorAll('.settings-section > .ui-collapsible-trigger');
    expect(triggers.length).toBeGreaterThan(0);
    for (const trigger of triggers) {
      expect(px(winnerOn(trigger, 'min-height'), 28), trigger.textContent ?? '').toBe(28);
    }
  });
});

// ── Focus rings, resolved through the whole cascade ───────────────────────────
//
// The checks above read single rules. This one asks the question the user's eye
// does: for THIS element, which `outline` wins when it is focused from the
// keyboard — across every sheet, by specificity and then source order — and does
// anything draw a ring for a mere pointer focus? A reset that outranks the kit's
// ring (a later `.settings-view .ui-btn { outline: none }` ties it at 0,2,0 and
// wins on order) is invisible to a rule-by-rule read of the kit.
describe('focus rings, as the cascade resolves them', () => {
  const RING_SHEETS = [
    'index.css',
    'ui/ui.css',
    'settings/settings-view.css',
    'settings/theme-browser.css',
    'settings/config-editor.css',
  ];
  const parsed = new Map<string, Root>();
  const rootOf = (file: string): Root => {
    let root = parsed.get(file);
    if (!root) {
      root = parse(cssText(file));
      parsed.set(file, root);
    }
    return root;
  };

  interface Ring {
    selector: string;
    prop: string;
    value: string;
    specificity: number;
    order: number;
  }

  /**
   * Declarations of `props` that reach `el` while it is focused. `keyboard` also
   * takes the `:focus-visible` rules; `pointer` takes only the plain `:focus` ones
   * (and, below, is asked about the focus-triggered rules alone).
   */
  function reaching(el: Element, props: RegExp, state: 'keyboard' | 'pointer'): Ring[] {
    const out: Ring[] = [];
    let order = 0;
    for (const file of RING_SHEETS) {
      rootOf(file).walkRules((rule) => {
        let parent = rule.parent;
        for (; parent && parent.type !== 'root'; parent = parent.parent) {
          if (parent.type === 'atrule' && (parent as AtRule).name.endsWith('keyframes')) return;
        }
        rule.walkDecls(props, (decl) => {
          order += 1;
          for (const selector of rule.selectors) {
            if (selector.includes('::')) continue;
            if (state === 'pointer' && /:focus-visible\b/.test(selector)) continue;
            const base = selector.replace(/:focus-visible\b|:focus(?![-\w])/g, '').trim() || '*';
            let hit = false;
            try {
              hit = el.matches(base);
            } catch {
              hit = false;
            }
            if (!hit) continue;
            // Under an at-rule the declaration is conditional, and a guess would be
            // a lie: refuse, so a media query that touches a ring is read by a human.
            for (let p = rule.parent; p && p.type !== 'root'; p = p.parent) {
              if (p.type === 'atrule')
                throw new Error(`${selector} sets ${decl.prop} in an at-rule`);
            }
            out.push({
              selector,
              prop: decl.prop,
              value: decl.value.replace(/\s+/g, ' ').trim(),
              specificity: specificityOf(selector),
              order,
            });
          }
        });
      });
    }
    return out;
  }

  const winner = (rings: Ring[], prop: string): Ring | undefined =>
    rings
      .filter((r) => r.prop === prop)
      .reduce<Ring | undefined>(
        (best, r) =>
          !best ||
          r.specificity > best.specificity ||
          (r.specificity === best.specificity && r.order > best.order)
            ? r
            : best,
        undefined,
      );

  const RESET = /^(?:none|hidden|0(?:px)?)\b/;
  const RING = '2px solid var(--t-accent)';

  /** The controls a person can focus in the panel, by what they are. */
  const focusables = (): Array<[string, Element]> => {
    render(<SettingsFields {...FULL} />);
    const by = (id: string) => screen.getByTestId(id);
    return [
      ['a section header', by('settings-section-terminal-trigger')],
      ['the Theme button', by('set-theme')],
      ['a text Button', by('open-keybindings')],
      ['a number Input', by('set-scrollback')],
      ['the import Input', by('set-theme-import')],
      ['the Select trigger', by('set-font')],
      ['a Segmented item', by('set-cursor').querySelector('.ui-seg-item') as Element],
      ['a Switch', by('set-blink')],
      ['the Edit config.json link row', by('edit-config')],
    ];
  };

  it('draws the keyboard ring on every control, and nothing resets it', () => {
    for (const [name, el] of focusables()) {
      const rings = reaching(el, /^outline(?:-style|-width|-color)?$/, 'keyboard');
      expect(winner(rings, 'outline')?.value, `${name}: outline`).toBe(RING);
      // A longhand written later would erase the shorthand without touching it.
      for (const longhand of ['outline-style', 'outline-width']) {
        const w = winner(rings, longhand);
        if (w) expect(w.value, `${name}: ${w.selector} { ${longhand} }`).not.toMatch(RESET);
      }
    }
  });

  it('draws the keyboard ring on every theme entry and on the sub-view’s back control', () => {
    render(<SettingsFields {...FULL} subView="themes" />);
    const entries = [...document.querySelectorAll("[data-testid^='theme-opt-']")];
    expect(entries.length).toBeGreaterThan(5);
    for (const el of [...entries, screen.getByTestId('settings-themes-back')]) {
      const rings = reaching(el, /^outline(?:-style|-width|-color)?$/, 'keyboard');
      expect(winner(rings, 'outline')?.value, el.getAttribute('data-testid') ?? '').toBe(RING);
    }
  });

  // Not a ring after a mouse click: nothing focus-triggered (no `:focus-visible`)
  // draws an outline or a shadow. An editable input is the case that proves it is
  // not a blanket rule — it takes only a border colour on plain `:focus`, and the
  // browser's own `:focus-visible` match is what draws its ring after a click.
  it('draws nothing for a pointer focus on any control', () => {
    for (const [name, el] of focusables()) {
      const drawn = reaching(el, /^(?:outline(?:-style|-width|-color)?|box-shadow)$/, 'pointer')
        // Static rules (no focus pseudo at all) are the element's resting look.
        .filter((r) => /:focus(?![-\w])/.test(r.selector));
      expect(
        drawn.map((r) => `${r.selector} { ${r.prop}: ${r.value} }`),
        name,
      ).toEqual([]);
    }
  });

  it('gives an editable input a second cue beside the ring: its border', () => {
    render(<SettingsFields {...FULL} />);
    const border = reaching(screen.getByTestId('set-scrollback'), /^border-color$/, 'pointer')
      .filter((r) => /:focus(?![-\w])/.test(r.selector))
      .map((r) => r.value);
    expect(border).toContain('var(--t-accent)');
  });
});

// ── Tokens and motion in the settings sheets ──────────────────────────────────
//
// ui.test.tsx holds these two rules for ui.css alone. The settings panel is the
// largest consumer of the kit and has three sheets of its own, so the same
// promises are read here: only the eight real tokens, and only the four motion
// tiers, each with its reduced-motion escape.
describe('the settings stylesheets', () => {
  const SHEETS = [
    'settings/settings-view.css',
    'settings/theme-browser.css',
    'settings/config-editor.css',
  ];
  const REAL = new Set([
    '--t-base',
    '--t-mantle',
    '--t-surface',
    '--t-text',
    '--t-subtext',
    '--t-accent',
    '--t-accent-alt',
    '--t-accent-ink',
  ]);

  const declarationsIn = (file: string) => {
    const out: Array<{ selector: string; prop: string; value: string }> = [];
    parse(cssText(file)).walkDecls((d) => {
      out.push({
        selector: d.parent && 'selector' in d.parent ? String(d.parent.selector) : '',
        prop: d.prop,
        value: d.value.replace(/\s+/g, ' ').trim(),
      });
    });
    return out;
  };

  it.each(SHEETS)('%s writes no colour literal', (file) => {
    const literal = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/i;
    const named = /\b(?:white|black|red|green|blue|gray|grey|yellow|orange|purple|pink|cyan)\b/i;
    const offenders = declarationsIn(file)
      .filter((d) => /color|background|border|outline|shadow|fill|stroke/.test(d.prop))
      .filter((d) => literal.test(d.value) || named.test(d.value))
      .map((d) => `${d.selector} { ${d.prop}: ${d.value} }`);
    expect(offenders).toEqual([]);
  });

  it.each(SHEETS)('%s names only the real colour tokens (there is no --t-crust)', (file) => {
    const used = declarationsIn(file)
      .filter((d) => !d.prop.startsWith('font'))
      .flatMap((d) => [...d.value.matchAll(/var\(\s*(--t-[a-z-]+)/g)].map((m) => m[1] ?? ''));
    // A sheet that names no token at all would pass the check below by saying nothing.
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((token) => !REAL.has(token))).toEqual([]);
  });

  it.each(SHEETS)('%s takes every duration from the motion tiers', (file) => {
    const TIERS = new Set(['--mo-0', '--mo-micro', '--mo-surface', '--mo-enter', '--mo-stagger']);
    const motion = declarationsIn(file).filter((d) => /^(?:transition|animation)/.test(d.prop));
    for (const d of motion) {
      const where = `${d.selector} { ${d.prop}: ${d.value} }`;
      // `0.001ms` is the reduced-motion collapse, not a tier of its own.
      const bare = d.value.replace(/0\.001ms/g, '').replace(/var\([^)]*\)/g, '');
      expect(bare, where).not.toMatch(/\d+(?:\.\d+)?m?s\b/);
      for (const m of d.value.matchAll(/var\(\s*(--mo-[a-z0-9-]+)/g)) {
        const token = m[1] ?? '';
        expect(token === '--mo-ease' || TIERS.has(token), where).toBe(true);
      }
    }
  });

  it.each(SHEETS)('%s collapses any transition under prefers-reduced-motion', (file) => {
    const root = parse(cssText(file));
    let transitions = 0;
    root.walkDecls(/^transition(?:-property)?$/, (d) => {
      if (d.parent?.parent?.type === 'root') transitions += 1;
    });
    if (transitions === 0) return;
    let collapsed = false;
    root.walkAtRules('media', (at) => {
      if (!at.params.includes('prefers-reduced-motion')) return;
      at.walkDecls('transition-duration', (d) => {
        if (d.value === '0.001ms' && d.important) collapsed = true;
      });
    });
    expect(collapsed, `${file} transitions but has no reduced-motion escape`).toBe(true);
  });

  // The editor owns its own box, and a list of up to twenty cursors is a strobe.
  it.each([
    ['settings/config-editor.css', '.config-editor-host'],
    ['settings/theme-browser.css', '.tb-swatch-cursor'],
    ['settings/theme-browser.css', '.tb-swatch'],
  ])('%s never animates %s', (file, selector) => {
    const motion = declarationsIn(file).filter(
      (d) => d.selector === selector && /^(?:transition|animation)/.test(d.prop),
    );
    expect(motion).toEqual([]);
  });
});

// ── The theme sub-view, at its edges ──────────────────────────────────────────
describe('theme sub-view edges', () => {
  it('opens and closes without changing a single setting', () => {
    const onChange = vi.fn();
    render(<SettingsFields {...FULL} onChange={onChange} />);
    fireEvent.click(screen.getByTestId('set-theme'));
    expect(screen.getByTestId('theme-browser')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('settings-themes-back'));
    expect(screen.getByTestId('set-theme')).toBeInTheDocument();
    // Looking at the themes is not choosing one.
    expect(onChange).not.toHaveBeenCalled();
  });

  it('goes back from the keyboard too', async () => {
    render(<SettingsFields {...FULL} />);
    fireEvent.click(screen.getByTestId('set-theme'));
    screen.getByTestId('settings-themes-back').focus();
    await userEvent.keyboard('{Enter}');
    expect(screen.queryByTestId('theme-browser')).toBeNull();
    expect(screen.getByTestId('set-theme')).toBeInTheDocument();
  });

  // A theme that was removed from disk after being chosen: the browser must still
  // open and must not pretend another entry is the current one.
  it('marks nothing as current when the stored theme is no longer registered', () => {
    render(
      <SettingsFields
        {...FULL}
        settings={{ ...DEFAULTS, themeId: 'user:gone' }}
        subView="themes"
      />,
    );
    expect(document.querySelectorAll('.tb-check')).toHaveLength(0);
    expect(
      document.querySelectorAll("[data-testid^='theme-opt-'][data-state='checked']"),
    ).toHaveLength(0);
    expect(document.querySelectorAll('[aria-current]')).toHaveLength(0);
  });

  it('lists every registered theme once, and a dynamically registered one too', () => {
    registerDynamicThemes([
      {
        id: 'user:extra',
        name: 'Extra',
        fg: 0xffffff,
        bg: 0x000000,
        ansi16: Array.from({ length: 16 }, (_, i) => i * 0x101010),
      },
    ]);
    try {
      render(<SettingsFields {...FULL} subView="themes" />);
      const ids = [...document.querySelectorAll("[data-testid^='theme-opt-']")].map((e) =>
        (e.getAttribute('data-testid') ?? '').replace('theme-opt-', ''),
      );
      expect(ids.toSorted()).toEqual(
        allProfiles()
          .map((p) => p.id)
          .toSorted(),
      );
      expect(ids).toContain('user:extra');
      expect(new Set(ids).size).toBe(ids.length);
    } finally {
      registerDynamicThemes([]);
    }
  });
});

/** Press Tab (or Shift+Tab) until `el` holds focus: the keyboard's own way there,
 *  with no focus() call to stand in for it. */
const tabTo = async (el: HTMLElement, shift = false): Promise<void> => {
  // oxlint-disable-next-line no-await-in-loop -- each Tab starts where the last one left focus
  for (let i = 0; i < 40 && document.activeElement !== el; i++) await userEvent.tab({ shift });
  expect(document.activeElement).toBe(el);
};

// ── Focus across the switch ───────────────────────────────────────────────────
//
// The switch replaces the control that holds focus, so without help focus drops
// on the body and a keyboard user starts again from the top of the page. Here the
// panel has its own `‹ Settings`, as in the dock; the drawer, which hides it, is
// covered in SessionDrawer.test.tsx.
describe('focus across the theme sub-view', () => {
  it.each([
    ['Enter', '{Enter}'],
    ['Space', ' '],
  ])('%s carries focus in to ‹ Settings, and back out to the Theme row', async (_, key) => {
    render(<SettingsFields {...FULL} />);
    await tabTo(screen.getByTestId('set-theme'));

    await userEvent.keyboard(key);
    expect(screen.getByTestId('theme-browser')).toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByTestId('settings-themes-back'));

    await userEvent.keyboard(key);
    expect(screen.queryByTestId('theme-browser')).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId('set-theme'));
  });

  it('keeps focus on a picked entry, and still returns it to the Theme row', async () => {
    const Host = () => {
      const [settings, setSettings] = useState<ClientSettings>(DEFAULTS);
      return (
        <SettingsFields
          {...FULL}
          settings={settings}
          onChange={(partial) => setSettings((s) => ({ ...s, ...partial }))}
        />
      );
    };
    render(<Host />);
    await tabTo(screen.getByTestId('set-theme'));
    await userEvent.keyboard('{Enter}');
    const entry = document.querySelector<HTMLElement>(
      "[data-testid^='theme-opt-']:not([data-state='checked'])",
    );
    await tabTo(entry!);
    await userEvent.keyboard('{Enter}');
    // A pick re-renders the list but replaces nothing in it, so focus stays put.
    expect(entry).toHaveAttribute('data-state', 'checked');
    expect(document.activeElement).toBe(entry);

    await tabTo(screen.getByTestId('settings-themes-back'), true);
    await userEvent.keyboard('{Enter}');
    expect(document.activeElement).toBe(screen.getByTestId('set-theme'));
  });

  // A text field outside the panel keeps its focus: in the drawer that is
  // #mobile-kbd, and its focus is the soft keyboard.
  it('leaves focus in a text field outside the panel, both ways', () => {
    const field = document.createElement('textarea');
    document.body.append(field);
    try {
      field.focus();
      const view = render(<SettingsFields {...FULL} subView={null} />);
      view.rerender(<SettingsFields {...FULL} subView="themes" />);
      expect(document.activeElement).toBe(field);
      view.rerender(<SettingsFields {...FULL} subView={null} />);
      expect(document.activeElement).toBe(field);
    } finally {
      field.remove();
    }
  });

  it('takes no focus on its first render, even straight into the sub-view', () => {
    render(<SettingsFields {...FULL} subView="themes" />);
    expect(document.activeElement).toBe(document.body);
  });
});

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select, textarea, a[href], [tabindex]';

/**
 * A whole pointer press the way a browser delivers it, focus moves included,
 * which fireEvent alone does not model. A mouse fires its mousedown right after
 * pointerdown and a touch only after pointerup, and that mousedown moves focus to
 * the focusable control it lands in (or off everything, onto the body) unless it
 * is cancelled. A cancelled pointerdown sends no mousedown or mouseup at all. A
 * touch pointerup goes where the pointerdown went; everything after it is
 * hit-tested when it happens, so it lands on whatever is there by then: the
 * pressed element while it is still in the document, else the body. A click that
 * reaches a <label> uncancelled focuses its control as well (Chromium; happy-dom
 * forwards the click itself). Answers whether the pointerdown was left alone,
 * which is what lets a list pan.
 */
const browserPress = (
  el: Element,
  pointerType: 'touch' | 'mouse',
  landing?: () => Element,
): boolean => {
  const at = { pointerId: 9, pointerType, clientX: 40, clientY: 40 };
  const mouse = { clientX: 40, clientY: 40, detail: 1 };
  const under = () => (el.isConnected ? el : document.body);
  // Named by a caller whose action put another control where the finger is: the
  // release's trailing events go to the newcomer, which is the case that bites.
  const after = () => landing?.() ?? under();
  const mouseDown = (target: Element) => {
    if (!fireEvent.mouseDown(target, mouse)) return;
    const into = target.closest<HTMLElement>(FOCUSABLE);
    if (into) into.focus();
    else if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  };
  const compat = fireEvent.pointerDown(el, at);
  if (compat && pointerType === 'mouse') mouseDown(under());
  fireEvent.pointerUp(pointerType === 'touch' ? el : under(), at);
  if (compat && pointerType === 'touch') mouseDown(after());
  if (compat) fireEvent.mouseUp(after(), mouse);
  const target = after();
  if (fireEvent.click(target, mouse)) {
    const control = target.closest('label')?.control;
    if (control instanceof HTMLElement) control.focus();
  }
  return compat;
};

// ── Pointer presses across the switch ─────────────────────────────────────────
//
// In the drawer #mobile-kbd holds focus, and its focus IS the soft keyboard. The
// Theme row used to answer a plain click: a real press focused the button natively
// before that click ran, so the switch saw focus inside the panel, carried it into
// the list, and the keyboard went down. Every control of the round trip (the row,
// its label, an entry, `‹ Settings`) now acts on the pointer itself, so each press
// below is the browser's whole sequence, starting from a focused #mobile-kbd. The
// panel here keeps its own `‹ Settings`, as the desktop dock does.
describe('pointer presses across the theme sub-view', () => {
  let kbd: HTMLTextAreaElement;
  beforeEach(() => {
    kbd = document.createElement('textarea');
    kbd.id = 'mobile-kbd';
    document.body.append(kbd);
    kbd.focus();
  });
  afterEach(() => {
    kbd.remove();
    // A press's tail mark outlives the test it was armed in; a key clears it.
    fireEvent.keyDown(document);
  });

  const themeRow = () => screen.getByTestId('set-theme');
  const themeLabel = () => document.querySelector<HTMLElement>('label[for="set-theme"]')!;
  const otherTheme = () =>
    [...document.querySelectorAll<HTMLElement>("[data-testid^='theme-opt-']")].find(
      (opt) => opt.getAttribute('aria-current') !== 'true',
    )!;
  const mount = () => {
    const onChange = vi.fn();
    const Host = () => {
      const [settings, setSettings] = useState<ClientSettings>(DEFAULTS);
      return (
        <SettingsFields
          {...FULL}
          settings={settings}
          onChange={(partial) => {
            onChange(partial);
            setSettings((s) => ({ ...s, ...partial }));
          }}
        />
      );
    };
    render(<Host />);
    return onChange;
  };

  it.each([
    ['touch', 'the row', themeRow],
    ['mouse', 'the row', themeRow],
    ['touch', 'its label', themeLabel],
    ['mouse', 'its label', themeLabel],
  ] as const)('%s: in by %s, a pick, and out, #mobile-kbd focused throughout', (type, _, entry) => {
    const onChange = mount();

    // The row and the entries sit in a scrolling panel: a touch that lands on one
    // must leave the pan to the browser.
    expect(browserPress(entry(), type)).toBe(type === 'touch');
    expect(screen.getByTestId('theme-browser')).toBeInTheDocument();
    expect(document.activeElement).toBe(kbd);

    const pick = otherTheme();
    const themeId = pick.dataset['testid']!.replace('theme-opt-', '');
    expect(browserPress(pick, type)).toBe(type === 'touch');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ themeId });
    expect(screen.getByTestId('theme-browser')).toBeInTheDocument();
    expect(document.activeElement).toBe(kbd);

    expect(browserPress(screen.getByTestId('settings-themes-back'), type)).toBe(type === 'touch');
    expect(screen.queryByTestId('theme-browser')).toBeNull();
    expect(themeRow()).toBeInTheDocument();
    expect(document.activeElement).toBe(kbd);
  });

  // A host that lifts the back stack and does not switch keeps the form under the
  // pointer, so the press's own click lands on the control it pressed. The label
  // is the case that matters: its click would act once more AND forward to the
  // button, which would act a third time.
  it.each([
    ['touch', 'the row', themeRow],
    ['mouse', 'the row', themeRow],
    ['touch', 'its label', themeLabel],
    ['mouse', 'its label', themeLabel],
  ] as const)('%s: one press on %s asks for the browser once', (type, _, entry) => {
    const onSubViewChange = vi.fn();
    render(<SettingsFields {...FULL} subView={null} onSubViewChange={onSubViewChange} />);
    browserPress(entry(), type);
    expect(onSubViewChange).toHaveBeenCalledTimes(1);
    expect(onSubViewChange).toHaveBeenCalledWith('themes');
    expect(document.activeElement).toBe(kbd);
  });

  it.each([
    ['the row', themeRow],
    ['its label', themeLabel],
  ] as const)('a touch on %s that moves is a scroll, and opens nothing', (_, entry) => {
    const onSubViewChange = vi.fn();
    render(<SettingsFields {...FULL} subView={null} onSubViewChange={onSubViewChange} />);
    const el = entry();
    const touch = { pointerId: 3, pointerType: 'touch', clientX: 40, clientY: 40 };
    expect(fireEvent.pointerDown(el, touch)).toBe(true);
    fireEvent.pointerMove(el, { ...touch, clientY: 90 });
    fireEvent.pointerUp(el, { ...touch, clientY: 90 });
    expect(onSubViewChange).not.toHaveBeenCalled();
  });

  it('a touch on an entry that moves is a scroll, and picks nothing', () => {
    const onChange = vi.fn();
    render(<SettingsFields {...FULL} onChange={onChange} subView="themes" />);
    const pick = otherTheme();
    const touch = { pointerId: 3, pointerType: 'touch', clientX: 40, clientY: 40 };
    expect(fireEvent.pointerDown(pick, touch)).toBe(true);
    fireEvent.pointerMove(pick, { ...touch, clientY: 90 });
    fireEvent.pointerUp(pick, { ...touch, clientY: 90 });
    expect(onChange).not.toHaveBeenCalled();
  });

  // The keyboard still drives every one of them, exactly once per key.
  it.each([
    ['Enter', '{Enter}'],
    ['Space', ' '],
  ])('%s acts once on the row, on an entry and on ‹ Settings', async (_, key) => {
    const onChange = mount();
    await tabTo(themeRow());
    await userEvent.keyboard(key);
    expect(screen.getByTestId('theme-browser')).toBeInTheDocument();

    const pick = otherTheme();
    await tabTo(pick);
    await userEvent.keyboard(key);
    expect(onChange).toHaveBeenCalledTimes(1);

    await tabTo(screen.getByTestId('settings-themes-back'), true);
    await userEvent.keyboard(key);
    expect(screen.queryByTestId('theme-browser')).toBeNull();
    expect(document.activeElement).toBe(themeRow());
  });
});

// ── Every way in, exactly once ────────────────────────────────────────────────
//
// Counting calls is the point. Opening the browser twice leaves the same sub-view
// and going back twice leaves the same form, so the outcome of a double activation
// is indistinguishable from a single one; only the host's callbacks can tell. Each
// control of the round trip answers a pointer press, Enter, Space, and a click with
// no pointer before it (assistive tech, `element.click()`). The label also has a
// click it would forward to its button, which must not make it twice. Hosts here
// lift the back stack and do not switch, so the form the press landed on is still
// under the finger when its own click arrives.
describe('activating the theme round trip exactly once', () => {
  let kbd: HTMLTextAreaElement;
  beforeEach(() => {
    kbd = document.createElement('textarea');
    kbd.id = 'mobile-kbd';
    document.body.append(kbd);
    kbd.focus();
  });
  afterEach(() => {
    kbd.remove();
    fireEvent.keyDown(document);
  });

  interface Probe {
    el: HTMLElement;
    spy: ReturnType<typeof vi.fn>;
    /** What the one activation reports. */
    arg: unknown;
  }
  const otherTheme = (): HTMLElement =>
    [...document.querySelectorAll<HTMLElement>("[data-testid^='theme-opt-']")].find(
      (opt) => opt.getAttribute('aria-current') !== 'true',
    )!;
  const CONTROLS: ReadonlyArray<readonly [string, () => Probe, boolean]> = [
    [
      'the Theme row',
      () => {
        const spy = vi.fn();
        render(<SettingsFields {...FULL} subView={null} onSubViewChange={spy} />);
        return { el: screen.getByTestId('set-theme'), spy, arg: 'themes' };
      },
      true,
    ],
    [
      'its label',
      () => {
        const spy = vi.fn();
        render(<SettingsFields {...FULL} subView={null} onSubViewChange={spy} />);
        return {
          el: document.querySelector<HTMLElement>('label[for="set-theme"]')!,
          spy,
          arg: 'themes',
        };
      },
      false,
    ],
    [
      'a theme entry',
      () => {
        const spy = vi.fn();
        render(<SettingsFields {...FULL} subView="themes" onChange={spy} />);
        const el = otherTheme();
        return { el, spy, arg: { themeId: el.dataset['testid']!.replace('theme-opt-', '') } };
      },
      true,
    ],
    [
      '‹ Settings',
      () => {
        const spy = vi.fn();
        render(<SettingsFields {...FULL} subView="themes" onSubViewChange={spy} />);
        return { el: screen.getByTestId('settings-themes-back'), spy, arg: null };
      },
      true,
    ],
  ];

  type Method = readonly [string, (el: HTMLElement) => void | Promise<void>];
  const POINTER_AND_CLICK: readonly Method[] = [
    ['a touch press', (el) => void browserPress(el, 'touch')],
    ['a mouse press', (el) => void browserPress(el, 'mouse')],
    ['click()', (el) => void act(() => el.click())],
    ['a click with no count', (el) => void fireEvent.click(el, { detail: 0 })],
    [
      'a click with a count and no press before it',
      (el) => void fireEvent.click(el, { detail: 1 }),
    ],
  ];
  const KEYS: readonly Method[] = [
    [
      'Enter',
      async (el) => {
        el.focus();
        await userEvent.keyboard('{Enter}');
      },
    ],
    [
      'Space',
      async (el) => {
        el.focus();
        await userEvent.keyboard(' ');
      },
    ],
  ];

  describe.each(CONTROLS)('%s', (_name, probe, focusable) => {
    it.each(focusable ? [...POINTER_AND_CLICK, ...KEYS] : POINTER_AND_CLICK)(
      '%s acts once',
      async (_method, run) => {
        const { el, spy, arg } = probe();
        await run(el);
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy).toHaveBeenCalledWith(arg);
      },
    );

    it('a touch that moves is a scroll: nothing acts, and its pointerdown is left alone', () => {
      const { el, spy } = probe();
      const touch = { pointerId: 3, pointerType: 'touch', clientX: 40, clientY: 40 };
      // A list pans only if the browser's own handling of this pointerdown is not cancelled.
      expect(fireEvent.pointerDown(el, touch)).toBe(true);
      fireEvent.pointerMove(el, { ...touch, clientY: 90 });
      expect(fireEvent.pointerUp(el, { ...touch, clientY: 90 })).toBe(true);
      expect(spy).not.toHaveBeenCalled();
    });

    it('a touch that moves and is then cancelled acts on nothing either', () => {
      const { el, spy } = probe();
      const touch = { pointerId: 3, pointerType: 'touch', clientX: 40, clientY: 40 };
      fireEvent.pointerDown(el, touch);
      fireEvent.pointerMove(el, { ...touch, clientY: 90 });
      fireEvent.pointerCancel(el, touch);
      fireEvent.pointerUp(el, touch);
      expect(spy).not.toHaveBeenCalled();
    });
  });

  // A mouse cannot pan, so a drag across a control still ends in a click on it, and
  // that click is a drag's end and not a press. It is also CANCELLED: on the label,
  // an uncancelled click is forwarded to the Theme button, which has no drag of its
  // own to recognise it by and opened the browser.
  it.each(CONTROLS)(
    'a mouse drag released on %s acts on nothing, though its click arrives',
    (_name, probe) => {
      const { el, spy } = probe();
      const mouse = { pointerId: 1, pointerType: 'mouse', clientX: 40, clientY: 40 };
      fireEvent.pointerDown(el, mouse);
      fireEvent.pointerMove(el, { ...mouse, clientX: 90 });
      fireEvent.pointerUp(el, { ...mouse, clientX: 90 });
      expect(fireEvent.click(el, { detail: 1 })).toBe(false);
      expect(spy).not.toHaveBeenCalled();
    },
  );
});

// ── The click that lands on the newcomer ──────────────────────────────────────
//
// The action redraws the spot under the finger and the browser hit-tests the
// press's own click only after the release, so it lands on whatever the action put
// there: ‹ Settings where the Theme row was, the Theme row where ‹ Settings was. A
// control that took that click as a tap of its own would shut the panel in the same
// tap that opened it (measured in the drawer, 4 of 4). Real state here, so the
// browser really replaces the form, and the click is delivered to the replacement.
describe('the press’s own click, landing on what the press drew', () => {
  let kbd: HTMLTextAreaElement;
  beforeEach(() => {
    kbd = document.createElement('textarea');
    kbd.id = 'mobile-kbd';
    document.body.append(kbd);
    kbd.focus();
  });
  afterEach(() => {
    kbd.remove();
    fireEvent.keyDown(document);
  });

  const mount = () => {
    const onChange = vi.fn();
    const Host = () => {
      const [settings, setSettings] = useState<ClientSettings>(DEFAULTS);
      return (
        <SettingsFields
          {...FULL}
          settings={settings}
          onChange={(partial) => {
            onChange(partial);
            setSettings((s) => ({ ...s, ...partial }));
          }}
        />
      );
    };
    render(<Host />);
    return onChange;
  };
  const back = () => screen.getByTestId('settings-themes-back');
  const row = () => screen.getByTestId('set-theme');
  const label = () => document.querySelector<HTMLElement>('label[for="set-theme"]')!;
  const firstEntry = () => document.querySelector<HTMLElement>("[data-testid^='theme-opt-']")!;

  describe.each(['touch', 'mouse'] as const)('a %s press', (type) => {
    it.each([
      ['the Theme row', row],
      ['its label', label],
    ])('on %s opens the browser, and its click on ‹ Settings does not shut it', (_, entry) => {
      const onChange = mount();
      browserPress(entry(), type, back);
      expect(screen.getByTestId('theme-browser')).toBeInTheDocument();
      expect(onChange).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(kbd);
    });

    it('on the Theme row opens the browser, and its click on a theme does not pick it', () => {
      const onChange = mount();
      browserPress(row(), type, firstEntry);
      expect(screen.getByTestId('theme-browser')).toBeInTheDocument();
      expect(onChange).not.toHaveBeenCalled();
    });

    it('on ‹ Settings goes back, and its click on the Theme row does not reopen the browser', () => {
      mount();
      fireEvent.click(row()); // no pointer, so no mark: the way in under test is the way out
      expect(screen.getByTestId('theme-browser')).toBeInTheDocument();
      browserPress(back(), type, row);
      expect(screen.queryByTestId('theme-browser')).toBeNull();
      expect(row()).toBeInTheDocument();
      expect(document.activeElement).toBe(kbd);
    });

    it('on ‹ Settings goes back, and its click on the label does not reopen it either', () => {
      mount();
      fireEvent.click(row());
      browserPress(back(), type, label);
      expect(screen.queryByTestId('theme-browser')).toBeNull();
    });

    it('swallows that one click and nothing after it: the next, separate press acts', () => {
      mount();
      browserPress(row(), type, back);
      expect(screen.getByTestId('theme-browser')).toBeInTheDocument();
      // A new pointerdown is a press of its own; it clears the mark.
      browserPress(back(), type, row);
      expect(screen.queryByTestId('theme-browser')).toBeNull();
      browserPress(row(), type, back);
      expect(screen.getByTestId('theme-browser')).toBeInTheDocument();
    });
  });

  // Some engines move focus onto the button at pointerdown, so it holds focus at the
  // release. The press puts #mobile-kbd back BEFORE it acts, or the switch below
  // finds focus inside the panel and carries it into the list (or, going back,
  // loses it with the button), and the soft keyboard goes down.
  it.each([
    ['the Theme row', () => {}, row],
    ['a theme entry', () => fireEvent.click(row()), firstEntry],
    ['‹ Settings', () => fireEvent.click(row()), back],
  ] as const)(
    'puts #mobile-kbd back when focus had already moved onto %s at the release',
    (_name, enter, control) => {
      mount();
      enter();
      const el = control();
      const touch = { pointerId: 4, pointerType: 'touch', clientX: 40, clientY: 40 };
      fireEvent.pointerDown(el, touch);
      el.focus();
      expect(document.activeElement).toBe(el);
      fireEvent.pointerUp(el, touch);
      expect(document.activeElement).toBe(kbd);
    },
  );

  // `click()` on a control from inside a gesture is not that gesture's tail: upload
  // and download do it. It has no count, so the mark lets it through while it
  // still waits for the press's own click.
  it('lets a click() with no count through while a press is marked', () => {
    mount();
    const touch = { pointerId: 4, pointerType: 'touch', clientX: 40, clientY: 40 };
    fireEvent.pointerDown(row(), touch);
    fireEvent.pointerUp(row(), touch);
    expect(screen.getByTestId('theme-browser')).toBeInTheDocument();
    act(() => back().click());
    expect(screen.queryByTestId('theme-browser')).toBeNull();
  });
});

// ── Test ids ──────────────────────────────────────────────────────────────────
//
// Other suites, and anyone driving the app by hand, select these. The redesign
// moved every control into a card and a column and was not allowed to rename one.
describe('test ids', () => {
  const BEFORE_THE_REDESIGN = [
    'set-theme',
    'set-theme-import',
    'set-theme-import-add',
    'set-font',
    'set-size',
    'set-cursor',
    'set-blink',
    'set-scrollback',
    'set-mobile',
    'set-native-sel',
    'set-images',
    'open-keybindings',
    'open-tips',
    'set-ctrlv',
    'set-ctrlf',
    'set-kbsel',
    'set-altdig',
    'set-vim',
    'set-sidebar-rail',
    'open-dictation-history',
    'reload-app',
    'install-pwa',
    'set-latency',
    'settings-section-appearance',
    'settings-section-terminal',
    'settings-section-keys',
    'settings-section-app',
  ];

  it('keeps every id the form had before the redesign', () => {
    render(<SettingsFields {...FULL} />);
    const missing = BEFORE_THE_REDESIGN.filter((id) => !screen.queryByTestId(id));
    expect(missing).toEqual([]);
  });

  it('keeps the theme entries’ and swatches’ ids, now in the browser', () => {
    render(<SettingsFields {...FULL} subView="themes" />);
    for (const p of allProfiles()) {
      expect(screen.getByTestId(`theme-opt-${p.id}`)).toBeInTheDocument();
      expect(screen.getByTestId(`theme-swatch-${p.id}`)).toBeInTheDocument();
    }
  });
});
