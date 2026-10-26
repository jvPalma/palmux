// ── Kit: VirtualList ──────────────────────────────────────────────────────────
//
// For LONG content: it mounts only the rows near the visible part plus an
// overscan, so ten thousand rows cost a few dozen elements. A thin wrapper over
// react-window 2.3.3's `List`; the props are react-window's own, so its docs and
// types apply as written (`rowCount`, `rowHeight` as a number, a function or a
// `useDynamicRowHeight` result, `rowComponent`, `rowProps`, `overscanCount`,
// `onRowsRendered`, `listRef`, `style`).
//
// react-window is its own scroll container: the `List` element IS the scroller,
// and rows are absolutely positioned inside it. That is why a `ScrollArea` cannot
// wrap it (two nested scrollers, and the row maths reads this element's scroll
// offset), and why the list wears a thin NATIVE scrollbar (`scrollbar-width` and
// `scrollbar-color` in ui.css, from the thumb colour the ScrollArea uses) rather
// than Radix's. Touch panning stays native: nothing here handles a pointer event.
//
// The row component receives the absolutely positioned `style` and must spread it
// on its root element. With a dynamic row height, leave `height` out of it: rows
// are measured, and the rows below move down when one grows.
//
// Give the list a height: a `style.height`, or a flex-column parent with
// `min-height: 0`, in which case it measures itself. The hooks and types a
// consumer needs are re-exported so nothing outside the kit imports react-window.

import { List, useDynamicRowHeight, useListRef } from 'react-window';
import type { ListProps } from 'react-window';

export type VirtualListProps<RowProps extends object> = ListProps<RowProps>;

export function VirtualList<RowProps extends object>({
  className,
  ...rest
}: VirtualListProps<RowProps>) {
  return (
    <List<RowProps>
      {...rest}
      className={['ui-virtual-list', className].filter(Boolean).join(' ')}
    />
  );
}

export { useDynamicRowHeight, useListRef };
export type { DynamicRowHeight, ListImperativeAPI, RowComponentProps } from 'react-window';
