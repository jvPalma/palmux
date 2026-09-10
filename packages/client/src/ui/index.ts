// ── Component kit barrel ──────────────────────────────────────────────────────
//
// The kit is additive: nothing in the app imports it yet. Consumers take
// `import { Button, Switch } from '../ui'`; ui.css is imported once from
// main.tsx, not per component, so a component can never be styled by accident.

export { Button } from './Button';
export type { ButtonProps, ButtonSize, ButtonVariant } from './Button';

export { IconButton } from './IconButton';
export type { IconButtonProps } from './IconButton';

export { Input } from './Input';
export type { InputProps } from './Input';

export { Switch } from './Switch';
export type { SwitchProps } from './Switch';

export { Segmented } from './Segmented';
export type { SegmentedOption, SegmentedProps } from './Segmented';

export { Tooltip, TooltipProvider } from './Tooltip';
export type { TooltipProps, TooltipProviderProps } from './Tooltip';

export { Collapsible } from './Collapsible';
export type { CollapsibleProps } from './Collapsible';

export { Dialog } from './Dialog';
export type { DialogProps } from './Dialog';

export { ErrorBoundary } from './ErrorBoundary';
export type { ErrorBoundaryProps } from './ErrorBoundary';
