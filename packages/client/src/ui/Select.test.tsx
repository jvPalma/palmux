// The kit Select's behaviour. What its stylesheet promises (control height,
// ellipsis, the popup's origin, the focus ring) is pinned as text in ui.test.tsx,
// because happy-dom does not lay anything out; what is pinned here is what a
// caller can observe through the DOM — the value on the trigger, the title that
// carries it in full, the choice reaching `onChange`, and the shared chevron.

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Icon } from './icons';
import { Select } from './index';

afterEach(cleanup);

const FONTS = [
  { value: 'jetbrains', label: 'JetBrains Mono' },
  { value: 'fira', label: 'Fira Code' },
  { value: 'cascadia', label: 'Cascadia Code' },
];

/** The drawn shapes of a registered icon, rendered into a node `screen` never sees. */
const iconPaths = (name: string): string | undefined => {
  const host = document.createElement('div');
  render(<Icon name={name} />, { container: host });
  return host.querySelector('svg')?.innerHTML;
};

const mount = (value = 'jetbrains', onChange = vi.fn()) => {
  render(
    <Select
      id="set-font"
      value={value}
      onChange={onChange}
      options={FONTS}
      aria-label="Font"
      data-testid="font"
    />,
  );
  return onChange;
};

const open = () => fireEvent.click(screen.getByTestId('font'));

