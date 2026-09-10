// ── Kit: Input ────────────────────────────────────────────────────────────────
//
// A plain text field on the recessed depth level (--t-base), so it reads as cut
// into the panel rather than sitting on it. No label, no row layout: the caller
// owns those, because the settings form and the dock lay rows out differently.

import { forwardRef } from 'react';
import type { InputHTMLAttributes } from 'react';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Paints the danger border; leave off for the resting state. */
  invalid?: boolean | undefined;
  'data-testid'?: string | undefined;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { invalid = false, className, type = 'text', 'data-testid': testId = 'ui-input', ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      type={type}
      className={['ui-input', invalid ? 'ui-input-invalid' : '', className]
        .filter(Boolean)
        .join(' ')}
      {...(invalid ? { 'aria-invalid': true } : {})}
      data-testid={testId}
      {...rest}
    />
  );
});
