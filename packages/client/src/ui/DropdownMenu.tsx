// ── Kit: DropdownMenu ─────────────────────────────────────────────────────────
//
// A menu opened by a BUTTON, as ContextMenu is a menu opened by a right-click or
// a long press. The app menu in the topbar is the first caller. Radix keeps what
// a popover of buttons would lose: `role="menu"`, roving focus, type-ahead,
// Escape, and focus returning to the trigger on close.
//
// It reuses ContextMenu's item shape and its `.ui-menu` / `.ui-menu-item`
// classes, so the two menus cannot drift apart. The only difference in look is
// the transform origin: a dropdown grows out of its trigger, and Radix publishes
// that as its own variable (see `.ui-dropdown` in ui.css).
//
// An item can also be a CHOICE that carries its state (`checked`): a check box
// (`menuitemcheckbox`) on its own, or one option of a radio set (`menuitemradio`)
// when it names a `radioGroup`. A check icon drawn into an ordinary item shows the
// state to the eye only, and a screen reader hears a plain command; `aria-checked`
// is what says which option is current. The check sits in the icon slot, which
// every choice keeps, so the labels line up whichever one is checked.
//
// A STEPPER is a number with a minus and a plus: one row, two menu items either side
// of the value. Selecting one does NOT close the menu (`preventDefault` on Radix's
// select event), because the point of the control is to tap it again and watch what it
// changes. Both buttons are real menu items, so the keyboard reaches them (the roving
// focus walks minus, then plus) and Enter or Space steps; a button that was not an item
// could not take focus at all, since Radix keeps Tab inside the menu from leaving it.
// The group is named by the label and the value is a polite live region, so each step
// is announced. The row is built from the item classes the other rows use, so it needs
// no sheet of its own.

import * as Radix from '@radix-ui/react-dropdown-menu';
import type { ReactNode } from 'react';
import type { ContextMenuItemSpec } from './ContextMenu';
import { Icon } from './icons';

/** An action, exactly as in the context menu. */
export interface DropdownMenuActionSpec extends ContextMenuItemSpec {
  checked?: undefined;
  radioGroup?: undefined;
}

/** A choice. Its icon slot holds the check, so it takes no icon of its own. */
export interface DropdownMenuChoiceSpec extends Omit<ContextMenuItemSpec, 'icon'> {
  checked: boolean;
  /**
   * Adjacent items naming the same group are ONE radio set, and the item that is
   * `checked` is its value. Without a group the item is a check box.
   */
  radioGroup?: string | undefined;
}

/** One button of a stepper. */
export interface DropdownMenuStep {
  /** What the button does, for assistive technology: it shows only a glyph. */
  label: string;
  disabled?: boolean | undefined;
  onSelect: () => void;
}

/** A value with a minus and a plus. Neither button closes the menu. */
export interface DropdownMenuStepperSpec {
  id: string;
  /** Names the row, drawn before the buttons and read as the group's name. */
  label: string;
  /** The current value, between the buttons; announced politely when it changes. */
  value: string;
  decrease: DropdownMenuStep;
  increase: DropdownMenuStep;
  separatorBefore?: boolean | undefined;
  checked?: undefined;
  radioGroup?: undefined;
}

export type DropdownMenuItemSpec =
  | DropdownMenuActionSpec
  | DropdownMenuChoiceSpec
  | DropdownMenuStepperSpec;

const isStepper = (item: DropdownMenuItemSpec): item is DropdownMenuStepperSpec =>
  'decrease' in item;

export interface DropdownMenuProps {
  items: DropdownMenuItemSpec[];
  /** The trigger. Rendered as-is (`asChild`), so it must be a single button. */
  children: ReactNode;
  /** Prefix for each item's `data-testid` (`<prefix>-<item id>`); the menu itself carries the bare prefix. */
  testidPrefix?: string | undefined;
  /** Which edge of the trigger the menu lines up with. */
  align?: 'start' | 'center' | 'end' | undefined;
}

/** One item, or the adjacent items of one radio set. */
type ItemRun = [DropdownMenuItemSpec, ...DropdownMenuItemSpec[]];

function runsOf(items: readonly DropdownMenuItemSpec[]): ItemRun[] {
  const runs: ItemRun[] = [];
  for (const item of items) {
    const last = runs.at(-1);
    if (last && item.radioGroup !== undefined && last[0].radioGroup === item.radioGroup) {
      last.push(item);
    } else {
      runs.push([item]);
    }
  }
  return runs;
}

