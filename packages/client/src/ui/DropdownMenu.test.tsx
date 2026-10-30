// The kit DropdownMenu's CHOICES: items that carry a state. The plain actions, the
// look and the trigger are pinned in ui.test.tsx; what is pinned here is what a
// screen reader and a keyboard get from a choice — the role, `aria-checked`, the
// radio set as one group, and the pick reaching `onSelect` from Enter and Space —
// and the STEPPER, a number with a minus and a plus that leaves the menu open.

import { cleanup, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DropdownMenu, IconButton, type DropdownMenuItemSpec } from './index';

afterEach(cleanup);

const items = (select: (id: string) => void, wrap = true): DropdownMenuItemSpec[] => [
  { id: 'open', label: 'Open', onSelect: () => select('open') },
  ...['split', 'unified'].map((value, i) => ({
    id: `layout-${value}`,
    label: value,
    checked: value === 'split',
    radioGroup: 'layout',
    separatorBefore: i === 0,
    onSelect: () => select(`layout-${value}`),
  })),
  {
    id: 'wrap',
    label: 'Wrap',
    checked: wrap,
    separatorBefore: true,
    onSelect: () => select('wrap'),
  },
];

const mount = (select = vi.fn(), wrap = true) => {
  render(
    <DropdownMenu items={items(select, wrap)} testidPrefix="m">
      <IconButton label="Menu" data-testid="trigger" />
    </DropdownMenu>,
  );
  return select;
};

/** Every item of the open menu, in order, as an assistive technology reads it. */
const announced = () =>
  [...screen.getByRole('menu').querySelectorAll<HTMLElement>('[role^="menuitem"]')].map((item) => ({
    label: item.textContent,
    role: item.getAttribute('role'),
    checked: item.getAttribute('aria-checked'),
  }));

const openFromKeyboard = async () => {
  screen.getByTestId('trigger').focus();
  await userEvent.keyboard('{Enter}');
};

describe('DropdownMenu choices', () => {
  it('announces a radio set and a check box with their state, beside a plain action', async () => {
    mount();
    await userEvent.click(screen.getByTestId('trigger'));
    expect(announced()).toEqual([
      { label: 'Open', role: 'menuitem', checked: null },
      { label: 'split', role: 'menuitemradio', checked: 'true' },
      { label: 'unified', role: 'menuitemradio', checked: 'false' },
      { label: 'Wrap', role: 'menuitemcheckbox', checked: 'true' },
    ]);
    // The radio set is ONE group, and its separator sits above it, not inside it.
    const [layout] = within(screen.getByRole('menu')).getAllByRole('group');
    expect(within(layout as HTMLElement).getAllByRole('menuitemradio')).toHaveLength(2);
    expect(layout?.querySelector('.ui-menu-sep')).toBeNull();
    expect(screen.getByRole('menu').querySelectorAll('.ui-menu-sep')).toHaveLength(2);
  });

  it('draws the check only on what is checked, in an icon slot every choice keeps', async () => {
    mount(vi.fn(), false);
    await userEvent.click(screen.getByTestId('trigger'));
    for (const id of ['layout-split', 'layout-unified', 'wrap']) {
      const item = screen.getByTestId(`m-${id}`);
      expect(item).toHaveClass('ui-menu-item');
      expect(item.querySelector('.ui-menu-icon')).toHaveAttribute('aria-hidden', 'true');
      expect(item.querySelector('svg') !== null).toBe(item.getAttribute('aria-checked') === 'true');
    }
    expect(screen.getByTestId('m-wrap')).toHaveAttribute('aria-checked', 'false');
  });

  it('picks a choice with Enter and toggles a check box with Space', async () => {
    const select = mount();
    await openFromKeyboard();
    // Open, split, unified.
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    expect(screen.getByTestId('m-layout-unified')).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(select).toHaveBeenLastCalledWith('layout-unified');
    expect(screen.queryByRole('menu')).toBeNull();

    await openFromKeyboard();
    await userEvent.keyboard('{End}');
    expect(screen.getByTestId('m-wrap')).toHaveFocus();
    await userEvent.keyboard(' ');
    expect(select).toHaveBeenLastCalledWith('wrap');
    expect(select).toHaveBeenCalledTimes(2);
  });

  it('never runs a disabled choice, and still says whether it is checked', async () => {
    const select = vi.fn();
    render(
      <DropdownMenu
        items={[
          { id: 'wrap', label: 'Always wraps', checked: true, disabled: true, onSelect: select },
        ]}
        testidPrefix="m"
      >
        <IconButton label="Menu" data-testid="trigger" />
      </DropdownMenu>,
    );
    await userEvent.click(screen.getByTestId('trigger'));
    const item = screen.getByTestId('m-wrap');
    expect(item).toHaveAttribute('aria-checked', 'true');
    expect(item).toHaveAttribute('data-disabled');
    await userEvent.click(item);
    expect(select).not.toHaveBeenCalled();
  });
});

describe('DropdownMenu side', () => {
  // The app menu's trigger is the first control of the dock rail, at the window's right edge, so
  // its menu has to open to the LEFT of it; a menu opened below would run off the screen.
  it('opens on the side it is given and below the trigger when none is', async () => {
    const select = vi.fn();
    const { unmount } = render(
      <DropdownMenu items={items(select)} testidPrefix="m" side="left" align="end">
        <IconButton label="Menu" data-testid="trigger" />
      </DropdownMenu>,
    );
    await userEvent.click(screen.getByTestId('trigger'));
    expect(screen.getByRole('menu')).toHaveAttribute('data-side', 'left');
    unmount();

    mount();
    await userEvent.click(screen.getByTestId('trigger'));
    expect(screen.getByRole('menu')).toHaveAttribute('data-side', 'bottom');
  });
});

