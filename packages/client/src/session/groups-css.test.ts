// The stylesheet half of the editor groups: what GroupsView, the strips, the drop overlay and the
// sashes need from `index.css`. happy-dom has no layout, so the geometry the component tests can
// not see (where the body starts, what stacks over what, what a sash drag leaves clickable) is
// held here, the way `tab-strip-css.test.ts` holds the strip's shape.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(__dirname, '../index.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

const blocks = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, sel, body]) => ({
  sel: (sel ?? '').replace(/\s+/g, ' ').trim(),
  body: body ?? '',
}));
const bodyOf = (selector: string): string =>
  blocks
    .filter((b) => b.sel === selector)
    .map((b) => b.body)
    .join('\n');

/** One declaration's value in a rule body, or undefined. */
const valueOf = (body: string, prop: string): string | undefined =>
  new RegExp(`(?:^|[;\\s])${prop}:\\s*([^;]+)`).exec(body)?.[1]?.trim();

/**
 * A length as px, with the tokens a strip is built from resolved: `calc()`, `var()`, `+`, `*` and
 * parentheses, which is all these declarations use. happy-dom has no layout, so the arithmetic the
 * browser would do is done here.
 */
const px = (value: string, vars: Record<string, number>): number => {
  const src = value.replace(/var\((--[\w-]+)\)/g, (_, name: string) => {
    const v = vars[name];
    if (v === undefined) throw new Error(`unresolved ${name}`);
    return `${v}px`;
  });
  const tokens = src.replace(/calc\(/g, '(').match(/\d+(?:\.\d+)?(?:px)?|[()+*]/g) ?? [];
  let i = 0;
  const factor = (): number => {
    const t = tokens[i++];
    if (t === '(') {
      const v = sum();
      i++; // ')'
      return v;
    }
    return parseFloat(t ?? 'NaN');
  };
  const product = (): number => {
    let v = factor();
    while (tokens[i] === '*') {
      i++;
      v *= factor();
    }
    return v;
  };
  const sum = (): number => {
    let v = product();
    while (tokens[i] === '+') {
      i++;
      v += product();
    }
    return v;
  };
  const total = sum();
  if (!Number.isFinite(total) || i !== tokens.length) throw new Error(`cannot evaluate ${value}`);
  return total;
};

describe('the pane strip height token', () => {
  // `--group-strip-h` is built from `--cluster-pad` on `.content-area`, and a custom property
  // resolves where it is USED: without a `:root` copy the content area (not inside a strip) would
  // resolve to nothing and every pane body would start at the top, under its strip.
  it('is built from the scale, and `--cluster-pad` is visible to the content area', () => {
    expect(bodyOf('.content-area')).toMatch(
      /--group-strip-h:\s*calc\(var\(--ctl-h\) \+ 2 \* \(var\(--cluster-pad\) \+ 1px\) \+ 1px\)/,
    );
    expect(bodyOf(':root')).toMatch(/--cluster-pad:\s*2px/);
  });

  // Every box is border-box, so the strip box's height includes its 1px bottom border. A token that
  // was only the strip's min-height left the strip 1px short, and a framed cluster painted over the
  // border (the focus mark among it). The body offset and the New-tab page read the same token.
  it('is the strip box: the strip’s own min-height plus the box’s bottom border, on both scales', () => {
    expect(bodyOf('*')).toMatch(/box-sizing:\s*border-box/);
    const token = valueOf(bodyOf('.content-area'), '--group-strip-h')!;
    const stripMin = valueOf(bodyOf('.session-tabs'), 'min-height')!;
    const border = valueOf(bodyOf('.group-strip'), 'border-bottom')!;
    const borderPx = parseFloat(/(\d+(?:\.\d+)?)px/.exec(border)![1]!);
    for (const ctl of [28, 36]) {
      const vars = { '--ctl-h': ctl, '--cluster-pad': 2 };
      expect(px(token, vars), `--ctl-h ${ctl}`).toBe(px(stripMin, vars) + borderPx);
    }
  });

  // A detached window draws its strips as the main window does, so only the mobile layer has none.
  it('is nothing where there is no strip: the mobile layer, and only there', () => {
    expect(bodyOf('.app.mobile .content-area')).toMatch(/--group-strip-h:\s*0px/);
    expect(css).not.toMatch(/\.app\.popout/);
    expect(css).not.toMatch(/\.app\.detached[^{]*\.content-area/);
  });

  it('keeps the pop-out bar and its brand out of the sheet: a detached window draws neither', () => {
    expect(css).not.toMatch(/\.popout-bar/);
    expect(css).not.toMatch(/\.topbar-brand/);
  });

  it('keeps the New-tab page below the one strip that stays', () => {
    expect(bodyOf('.newtab-page')).toMatch(/top:\s*var\(--group-strip-h\)/);
  });
});

describe('the pane grid root and a strip', () => {
  it('is the positioned ancestor of every pane, strip, overlay and sash', () => {
    const body = bodyOf('.groups-view');
    expect(body).toMatch(/position:\s*absolute/);
    expect(body).toMatch(/inset:\s*0/);
  });

  it('draws a strip as an absolute box with the token height and a 1px bottom edge', () => {
    const body = bodyOf('.group-strip');
    expect(body).toMatch(/position:\s*absolute/);
    expect(body).toMatch(/height:\s*var\(--group-strip-h\)/);
    expect(body).toMatch(/border-bottom:\s*1px solid var\(--t-surface\)/);
    expect(body).toMatch(/background:\s*var\(--t-mantle\)/);
  });

  // The strip's context menu is `position: fixed` inside it and must rise into the outer stacking
  // context; a z-index here would trap it under the panes and the dock.
  it('sets no z-index on a strip', () => {
    expect(bodyOf('.group-strip')).not.toMatch(/z-index/);
  });

  it('marks the focused pane through the strip alone, by its bottom edge', () => {
    const rule = bodyOf('.group-strip.group-strip-focused');
    expect(rule).toMatch(/border-bottom-color:\s*var\(--t-accent\)/);
    // No ring on the pane's body, in either kind of pane.
    expect(css).not.toMatch(/\.term-wrap\.slot\.focused/);
    expect(css).not.toMatch(/\.pane\.slot\.focused/);
  });
});

describe('drag and sash layers', () => {
  it('stacks the drop overlay over the panes (20) and the New-tab page (25)', () => {
    expect(bodyOf('.group-drop-overlay')).toMatch(/z-index:\s*40/);
    expect(bodyOf('.pane-host')).toMatch(/z-index:\s*20/);
    expect(bodyOf('.newtab-page')).toMatch(/z-index:\s*25/);
  });

  it('tints the claimed region from the tokens', () => {
    const body = bodyOf('.group-drop-preview');
    expect(body).toMatch(/var\(--t-accent\)/);
    expect(body).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
  });

  // The overlay, the preview and the sash float over the terminal grid, which nothing may animate.
  it('animates none of them', () => {
    for (const b of blocks.filter((x) => /\.group-(drop|sash)/.test(x.sel))) {
      expect(b.body, b.sel).not.toMatch(/transition|animation/);
    }
  });

  // A tab another pane holds lights its target strip whole (its drop keeps the tab's server-order
  // place, so an insertion bar would lie). It sits on the line the panes start under: no motion.
  it('lights a strip whole for a tab from another pane, from the tokens and without motion', () => {
    const body = bodyOf('.session-tabs.drop-into');
    expect(body).toMatch(/var\(--t-accent\)/);
    expect(body).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
    expect(body).not.toMatch(/transition|animation/);
  });

  it('leaves a sash drag its pointer over an iframe', () => {
    expect(bodyOf(".content-area[data-sash-drag='true'] iframe")).toMatch(/pointer-events:\s*none/);
  });
});

describe('the window-controls-overlay title bar', () => {
  it('is nothing outside window-controls-overlay mode', () => {
    expect(bodyOf('.wco-titlebar')).toMatch(/display:\s*none/);
  });

  it('is an empty drag region the height of the native controls inside it', () => {
    const media =
      /@media \(display-mode: window-controls-overlay\)\s*\{\s*\.wco-titlebar\s*\{([^{}]*)\}/.exec(
        css,
      );
    expect(media?.[1]).toMatch(/display:\s*block/);
    expect(media?.[1]).toMatch(/height:\s*env\(titlebar-area-height\)/);
    expect(media?.[1]).toMatch(/-webkit-app-region:\s*drag/);
  });
});
