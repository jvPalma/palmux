// The tab strip's SHAPE contract.
//
// Two of these were broken while writing the Chrome-like strip, and neither
// showed up in SessionTabs.test.tsx — that suite asserts behaviour, and happy-dom
// has no layout, so a tab can be the wrong shape or collapsed to nothing and
// every behavioural test still passes. These are grep-level assertions on the
// stylesheet, which is the only cheap place to catch them.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(__dirname, '../index.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

const blocks = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, sel, body]) => ({
  sel: (sel ?? '').replace(/\s+/g, ' ').trim(),
  body: body ?? '',
}));
const rule = (selector: string) => blocks.find((b) => b.sel === selector);

describe('tab strip shape', () => {
  it('aligns the strip to flex-end so the active tab can stand taller', () => {
    expect(rule('.session-tabs')?.body).toMatch(/align-items:\s*flex-end/);
  });

  // Regression: the strip used to be `align-items: stretch`, which is what gave
  // .group-chip its height. Switching to flex-end collapsed the chip to a 12px
  // sliver that read as a stray coloured line between two tabs.
  it('gives every strip child an explicit height, since flex-end no longer stretches them', () => {
    for (const sel of ['.ctab', '.group-chip']) {
      expect(rule(sel)?.body, sel).toMatch(/(^|[;\s])height:\s*\d+px/);
    }
  });

  it('rounds tabs on the top edge only', () => {
    expect(rule('.ctab')?.body).toMatch(/border-radius:\s*8px 8px 0 0/);
    expect(rule('.ctab.fused')?.body).toMatch(/border-radius:\s*8px 8px 0 0/);
  });

  it('makes the active tab taller and gives it the content background', () => {
    const active = rule('.ctab.active')?.body ?? '';
    expect(active).toMatch(/height:\s*30px/);
    expect(active).toMatch(/background-color:\s*var\(--t-base\)/);
    expect(active).toMatch(/border-top-color:\s*var\(--tab-accent\)/);
  });

  // Regression: the active tab must MERGE with the content, and it cannot draw
  // over a border because `.session-tabs` sets `overflow-x: auto`, which makes
  // overflow-y compute to auto — the strip clips its children vertically, so no
  // negative margin reaches past it. The separation is mantle-vs-base, not a line.
  it('draws no bottom border on the topbar', () => {
    expect(rule('.topbar')?.body ?? '').not.toMatch(/border-bottom:/);
  });

  it('treats a group as one block with a single outer radius', () => {
    expect(rule('.group-chip')?.body).toMatch(/border-radius:\s*8px 0 0 0/);
    expect(rule('.ctab.grouped')?.body).toMatch(/border-top-left-radius:\s*0/);
    // Only a member FOLLOWED by another member loses the right corner, so the
    // last one keeps it — contiguity is guaranteed by the server's normalizeOrder.
    const notLast = blocks.find((b) => b.sel.includes('.ctab.grouped:has(+ .ctab.grouped)'));
    expect(notLast?.body).toMatch(/border-top-right-radius:\s*0/);
  });

  it('keeps a focused fused segment merged with the content, not solid-filled', () => {
    // A solid accent fill on the focused half breaks the join that the whole
    // shape exists to create.
    expect(rule('.ctab.fused.active .fused-seg.on')?.body).toMatch(
      /background-color:\s*var\(--t-base\)/,
    );
  });

  // Reported live: with a red member tab the pairing read as focused on the
  // WRONG half. The unfocused segment was filled with its own --tab-accent, so a
  // saturated member colour out-shouted the focused half's plain background.
  it('never tints the unfocused fused segment with its member colour', () => {
    const seg = rule('.ctab.fused.active .fused-seg')?.body ?? '';
    expect(seg).toMatch(/background-color:[^;]*--t-base[^;]*--t-mantle/);
    expect(seg).not.toMatch(/background-color:[^;]*--tab-accent/);
  });

  // Both halves carry the accent tip, or the block does not read as one active
  // tab at all — which was the other half of the same report.
  it('gives both halves of an active pairing an accent top border', () => {
    expect(rule('.ctab.fused.active .fused-seg')?.body).toMatch(
      /border-top:\s*3px solid color-mix\([^)]*--tab-accent/,
    );
    expect(rule('.ctab.fused.active .fused-seg.on')?.body).toMatch(
      /border-top-color:\s*var\(--tab-accent\)/,
    );
  });
});