describe('Select', () => {
  it('shows the label of the current value on the closed trigger', () => {
    mount('fira');
    const trigger = screen.getByTestId('font');
    expect(trigger).toHaveTextContent('Fira Code');
    // The value is the option's label, never its machine value.
    expect(trigger).not.toHaveTextContent('fira');
  });

  it('is a labelled combobox the caller can reach by id', () => {
    mount();
    const trigger = screen.getByRole('combobox', { name: 'Font' });
    expect(trigger).toBe(screen.getByTestId('font'));
    expect(trigger.id).toBe('set-font');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('carries a stable default test id', () => {
    render(<Select value="a" onChange={vi.fn()} options={[{ value: 'a', label: 'A' }]} />);
    expect(screen.getByTestId('ui-select')).toBeInTheDocument();
  });

  it('draws the trigger chevron from the shared icon set', () => {
    mount();
    const chevron = screen.getByTestId('font').querySelector('.ui-select-chevron');
    expect(chevron).toHaveAttribute('aria-hidden', 'true');
    expect(chevron?.querySelectorAll('svg')).toHaveLength(1);
    expect(chevron?.querySelector('svg')?.innerHTML).toBe(iconPaths('chevron-down'));
    expect(chevron?.textContent).toBe('');
  });

  describe('a value longer than its box', () => {
    const LONG = 'Cobalt Next Minimal With A Name That Cannot Possibly Fit In A Column';
    const mountLong = () =>
      render(
        <Select
          value="long"
          onChange={vi.fn()}
          options={[
            { value: 'short', label: 'Short' },
            { value: 'long', label: LONG },
          ]}
          data-testid="theme"
        />,
      );

    it('puts the whole text in the trigger title', () => {
      mountLong();
      expect(screen.getByTestId('theme')).toHaveAttribute('title', LONG);
    });

    it('renders it as ONE text node in the element the stylesheet truncates', () => {
      mountLong();
      const value = screen.getByTestId('theme').querySelector('[data-ui-select-value]');
      // The ellipsis rule is keyed on this attribute; losing it drops the truncation.
      expect(value).not.toBeNull();
      expect(value?.textContent).toBe(LONG);
      expect(value?.childNodes).toHaveLength(1);
    });
  });

  // The same promise inside the popup. Radix's ItemText discards `className`, so a
  // class written on it never reached the DOM, and a long unbroken name wrapped
  // or pushed the check out past the clipped viewport.
  describe('an option label longer than the popup', () => {
    const UNBROKEN = 'JetBrainsMonoNerdFontCompleteWindowsCompatibleExtraLightItalic';
    const mountOpen = () => {
      render(
        <Select
          value="long"
          onChange={vi.fn()}
          options={[
            { value: 'short', label: 'Short' },
            { value: 'long', label: UNBROKEN },
          ]}
          data-testid="font"
        />,
      );
      open();
      return screen.getByTestId('font-option-long');
    };

    it('renders its text inside the element the stylesheet truncates', () => {
      const option = mountOpen();
      const label = option.querySelector('.ui-menu-label');
      expect(label).not.toBeNull();
      expect(label?.textContent).toBe(UNBROKEN);
      // Still Radix's ItemText underneath: it names the option, which is what
      // typeahead and a screen reader read.
      expect(screen.getByRole('option', { name: UNBROKEN })).toBe(option);
    });

    it('keeps the check in the item, beside the label rather than inside its clip', () => {
      const option = mountOpen();
      const label = option.querySelector('.ui-menu-label');
      const check = option.querySelector('.ui-select-check');
      expect(check).not.toBeNull();
      expect(check?.parentElement).toBe(option);
      expect(label?.parentElement).toBe(option);
      expect(label?.contains(check ?? null)).toBe(false);
    });

    it('still shows the selected text on the trigger', () => {
      mountOpen();
      const trigger = screen.getByTestId('font');
      expect(trigger.querySelector('[data-ui-select-value]')?.textContent).toBe(UNBROKEN);
      expect(trigger).toHaveAttribute('title', UNBROKEN);
    });
  });

  it('shows a value that matches no option as its own text, not as an empty box', () => {
    mount('Iosevka Term');
    const trigger = screen.getByTestId('font');
    expect(trigger).toHaveTextContent('Iosevka Term');
    expect(trigger).toHaveAttribute('title', 'Iosevka Term');
  });

  it('opens a listbox of every option, the current one marked', () => {
    mount('fira');
    open();
    const options = screen.getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual([
      'JetBrains Mono',
      'Fira Code',
      'Cascadia Code',
    ]);
    // The trigger is aria-hidden while the popup is open, so it is found by id, not by role.
    expect(screen.getByTestId('font')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('font-option-fira')).toHaveAttribute('data-state', 'checked');
    expect(screen.getByTestId('font-option-jetbrains')).toHaveAttribute('data-state', 'unchecked');
  });

  it('ticks the current option with the shared check icon, and no other', () => {
    mount('fira');
    open();
    const tick = screen.getByTestId('font-option-fira').querySelector('.ui-select-check');
    expect(tick?.querySelector('svg')?.innerHTML).toBe(iconPaths('check'));
    expect(tick?.textContent).toBe('');
    expect(
      screen.getByTestId('font-option-jetbrains').querySelector('.ui-select-check'),
    ).toBeNull();
  });

  it('draws the popup as the shared menu surface', () => {
    mount();
    open();
    const popup = screen.getByRole('listbox');
    expect(popup.className).toContain('ui-menu');
    expect(popup.className).toContain('ui-select-content');
    expect(within(popup).getAllByRole('option')[0]?.className).toContain('ui-menu-item');
  });

  it('reports the chosen value and closes', () => {
    const onChange = mount('jetbrains');
    open();
    fireEvent.click(screen.getByTestId('font-option-cascadia'));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('cascadia');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('does not report a pick of the value it already holds', () => {
    const onChange = mount('jetbrains');
    open();
    fireEvent.click(screen.getByTestId('font-option-jetbrains'));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('follows a controlled value, and shows the new label after a pick', () => {
    const Harness = () => {
      const [value, setValue] = useState('jetbrains');
      return <Select value={value} onChange={setValue} options={FONTS} data-testid="font" />;
    };
    render(<Harness />);
    open();
    fireEvent.click(screen.getByTestId('font-option-fira'));
    expect(screen.getByTestId('font')).toHaveTextContent('Fira Code');
    expect(screen.getByTestId('font')).toHaveAttribute('title', 'Fira Code');
  });

  // Radix renders a visually hidden native <select> when the trigger sits inside a
  // <form>, so "no native select in the settings panel" holds only while the panel
  // is not wrapped in one — pinned here so that stays a known fact, not a surprise.
  it('adds no native select element of its own, open or closed', () => {
    const { container } = render(
      <Select value="jetbrains" onChange={vi.fn()} options={FONTS} data-testid="font" />,
    );
    expect(container.querySelector('select')).toBeNull();
    open();
    expect(document.querySelector('select')).toBeNull();
  });

  it('opens from the keyboard and Escape closes it', () => {
    mount();
    const trigger = screen.getByTestId('font');
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  // The whole choice by keyboard, with no pointer anywhere: open, move, commit.
  // The panel is reachable from a physical keyboard on a desktop, and a list that
  // only a click could finish would be a trap there.
  it('picks by keyboard — open, arrow to an option, Enter — and hands focus back', async () => {
    const onChange = vi.fn();
    mount('jetbrains', onChange);
    const user = userEvent.setup();
    const trigger = screen.getByTestId('font');
    trigger.focus();
    await user.keyboard('{Enter}');
    // Focus lands on the current option, so ArrowDown moves from where the value is.
    expect(document.activeElement).toBe(screen.getByTestId('font-option-jetbrains'));
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(screen.getByTestId('font-option-fira'));
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('fira');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('hands focus back to the trigger when Escape dismisses it, and reports nothing', async () => {
    const onChange = mount();
    const user = userEvent.setup();
    const trigger = screen.getByTestId('font');
    trigger.focus();
    await user.keyboard('{Enter}');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('is named by a <label htmlFor> that points at its id', () => {
    render(
      <>
        <label htmlFor="set-font">Font</label>
        <Select id="set-font" value="fira" onChange={vi.fn()} options={FONTS} data-testid="font" />
      </>,
    );
    expect(screen.getByLabelText('Font')).toBe(screen.getByTestId('font'));
  });

  // The Font row's real values are CSS font stacks: quotes, commas and spaces. The
  // value is opaque to the Select — it must reach `onChange` byte for byte, and
  // the trigger must show the LABEL, never the stack.
  describe('with CSS font stacks as values', () => {
    const STACK = '"JetBrains Mono", ui-monospace, Menlo, Consolas, monospace';
    const SYSTEM = 'ui-monospace, monospace';
    const STACKS = [
      { value: STACK, label: 'JetBrains Mono' },
      { value: SYSTEM, label: 'System monospace' },
    ];

    it('shows the label, and reports the exact stack that was picked', () => {
      const onChange = vi.fn();
      render(<Select value={STACK} onChange={onChange} options={STACKS} data-testid="font" />);
      const trigger = screen.getByTestId('font');
      expect(trigger).toHaveTextContent('JetBrains Mono');
      expect(trigger).not.toHaveTextContent('ui-monospace');
      open();
      expect(screen.getByRole('option', { name: 'JetBrains Mono' })).toHaveAttribute(
        'data-state',
        'checked',
      );
      fireEvent.click(screen.getByRole('option', { name: 'System monospace' }));
      expect(onChange).toHaveBeenCalledWith(SYSTEM);
    });

    it('shows a custom stack that is not an option as its own text, and in the title', () => {
      const custom = '"Iosevka Term", monospace';
      render(<Select value={custom} onChange={vi.fn()} options={STACKS} data-testid="font" />);
      expect(screen.getByTestId('font')).toHaveTextContent(custom);
      expect(screen.getByTestId('font')).toHaveAttribute('title', custom);
    });
  });

  // System fonts arrive over the control socket after the panel first renders, so
  // the same value can start without an option and gain one. The trigger has to
  // follow, or the Font row would keep showing a raw stack until it was reopened.
  it('swaps a raw value for its label when the matching option arrives later', () => {
    const view = render(
      <Select value="iosevka" onChange={vi.fn()} options={FONTS} data-testid="font" />,
    );
    expect(screen.getByTestId('font')).toHaveTextContent('iosevka');
    view.rerender(
      <Select
        value="iosevka"
        onChange={vi.fn()}
        options={[...FONTS, { value: 'iosevka', label: 'Iosevka Term' }]}
        data-testid="font"
      />,
    );
    expect(screen.getByTestId('font')).toHaveTextContent('Iosevka Term');
    expect(screen.getByTestId('font')).toHaveAttribute('title', 'Iosevka Term');
  });

  // The other half of "no native select in the panel": Radix mirrors the choice
  // into a hidden native <select> whenever the trigger sits inside a <form>. The
  // settings panel is not one, and this is what would break that claim if it were
  // ever wrapped in one.
  it('mirrors itself into a native select only inside a form', () => {
    const { container } = render(
      <form>
        <Select value="jetbrains" onChange={vi.fn()} options={FONTS} data-testid="font" />
      </form>,
    );
    expect(container.querySelector('form select')).not.toBeNull();
  });
});
