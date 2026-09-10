// ── Theme swatch content ──────────────────────────────────────────────────────
//
// The lines drawn inside each option of the theme picker.
//
// A row of sixteen colour chips tells you a palette is "colourful" and nothing
// about whether you can READ it. A fake shell session does: the same tokens a
// real prompt colours, at the size and against the background they will actually
// have. That is the only way to see that a theme's red is invisible on its own
// background, or that its comment grey has vanished.
//
// Pure and data-only so the token/slot choice is reviewable and testable without
// rendering anything.

/** One coloured run. `slot` indexes ansi16; `fg` uses the profile's foreground. */
export interface PreviewToken {
  text: string;
  /** 0–15 → that ANSI colour. `'fg'` → the profile's foreground. */
  slot: number | 'fg';
  dim?: boolean;
}

/**
 * Two lines of shell, chosen to exercise a SPREAD of the palette rather than
 * all of it: a prompt with a path and a git branch, then a command and an
 * error. Between them they use slots 2–6 and 9–14 plus the bright black that
 * every theme uses for comments — the colours a terminal actually shows you all
 * day. The remaining slots (0 black, 7/15 white) are the background and the
 * foreground, which the swatch already shows by being itself.
 */
export const PREVIEW_LINES: PreviewToken[][] = [
  [
    { text: '~/proj', slot: 4 },
    { text: ' ', slot: 'fg' },
    { text: 'main', slot: 5 },
    { text: ' ✔', slot: 2 },
    { text: ' ❯ ', slot: 10 },
    { text: 'yarn', slot: 'fg' },
    { text: ' build', slot: 14 },
    { text: ' -w', slot: 3 },
  ],
  [
    { text: 'warn', slot: 11 },
    { text: ' 2 chunks', slot: 8, dim: true },
    { text: ' ', slot: 'fg' },
    { text: 'error', slot: 9 },
    { text: ' TS2345', slot: 13 },
    { text: ': ', slot: 8, dim: true },
    { text: 'x', slot: 6 },
    { text: '≠', slot: 'fg' },
    { text: 'y', slot: 12 },
  ],
];

/**
 * Longest line the swatch may hold.
 *
 * MEASURED, not estimated: the popup is 300px, the swatch is 10.5px monospace
 * with 18px of padding, and a character comes out at ~7px — so 32 columns, not
 * the 40 an em-width guess gave. The first version overflowed by 36px and the
 * last two tokens of line two were replaced by an ellipsis, which in a COLOUR
 * sample silently hides the slots it exists to show.
 */
export const MAX_PREVIEW_CHARS = 32;

/** Every ANSI slot the preview actually paints — the coverage claim, testable. */
export function previewSlots(lines: PreviewToken[][] = PREVIEW_LINES): number[] {
  const out = new Set<number>();
  for (const line of lines) for (const t of line) if (typeof t.slot === 'number') out.add(t.slot);
  return [...out].sort((a, b) => a - b);
}

/**
 * Split the profiles into the two groups the picker shows.
 *
 * Light and dark is the only division worth making here: it is the one thing a
 * reader is choosing between before they look at anything else, and every other
 * grouping (by family, by origin) puts near-identical swatches in different
 * places. Order inside a group is left alone — the registry's order is
 * deliberate, and sorting would scatter each family's variants.
 */
export function groupByBrightness<T>(
  profiles: T[],
  isLight: (p: T) => boolean,
): { dark: T[]; light: T[] } {
  const dark: T[] = [];
  const light: T[] = [];
  for (const p of profiles) (isLight(p) ? light : dark).push(p);
  return { dark, light };
}