// ── The split divider's rotate handle ─────────────────────────────────────────
//
// It is 20px over a 10px divider, so it overhangs the drag strip by 5px on each
// side — measured swallowing clicks on the TERMINAL while at opacity 0. Invisible
// has to mean intangible; there is nothing on screen to explain a dead zone.
describe('split divider rotate handle', () => {
  it('takes no pointer events while hidden, and both come back together', () => {
    const hidden = rule('.split-divider-rotate')?.body ?? '';
    expect(hidden).toMatch(/opacity:\s*0/);
    expect(hidden).toMatch(/pointer-events:\s*none/);

    const shown =
      blocks.find((b) => b.sel.includes('.split-divider:hover .split-divider-rotate'))?.body ?? '';
    expect(shown).toMatch(/opacity:\s*1/);
    expect(shown).toMatch(/pointer-events:\s*auto/);
  });

  // Keyboard users never hover, so focus has to reveal it too — and it shares the
  // rule above, which is what keeps the two states from drifting apart.
  it('reveals on focus as well as hover', () => {
    const sel =
      blocks.find(
        (b) =>
          b.sel.includes('.split-divider-rotate:focus-visible') &&
          b.sel.includes('.split-divider:hover'),
      )?.sel ?? '';
    expect(sel).toContain('.split-divider:hover .split-divider-rotate');
  });

  // A control that is invisible until hovered is the last place a keyboard user
  // can afford an invisible focus state, and this is a bare button rather than a
  // `.ui-btn`, so it does not inherit the kit's ring.
  it('draws its own focus ring', () => {
    const focus = rule('.split-divider-rotate:focus-visible')?.body ?? '';
    expect(focus).toMatch(/outline:\s*2px solid var\(--t-accent\)/);
  });

  // The motion contract is absolute about the terminal grid, and this element
  // floats over the WebGL canvas.
  it('never animates, because it sits over the canvas', () => {
    const body = rule('.split-divider-rotate')?.body ?? '';
    expect(body).not.toMatch(/transition|animation/);
  });
});

// The Window Controls Overlay block: palmux declares WCO in the manifest, so an
// installed desktop PWA lays the topbar into the OS title-bar strip. Both of
// these were wrong for a long time and neither has a runtime symptom a render
// test can see — the strip only exists in an installed window.
describe('window-controls-overlay', () => {
  const wco = css.slice(css.indexOf('@media (display-mode: window-controls-overlay)'));
  const topbar = wco.slice(wco.indexOf('.topbar {'), wco.indexOf('}', wco.indexOf('.topbar {')));

  it('never pins a fixed height — the strip is shorter than the strip content', () => {
    // ~33px of title bar against 36px of topbar (6px padding + a 30px active
    // tab). A hard `height` clipped the active tab's bottom edge, and that edge
    // IS the join to the content the Chrome shape depends on.
    expect(topbar).not.toMatch(/[^-]height:\s*env\(titlebar-area-height/);
    expect(topbar).toMatch(/min-height:\s*env\(titlebar-area-height/);
  });

  it('spans the whole strip, left inset included', () => {
    // `box-sizing: border-box` is global, so a bare `width: …-width` stops short
    // by the left inset: zero on Windows, ~75px on macOS's traffic lights.
    expect(topbar).toMatch(
      /width:\s*calc\(env\(titlebar-area-x[^)]*\)\s*\+\s*env\(titlebar-area-width/,
    );
  });

  it('keeps the bar draggable and its controls clickable', () => {
    expect(topbar).toMatch(/-webkit-app-region:\s*drag/);
    expect(wco).toMatch(/-webkit-app-region:\s*no-drag/);
  });
});
