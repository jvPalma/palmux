// ── Kit: Select ───────────────────────────────────────────────────────────────
//
// The one way to choose from a list. The settings panel had a native <select>
// for Font and a Radix popup of its own for Theme; a native element cannot take
// the kit's trigger, chevron or popup, so the two never looked like the same
// control and the phone drew the native one as a full-screen picker.
//
// The trigger is a control-height box that fills whatever column the caller gives
// it, with the label on ONE line: a value longer than its box ends in an ellipsis
// and the whole of it is the trigger's `title`. The popup is the menu surface
// (`.ui-menu`, the context menu's box) so a list and a menu cannot drift apart.
//
// Radix reserves the empty string for "no selection", so an option's `value` must
// not be ''. A `value` that matches no option still shows as its own text, rather
// than an empty box that looks like nothing is chosen.
//
// Radix drops `className` on `Select.Value`, so the label is styled through a data
// attribute instead (see `[data-ui-select-value]` in ui.css). `Select.ItemText`
// drops it too, so each option's label sits in a `.ui-menu-label` wrapper, the
// same element the context and dropdown menus use.

import * as RadixSelect from '@radix-ui/react-select';
import { Icon } from './icons';

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps {
  /** On the trigger, so a `<label htmlFor>` reaches it. */
  id?: string | undefined;
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  'aria-label'?: string | undefined;
  /** The trigger's id; each option is `<testid>-option-<value>`. */
  'data-testid'?: string | undefined;
}

export function Select({
  id,
  value,
  onChange,
  options,
  'aria-label': ariaLabel,
  'data-testid': testId = 'ui-select',
}: SelectProps) {
  const label = options.find((option) => option.value === value)?.label ?? value;
  return (
    <RadixSelect.Root value={value} onValueChange={onChange}>
      <RadixSelect.Trigger
        className="ui-select-trigger"
        id={id}
        aria-label={ariaLabel}
        title={label}
        data-testid={testId}
      >
        {/* The label is passed as children so it is ours to render: left to
            itself Radix clones the selected ItemText here, and a value with no
            matching option would leave the box empty. */}
        <RadixSelect.Value data-ui-select-value="">{label}</RadixSelect.Value>
        <RadixSelect.Icon className="ui-select-chevron">
          <Icon name="chevron-down" size={12} />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Portal>
        {/* `position="popper"` so the popup grows from the trigger and takes its
            width; the item-aligned default would slide the list over it instead. */}
        <RadixSelect.Content
          className="ui-menu ui-select-content"
          position="popper"
          sideOffset={4}
          collisionPadding={8}
        >
          <RadixSelect.ScrollUpButton className="ui-select-scroll">
            <Icon name="chevron-up" size={12} />
          </RadixSelect.ScrollUpButton>
          <RadixSelect.Viewport>
            {options.map((option) => (
              <RadixSelect.Item
                key={option.value}
                value={option.value}
                className="ui-menu-item ui-select-item"
                data-testid={`${testId}-option-${option.value}`}
              >
                {/* The wrapper carries the class because ItemText discards
                    `className` (and `style`). It is the menus' own label box,
                    so a long name ends in an ellipsis and the check beside it
                    stays in view. ItemText still holds the text: it names the
                    option and is what typeahead reads. */}
                <span className="ui-menu-label">
                  <RadixSelect.ItemText>{option.label}</RadixSelect.ItemText>
                </span>
                <RadixSelect.ItemIndicator className="ui-select-check">
                  <Icon name="check" size={12} />
                </RadixSelect.ItemIndicator>
              </RadixSelect.Item>
            ))}
          </RadixSelect.Viewport>
          <RadixSelect.ScrollDownButton className="ui-select-scroll">
            <Icon name="chevron-down" size={12} />
          </RadixSelect.ScrollDownButton>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  );
}
