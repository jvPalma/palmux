// ── Kit: Segmented ────────────────────────────────────────────────────────────
//
// A one-of-N control (Radix ToggleGroup, `type="single"`) for the two-to-four
// option settings a <select> makes needlessly heavy — mobile mode, cursor style.
// Generic over the value so the caller keeps its own union instead of `string`.

import * as ToggleGroup from '@radix-ui/react-toggle-group';
import { useCallback } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { consumeGesture } from '../panes/press';

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  disabled?: boolean | undefined;
}

export interface SegmentedProps<T extends string> {
  value: T;
  onValueChange: (value: T) => void;
  options: ReadonlyArray<SegmentedOption<T>>;
  /** Accessible name for the group — it has no visible label of its own. */
  label: string;
  className?: string | undefined;
  'data-testid'?: string | undefined;
  /**
   * Select without taking focus (the mobile drawer). Radix selects on CLICK, and
   * a click focuses the segment — which blurs the hidden `#mobile-kbd` textarea
   * and dismisses the soft keyboard, the exact reason every other drawer control
   * acts on pointerdown + preventDefault.
   *
   * So the selection moves INTO pointerdown, and that press marks its gesture
   * (`consumeGesture`, panes/press.ts) the way the drawer's fixed buttons do.
   * Selecting swaps the drawer's whole body, and the tap's own mousedown and
   * click would otherwise land on what the new view drew under the finger: the
   * mousedown moving focus off `#mobile-kbd`, the click pressing the newcomer.
   * A key, assistive tech or `click()` reaches a segment as a click with no
   * count, which the mark lets through to Radix's own handler.
   */
  keepFocus?: boolean | undefined;
}

export function Segmented<T extends string>({
  value,
  onValueChange,
  options,
  label,
  className,
  'data-testid': testId = 'ui-segmented',
  keepFocus = false,
}: SegmentedProps<T>) {
  // Radix reports '' when the pressed item was already selected. A segmented
  // control has no empty state, so that press is a no-op rather than a
  // deselection that would leave the setting with no value at all.
  const handleValueChange = useCallback(
    (next: string) => {
      if (next) onValueChange(next as T);
    },
    [onValueChange],
  );

  return (
    <ToggleGroup.Root
      type="single"
      className={['ui-seg', className].filter(Boolean).join(' ')}
      aria-label={label}
      value={value}
      onValueChange={handleValueChange}
      data-testid={testId}
    >
      {options.map((option) => (
        <ToggleGroup.Item
          key={option.value}
          className="ui-seg-item"
          value={option.value}
          disabled={option.disabled ?? false}
          data-testid={`${testId}-${option.value}`}
          {...(keepFocus && !option.disabled
            ? {
                onPointerDown: (e: ReactPointerEvent) => {
                  e.preventDefault();
                  consumeGesture(e, () => onValueChange(option.value));
                },
              }
            : {})}
        >
          {option.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}
