// ── Whether the review is drawn compact ────────────────────────────────────────
//
// On a phone the review gives up height before anything else: a gap, a hunk header and
// a file header are shorter (`COMPACT_ROW_METRICS`). Height is JavaScript's number (the
// list is handed an exact one per row), so the pane has to KNOW, and it reads the same
// flag the scale does: App writes `data-mobile` on `:root` from the resolved mobile
// mode, which is what raises `--ctl-h` to 36px. It keys on the device class and not on
// the pane's width, as `review-layout.ts` does for the layout, because a phone held
// sideways has a wide pane and still has little height.

import { useSyncExternalStore } from 'react';

const ATTRIBUTE = 'data-mobile';

const read = (): boolean => document.documentElement.getAttribute(ATTRIBUTE) === 'true';

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: [ATTRIBUTE] });
  return () => observer.disconnect();
}

/** True while the app is in its mobile layer. Follows a change of the mode at once. */
export const useCompactReview = (): boolean => useSyncExternalStore(subscribe, read, () => false);