function Stepper({
  item,
  testidPrefix,
}: {
  item: DropdownMenuStepperSpec;
  testidPrefix: string | undefined;
}) {
  const testid = (part: string): string | undefined =>
    testidPrefix ? `${testidPrefix}-${item.id}-${part}` : undefined;
  const button = (step: DropdownMenuStep, part: string, glyph: string) => (
    <Radix.Item
      className="ui-menu-item"
      aria-label={step.label}
      disabled={step.disabled ?? false}
      data-testid={testid(part)}
      onSelect={(event) => {
        event.preventDefault();
        step.onSelect();
      }}
    >
      <span className="ui-menu-icon" aria-hidden="true">
        {glyph}
      </span>
    </Radix.Item>
  );
  return (
    <div role="group" aria-label={item.label} className="ui-menu-item">
      <span className="ui-menu-label">{item.label}</span>
      {button(item.decrease, 'decrease', '−')}
      <span
        className="ui-menu-icon"
        aria-live="polite"
        aria-atomic="true"
        data-testid={testid('value')}
      >
        {item.value}
      </span>
      {button(item.increase, 'increase', '+')}
    </div>
  );
}

function MenuItem({
  item,
  testidPrefix,
}: {
  item: Exclude<DropdownMenuItemSpec, DropdownMenuStepperSpec>;
  testidPrefix: string | undefined;
}) {
  const shared = {
    className: `ui-menu-item${item.danger ? ' danger' : ''}`,
    disabled: item.disabled ?? false,
    'data-testid': testidPrefix ? `${testidPrefix}-${item.id}` : undefined,
    onSelect: item.onSelect,
  };
  const label = <span className="ui-menu-label">{item.label}</span>;
  if (item.checked === undefined) {
    return (
      <Radix.Item {...shared}>
        {item.icon !== undefined && (
          <span className="ui-menu-icon" aria-hidden="true">
            {item.icon}
          </span>
        )}
        {label}
      </Radix.Item>
    );
  }
  const body = (
    <>
      <span className="ui-menu-icon" aria-hidden="true">
        <Radix.ItemIndicator>
          <Icon name="check" size={14} />
        </Radix.ItemIndicator>
      </span>
      {label}
    </>
  );
  return item.radioGroup === undefined ? (
    <Radix.CheckboxItem {...shared} checked={item.checked}>
      {body}
    </Radix.CheckboxItem>
  ) : (
    <Radix.RadioItem {...shared} value={item.id}>
      {body}
    </Radix.RadioItem>
  );
}

export function DropdownMenu({
  items,
  children,
  testidPrefix,
  align = 'start',
}: DropdownMenuProps) {
  if (items.length === 0) return <>{children}</>;
  return (
    <Radix.Root>
      {/* asChild: the trigger must BE the caller's button, not a wrapper around
          it — a wrapper would add a box the topbar's flex row does not account for. */}
      <Radix.Trigger asChild className="ui-menu-trigger">
        {children}
      </Radix.Trigger>
      <Radix.Portal>
        <Radix.Content
          className="ui-menu ui-dropdown"
          align={align}
          sideOffset={4}
          collisionPadding={8}
          data-testid={testidPrefix}
        >
          {runsOf(items).flatMap((run) => {
            const [first] = run;
            const radioGroup = first.radioGroup;
            // A separator above a radio set is drawn outside it, so the group holds
            // its options and nothing else.
            const entries = run.map((item, index) => (
              <div key={item.id}>
                {item.separatorBefore && (radioGroup === undefined || index > 0) && (
                  <Radix.Separator className="ui-menu-sep" />
                )}
                {isStepper(item) ? (
                  <Stepper item={item} testidPrefix={testidPrefix} />
                ) : (
                  <MenuItem item={item} testidPrefix={testidPrefix} />
                )}
              </div>
            ));
            if (radioGroup === undefined) return entries;
            return (
              <div key={`${radioGroup}:${first.id}`}>
                {first.separatorBefore && <Radix.Separator className="ui-menu-sep" />}
                <Radix.RadioGroup value={run.find((item) => item.checked)?.id}>
                  {entries}
                </Radix.RadioGroup>
              </div>
            );
          })}
        </Radix.Content>
      </Radix.Portal>
    </Radix.Root>
  );
}