describe('DropdownMenu stepper', () => {
  const stepper = (
    steps: { value: number; min?: number; max?: number },
    onStep: (id: string) => void,
  ): DropdownMenuItemSpec[] => [
    { id: 'open', label: 'Open', onSelect: () => onStep('open') },
    {
      id: 'size',
      label: 'Code font size',
      value: String(steps.value),
      decrease: {
        label: 'Smaller code',
        disabled: steps.value <= (steps.min ?? 0),
        onSelect: () => onStep('smaller'),
      },
      increase: {
        label: 'Larger code',
        disabled: steps.value >= (steps.max ?? 99),
        onSelect: () => onStep('larger'),
      },
      separatorBefore: true,
    },
  ];

  /** A menu whose value really changes, as a caller's state does. */
  function Live({
    onStep,
    start = 12,
    max,
  }: {
    onStep: (id: string) => void;
    start?: number;
    max?: number;
  }) {
    const [value, setValue] = useState(start);
    return (
      <DropdownMenu
        items={stepper({ value, ...(max === undefined ? {} : { max }) }, (id) => {
          onStep(id);
          if (id === 'smaller') setValue((v) => v - 1);
          if (id === 'larger') setValue((v) => v + 1);
        })}
        testidPrefix="m"
      >
        <IconButton label="Menu" data-testid="trigger" />
      </DropdownMenu>
    );
  }

  it('draws a named group: the label, a minus, the value and a plus', async () => {
    render(<Live onStep={vi.fn()} />);
    await userEvent.click(screen.getByTestId('trigger'));
    const group = screen.getByRole('group', { name: 'Code font size' });
    expect(within(group).getByTestId('m-size-value')).toHaveTextContent('12');
    expect(within(group).getByRole('menuitem', { name: 'Smaller code' })).toBe(
      screen.getByTestId('m-size-decrease'),
    );
    expect(within(group).getByRole('menuitem', { name: 'Larger code' })).toBe(
      screen.getByTestId('m-size-increase'),
    );
    // Minus comes before plus, with the value between them.
    const order = [...group.querySelectorAll('[data-testid]')].map((el) =>
      el.getAttribute('data-testid'),
    );
    expect(order).toEqual(['m-size-decrease', 'm-size-value', 'm-size-increase']);
    // A separator above it, like any item's.
    expect(screen.getByRole('menu').querySelectorAll('.ui-menu-sep')).toHaveLength(1);
  });

  it('steps without closing the menu, again and again, and shows each value', async () => {
    const onStep = vi.fn();
    render(<Live onStep={onStep} />);
    await userEvent.click(screen.getByTestId('trigger'));
    await userEvent.click(screen.getByTestId('m-size-decrease'));
    await userEvent.click(screen.getByTestId('m-size-decrease'));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getByTestId('m-size-value')).toHaveTextContent('10');
    await userEvent.click(screen.getByTestId('m-size-increase'));
    expect(screen.getByTestId('m-size-value')).toHaveTextContent('11');
    expect(onStep.mock.calls.map(([id]) => id)).toEqual(['smaller', 'smaller', 'larger']);
  });

  it('is reached and driven from the keyboard, and the menu stays open', async () => {
    const onStep = vi.fn();
    render(<Live onStep={onStep} />);
    await openFromKeyboard();
    // Open, then the minus, then the plus.
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByTestId('m-size-decrease')).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(screen.getByTestId('m-size-value')).toHaveTextContent('11');
    expect(screen.getByTestId('m-size-decrease')).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByTestId('m-size-increase')).toHaveFocus();
    await userEvent.keyboard(' ');
    await userEvent.keyboard('{Enter}');
    expect(screen.getByTestId('m-size-value')).toHaveTextContent('13');
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(onStep.mock.calls.map(([id]) => id)).toEqual(['smaller', 'larger', 'larger']);
  });

  it('announces the value politely, so each step is heard', async () => {
    render(<Live onStep={vi.fn()} />);
    await userEvent.click(screen.getByTestId('trigger'));
    const value = screen.getByTestId('m-size-value');
    expect(value).toHaveAttribute('aria-live', 'polite');
    expect(value).toHaveAttribute('aria-atomic', 'true');
  });

  it('leaves the other items closing the menu, and a step does not select them', async () => {
    const onStep = vi.fn();
    render(<Live onStep={onStep} />);
    await userEvent.click(screen.getByTestId('trigger'));
    await userEvent.click(screen.getByTestId('m-size-increase'));
    expect(onStep).not.toHaveBeenCalledWith('open');
    await userEvent.click(screen.getByTestId('m-open'));
    expect(onStep).toHaveBeenLastCalledWith('open');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('never runs a disabled button, and says it is disabled', async () => {
    const onStep = vi.fn();
    render(<Live onStep={onStep} start={9} max={9} />);
    await userEvent.click(screen.getByTestId('trigger'));
    const larger = screen.getByTestId('m-size-increase');
    expect(larger).toHaveAttribute('data-disabled');
    expect(larger).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(larger);
    expect(onStep).not.toHaveBeenCalled();
    expect(screen.getByTestId('m-size-decrease')).not.toHaveAttribute('data-disabled');
  });
});
