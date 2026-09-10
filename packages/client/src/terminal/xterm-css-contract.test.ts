// What palmux's CSS is allowed to do to xterm's own DOM.
//
// This is a grep, not a render test, and that is deliberate: the bug it guards
// against has no runtime symptom a jsdom test could see. xterm 6 moved
// `.xterm-screen` inside VS Code's scrollable element, which positions it with
// an INLINE `top` to implement scrolling. A stylesheet rule that also positions
// it loses to that inline style on `top` but WINS on `bottom` — so the element
// ends up anchored by both at once and renders a full viewport off-screen.
//
// On a phone that meant the terminal was simply not there: black above the
// extra-keys bar, no error, nothing in the console. Geometry checks that measure
// widths pass happily. The only cheap, durable guard is to forbid the pattern.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Comments are stripped first: without that, everything since the previous `}`
// — including this file's own explanatory comments — lands in the selector.
const css = readFileSync(join(__dirname, '../index.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Selector blocks whose body we care about, flattened to `selector{body}`. */
const blocks = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, sel, body]) => ({
  sel: (sel ?? '').replace(/\s+/g, ' ').trim(),
  body: body ?? '',
}));

describe('xterm DOM ownership', () => {
  it('never positions .xterm-screen — xterm 6 owns that', () => {
    const offenders = blocks
      .filter((b) => /\.xterm-screen\b/.test(b.sel))
      .filter((b) => /(^|[;\s])(top|bottom|left|right|position)\s*:/.test(b.body))
      .map((b) => b.sel);
    expect(offenders, `move the offset to a transform on .xterm instead`).toEqual([]);
  });

  it('never positions the scrollable element or its slider container', () => {
    const offenders = blocks
      .filter((b) => /\.xterm-scrollable-element\b/.test(b.sel))
      .filter((b) => /(^|[;\s])(top|bottom|position|height)\s*:/.test(b.body))
      .map((b) => b.sel);
    expect(offenders).toEqual([]);
  });

  // The gutter the owner reported: a cream stripe down the right of the terminal
  // on a light theme. Two separate causes, and only one of them is reclaimable.
  describe('the right gutter', () => {
    it('has no scrollbar to leave a gutter, on ANY device', () => {
      // Owner decision: removed everywhere, not just on mobile. xterm 6's
      // scrollbar is a `vs/base` widget, so only this selector reaches it —
      // `scrollbar-width` and `::-webkit-scrollbar` do not.
      const rule = blocks.find(
        (b) => b.sel === '.term-host .xterm .xterm-scrollable-element > .scrollbar',
      );
      expect(rule, 'the scrollbar rule is gone or re-scoped').toBeTruthy();
      expect(rule!.body).toMatch(/display:\s*none/);
      // Re-scoping it to mobile would silently bring the desktop gutter back.
      expect(blocks.map((b) => b.sel).filter((s) => /\.scrollbar\b/.test(s))).toEqual([
        '.term-host .xterm .xterm-scrollable-element > .scrollbar',
      ]);
    });

    it("overhangs the host by the fit addon's fixed scrollbar reservation", () => {
      // addon-fit 0.11 subtracts a flat `overviewRuler.width || 14` and offers no
      // way to ask for zero, so the host is widened by exactly that and clipped.
      expect(blocks.find((b) => b.sel === '.term-host')?.body).toMatch(
        /width:\s*calc\(100% \+ 14px\)/,
      );
      expect(blocks.find((b) => b.sel === '.term-wrap')?.body).toMatch(/overflow:\s*hidden/);
    });

    it("drops xterm's own 2px inset on mobile", () => {
      // 4px across the two edges where columns are scarcest, showing the APP
      // background rather than the terminal's.
      expect(blocks.find((b) => b.sel === '.app.mobile .term-host .xterm')?.body).toMatch(
        /padding:\s*0/,
      );
    });

    it('paints the wrapper in the TERMINAL background, not the derived UI base', () => {
      // `floor(width / cellWidth)` always leaves a sub-cell remainder; it cannot
      // be reclaimed, but it must not read as a strip of the app showing through.
      const rule = blocks.find((b) => b.sel === '.term-wrap');
      expect(rule?.body).toMatch(/background:\s*var\(--t-term-bg/);
      // --t-base is the DERIVED chrome colour and differs from the terminal's own.
      expect(rule?.body).not.toMatch(/var\(--t-base/);
    });
  });

  it('offsets the mobile grid with a transform, which is layout-neutral', () => {
    // A transform cannot feed back into the fit (it is not layout) and IS
    // reflected in getBoundingClientRect, which is how touch.ts maps taps.
    const rule = blocks.find((b) => b.sel === '.app.mobile .term-host .xterm');
    expect(rule, 'the mobile bottom-align rule is gone').toBeTruthy();
    expect(rule!.body).toMatch(/transform:\s*translateY\(var\(--fit-rem/);
  });
});
