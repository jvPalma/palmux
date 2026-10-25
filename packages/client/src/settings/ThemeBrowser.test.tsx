// The theme browser. What matters here is that each entry paints itself in ITS
// OWN palette — a browser whose swatches obeyed the current theme would show you
// the current theme once per row, which is exactly the failure the native
// <select> had and the reason this component exists. The behaviour that replaced
// the popup is the other half: a pick reports its id and the list stays put.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { parse } from 'postcss';
import { allProfiles, isLightBg, type ColorProfile } from './themes';
import { ThemeBrowser } from './ThemeBrowser';
import { Icon } from '../ui/icons';

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

/** The drawn shapes of a registered icon, to compare against what a control
 *  rendered. Rendered into a detached node so `screen` never sees it. */
const iconPaths = (name: string): string | undefined => {
  const host = document.createElement('div');
  render(<Icon name={name} />, { container: host });
  return host.querySelector('svg')?.innerHTML;
};

describe('ThemeBrowser', () => {
  it('lists every theme at once, with no popup to open first', () => {
    render(<ThemeBrowser profiles={PROFILES} value="dark-one" onChange={vi.fn()} />);
    expect(screen.getByTestId('theme-browser')).toBeInTheDocument();
    for (const p of PROFILES) expect(screen.getByTestId(`theme-opt-${p.id}`)).toBeInTheDocument();
  });

  // The current entry's tick is a shared icon, not a ✓ character, and it is drawn
  // on the current entry alone.
  it('draws the current entry’s tick as an icon, on that entry only', () => {
    render(<ThemeBrowser profiles={PROFILES} value="dark-two" onChange={vi.fn()} />);
    const tick = screen.getByTestId('theme-opt-dark-two').querySelector('.tb-check');
    expect(tick?.querySelectorAll('svg')).toHaveLength(1);
    expect(tick?.querySelector('svg')?.innerHTML).toBe(iconPaths('check'));
    expect(tick?.textContent).toBe('');
    expect(screen.getByTestId('theme-opt-dark-one').querySelector('.tb-check')).toBeNull();
    expect(document.querySelectorAll('.tb-check')).toHaveLength(1);
  });

  it('groups by brightness, registry order preserved inside each group', () => {
    render(<ThemeBrowser profiles={PROFILES} value="dark-one" onChange={vi.fn()} />);
    const groups = screen.getAllByRole('group');
    expect(groups).toHaveLength(2);
    expect(groups[0]).toHaveAccessibleName('Dark');
    expect(
      within(groups[0]!)
        .getAllByRole('button')
        .map((b) => b.dataset['testid']),
    ).toEqual(['theme-opt-dark-one', 'theme-opt-dark-two']);
    expect(groups[1]).toHaveAccessibleName('Light');
    expect(
      within(groups[1]!)
        .getAllByRole('button')
        .map((b) => b.dataset['testid']),
    ).toEqual(['theme-opt-light-one']);
  });

  // The whole point. Each swatch is painted from ITS profile, not the app's.
  it('paints every swatch in its own background, foreground and cursor', () => {
    render(<ThemeBrowser profiles={PROFILES} value="dark-one" onChange={vi.fn()} />);
    const dark = screen.getByTestId('theme-swatch-dark-one');
    expect(dark.style.background).toBe('#1e1e2e');
    expect(dark.style.color).toBe('#cdd6f4');

    const light = screen.getByTestId('theme-swatch-light-one');
    expect(light.style.background).toBe('#fafafa');
    expect(light.style.color).toBe('#333333');

    // The cursor block uses the profile's explicit cursor colour, which nothing
    // else in the swatch shows and a palette can get wrong on its own.
    const cursor = dark.querySelector('.tb-swatch-cursor') as HTMLElement;
    expect(cursor.style.background).toBe('#a6e3a1');
  });

  it('falls back to the foreground when a profile declares no cursor', () => {
    render(<ThemeBrowser profiles={[LIGHT]} value="light-one" onChange={vi.fn()} />);
    const cursor = screen
      .getByTestId('theme-swatch-light-one')
      .querySelector('.tb-swatch-cursor') as HTMLElement;
    expect(cursor.style.background).toBe('#333333');
  });

  it('draws the preview lines with several distinct colours from that palette', () => {
    render(<ThemeBrowser profiles={PROFILES} value="dark-one" onChange={vi.fn()} />);
    const lines = screen.getByTestId('theme-swatch-dark-one').querySelectorAll('.tb-swatch-line');
    expect(lines).toHaveLength(2);
    const colours = new Set(
      [...lines].flatMap((l) => [...l.querySelectorAll('span')].map((s) => s.style.color)),
    );
    // A swatch painting one colour would prove nothing about the palette.
    expect(colours.size).toBeGreaterThan(5);
  });

  it('reports the chosen id, and does not change the list it is showing', () => {
    const onChange = vi.fn();
    render(<ThemeBrowser profiles={PROFILES} value="dark-one" onChange={onChange} />);
    fireEvent.click(screen.getByTestId('theme-opt-light-one'));
    expect(onChange).toHaveBeenCalledWith('light-one');
    expect(onChange).toHaveBeenCalledTimes(1);
    // The browser has no selection state of its own: the host re-renders it with
    // the new `value`. Until it does, the old current theme is still marked.
    expect(screen.getByTestId('theme-opt-dark-one')).toHaveAttribute('data-state', 'checked');
    expect(screen.getAllByRole('button')).toHaveLength(3);
  });

  it('follows `value` to the new current entry without remounting the list', () => {
    const { rerender } = render(
      <ThemeBrowser profiles={PROFILES} value="dark-one" onChange={vi.fn()} />,
    );
    const first = screen.getByTestId('theme-opt-dark-one');
    rerender(<ThemeBrowser profiles={PROFILES} value="light-one" onChange={vi.fn()} />);
    expect(screen.getByTestId('theme-opt-dark-one')).toBe(first);
    expect(first).toHaveAttribute('data-state', 'unchecked');
    expect(screen.getByTestId('theme-opt-light-one')).toHaveAttribute('data-state', 'checked');
  });

  it('is operable from the keyboard: Enter on a focused entry picks it', async () => {
    const onChange = vi.fn();
    render(<ThemeBrowser profiles={PROFILES} value="dark-one" onChange={onChange} />);
    screen.getByTestId('theme-opt-dark-two').focus();
    await userEvent.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledWith('dark-two');
  });

  // Radix marked the CURRENT value with `data-state="checked"`; the ring in
  // theme-browser.css keys off the same attribute, and `aria-current` is what
  // tells a screen reader. Exactly one entry carries each.
  it('marks the current entry as current, and only that one', () => {
    render(<ThemeBrowser profiles={PROFILES} value="dark-two" onChange={vi.fn()} />);
    expect(screen.getByTestId('theme-opt-dark-two')).toHaveAttribute('data-state', 'checked');
    expect(screen.getByTestId('theme-opt-dark-two')).toHaveAttribute('aria-current', 'true');
    expect(screen.getByTestId('theme-opt-dark-one')).toHaveAttribute('data-state', 'unchecked');
    expect(screen.getByTestId('theme-opt-dark-one')).not.toHaveAttribute('aria-current');
    expect(
      screen.getAllByRole('button').filter((o) => o.dataset['state'] === 'checked'),
    ).toHaveLength(1);
  });

  it('renders a group only when it has members', () => {
    render(<ThemeBrowser profiles={[DARK, DARK2]} value="dark-one" onChange={vi.fn()} />);
    expect(screen.getAllByRole('group')).toHaveLength(1);
    expect(screen.queryByText('Light')).toBeNull();
  });

  it('names each entry by its theme', () => {
    render(<ThemeBrowser profiles={PROFILES} value="dark-one" onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Light One' })).toBe(
      screen.getByTestId('theme-opt-light-one'),
    );
  });
});

