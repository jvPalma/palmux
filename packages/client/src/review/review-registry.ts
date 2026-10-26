// ── Which review the keybindings are talking to ───────────────────────────────
//
// Panes stay mounted while their tab exists, so several reviews are alive at once,
// and the review keys (next change, Reviewed, …) must reach the one the user is
// looking at. App knows which tab that is; a review pane knows how to move. This
// registry joins them by tab id, the way `panes/editor-registry.ts` does for the
// extra-keys bar: ref-held and read when a key is pressed, so a handler never has
// to re-bind as a pane re-renders.

/** What a review pane lets the app do to it. */
export interface ReviewApi {
  nextChange(): void;
  prevChange(): void;
  nextFile(): void;
  prevFile(): void;
  /** Reviewed in a Changes review, Unstage in a Staged one, for the file in view. */
  reviewCurrent(): void;
}

const reviews = new Map<string, ReviewApi>();

/** Register a pane's api under its tab id. Returns the way to take it out again. */
export function registerReview(tabId: string, api: ReviewApi): () => void {
  reviews.set(tabId, api);
  return () => {
    // A pane that remounted under the same id has already put its own in.
    if (reviews.get(tabId) === api) reviews.delete(tabId);
  };
}

export function reviewApiFor(tabId: string): ReviewApi | undefined {
  return reviews.get(tabId);
}

/** Test seam: the module holds process-wide state by design. */
export function resetReviewRegistry(): void {
  reviews.clear();
}
