// ── Kit: Switch ───────────────────────────────────────────────────────────────
//
// Radix owns the behaviour (role, keyboard, `data-state`); ui.css owns the look.
// The thumb travels on --mo-switch (220ms, the kit's switch tier) with the
// surface easing, and the track crossfades on the micro tier.
//
// Props pass straight through to Radix's Root, so `id` still pairs with a
// `<label for=…>` the way the existing settings rows do.

import * as RadixSwitch from '@radix-ui/react-switch';
import type { ComponentPropsWithoutRef } from 'react';

export interface SwitchProps extends Omit<
  ComponentPropsWithoutRef<typeof RadixSwitch.Root>,
  'asChild' | 'children'
> {
  'data-testid'?: string | undefined;
}

export function Switch({ className, 'data-testid': testId = 'ui-switch', ...rest }: SwitchProps) {
  return (
    <RadixSwitch.Root
      className={['ui-switch', className].filter(Boolean).join(' ')}
      data-testid={testId}
      {...rest}
    >
      <RadixSwitch.Thumb className="ui-switch-thumb" />
    </RadixSwitch.Root>
  );
}
