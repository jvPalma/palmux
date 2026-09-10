import { describe, expect, it } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { ImageAddon } from '@xterm/addon-image';
import { imageAddonOptions } from './image-support';

// The DA1 answer IS the tmux integration: tmux queries it at client attach and
// gains the `sixel` feature from the `;4;` in the reply. Nothing else negotiates
// it, and the addon owns the override — so an xterm/addon version bump that
// silently reverted this would cost inline images with no other symptom.
const replyTo = async (query: string, withImage: boolean): Promise<string> => {
  const term = new Terminal({ allowProposedApi: true });
  if (withImage) term.loadAddon(new ImageAddon());
  let out = '';
  term.onData((d) => {
    out += d;
  });
  await new Promise<void>((resolve) => term.write(query, resolve));
  return out;
};

describe('DA1 report (the tmux sixel handshake)', () => {
  it('is a plain VT100 without the addon', async () => {
    expect(await replyTo('\x1b[c', false)).toBe('\x1b[?1;2c');
  });

  it('advertises sixel (;4;) once the addon is loaded', async () => {
    expect(await replyTo('\x1b[c', true)).toBe('\x1b[?62;4;9;22c');
  });
});

const KNOBS = ['pixelLimit', 'storageLimit', 'sixelSizeLimit', 'iipSizeLimit'] as const;

describe('imageAddonOptions', () => {
  it('caps every memory knob strictly tighter on mobile', () => {
    const desktop = imageAddonOptions(false);
    const mobile = imageAddonOptions(true);
    for (const knob of KNOBS) {
      expect(mobile[knob], knob).toBeGreaterThan(0);
      expect(mobile[knob], knob).toBeLessThan(desktop[knob] as number);
    }
  });

  it('keeps peak decode memory inside a phone tab budget', () => {
    // Two full RGBA buffers are alive at once while decoding — that product, not
    // the pixel count, is what gets the tab killed. Two panes may be decoding.
    const perPane = (imageAddonOptions(true).pixelLimit as number) * 4 * 2;
    expect(perPane).toBeLessThanOrEqual(32 * 1024 * 1024);
  });
});
