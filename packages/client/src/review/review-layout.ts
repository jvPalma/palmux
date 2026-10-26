// ── Layout by pane width ───────────────────────────────────────────────────────
//
// Two readable code columns need room: below this the pane is unified. Like the
// editor's gutter chrome (`panes/editor-layout.ts`) the rule keys off the PANE's
// width and not the device, because the dock is 300px on a desktop too, and the
// observer reports only the CROSSING: re-laying out a review on every frame of a
// dock animation is the resize storm the layout rules forbid elsewhere.

import type { ScmLayoutPref } from '../settings/settings';
import type { RowsLayout } from './rows';

export const REVIEW_SPLIT_MIN_PX = 720;

export const isNarrowReview = (width: number): boolean => width < REVIEW_SPLIT_MIN_PX;

/**
 * Below this the review bar has no room for its layout, wrap and algorithm controls
 * beside the title: they wrapped onto a second row, ~180px of a phone's 844. So they
 * fold into one menu and the bar stays one row. `NARROW_EDITOR_PX`'s number, for the
 * same pane: the width at which a phone-sized column stops being one.
 */
export const REVIEW_COMPACT_BAR_PX = 500;

/** The layout a preference resolves to at the pane's current width class. */
export function resolveReviewLayout(pref: ScmLayoutPref, narrow: boolean): RowsLayout {
  if (pref === 'split') return 'split';
  if (pref === 'unified') return 'unified';
  return narrow ? 'unified' : 'split';
}

/**
 * Whether lines wrap. Split always does (two half-width columns cannot share one
 * horizontal scroll). Unified follows the Wrap toggle, and without a choice wraps
 * exactly when the pane is narrow.
 */
export function resolveWrap(pref: boolean | null, layout: RowsLayout, narrow: boolean): boolean {
  if (layout === 'split') return true;
  return pref ?? narrow;
}

/**
 * Watch a host. `onWidth` hears every positive width; `onCross` only each time the
 * width crosses the threshold, and once at the start. A hidden pane measures 0 and
 * is ignored: panes stay mounted, so that happens on every tab switch and must not
 * read as "very narrow".
 */
export function observeReviewWidth(
  host: HTMLElement,
  onCross: (narrow: boolean) => void,
  onWidth?: (width: number) => void,
): () => void {
  let lastNarrow: boolean | null = null;
  const check = (width: number): void => {
    if (width <= 0) return;
    onWidth?.(width);
    const narrow = isNarrowReview(width);
    if (narrow === lastNarrow) return;
    lastNarrow = narrow;
    onCross(narrow);
  };
  check(host.getBoundingClientRect().width);
  if (typeof ResizeObserver === 'undefined') return () => {};
  const observer = new ResizeObserver((entries) => {
    check(entries[0]?.contentRect.width ?? 0);
  });
  observer.observe(host);
  return () => observer.disconnect();
}
