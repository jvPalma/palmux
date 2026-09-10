// ── Kit: Tooltip ──────────────────────────────────────────────────────────────
//
// Radix Tooltip, one shared Provider (exported from the barrel) mounted once at
// the app root so the open/close delays are consistent and a second tooltip
// opens instantly while the pointer is still travelling.
//
// The trigger is `asChild`: the tooltip must anchor to the real control, and the
// `aria-describedby` Radix adds has to land on the focusable element for a
// screen reader to read the description. That is why the kit's Button and
// IconButton forward refs.

import * as RadixTooltip from '@radix-ui/react-tooltip';
import type { ReactElement, ReactNode } from 'react';

export interface TooltipProviderProps {
  children: ReactNode;
  /** Hover dwell before the first tooltip opens. */
  delayDuration?: number | undefined;
}

export function TooltipProvider({ children, delayDuration = 300 }: TooltipProviderProps) {
  return (
    <RadixTooltip.Provider delayDuration={delayDuration} skipDelayDuration={200}>
      {children}
    </RadixTooltip.Provider>
  );
}

export interface TooltipProps {
  /** Tooltip body — keep it to a phrase; this is not a popover. */
  content: ReactNode;
  /** The control the tooltip describes. Must accept a ref (Radix `asChild`). */
  children: ReactElement;
  side?: 'top' | 'right' | 'bottom' | 'left' | undefined;
  'data-testid'?: string | undefined;
}

export function Tooltip({
  content,
  children,
  side = 'top',
  'data-testid': testId = 'ui-tooltip',
}: TooltipProps) {
  return (
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          className="ui-tooltip"
          side={side}
          sideOffset={6}
          data-testid={testId}
        >
          {content}
          <RadixTooltip.Arrow className="ui-tooltip-arrow" />
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