// ── Picking by pointer ────────────────────────────────────────────────────────
//
// The entries sit in a list that scrolls, inside a drawer whose soft keyboard is
// #mobile-kbd's focus. A press that picked on pointerdown would stop the list from
// panning (a touch pointerdown cannot be cancelled), and one that let the button
// take focus natively would dismiss the keyboard. So an entry picks on the release,
// from a still press, once, and leaves focus where it was. Every other way to
// activate it (Enter, Space, assistive tech) still reaches it as a click.
describe('picking an entry by pointer', () => {
  let kbd: HTMLTextAreaElement;
  beforeEach(() => {
    kbd = document.createElement('textarea');
    kbd.id = 'mobile-kbd';
    document.body.append(kbd);
    kbd.focus();
  });
  afterEach(() => {
    kbd.remove();
    // A press's tail mark outlives its test; a key clears it.
    fireEvent.keyDown(document);
  });

  const mount = () => {
    const onChange = vi.fn();
    render(<ThemeBrowser profiles={PROFILES} value="dark-one" onChange={onChange} />);
    return { onChange, entry: screen.getByTestId('theme-opt-light-one') };
  };

  /**
   * One press as the browser delivers it, focus moves included: a mouse's mousedown
   * comes right after pointerdown and a touch's after pointerup, and either moves
   * focus onto the button unless something cancels it. A cancelled pointerdown sends
   * no mousedown or mouseup at all.
   */
  const press = (el: HTMLElement, pointerType: 'touch' | 'mouse'): boolean => {
    const at = { pointerId: 9, pointerType, clientX: 40, clientY: 40 };
    const mouse = { clientX: 40, clientY: 40, detail: 1 };
    const mouseDown = () => {
      if (fireEvent.mouseDown(el, mouse)) el.focus();
    };
    const left = fireEvent.pointerDown(el, at);
    if (left && pointerType === 'mouse') mouseDown();
    fireEvent.pointerUp(el, at);
    if (left && pointerType === 'touch') mouseDown();
    if (left) fireEvent.mouseUp(el, mouse);
    fireEvent.click(el, mouse);
    return left;
  };

  it.each(['touch', 'mouse'] as const)(
    'a %s press picks once, and #mobile-kbd keeps focus through the whole sequence',
    (type) => {
      const { onChange, entry } = mount();
      // Left alone on a touch, so the list can pan; a mouse cannot pan.
      expect(press(entry, type)).toBe(type === 'touch');
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledWith('light-one');
      expect(document.activeElement).toBe(kbd);
    },
  );

  it.each([
    ['Enter', async () => userEvent.keyboard('{Enter}')],
    ['Space', async () => userEvent.keyboard(' ')],
  ])('%s on a focused entry picks once', async (_, key) => {
    const { onChange, entry } = mount();
    entry.focus();
    await key();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('light-one');
  });

  it.each([
    ['click()', (el: HTMLElement) => act(() => el.click())],
    ['a click with no count', (el: HTMLElement) => fireEvent.click(el, { detail: 0 })],
    [
      'a click with a count and no press before it',
      (el: HTMLElement) => fireEvent.click(el, { detail: 1 }),
    ],
  ])('%s, as assistive tech makes it, picks once', (_, click) => {
    const { onChange, entry } = mount();
    click(entry);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('light-one');
  });

  it('a touch that moves is a scroll: nothing is picked, and the pointerdown is left alone', () => {
    const { onChange, entry } = mount();
    const touch = { pointerId: 3, pointerType: 'touch', clientX: 40, clientY: 40 };
    expect(fireEvent.pointerDown(entry, touch)).toBe(true);
    fireEvent.pointerMove(entry, { ...touch, clientY: 90 });
    fireEvent.pointerUp(entry, { ...touch, clientY: 90 });
    expect(onChange).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(kbd);
  });

  it('a mouse drag released on an entry picks nothing, though its click arrives', () => {
    const { onChange, entry } = mount();
    const mouse = { pointerId: 1, pointerType: 'mouse', clientX: 40, clientY: 40 };
    fireEvent.pointerDown(entry, mouse);
    fireEvent.pointerMove(entry, { ...mouse, clientX: 90 });
    fireEvent.pointerUp(entry, { ...mouse, clientX: 90 });
    fireEvent.click(entry, { detail: 1 });
    expect(onChange).not.toHaveBeenCalled();
  });

  // Some engines move focus at pointerdown, so the button already holds it at the
  // release. The press puts #mobile-kbd back before it acts.
  it('puts #mobile-kbd back when focus had already moved onto the entry at the release', () => {
    const { onChange, entry } = mount();
    const touch = { pointerId: 3, pointerType: 'touch', clientX: 40, clientY: 40 };
    fireEvent.pointerDown(entry, touch);
    entry.focus();
    expect(document.activeElement).toBe(entry);
    fireEvent.pointerUp(entry, touch);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(kbd);
  });

  it('two separate presses are two picks: the first one’s mark does not swallow the second', () => {
    const { onChange, entry } = mount();
    press(entry, 'touch');
    press(entry, 'touch');
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('picks the entry the press landed on and no other', () => {
    const { onChange } = mount();
    press(screen.getByTestId('theme-opt-dark-two'), 'touch');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('dark-two');
  });
});

// ── The whole registry, and the edges of the list ─────────────────────────────
describe('ThemeBrowser against the real registry', () => {
  it('lists every registered theme once, split into both groups', () => {
    const profiles = allProfiles();
    render(<ThemeBrowser profiles={profiles} value={profiles[0]!.id} onChange={vi.fn()} />);
    expect(screen.getAllByRole('button')).toHaveLength(profiles.length);
    const ids = [...document.querySelectorAll("[data-testid^='theme-opt-']")].map((e) =>
      (e.getAttribute('data-testid') ?? '').replace('theme-opt-', ''),
    );
    expect(ids.toSorted()).toEqual(profiles.map((p) => p.id).toSorted());
    // The registry has both families, so both captions render.
    expect(profiles.some((p) => isLightBg(p))).toBe(true);
    expect(profiles.some((p) => !isLightBg(p))).toBe(true);
    expect(screen.getAllByRole('group')).toHaveLength(2);
  });

  it('puts each theme in the group its own background says, never the app’s', () => {
    const profiles = allProfiles();
    render(<ThemeBrowser profiles={profiles} value={profiles[0]!.id} onChange={vi.fn()} />);
    const [dark, light] = screen.getAllByRole('group');
    for (const p of profiles) {
      const entry = screen.getByTestId(`theme-opt-${p.id}`);
      expect(within(isLightBg(p) ? light! : dark!).getByTestId(`theme-opt-${p.id}`)).toBe(entry);
    }
  });

  it('renders an empty list as an empty browser, not a crash', () => {
    render(<ThemeBrowser profiles={[]} value="none" onChange={vi.fn()} />);
    expect(screen.getByTestId('theme-browser')).toBeInTheDocument();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryAllByRole('group')).toHaveLength(0);
  });

  // The host's stored id can outlive the theme (a user theme deleted from disk).
  it('marks no entry as current when `value` names none of them', () => {
    render(<ThemeBrowser profiles={PROFILES} value="user:gone" onChange={vi.fn()} />);
    expect(document.querySelectorAll('.tb-check')).toHaveLength(0);
    expect(document.querySelectorAll('[aria-current]')).toHaveLength(0);
    expect(document.querySelectorAll("[data-state='checked']")).toHaveLength(0);
  });

  it('reports a tap on the entry that is already current, rather than swallowing it', () => {
    const onChange = vi.fn();
    render(<ThemeBrowser profiles={PROFILES} value="dark-one" onChange={onChange} />);
    fireEvent.click(screen.getByTestId('theme-opt-dark-one'));
    expect(onChange).toHaveBeenCalledWith('dark-one');
  });

  // Every line of preview is a fake shell, so a screen reader hears the theme's
  // name and not forty tokens of `ls` and `error:` per entry.
  it('hides the fake shell from assistive technology, and keeps the name', () => {
    render(<ThemeBrowser profiles={PROFILES} value="dark-one" onChange={vi.fn()} />);
    const swatch = screen.getByTestId('theme-swatch-dark-one');
    for (const line of swatch.querySelectorAll('.tb-swatch-line')) {
      expect(line).toHaveAttribute('aria-hidden', 'true');
    }
    expect(swatch.querySelector('.tb-swatch-cursor')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByTestId('theme-opt-dark-one')).toHaveAccessibleName('Dark One');
  });
});

// ── "A ring, not a fill" ──────────────────────────────────────────────────────
//
// The swatch owns the background, so a highlight painted as a background on the
// entry would be covered by the theme's own and the hover, the keyboard focus and
// the current theme would all be invisible. The stylesheet is read for it.
describe('theme-browser.css', () => {
  const sheet = parse(readFileSync(join(__dirname, 'theme-browser.css'), 'utf8'));

  const declarationsOf = (selector: string): Array<{ prop: string; value: string }> => {
    const out: Array<{ prop: string; value: string }> = [];
    sheet.walkRules((rule) => {
      if (!rule.selectors.includes(selector)) return;
      rule.walkDecls((d) => {
        out.push({ prop: d.prop, value: d.value.replace(/\s+/g, ' ').trim() });
      });
    });
    return out;
  };

  it('draws an entry with no background of its own', () => {
    const base = declarationsOf('.tb-item');
    expect(base.find((d) => d.prop === 'background')?.value).toBe('none');
  });

  it.each(['.tb-item:hover', '.tb-item:focus-visible', ".tb-item[data-state='checked']"])(
    'highlights %s with a ring and never with a fill',
    (selector) => {
      const decls = declarationsOf(selector);
      expect(decls.length, `no rule for ${selector}`).toBeGreaterThan(0);
      expect(decls.filter((d) => d.prop.startsWith('background'))).toEqual([]);
    },
  );

  it('rings the current entry twice over, so current and hovered never read alike', () => {
    const current = declarationsOf(".tb-item[data-state='checked']");
    expect(current.find((d) => d.prop === 'border-color')?.value).toBe('var(--t-accent)');
    expect(current.find((d) => d.prop === 'box-shadow')?.value).toBe(
      'inset 0 0 0 1px var(--t-accent)',
    );
    const hover = declarationsOf('.tb-item:hover');
    expect(hover.find((d) => d.prop === 'box-shadow')).toBeUndefined();
  });

  it('keeps the keyboard ring inside the entry, which clips its own overflow', () => {
    const focus = declarationsOf('.tb-item:focus-visible');
    expect(focus.find((d) => d.prop === 'outline')?.value).toBe('2px solid var(--t-accent)');
    expect(focus.find((d) => d.prop === 'outline-offset')?.value).toMatch(/^-/);
    expect(declarationsOf('.tb-item').find((d) => d.prop === 'overflow')?.value).toBe('hidden');
  });

  it('keeps the cursor block still and square', () => {
    const cursor = declarationsOf('.tb-swatch-cursor');
    expect(cursor.filter((d) => /^(?:animation|transition)/.test(d.prop))).toEqual([]);
    expect(cursor.find((d) => d.prop === 'border-radius')).toBeUndefined();
  });

  it('makes the check a plate of its own, because it sits over an unknown background', () => {
    const check = declarationsOf('.tb-check');
    expect(check.find((d) => d.prop === 'background')?.value).toBe('var(--t-mantle)');
    expect(check.find((d) => d.prop === 'position')?.value).toBe('absolute');
  });
});
