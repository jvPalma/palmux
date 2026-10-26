// ── Kit: ScrollArea ───────────────────────────────────────────────────────────
//
// For BOUNDED content: a settings form, a short list, a panel body. Radix owns
// the scrollbar's behaviour (thumb size, drag, `type="auto"` so it shows exactly
// when the content overflows, like native `overflow: auto`); ui.css owns the
// look, from the same `--ui-scroll-thumb` colour the VirtualList's native
// scrollbar uses, so the two read as one control.
//
// A long list does NOT belong in here. react-window is its own scroll container,
// so wrapping it would give two nested scrollers and break its row maths; that
// is `VirtualList`'s job, and it wears a thin native scrollbar instead.
//
// Vertical by default: the content is laid out as a block, so a long line
// truncates or wraps inside the area instead of opening a sideways scroll. Radix
// wraps its content in a `display: table` box that grows to the widest line;
// only the horizontal and both-ways areas want that.
//
// Not for the terminal grid (it scrolls itself) and, on a phone, the bar is
// hidden by ui.css: it would sit on the edge the drawer's gesture lives on.

import * as RadixScrollArea from '@radix-ui/react-scroll-area';
import type { CSSProperties, ReactNode } from 'react';

export interface ScrollAreaProps {
  children: ReactNode;
  /** Which way the content scrolls. Vertical unless asked. */
  orientation?: 'vertical' | 'horizontal' | 'both' | undefined;
  /** For a child of a flex column: take the height the siblings leave and scroll
   *  inside it. Without it the area is as tall as its parent (`height: 100%`),
   *  which scrolls only when that parent has a height of its own. */
  fill?: boolean | undefined;
  className?: string | undefined;
  style?: CSSProperties | undefined;
  'data-testid'?: string | undefined;
}

// Radix's own inline `display: table` beats any stylesheet rule short of
// `!important`, and a prop is the one door it leaves open.
const BLOCK_CONTENT: CSSProperties = { display: 'block' };

function Bar({ orientation }: { orientation: 'vertical' | 'horizontal' }) {
  return (
    <RadixScrollArea.Scrollbar orientation={orientation} className="ui-scroll-bar">
      <RadixScrollArea.Thumb className="ui-scroll-thumb" />
    </RadixScrollArea.Scrollbar>
  );
}

export function ScrollArea({
  children,
  orientation = 'vertical',
  fill = false,
  className,
  style,
  'data-testid': testId = 'ui-scroll-area',
}: ScrollAreaProps) {
  const vertical = orientation !== 'horizontal';
  const horizontal = orientation !== 'vertical';
  return (
    <RadixScrollArea.Root
      type="auto"
      className={['ui-scroll', fill && 'ui-scroll-fill', className].filter(Boolean).join(' ')}
      style={style}
      data-testid={testId}
    >
      <RadixScrollArea.Viewport
        className="ui-scroll-viewport"
        disableImplicitContentElement
        data-testid={`${testId}-viewport`}
      >
        <RadixScrollArea.Content
          className="ui-scroll-content"
          style={horizontal ? undefined : BLOCK_CONTENT}
        >
          {children}
        </RadixScrollArea.Content>
      </RadixScrollArea.Viewport>
      {vertical && <Bar orientation="vertical" />}
      {horizontal && <Bar orientation="horizontal" />}
      {vertical && horizontal && <RadixScrollArea.Corner />}
    </RadixScrollArea.Root>
  );
}
