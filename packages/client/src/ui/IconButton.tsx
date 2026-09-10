// ── Kit: IconButton ───────────────────────────────────────────────────────────
//
// A square button holding one glyph. Sized off `--mbtn-h` — the extra-keys key
// height, this project's touch-target reference — falling back to 30px outside
// the surfaces that define it, so a desktop control and a thumb-driven one are
// the same size by construction.
//
// `label` is required: an icon-only control with no accessible name is invisible
// to a screen reader, and it doubles as the tooltip text at the call site.

import { forwardRef } from 'react';
import type { ButtonHTMLAttributes } from 'react';
import type { ButtonSize, ButtonVariant } from './Button';

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Accessible name (`aria-label`) — icon-only controls have no text. */
  label: string;
  variant?: ButtonVariant | undefined;
  size?: ButtonSize | undefined;
  'data-testid'?: string | undefined;
}

// Ghost and md ARE the base rule, so they add no class rather than an empty one.
const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: 'ui-icon-btn-primary',
  ghost: '',
  danger: 'ui-icon-btn-danger',
};

const SIZE_CLASS: Record<ButtonSize, string> = {
  sm: 'ui-icon-btn-sm',
  md: '',
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    label,
    variant = 'ghost',
    size = 'md',
    className,
    type = 'button',
    'data-testid': testId = 'ui-icon-button',
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={['ui-icon-btn', VARIANT_CLASS[variant], SIZE_CLASS[size], className]
        .filter(Boolean)
        .join(' ')}
      data-testid={testId}
      {...rest}
    />
  );
});
