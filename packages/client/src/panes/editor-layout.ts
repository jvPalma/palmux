// ── How much chrome an editor can afford ──────────────────────────────────────
//
// Monaco's defaults assume a desktop pane. Measured on a 390px phone: the text
// got 319px and the other 71px — 18% of the screen — went to the line-number
// gutter, the folding column, the decoration margin and the overview ruler. On a
// narrow pane that chrome costs more than it gives, and horizontal scrolling in
// a code file on a touch screen is worse than a wrapped line.
//
// This keys off the PANE's width, not `mobileMode`. The dock is 300px on a
// desktop too, and an editor in it is exactly as cramped as one on a phone —
// a device check would have fixed one and missed the other.

/** Below this, the pane cannot afford Monaco's gutter chrome. Measured, not guessed:
 *  at 390px the chrome took 71px; by ~520px it is under 14% and stops mattering. */
export const NARROW_EDITOR_PX = 500;

/** The subset of Monaco options that depend on how wide the pane is. */
export interface EditorLayoutOptions {
  lineNumbers: 'on' | 'off';
  folding: boolean;
  glyphMargin: boolean;
  lineDecorationsWidth: number;
  overviewRulerLanes: number;
  hideCursorInOverviewRuler: boolean;
  wordWrap: 'on';
  scrollbar: { verticalScrollbarSize: number; horizontalScrollbarSize: number };
  scrollBeyondLastLine: boolean;
}

/**
 * `wordWrap` is 'on' at every width on purpose. A terminal user reads code in a
 * narrow column far more often than they need column alignment, and the pane can
 * be a 300px dock at any viewport size — so wrapping is the safe default and the
 * only thing that changes with width is how much chrome sits beside the text.
 */
export function editorLayoutOptions(width: number): EditorLayoutOptions {
  const narrow = width > 0 && width < NARROW_EDITOR_PX;
  return {
    lineNumbers: narrow ? 'off' : 'on',
    folding: !narrow,
    glyphMargin: false,
    lineDecorationsWidth: narrow ? 0 : 10,
    // The ruler is a desktop affordance: a miniature of a file you can already
    // see all of. On a phone it is a stripe of colour that costs a column.
    overviewRulerLanes: narrow ? 0 : 2,
    hideCursorInOverviewRuler: narrow,
    wordWrap: 'on',
    // Touch needs a bigger grab target than a mouse; a 6px slider is unusable
    // with a finger and a 14px one wastes a phone's width.
    scrollbar: {
      verticalScrollbarSize: narrow ? 10 : 14,
      horizontalScrollbarSize: narrow ? 10 : 14,
    },
    // Half a screen of blank space below the last line is a desktop luxury.
    scrollBeyondLastLine: !narrow,
  };
}

/**
 * Watch a host and report each time it crosses the narrow threshold.
 *
 * Only the CROSSING is reported, not every resize: `updateOptions` re-lays out
 * the editor, and firing it on every frame of a dock animation is the resize
 * storm the layout rules already forbid elsewhere.
 */
export function observeEditorWidth(
  host: HTMLElement,
  onChange: (opts: EditorLayoutOptions) => void,
): () => void {
  let lastNarrow: boolean | null = null;
  const check = (width: number) => {
    const narrow = width > 0 && width < NARROW_EDITOR_PX;
    if (narrow === lastNarrow) return;
    lastNarrow = narrow;
    onChange(editorLayoutOptions(width));
  };
  check(host.getBoundingClientRect().width);
  if (typeof ResizeObserver === 'undefined') return () => {};
  const ro = new ResizeObserver((entries) => {
    const w = entries[0]?.contentRect.width ?? 0;
    // A hidden pane measures 0 and must not be mistaken for "very narrow" —
    // panes stay mounted here, so this happens on every tab switch.
    if (w > 0) check(w);
  });
  ro.observe(host);
  return () => ro.disconnect();
}
