// The tab strip's SHAPE contract.
//
// SessionTabs.test.tsx asserts behaviour, and happy-dom has no layout, so a pill
// can lose its border, a chip can collapse to a sliver or the active tab can
// quietly go back to being marked by colour while every behavioural test still
// passes. These are grep-level assertions on the stylesheet, which is the only
// cheap place to catch them.
//
// The contract (ui-rework, tabs as pills): every tab is a bordered pill, the
// active one is raised and ringed from the eight tokens, inactive text is dimmed
// a step, colour is a dot and nothing else, a group is a framed cluster whose
// chip never reacts to the active tab, and a split pairing is one pill that
// shows its glyph and seam even when inactive.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COLOR_PROFILES, deriveUiTokens, luminance, mix } from '../settings/themes';

const css = readFileSync(join(__dirname, '../index.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

const blocks = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, sel, body]) => ({
  sel: (sel ?? '').replace(/\s+/g, ' ').trim(),
  body: body ?? '',
}));
const rule = (selector: string) => blocks.find((b) => b.sel === selector);
const bodyOf = (selector: string) => rule(selector)?.body ?? '';
/** A custom property's value inside one rule, whitespace collapsed. */
const prop = (selector: string, name: string) =>
  new RegExp(`(?:^|[;\\s])${name}:\\s*([^;]+);`).exec(bodyOf(selector))?.[1]?.replace(/\s+/g, ' ');

/** The rule that declares the pill tokens: shared by the strip and the mobile drawer's
 *  list (SessionDrawer.test.tsx pins that side), so the two cannot drift apart. */
const PILL_TOKENS = '.session-tabs, .drawer-sessions, .drawer-top';

/** Every strip rule: from the strip container through the `+` button's hover
 *  (the right-click menu follows it, and is not strip chrome). */
const stripCss = css.slice(css.indexOf('.session-tabs {'), css.indexOf('.tab-menu {'));
const stripBlocks = [...stripCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, sel, body]) => ({
  sel: (sel ?? '').replace(/\s+/g, ' ').trim(),
  body: body ?? '',
}));

