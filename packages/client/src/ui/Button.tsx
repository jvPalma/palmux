// ── Kit: Button ───────────────────────────────────────────────────────────────
//
// Three intents, two sizes, no colour of its own — every value resolves to a
// `--t-*` token in ui.css, which is what makes a theme switch repaint it.
//
// `forwardRef` (not an arrow component) because Radix `asChild` — Tooltip's
// trigger, a Dialog trigger — clones its child and hands it a ref; a plain
// function component would drop it and the tooltip would have nothing to anchor
// to. Same reasoning as Toast.tsx.

import { forwardRef } from 'react';
import type { ButtonHTMLAttributes } from 'react';

export type ButtonVariant = 'primary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant | undefined;
  size?: ButtonSize | undefined;
  /** Overridable so a consumer can name the specific control. */
  'data-testid'?: string | undefined;
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: 'ui-btn-primary',
  ghost: 'ui-btn-ghost',
  danger: 'ui-btn-danger',
};

const SIZE_CLASS: Record<ButtonSize, string> = {
  sm: 'ui-btn-sm',
  md: 'ui-btn-md',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'ghost',
    size = 'md',
    className,
    type = 'button',
    'data-testid': testId = 'ui-button',
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={['ui-btn', VARIANT_CLASS[variant], SIZE_CLASS[size], className]
        .filter(Boolean)
        .join(' ')}
      data-testid={testId}
      {...rest}
    />
  );
});
