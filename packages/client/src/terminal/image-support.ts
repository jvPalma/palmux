// ── Inline terminal images: memory budgets ────────────────────────────────────
//
// Knobs for `@xterm/addon-image`. Both of the ones that matter are real memory,
// not preferences: a decode holds TWO full RGBA pixel buffers at once
// (`pixelLimit` × 4 bytes each), and the FIFO cache of already-drawn images
// holds `storageLimit` MB on top of that. The desktop numbers below ARE the
// addon's own defaults — spelled out rather than omitted so the mobile deltas
// are legible next to what they depart from.
//
// Mobile is not a smaller desktop. A phone tab is killed outright rather than
// swapped, and a split pane means TWO addons drawing on the same budget, so the
// pixel cap drops to 2048×2048 (32 MB of peak decode instead of 128 MB) and the
// cache to 32 MB. The sequence caps come down with them for a different reason:
// a 25 MB SIXEL escape has to cross the WebSocket in full before a single pixel
// is decoded, and on a phone link that is a freeze, not a picture.
//
// Everything else stays at the addon defaults on purpose. `sixelPaletteLimit`
// in particular: apps read it back via XTSMGRAPHICS and will happily emit more
// colours if offered, which only makes the sequence bigger for the same picture.

import type { IImageAddonOptions } from '@xterm/addon-image';

const DESKTOP: IImageAddonOptions = {
  pixelLimit: 4096 * 4096,
  storageLimit: 128,
  sixelSizeLimit: 25_000_000,
  iipSizeLimit: 20_000_000,
};

const MOBILE: IImageAddonOptions = {
  pixelLimit: 2048 * 2048,
  storageLimit: 32,
  sixelSizeLimit: 8_000_000,
  iipSizeLimit: 8_000_000,
};

/** Per-device image budget. One object per pane — the caps are per addon instance. */
export function imageAddonOptions(mobile: boolean): IImageAddonOptions {
  return mobile ? MOBILE : DESKTOP;
}