describe('tab strip shape', () => {
  // Replaces the flex-end alignment that let Chrome's active tab stand taller:
  // pills share one centre line and only their fill and ring say which is active.
  it('centres the strip and the topbar on one line', () => {
    expect(bodyOf('.session-tabs')).toMatch(/align-items:\s*center/);
    expect(bodyOf('.session-tabs')).not.toMatch(/align-items:\s*flex-end/);
    expect(bodyOf('.topbar')).toMatch(/align-items:\s*center/);
  });

  // Regression: a strip child with no intrinsic height collapses to its text box
  // (the group chip once became a 12px sliver that read as a stray coloured line).
  // The strip no longer stretches children, so each needs the control height.
  it('gives every strip child the control height explicitly', () => {
    for (const sel of ['.ctab', '.group-chip', '.ctab-new']) {
      expect(bodyOf(sel), sel).toMatch(/(^|[;\s])height:\s*var\(--ctl-h\)/);
    }
  });

  // Replaces the top-only radius and the 8% tint: a pill is closed all round.
  it('draws a 1px border at 10% text on every pill, with the control radius', () => {
    expect(prop(PILL_TOKENS, '--pill-border')).toBe(
      'color-mix(in srgb, var(--t-text) 10%, transparent)',
    );
    expect(bodyOf('.ctab')).toMatch(/border:\s*1px solid var\(--pill-border\)/);
    expect(bodyOf('.ctab')).toMatch(/border-radius:\s*var\(--r-2\)/);
    // The fused pill is a .ctab: it must inherit the border and radius, not
    // restate (or drop) them, or a split would stop looking like a tab.
    expect(bodyOf('.ctab.fused')).not.toMatch(/border|radius/);
  });

  it('separates entries by the scale gap and sizes a pill between a min and a max', () => {
    expect(bodyOf('.session-tabs')).toMatch(/gap:\s*var\(--sp-2\)/);
    const pill = bodyOf('.ctab');
    expect(pill).toMatch(/min-width:\s*92px/);
    expect(pill).toMatch(/max-width:\s*200px/);
    expect(pill).toMatch(/flex:\s*1 1 auto/); // grows with its title while there is room
  });

  // Replaces "makes the active tab taller and gives it the content background".
  // The floor is one surface step: the fill is the surface mixed toward the text.
  it('raises the active pill with a token fill and a ring, at full text and weight 600', () => {
    expect(prop(PILL_TOKENS, '--pill-fill')).toBe(
      'color-mix(in srgb, var(--t-surface), var(--t-text) 10.5%)',
    );
    expect(prop(PILL_TOKENS, '--pill-ring')).toBe(
      '0 0 0 1.5px color-mix(in srgb, var(--t-text) 60%, transparent)',
    );
    const active = bodyOf('.ctab.active');
    expect(active).toMatch(/background-color:\s*var\(--pill-fill\)/);
    expect(active).toMatch(/--ring:\s*var\(--pill-ring\)/);
    expect(active).toMatch(/color:\s*var\(--t-text\)/);
    expect(active).toMatch(/font-weight:\s*600/);
    // The ring is a layer of the pill's box-shadow, composed with a drop marker.
    expect(bodyOf('.ctab')).toMatch(/box-shadow:[^;]*var\(--ring/);
  });

  // Spec: the active fill differs from the strip background by AT LEAST the
  // theme's surface step. The CSS only names a mix, so the floor is checked on
  // the numbers, for every built-in theme: the fill is `--pill-fill` over the
  // strip (the topbar's mantle), measured against how far `--t-surface` itself
  // sits from that mantle. Mixing the surface toward the text moves it AWAY from
  // the mantle in both a dark and a light theme, which is what this guards.
  it('raises the active fill at least one surface step off the strip, in every theme', () => {
    expect(bodyOf('.topbar')).toMatch(/background:\s*var\(--t-mantle\)/);
    expect(bodyOf('.session-tabs')).not.toMatch(/background/); // the strip IS the topbar
    // Read the mix off the stylesheet so the numbers follow it: a change of the
    // token it mixes toward or the amount is checked here, not just re-pinned.
    const m = /^color-mix\(in srgb, var\(--t-(\w+)\), var\(--t-(\w+)\) ([\d.]+)%\)$/.exec(
      prop(PILL_TOKENS, '--pill-fill') ?? '',
    );
    expect(m, '--pill-fill is a two-token srgb mix').not.toBeNull();
    const [, from, toward, pct] = m!;
    const step = (a: number, b: number) => Math.abs(luminance(a) - luminance(b));
    expect(COLOR_PROFILES.length).toBeGreaterThan(5);
    for (const profile of COLOR_PROFILES) {
      const t = deriveUiTokens(profile) as unknown as Record<string, number>;
      const fill = mix(t[from!]!, t[toward!]!, Number(pct) / 100);
      expect(
        step(fill, t['mantle']!),
        `${profile.id}: active fill vs strip`,
      ).toBeGreaterThanOrEqual(step(t['surface']!, t['mantle']!));
    }
  });

  it('dims inactive text a step and fills nothing at rest', () => {
    expect(prop(PILL_TOKENS, '--pill-text')).toBe(
      'color-mix(in srgb, var(--t-text) 85%, var(--t-mantle))',
    );
    const pill = bodyOf('.ctab');
    expect(pill).toMatch(/color:\s*var\(--pill-text\)/);
    expect(pill).not.toMatch(/background/);
  });

  it('fills on hover only a pill that is not active', () => {
    const hovered = stripBlocks.filter((b) => /:hover/.test(b.sel) && /background/.test(b.body));
    const forPills = hovered.filter(
      (b) => /\.ctab(?![-\w])/.test(b.sel) && !b.sel.includes('kill'),
    );
    expect(forPills.length).toBeGreaterThan(0);
    for (const b of forPills) expect(b.sel, b.sel).toContain(':not(.active)');
  });

  // Inside a pairing the segments are the hover targets, and the same rule holds:
  // the focused one is already raised, and a hover fill must not replace that.
  it('fills on hover only a fused segment that is not the focused one', () => {
    const segments = stripBlocks.filter(
      (b) => b.sel.includes('.fused-seg') && /:hover/.test(b.sel) && /background/.test(b.body),
    );
    expect(segments.length).toBeGreaterThan(0);
    for (const b of segments) expect(b.sel, b.sel).toContain(':not(.on)');
  });

  // Replaces the 8% tint, the coloured top border and the colour fill. A tab's
  // colour is its dot: --tab-accent may be read by the dot rule and by nothing else.
  it('uses a tab colour for its 7px dot only — never a fill, tint or border', () => {
    const readers = stripBlocks.filter((b) => b.body.includes('--tab-accent'));
    expect(readers.map((b) => b.sel)).toEqual(['.ctab-dot']);
    const dot = bodyOf('.ctab-dot');
    expect(dot).toMatch(/width:\s*7px/);
    expect(dot).toMatch(/height:\s*7px/);
    expect(dot).toMatch(/background:\s*var\(--tab-accent\)/);
    expect(stripCss).not.toMatch(/border-top[^;]*(accent|--tab)/);
  });

  // The strip is styled from the eight tokens; a literal here would not follow a
  // theme change (and --t-crust does not exist, so it fails silently).
  it('takes every colour from the tokens', () => {
    expect(stripCss).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
    expect(stripCss).not.toContain('--t-crust');
    // The topbar sits above the strip's slice, and a literal there would stop
    // following a theme change just the same.
    expect(bodyOf('.topbar')).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|--t-crust/);
  });

  // Active is a fill and a ring on the SAME box. A height, padding, margin or
  // border change would bring back the Chrome "taller active tab" — and, with the
  // strip centred, a pill that jumps by a pixel on every tab switch.
  it('lets the active pill differ from the others in fill, ring and text only', () => {
    const active = bodyOf('.ctab.active');
    expect(active).not.toBe('');
    expect(active).not.toMatch(/(^|[;\s])(min-|max-)?(height|width|padding|margin|border)[-\w]*:/);
    expect(active).not.toMatch(/transform|top:|bottom:/);
  });

  // The strip stays one row that scrolls: pills hold their minimum (above) and
  // everything else on the row refuses to shrink, so only overflow-x gives way.
  it('scrolls horizontally and never squeezes the chip or the + button', () => {
    expect(bodyOf('.session-tabs')).toMatch(/overflow-x:\s*auto/);
    expect(bodyOf('.session-tabs')).not.toMatch(/flex-wrap:\s*wrap/);
    for (const sel of ['.group-chip', '.ctab-new']) {
      expect(bodyOf(sel), sel).toMatch(/flex:\s*0 0 auto/);
    }
  });

  // The ✕ is the one control a pill carries. It stays out of sight until the
  // pill is hovered or active, and a dirty one never hides — the unsaved mark
  // must not depend on the pointer.
  it('shows the close mark on hover, on the active pill, and always when dirty', () => {
    expect(bodyOf('.ctab-kill')).toMatch(/visibility:\s*hidden/);
    const shown = stripBlocks.find((b) => /visibility:\s*visible/.test(b.body));
    expect(shown?.sel.split(/\s*,\s*/).toSorted()).toEqual([
      '.ctab-kill.dirty',
      '.ctab.active .ctab-kill',
      '.ctab:hover .ctab-kill',
    ]);
  });

  // Replaces "draws no bottom border on the topbar". That rule existed only so
  // the Chrome active tab could merge into the content below it; a pill merges
  // with nothing, so the topbar ends in a 1px separator instead.
  it('ends the topbar in a 1px separator', () => {
    expect(bodyOf('.topbar')).toMatch(/border-bottom:\s*1px solid var\(--t-surface\)/);
  });

  // Replaces "treats a group as one block with a single outer radius", the
  // `:has(+ …)` shared-radius rule and the 3px underline.
  it('frames a group as a cluster: 1px group-colour frame, padded, same gap', () => {
    const cluster = bodyOf('.group-cluster');
    expect(cluster).toMatch(/border:\s*1px solid var\(--group-accent\)/);
    expect(cluster).toMatch(/border-radius:\s*var\(--r-3\)/);
    expect(cluster).toMatch(/gap:\s*var\(--sp-2\)/);
    expect(cluster).toMatch(/padding:\s*var\(--cluster-pad\)/);
    expect(prop(PILL_TOKENS, '--cluster-pad')).toMatch(/^[234]px$/); // 2–4px
    expect(stripCss).not.toContain(':has(');
    expect(stripCss).not.toMatch(/background-size:\s*100% 3px/);
    expect(rule('.ctab.grouped')).toBeUndefined();
  });

  // A plain row is as tall as a cluster, or creating a group would shift the
  // terminal by the frame and its padding.
  it('keeps a plain row as tall as a framed cluster', () => {
    expect(bodyOf('.session-tabs')).toMatch(
      /min-height:\s*calc\(var\(--ctl-h\) \+ 2 \* \(var\(--cluster-pad\) \+ 1px\)\)/,
    );
  });

  // Replaces the solid `member-active` chip fill. The chip's look is one rule,
  // and no rule may vary it by which tab is active.
  it('fills the chip with the group colour whichever tab is active', () => {
    const chip = bodyOf('.group-chip');
    expect(chip).toMatch(/background-color:\s*var\(--group-accent\)/);
    expect(chip).toMatch(/color:\s*var\(--group-ink\)/);
    const varying = blocks.filter(
      (b) => b.sel.includes('group-chip') && /member-active|\.active|:has\(/.test(b.sel),
    );
    expect(varying).toEqual([]);
    // The cluster is the same for every active tab too.
    expect(
      blocks.filter((b) => b.sel.includes('group-cluster') && b.sel.includes('active')),
    ).toEqual([]);
  });

  // The chip and cluster read --group-accent from the cluster's inline style; a
  // default declared on the chip itself would shadow it and recolour every chip.
  it('declares the group colour defaults on the cluster, not the chip', () => {
    expect(bodyOf('.group-cluster')).toMatch(/--group-accent:\s*var\(--t-accent\)/);
    expect(bodyOf('.group-cluster')).toMatch(/--group-ink:\s*var\(--t-accent-ink\)/);
    expect(bodyOf('.group-chip')).not.toMatch(/--group-(accent|ink):/);
  });

  // Replaces the accent-tip and neutral-recess cues. A pairing now reads from a
  // glyph, a seam and one raised segment — and the first two must not need the
  // pairing to be active, or an inactive split looks like two ordinary tabs.
  it('draws the split glyph and the seam whether or not the pairing is active', () => {
    const shown = stripBlocks.filter(
      (b) => b.sel.includes('.fused-glyph') || b.sel === '.fused-seg + .fused-seg',
    );
    expect(shown.map((b) => b.sel).toSorted()).toEqual(['.fused-glyph', '.fused-seg + .fused-seg']);
    for (const b of shown) {
      expect(b.sel, b.sel).not.toContain('.active');
      expect(b.body, b.sel).not.toMatch(/display:\s*none|visibility:\s*hidden|opacity:\s*0/);
    }
    expect(bodyOf('.fused-seg + .fused-seg')).toMatch(
      /border-left:\s*1px solid var\(--pill-border\)/,
    );
  });

  it('rings an active pairing and raises only its focused segment', () => {
    // The pill takes the active ring (from `.ctab.active`) but no fill of its own…
    expect(bodyOf('.ctab.fused.active')).toMatch(/background-color:\s*transparent/);
    // …the focused segment takes the raised fill, full text, weight 600…
    const on = bodyOf('.ctab.fused.active .fused-seg.on');
    expect(on).toMatch(/background-color:\s*var\(--pill-fill\)/);
    expect(on).toMatch(/color:\s*var\(--t-text\)/);
    expect(on).toMatch(/font-weight:\s*600/);
    // …and the other segment stays unraised, with inactive text.
    const seg = bodyOf('.fused-seg');
    expect(seg).not.toMatch(/background/);
    expect(seg).toMatch(/color:\s*var\(--pill-text\)/);
    expect(seg).toMatch(/font-weight:\s*500/);
  });

  it('keeps a minimum width on each fused segment', () => {
    expect(bodyOf('.fused-seg')).toMatch(/min-width:\s*\d+px/);
  });

  // The insertion bar and the will-join ring must stay visible on the new shape,
  // including over the active ring, which is why they compose through --mark.
  it('composes the drop marker and the join ring with the active ring', () => {
    expect(bodyOf('.ctab.drop-before')).toMatch(/--mark:[^;]*var\(--t-accent\)/);
    expect(bodyOf('.ctab.drop-after')).toMatch(/--mark:[^;]*var\(--t-accent\)/);
    expect(bodyOf('.ctab.join-armed')).toMatch(/--mark:\s*inset 0 0 0 2px var\(--group-accent/);
    expect(bodyOf('.ctab')).toMatch(/box-shadow:\s*var\(--mark[^;]*var\(--ring/);
    // A whole group gets the same bar, on its cluster.
    expect(bodyOf('.group-cluster.drop-before')).toMatch(/box-shadow:[^;]*var\(--t-accent\)/);
    expect(bodyOf('.group-cluster.drop-after')).toMatch(/box-shadow:[^;]*var\(--t-accent\)/);
  });

  // Hovering the middle of a member sets BOTH `.drop-before` and `.join-armed` on
  // it (the join target is also the resolved boundary). Both rules set `--mark`
  // at one specificity, so the later one wins — it has to be the join ring, or
  // the will-join cue the group colour exists for would show as a plain bar.
  it('lets the will-join ring win over the insertion bar when a pill carries both', () => {
    const at = (sel: string) => css.indexOf(`${sel} {`);
    expect(at('.ctab.drop-before')).toBeGreaterThan(-1);
    expect(at('.ctab.join-armed')).toBeGreaterThan(at('.ctab.drop-before'));
    expect(at('.ctab.join-armed')).toBeGreaterThan(at('.ctab.drop-after'));
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
    // ~33px of title bar against a topbar of 4px padding + a 34px strip + a 1px
    // separator. A hard `height` clipped the strip — the active ring and a
    // cluster's frame live at its edges — so the topbar may overflow the title
    // bar instead.
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
