// What the component kit promises. Two halves:
//
// 1. A grep over ui.css, in the spirit of xterm-css-contract.test.ts. The
//    theming rule ("no colour literal outside a color-mix over --t-*") has no
//    runtime symptom a render test can see — a hard-coded hex looks perfect
//    until someone switches to a light theme — so the stylesheet is checked as
//    text.
// 2. Render tests for the behaviour that is ours rather than Radix's: variant
//    classes, the Collapsible's per-device persistence, and the confirm path.

import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { parse, type AtRule, type Rule } from 'postcss';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardBody } from '../panes/DashboardBody';
import { DEFAULTS } from '../settings/settings';
import { SettingsFields } from '../settings/SettingsFields';
import {
  Button,
  Collapsible,
  Dialog,
  DropdownMenu,
  IconButton,
  Input,
  Segmented,
  Select,
  Switch,
} from './index';

const css = readFileSync(join(__dirname, 'ui.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Every `property: value` pair in the file, comments already stripped. */
const declarations = [...css.matchAll(/([a-z-]+)\s*:\s*([^;{}]+)[;}]/g)].map(([, prop, value]) => ({
  prop: prop ?? '',
  value: (value ?? '').trim(),
}));

const NAMED_COLORS =
  /\b(white|black|red|green|blue|yellow|orange|purple|pink|gray|grey|silver|maroon|navy|teal|olive|lime|aqua|fuchsia)\b/;

describe('ui.css theming contract', () => {
  it('declares no colour literal — every colour resolves to a --t-* token', () => {
    const offenders = declarations.filter(
      (d) => /#[0-9a-f]{3,8}\b/i.test(d.value) || /\b(rgba?|hsla?)\(/i.test(d.value),
    );
    expect(offenders, 'use var(--t-*) or a color-mix() over one').toEqual([]);
  });

  it('names no colour keyword except transparent', () => {
    const offenders = declarations.filter((d) => NAMED_COLORS.test(d.value));
    expect(offenders).toEqual([]);
  });

  it('references no theme token outside the eight', () => {
    const tokens = new Set([...css.matchAll(/var\(\s*(--t-[a-z-]+)/g)].map((m) => m[1]));
    expect([...tokens].toSorted()).toEqual(
      [
        '--t-accent',
        '--t-accent-alt',
        '--t-accent-ink',
        '--t-base',
        '--t-mantle',
        '--t-subtext',
        '--t-surface',
        '--t-text',
      ].filter((t) => tokens.has(t)),
    );
  });

  it('never names the retired --t-crust / --t-overlay / --t-border tokens', () => {
    expect(css).not.toMatch(/--t-crust\b/);
    expect(css).not.toMatch(/--t-overlay\b/);
    expect(css).not.toMatch(/--t-border\b/);
  });

  it('defines the four motion tiers and the shared easing', () => {
    for (const token of ['--mo-0:', '--mo-micro:', '--mo-surface:', '--mo-enter:', '--mo-ease:']) {
      expect(css).toContain(token);
    }
  });

  it('hard-codes no duration — durations come from the motion tokens', () => {
    const offenders = declarations
      .filter((d) => /^(transition|animation)/.test(d.prop))
      .filter((d) => /\b\d+(\.\d+)?m?s\b/.test(d.value) && !/0\.001ms/.test(d.value))
      .filter((d) => !/\b0s\b/.test(d.value));
    expect(offenders).toEqual([]);
  });

  // The project declares exactly four motion tiers (0ms, 140ms, 240ms, 380ms +
  // 40ms stagger) — see CLAUDE.md's MOTION rule. `--mo-ease` is a timing
  // function, not a duration, so it is exempt from this check.
  it('uses only the four declared tiers as a transition/animation duration', () => {
    const ALLOWED_DURATION_TOKENS = new Set([
      '--mo-0',
      '--mo-micro',
      '--mo-surface',
      '--mo-enter',
      '--mo-stagger',
    ]);
    const used = new Set(
      declarations
        .filter((d) => /^(transition|animation)/.test(d.prop))
        .flatMap((d) => [...d.value.matchAll(/var\(\s*(--mo-[a-z0-9-]+)/g)].map((m) => m[1]))
        .filter((token): token is string => token !== undefined && token !== '--mo-ease'),
    );
    const offenders = [...used].filter((token) => !ALLOWED_DURATION_TOKENS.has(token));
    expect(offenders, 'introduces a motion duration outside the four declared tiers').toEqual([]);
  });

  it('suppresses motion under prefers-reduced-motion', () => {
    const block = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(block).not.toEqual('');
    expect(block).toContain('--mo-micro: 0.001ms');
    expect(block).toContain('--mo-surface: 0.001ms');
    expect(block).toContain('transition-duration: 0.001ms !important');
    expect(block).toContain('animation-duration: 0.001ms !important');
  });

  it('animates the collapsible with grid rows, never a measured height', () => {
    expect(css).toContain('grid-template-rows: 0fr');
    expect(css).toContain('grid-template-rows: 1fr');
    // A `max-height` ceiling is how a height animation gets faked, so it is banned
    // from the collapsible's own rules. It is not banned from the file: the Select
    // popup needs one to scroll a long list inside the viewport.
    const collapsibleRules = [...css.matchAll(/(\.ui-collapsible[^{}]*)\{([^{}]*)\}/g)]
      .map(([, selector, body]) => `${selector ?? ''}{${body ?? ''}}`)
      .join('\n');
    expect(collapsibleRules).toContain('grid-template-rows');
    expect(collapsibleRules).not.toContain('max-height');
    expect(css).not.toContain('--radix-collapsible-content-height');
  });

  // Depth is base / mantle / surface; a shadow is reserved for the three things
  // that genuinely float above the page in a portal. Anything else acquiring one
  // means a panel is pretending to be a popover.
  it('shadows only the surfaces that float', () => {
    const shadowed = [...css.matchAll(/([^{}]+)\{([^{}]*box-shadow[^{}]*)\}/g)].map(([, sel]) =>
      (sel ?? '').trim(),
    );
    expect(shadowed).toEqual(['.ui-tooltip', '.ui-dialog-content', '.ui-menu']);
  });
});

describe('Button', () => {
  it('carries the variant and size classes, and a default testid', () => {
    render(
      <Button variant="danger" size="sm">
        Kill
      </Button>,
    );
    const button = screen.getByTestId('ui-button');
    expect(button.className).toBe('ui-btn ui-btn-danger ui-btn-sm');
    expect(button).toHaveAttribute('type', 'button');
  });

  it('defaults to the ghost md intent and lets a caller name it', () => {
    render(<Button data-testid="save">Save</Button>);
    expect(screen.getByTestId('save').className).toBe('ui-btn ui-btn-ghost ui-btn-md');
  });

  it('carries the primary variant class', () => {
    render(<Button variant="primary">Save</Button>);
    expect(screen.getByTestId('ui-button').className).toBe('ui-btn ui-btn-primary ui-btn-md');
  });

  it('is keyboard-activatable — Enter on a focused button fires a click', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save</Button>);
    screen.getByTestId('ui-button').focus();
    await user.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe('IconButton', () => {
  it('is square and names itself for a screen reader', () => {
    render(<IconButton label="Close tab">✕</IconButton>);
    const button = screen.getByRole('button', { name: 'Close tab' });
    expect(button.className).toBe('ui-icon-btn');
  });
});

describe('Input', () => {
  it('marks an invalid field for assistive tech, not just visually', () => {
    render(<Input invalid defaultValue="nope" />);
    const input = screen.getByTestId('ui-input');
    expect(input.className).toBe('ui-input ui-input-invalid');
    expect(input).toHaveAttribute('aria-invalid', 'true');
  });
});

describe('Switch', () => {
  it('reports the new value on press', () => {
    const onCheckedChange = vi.fn();
    render(<Switch checked={false} onCheckedChange={onCheckedChange} />);
    fireEvent.click(screen.getByTestId('ui-switch'));
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });
});

describe('Segmented', () => {
  it('reports the pressed option', () => {
    const onValueChange = vi.fn();
    render(
      <Segmented
        label="Mobile mode"
        value="auto"
        onValueChange={onValueChange}
        options={[
          { value: 'auto', label: 'Auto' },
          { value: 'on', label: 'On' },
        ]}
      />,
    );
    fireEvent.click(screen.getByTestId('ui-segmented-on'));
    expect(onValueChange).toHaveBeenCalledWith('on');
  });

  it('ignores a press on the option already selected — there is no empty state', () => {
    const onValueChange = vi.fn();
    render(
      <Segmented
        label="Mobile mode"
        value="auto"
        onValueChange={onValueChange}
        options={[
          { value: 'auto', label: 'Auto' },
          { value: 'on', label: 'On' },
        ]}
      />,
    );
    fireEvent.click(screen.getByTestId('ui-segmented-auto'));
    expect(onValueChange).not.toHaveBeenCalled();
  });

  // `keepFocus` exists for the mobile drawer: taking focus there blurs the
  // hidden #mobile-kbd textarea and dismisses the soft keyboard. Selecting must
  // therefore happen on pointerdown WITH preventDefault — which on a touch
  // pointer also suppresses the click, so pointerdown is the only chance.
  describe('keepFocus', () => {
    const setup = (keepFocus: boolean) => {
      const onValueChange = vi.fn();
      render(
        <Segmented
          label="Drawer view"
          value="auto"
          onValueChange={onValueChange}
          keepFocus={keepFocus}
          options={[
            { value: 'auto', label: 'Auto' },
            { value: 'on', label: 'On' },
            { value: 'off', label: 'Off', disabled: true },
          ]}
        />,
      );
      return onValueChange;
    };

    it('selects on pointerdown and prevents the default focus move', () => {
      const onValueChange = setup(true);
      const item = screen.getByTestId('ui-segmented-on');
      const prevented = !fireEvent.pointerDown(item);

      expect(onValueChange).toHaveBeenCalledWith('on');
      expect(prevented).toBe(true);
    });

    it('leaves a disabled option inert', () => {
      const onValueChange = setup(true);
      fireEvent.pointerDown(screen.getByTestId('ui-segmented-off'));
      expect(onValueChange).not.toHaveBeenCalled();
    });

    it('is off by default — every other host wants the normal click', () => {
      const onValueChange = setup(false);
      fireEvent.pointerDown(screen.getByTestId('ui-segmented-on'));
      expect(onValueChange).not.toHaveBeenCalled();
      fireEvent.click(screen.getByTestId('ui-segmented-on'));
      expect(onValueChange).toHaveBeenCalledWith('on');
    });
  });
});

describe('Collapsible', () => {
  it('keeps its content mounted while closed, so it has a full height to open to', () => {
    render(
      <Collapsible title="Appearance" defaultOpen={false}>
        <p>Theme</p>
      </Collapsible>,
    );
    expect(screen.getByText('Theme')).toBeInTheDocument();
    expect(screen.getByTestId('ui-collapsible-content')).toHaveAttribute('data-state', 'closed');
  });

  it('persists open/closed per device under storageKey', () => {
    localStorage.removeItem('kit-test-section');
    render(
      <Collapsible title="Keys" storageKey="kit-test-section">
        <p>Keybindings</p>
      </Collapsible>,
    );
    fireEvent.click(screen.getByTestId('ui-collapsible-trigger'));
    expect(localStorage.getItem('kit-test-section')).toBe('0');
  });

  it('restores a stored state on mount', () => {
    localStorage.setItem('kit-test-restore', '0');
    render(
      <Collapsible title="Keys" storageKey="kit-test-restore">
        <p>Keybindings</p>
      </Collapsible>,
    );
    expect(screen.getByTestId('ui-collapsible-content')).toHaveAttribute('data-state', 'closed');
  });

  it('survives an unmount and remount under the same storageKey', () => {
    localStorage.removeItem('kit-test-unmount');
    const { unmount } = render(
      <Collapsible title="Keys" storageKey="kit-test-unmount">
        <p>Keybindings</p>
      </Collapsible>,
    );
    fireEvent.click(screen.getByTestId('ui-collapsible-trigger'));
    expect(screen.getByTestId('ui-collapsible-content')).toHaveAttribute('data-state', 'closed');
    unmount();

    render(
      <Collapsible title="Keys" storageKey="kit-test-unmount">
        <p>Keybindings</p>
      </Collapsible>,
    );
    expect(screen.getByTestId('ui-collapsible-content')).toHaveAttribute('data-state', 'closed');
  });

  it('falls back to defaultOpen on a corrupt stored value instead of throwing', () => {
    localStorage.setItem('kit-test-corrupt', '{"open":true}');
    expect(() =>
      render(
        <Collapsible title="Keys" storageKey="kit-test-corrupt" defaultOpen={false}>
          <p>Keybindings</p>
        </Collapsible>,
      ),
    ).not.toThrow();
    expect(screen.getByTestId('ui-collapsible-content')).toHaveAttribute('data-state', 'closed');
  });
});

describe('Dialog', () => {
  it('renders a blocking confirm and reports the answer', () => {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <Dialog
        open
        onOpenChange={onOpenChange}
        title="Kill terminal 3?"
        description="The shell and everything running in it are lost."
        confirmLabel="Kill"
        destructive
        onConfirm={onConfirm}
      />,
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByTestId('ui-dialog-confirm').className).toContain('ui-btn-danger');
    fireEvent.click(screen.getByTestId('ui-dialog-confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('renders nothing while closed', () => {
    render(
      <Dialog open={false} onOpenChange={vi.fn()} title="Kill terminal 3?" onConfirm={vi.fn()} />,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

// Contested during review, so pinned with the mechanism spelled out.
//
// The grid transition MUST live on `.ui-collapsible-track` — an element we own,
// nested INSIDE Radix's Content — and never on the Content node itself. Radix's
// CollapsibleContentImpl layout effect sets `transitionDuration: '0s'` on its own
// node, reads getBoundingClientRect() to force the recalc, then restores; a
// transition declared on that node is swallowed by that sequence. Measured live
// in Chromium with the track in place: closing ran 169 → 119 → 34 → 0 px with
// transitionrun/transitionend for grid-template-rows, opening 0 → 89 → 155 → 169.
describe('Collapsible animation ownership', () => {
  it('puts the grid transition on our own track, not on the Radix content node', () => {
    const track = /\.ui-collapsible-track\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(track).toMatch(/transition:\s*grid-template-rows/);
    expect(track).toMatch(/grid-template-rows:\s*0fr/);

    const contentRule = /\.ui-collapsible-content\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(contentRule, 'a transition here is eaten by Radix').not.toMatch(
      /transition:[^;]*grid-template-rows/,
    );
  });
});

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const flat = (text: string): string => text.replace(/\s+/g, ' ');

/** The body of the first top-level rule whose selector is exactly `selector`. */
const ruleBody = (source: string, selector: string): string =>
  new RegExp(`(?:^|[};])\\s*${escapeRe(selector)}\\s*\\{([^{}]*)\\}`).exec(flat(source))?.[1] ?? '';

const backgroundOf = (body: string): string =>
  /(?:^|[;\s])background:\s*([^;]+)/.exec(body)?.[1]?.trim() ?? '';

// Press and menu motion. The pressed state is a COLOUR and nothing else, on every
// motion setting. A transform on the button itself is ruled out, not just
// unneeded: `scale(0.97)` shrinks the HIT target under a finger that is still
// down, and the move-tolerant presses (`pressMove`/`pressKbdMove`, panes/press.ts)
// drop their gesture on pointerleave — so a press landing near an edge left the
// shrunken box and cancelled itself (3px a side on a 200px button). The colour is
// also what the owner chose for the extra-keys bar. jsdom does not cascade, so all
// of this is read as text.
describe('press and menu motion', () => {
  const mediaAt = css.indexOf('@media (prefers-reduced-motion: reduce)');
  /** The reduced-motion block alone, braces matched — not everything after it. */
  const reducedMotion = ((): string => {
    const open = css.indexOf('{', mediaAt);
    let depth = 0;
    for (let i = open; i < css.length; i += 1) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i);
    }
    return '';
  })();

  // [hover selector, :active selector] — every state a pointer can leave a button in.
  const PRESS_PAIRS = [
    ['.ui-btn-ghost:not(:disabled):hover', '.ui-btn-ghost:not(:disabled):active'],
    ['.ui-btn-primary:not(:disabled):hover', '.ui-btn-primary:not(:disabled):active'],
    ['.ui-btn-danger:not(:disabled):hover', '.ui-btn-danger:not(:disabled):active'],
    ['.ui-icon-btn:not(:disabled):hover', '.ui-icon-btn:not(:disabled):active'],
    ['.ui-icon-btn-primary:not(:disabled):hover', '.ui-icon-btn-primary:not(:disabled):active'],
    ['.ui-icon-btn-danger:not(:disabled):hover', '.ui-icon-btn-danger:not(:disabled):active'],
  ] as const;

  /** Every top-level or nested rule as [selector list, body]. The delimiter is a
   *  LOOKBEHIND: a pattern that consumed it would eat the `}` the next rule needs
   *  and silently see only every other rule. */
  const rules = [...flat(css).matchAll(/(?<=^|[{};])\s*([^{};]*)\{([^{}]*)\}/g)].map(
    ([, selector, body]) => [(selector ?? '').trim(), body ?? ''] as const,
  );

  it.each(['.ui-btn', '.ui-icon-btn'])(
    '%s releases a press on the micro tier and transitions no transform',
    (selector) => {
      const transition = /transition:([^;]*);/.exec(ruleBody(css, selector))?.[1] ?? '';
      const props = flat(transition)
        .split(',')
        .map((t) => t.trim());
      for (const kept of ['background', 'border-color', 'color']) {
        expect(props, kept).toContain(`${kept} var(--mo-micro) ease`);
      }
      expect(props.filter((p) => p.startsWith('transform'))).toEqual([]);
    },
  );

  it.each(['.ui-btn', '.ui-icon-btn'])(
    '%s lands its pressed colour with no transition into it',
    (selector) => {
      const body = ruleBody(css, `${selector}:not(:disabled):active`);
      expect(body).toContain('transition-duration: var(--mo-0)');
    },
  );

  // The hit-area guard. Any transform on a pressed kit button — a scale, a
  // translate, the individual `scale:`/`translate:`/`rotate:` properties, even
  // one scoped to a media query — moves the box out from under a held finger
  // and cancels a move-tolerant press.
  it('sets no transform on a pressed .ui-btn or .ui-icon-btn, anywhere in the file', () => {
    const offenders = rules
      .filter(([selector]) => /\.ui-(?:icon-)?btn\b[^,]*:active/.test(selector))
      .filter(([, body]) => /(?:^|[;\s])(?:transform|scale|translate|rotate)\s*:/.test(body))
      .map(([selector]) => selector);
    expect(offenders).toEqual([]);
  });

  it.each(PRESS_PAIRS)('%s has a pressed colour of its own: %s', (hover, active) => {
    const hovered = backgroundOf(ruleBody(css, hover));
    const pressed = backgroundOf(ruleBody(css, active));
    expect(hovered, `${hover} has no background`).not.toBe('');
    expect(pressed, `${active} has no background`).not.toBe('');
    expect(pressed).not.toBe(hovered);
    // Token-derived, never a literal — ui.css's colour guard above covers the
    // literal case, this pins that the pressed fill is a mix over the theme.
    expect(pressed).toMatch(/color-mix\(in srgb, var\(--t-(?:text|accent-alt|accent|surface)\)/);
  });

  it.each(PRESS_PAIRS)(
    '%s is overridden by %s while the pointer is still over it',
    (hover, active) => {
      // Equal specificity, so source order decides which fill a held button shows.
      expect(css.indexOf(`${active} {`)).toBeGreaterThan(css.indexOf(`${hover} {`));
    },
  );

  // With no motion in the press, reduced motion has nothing of it to remove: a
  // press there must read exactly as it does everywhere else, so the block holds
  // no :active rule and every pressed colour sits OUTSIDE it.
  it('presses identically under reduced motion — the block touches no :active state', () => {
    expect(mediaAt).toBeGreaterThan(-1);
    expect(reducedMotion).toContain('transition-duration: 0.001ms !important');
    expect(reducedMotion).not.toContain(':active');
    for (const [, active] of PRESS_PAIRS) {
      const at = css.indexOf(`${active} {`);
      expect(at, active).toBeGreaterThan(-1);
      expect(at, `${active} must precede the reduced-motion block`).toBeLessThan(mediaAt);
    }
  });

  it('lets a variant icon button override the generic pressed colour while held', () => {
    const generic = css.indexOf('.ui-icon-btn:not(:disabled):active {');
    for (const variant of ['.ui-icon-btn-primary', '.ui-icon-btn-danger']) {
      const at = css.indexOf(`${variant}:not(:disabled):active {`);
      expect(at, variant).toBeGreaterThan(generic);
    }
  });

  it('presses only an enabled control — every :active rule is guarded by :not(:disabled)', () => {
    const selectors = [...flat(css).matchAll(/(?:^|[};])\s*([^{};]*:active[^{};]*)\{/g)].map((m) =>
      (m[1] ?? '').trim(),
    );
    const pressable = selectors.filter((s) => /\.ui-(?:icon-)?btn/.test(s));
    expect(pressable.length).toBeGreaterThanOrEqual(PRESS_PAIRS.length + 1);
    expect(pressable.filter((s) => !s.includes(':not(:disabled)'))).toEqual([]);
  });

  it('keeps the press release alive — no variant rule re-declares the transition', () => {
    // A later `transition:` on `.ui-btn-primary` would replace the base list, so
    // the pressed fill would stop easing out on the micro tier.
    const offenders = rules
      .filter(([selector]) => /\.ui-(?:icon-)?btn-/.test(selector))
      .filter(([, body]) => /(?:^|[;\s])transition\s*:/.test(body))
      .map(([selector]) => selector);
    expect(offenders).toEqual([]);
  });

  it('enters the context menu on the micro tier, still from the pointer corner', () => {
    const body = ruleBody(css, '.ui-menu');
    expect(body).toMatch(/animation:\s*ui-menu-in var\(--mo-micro\)/);
    expect(body).not.toContain('--mo-surface');
    expect(body).toContain('transform-origin: var(--radix-context-menu-content-transform-origin)');
  });

  // Moved here from the theme picker's own stylesheet, which went with the picker:
  // the popup is now the kit Select's, a `.ui-menu` that wears `.ui-select-content`.
  // The entrance is the shared surface's (micro tier, scaled up from 0.97 while
  // fading in), and what the Select adds is the origin — the side of the trigger
  // Radix placed the popup on. The scale is pinned exactly, not as "just under 1":
  // 0.97 is the design's one value for popovers and menus, the one `.tab-menu`
  // and the picker this popup replaced both enter from, and a wildcard would let
  // the kit drift off it unnoticed.
  it('enters the select popup on the micro tier, from the side Radix placed it', () => {
    const surface = ruleBody(css, '.ui-menu');
    expect(surface).toMatch(/animation:\s*ui-menu-in var\(--mo-micro\)/);
    expect(surface).not.toContain('--mo-surface');
    expect(flat(css)).toMatch(
      /@keyframes ui-menu-in \{ from \{ transform: scale\(0\.97\); opacity: 0;/,
    );

    const popup = ruleBody(css, '.ui-select-content');
    expect(popup).toContain('transform-origin: var(--radix-select-content-transform-origin)');
    // The popup rule must not restate the animation on a duration of its own.
    expect(popup).not.toMatch(/animation:/);
    // Equal specificity: the origin only wins if it is declared second. The LAST
    // occurrence, because the reduced-motion list names the popup earlier on.
    expect(css.lastIndexOf('.ui-select-content {')).toBeGreaterThan(css.indexOf('.ui-menu {'));
  });

  it('gives the select popup no entrance under reduced motion', () => {
    expect(reducedMotion).toMatch(
      /\.ui-select-content[^{}]*\{[^}]*animation-duration: 0\.001ms !important/,
    );
  });
});

// `.tab-menu` lives in index.css (2000+ lines every feature edits), so its
// entrance is pinned from there rather than from ui.css.
describe('index.css tab menu entrance', () => {
  const indexCss = readFileSync(join(__dirname, '..', 'index.css'), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );
  const flatIndex = indexCss.replace(/\s+/g, ' ');

  it('animates on the micro tier from the pointer corner', () => {
    const body = /(?:^|[};])\s*\.tab-menu \{([^{}]*)\}/.exec(flatIndex)?.[1] ?? '';
    // index.css writes the tier with its fallback: the tokens are declared in ui.css.
    expect(body).toMatch(/animation:\s*tab-menu-in var\(--mo-micro(?:, 140ms)?\)/);
    expect(body).not.toContain('--mo-surface');
    expect(body).toContain('transform-origin: top left');
  });

  it('scales from 0.97 while fading in', () => {
    expect(flatIndex).toMatch(
      /@keyframes tab-menu-in \{ from \{ transform: scale\(0\.97\); opacity: 0; \} \}/,
    );
  });

  it('has no entrance under reduced motion', () => {
    expect(flatIndex).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{ \.tab-menu \{ animation: none; \} \}/,
    );
  });
});

// The app menu's wrapper. Radix owns the menu semantics, so what is pinned here
// is what the kit adds: the shared `.ui-menu` look, the trigger left as the
// caller's own button, and the transform origin — a dropdown's corner is published
// under Radix's own variable, and the context menu's would resolve to nothing.
describe('DropdownMenu', () => {
  const items = (onSelect = vi.fn()) => [
    { id: 'settings', label: 'Settings', onSelect },
    { id: 'reload', label: 'Reload app', separatorBefore: true, onSelect: vi.fn() },
    { id: 'off', label: 'Unavailable', disabled: true, onSelect },
  ];
  const mount = (onSelect = vi.fn()) =>
    render(
      <DropdownMenu items={items(onSelect)} testidPrefix="m">
        <IconButton label="Menu" data-testid="trigger" />
      </DropdownMenu>,
    );

  it('keeps the trigger closed and unmounted until it is opened', () => {
    mount();
    expect(screen.getByTestId('trigger')).toHaveAttribute('aria-haspopup', 'menu');
    expect(screen.getByTestId('trigger')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('opens from the trigger as a real menu in the context menu look', async () => {
    mount();
    await userEvent.click(screen.getByTestId('trigger'));
    const menu = screen.getByRole('menu');
    expect(menu).toHaveAttribute('data-testid', 'm');
    expect(menu.className).toBe('ui-menu ui-dropdown');
    expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
      'Settings',
      'Reload app',
      'Unavailable',
    ]);
    expect(menu.querySelectorAll('.ui-menu-sep')).toHaveLength(1);
    expect(screen.getByTestId('trigger')).toHaveAttribute('aria-expanded', 'true');
  });

  it('runs the chosen item and closes', async () => {
    const onSelect = vi.fn();
    mount(onSelect);
    await userEvent.click(screen.getByTestId('trigger'));
    await userEvent.click(screen.getByTestId('m-settings'));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('never runs a disabled item', async () => {
    const onSelect = vi.fn();
    mount(onSelect);
    await userEvent.click(screen.getByTestId('trigger'));
    await userEvent.click(screen.getByTestId('m-off'));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('opens from the keyboard and Escape hands focus back to the trigger', async () => {
    mount();
    screen.getByTestId('trigger').focus();
    await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByTestId('trigger')).toHaveFocus();
  });

  it('renders just the trigger when there is nothing to offer', () => {
    render(
      <DropdownMenu items={[]}>
        <IconButton label="Menu" data-testid="trigger" />
      </DropdownMenu>,
    );
    expect(screen.getByTestId('trigger')).not.toHaveAttribute('aria-haspopup');
  });

  it("grows out of the trigger, from Radix's dropdown origin variable", () => {
    expect(ruleBody(css, '.ui-dropdown')).toContain(
      'transform-origin: var(--radix-dropdown-menu-content-transform-origin)',
    );
    // The shared rule stays the context menu's, and the micro-tier entrance with it.
    expect(ruleBody(css, '.ui-menu')).toMatch(/animation:\s*ui-menu-in var\(--mo-micro\)/);
  });

  it('sizes an icon-button trigger to the pill height, and holds a fill while open', () => {
    const body = ruleBody(css, '.ui-icon-btn.ui-menu-trigger');
    expect(body).toContain('width: var(--ctl-h)');
    expect(body).toContain('height: var(--ctl-h)');
    expect(body).toContain('border-radius: var(--r-2)');
    expect(ruleBody(css, ".ui-icon-btn.ui-menu-trigger[data-state='open']")).toContain(
      'background: var(--t-surface)',
    );
  });

  // The trigger rule above is a compound selector, so it only does anything if the
  // DOM carries BOTH classes on one element. The wrapper hands Radix its class via
  // `asChild`; a wrapper element, or a Slot that dropped the IconButton's own
  // class, would leave the CSS matching nothing and the button at its default size.
  it("leaves the caller's own button as the trigger, wearing both classes, with no wrapper", () => {
    const { container } = mount();
    const trigger = screen.getByTestId('trigger');
    expect(trigger.classList.contains('ui-icon-btn')).toBe(true);
    expect(trigger.classList.contains('ui-menu-trigger')).toBe(true);
    expect(container.firstElementChild).toBe(trigger);
    expect(container.querySelectorAll('button')).toHaveLength(1);
  });

  // `.ui-dropdown` and `.ui-menu` have equal specificity and both set
  // `transform-origin`, so which one a dropdown gets is decided by source order
  // alone. Declared first, the context menu's variable (undefined here) wins and
  // the menu scales from its centre instead of out of the button.
  it('declares .ui-dropdown after .ui-menu, so its origin is the one that applies', () => {
    const menu = css.indexOf('.ui-menu {');
    const dropdown = css.indexOf('.ui-dropdown {');
    expect(menu).toBeGreaterThan(-1);
    expect(dropdown).toBeGreaterThan(menu);
  });

  it('shows an item its icon (hidden from assistive tech) and its danger look', async () => {
    render(
      <DropdownMenu
        testidPrefix="m"
        items={[
          { id: 'plain', label: 'Plain', onSelect: vi.fn() },
          {
            id: 'rm',
            label: 'Delete',
            icon: <svg data-testid="glyph" />,
            danger: true,
            onSelect: vi.fn(),
          },
        ]}
      >
        <IconButton label="Menu" data-testid="trigger" />
      </DropdownMenu>,
    );
    await userEvent.click(screen.getByTestId('trigger'));
    const plain = screen.getByTestId('m-plain');
    const rm = screen.getByTestId('m-rm');
    expect(plain.className).toBe('ui-menu-item');
    expect(plain.querySelector('.ui-menu-icon')).toBeNull();
    expect(rm.className).toBe('ui-menu-item danger');
    const icon = rm.querySelector('.ui-menu-icon');
    expect(icon).toHaveAttribute('aria-hidden', 'true');
    expect(icon).toContainElement(screen.getByTestId('glyph'));
  });

  it('focuses the first item as the keyboard opens it, and Enter runs that item', async () => {
    const onSelect = vi.fn();
    mount(onSelect);
    screen.getByTestId('trigger').focus();
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard('{Enter}'); // the first item takes focus as the menu opens
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

// ── The section title ─────────────────────────────────────────────────────────
//
// `.ui-collapsible-trigger` is the heading style of every Collapsible — Settings,
// the New-tab chooser, the Explorer, Dictation — so these pin the kit's own rule
// as text, and the cascade block further down pins what actually reaches the
// screen once a consumer's stylesheet has had its say.
describe('section title', () => {
  const trigger = ruleBody(css, '.ui-collapsible-trigger');

  it('is a small secondary-colour label, not an uppercase tracked heading', () => {
    expect(trigger).toContain('font-size: var(--fs-1)');
    expect(trigger).toContain('font-weight: 600');
    expect(trigger).toContain('color: var(--t-subtext)');
    expect(trigger).toContain('letter-spacing: 0;');
    expect(trigger).toContain('text-transform: none');
    expect(trigger).not.toMatch(/text-transform:\s*uppercase/);
  });

  it('is the only place in the kit that uppercases text', () => {
    expect(css).not.toMatch(/text-transform:\s*uppercase/);
  });
});

// ── Keyboard focus ring ───────────────────────────────────────────────────────
//
// A ring rule is easy to erase without touching it: a later reset at the same
// specificity wins on source order alone, which is what `.ui-input:focus {
// outline: none }` did to the Input's ring. happy-dom cannot say whether a ring
// is drawn, so the rule list is read: every control that rings on :focus-visible
// must have no rule at all, before or after, that resets its outline on focus.
describe('keyboard focus ring', () => {
  const sheet = parse(readFileSync(join(__dirname, 'ui.css'), 'utf8'));
  const rules: Rule[] = [];
  sheet.walkRules((rule) => {
    rules.push(rule);
  });

  const ring = rules.find((rule) => rule.selectors.includes('.ui-btn:focus-visible'));
  const ringed = (ring?.selectors ?? []).map((selector) => selector.replace(':focus-visible', ''));
  const resetsOutline = (rule: Rule): boolean => {
    let reset = false;
    rule.walkDecls(/^outline(?:-style|-width)?$/, (decl) => {
      if (/^(?:none|hidden|0(?:px)?)\b/.test(decl.value)) reset = true;
    });
    return reset;
  };

  it('rings every control the kit lets a keyboard reach', () => {
    expect(ring, 'no :focus-visible ring rule').toBeDefined();
    // The controls the settings panel is built from.
    for (const control of [
      '.ui-btn',
      '.ui-input',
      '.ui-switch',
      '.ui-seg-item',
      '.ui-collapsible-trigger',
      '.ui-select-trigger',
    ]) {
      expect(ringed, control).toContain(control);
    }
    const decls: Record<string, string> = {};
    ring?.walkDecls((decl) => {
      decls[decl.prop] = decl.value;
    });
    expect(decls['outline']).toBe('2px solid var(--t-accent)');
  });

  it.each(['.ui-btn', '.ui-input', '.ui-collapsible-trigger', '.ui-select-trigger'])(
    'leaves no rule that resets the outline of %s on focus',
    (control) => {
      const onThis = new RegExp(`${escapeRe(control)}(?![\\w-])[^,]*:focus`);
      const offenders = rules
        .filter((rule) => rule.selectors.some((selector) => onThis.test(selector)))
        .filter(resetsOutline)
        .map((rule) => rule.selector);
      expect(offenders).toEqual([]);
    },
  );

  it('keeps the Input border change as a second cue, not as the only one', () => {
    expect(ruleBody(css, '.ui-input:focus')).toContain('border-color: var(--t-accent)');
    expect(ringed).toContain('.ui-input');
  });
});

// ── Select: what the stylesheet promises ─────────────────────────────────────
describe('Select stylesheet', () => {
  it('draws the trigger at the control height, which is 36px on a phone', () => {
    const body = ruleBody(css, '.ui-select-trigger');
    expect(body).toContain('height: var(--ctl-h)');
    expect(body).toContain('width: 100%');
    expect(body).toContain('font-size: var(--fs-2)');
    expect(body).toContain('border-radius: var(--r-2)');
  });

  it('keeps the label on one line and ends it in an ellipsis', () => {
    const body = ruleBody(css, '.ui-select-trigger [data-ui-select-value]');
    expect(body).toContain('overflow: hidden');
    expect(body).toContain('text-overflow: ellipsis');
    expect(body).toContain('white-space: nowrap');
    // Without this a flex item cannot shrink below its text, and the ellipsis never shows.
    expect(body).toContain('min-width: 0');
  });

  // Select.tsx wraps each option's ItemText in `.ui-menu-label` (ItemText drops a
  // className), so this is the rule that truncates an option; the check beside it
  // must not shrink, or a long name squeezes it out of the item.
  it('keeps an option label on one line and the check beside it whole', () => {
    const label = ruleBody(css, '.ui-menu-label');
    expect(label).toContain('min-width: 0');
    expect(label).toContain('overflow: hidden');
    expect(label).toContain('text-overflow: ellipsis');
    expect(label).toContain('white-space: nowrap');
    expect(ruleBody(css, '.ui-select-check')).toContain('flex: 0 0 auto');
  });

  it('sizes the popup to its trigger and lets a long list scroll inside the viewport', () => {
    const body = ruleBody(css, '.ui-select-content');
    expect(body).toContain('width: var(--radix-select-trigger-width)');
    expect(body).toContain('max-height: min(60vh, var(--radix-select-content-available-height');
    // The menu's own ceiling would clip a full-width trigger in the dock.
    expect(body).toContain('max-width: none');
  });

  // The shadow guard at the top of the file lists exactly three floating
  // surfaces; the popup is one of them by being `.ui-menu`, not by adding a
  // fourth rule.
  it('draws its popup in the context menu surface, so a list and a menu cannot drift', () => {
    expect(ruleBody(css, '.ui-select-content')).not.toContain('box-shadow');
    expect(ruleBody(css, '.ui-menu')).toContain('box-shadow');
  });
});

// ── The section title, as it cascades ─────────────────────────────────────────
//
// The kit rule above is only the heading style if nothing outranks it. Two
// consumers did: `.settings-view .settings-section > .ui-collapsible-trigger` and
// `.dash-dock .ui-collapsible-trigger` both restated size, weight and tracking at
// a higher specificity, so the kit's one rule never reached the two surfaces it
// was written for. happy-dom does not cascade, so — as press-consumers.test.tsx
// does for the pressed colour — every rule of every stylesheet is matched against
// the rendered trigger and ranked by importance, specificity and source order.
//
// Expected to FAIL until those two consumer stylesheets drop their typography:
// the failure message names each declaration still outranking the kit.
type Specificity = [number, number, number];

const bySpecificity = (a: Specificity, b: Specificity): number =>
  a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** Selectors Level 4 specificity: `:not/:is/:has` take their most specific argument, `:where` nothing. */
function specificityOf(selector: string): Specificity {
  const total: Specificity = [0, 0, 0];
  let rest = selector;
  let previous: string;
  // Repeated, so `:not(:is(.a))` is read from the inside out.
  do {
    previous = rest;
    rest = rest.replace(/:(not|is|has|where)\(([^()]*)\)/g, (_, name: string, args: string) => {
      if (name !== 'where') {
        const best = args
          .split(',')
          .map(specificityOf)
          .reduce((a, b) => (bySpecificity(b, a) > 0 ? b : a), [0, 0, 0] as Specificity);
        total[0] += best[0];
        total[1] += best[1];
        total[2] += best[2];
      }
      return ' ';
    });
  } while (rest !== previous);
  // An attribute's value can hold a `.` or `#`, so attributes are counted and removed first.
  const attributes = rest.match(/\[[^\]]*\]/g)?.length ?? 0;
  rest = rest.replace(/\[[^\]]*\]/g, ' ');
  total[0] += rest.match(/#[\w-]+/g)?.length ?? 0;
  total[1] += attributes + (rest.match(/\.[\w-]+|(?<!:):(?!:)[\w-]+/g)?.length ?? 0);
  total[2] += rest.match(/::[\w-]+|(?:^|[\s>+~])[a-z][\w-]*/gi)?.length ?? 0;
  return total;
}

interface Declared {
  selector: string;
  prop: string;
  value: string;
  specificity: Specificity;
  important: boolean;
  order: number;
  /** Inside an at-rule (a media query): not evaluated, but proven not to reach the trigger. */
  conditional: boolean;
}

const SRC = join(__dirname, '..');
const sheetFiles = readdirSync(SRC, { recursive: true, encoding: 'utf8' })
  .filter((file) => file.endsWith('.css'))
  .map((file) => file.split(sep).join('/'))
  .toSorted();

const declaredMemo = new Map<string, Declared[]>();

/** Every declaration of a property matching `props`, across `files` in that load order. */
function declared(files: string[], props: RegExp): Declared[] {
  // The stylesheets do not change under a test run, and every context re-asks.
  const key = `${files.join('|')}\u0000${props.source}`;
  const cached = declaredMemo.get(key);
  if (cached) return cached;
  const out: Declared[] = [];
  let order = 0;
  for (const file of files) {
    parse(readFileSync(join(SRC, file), 'utf8')).walkRules((rule) => {
      let conditional = false;
      for (let p = rule.parent; p && p.type !== 'root'; p = p.parent) {
        if (p.type === 'atrule') conditional = true;
      }
      if (rule.parent?.type === 'atrule' && (rule.parent as AtRule).name.endsWith('keyframes'))
        return;
      rule.walkDecls(props, (decl) => {
        order += 1;
        for (const selector of rule.selectors) {
          // A state or a pseudo-element is not the trigger at rest.
          if (
            /::|:(?:before|after|hover|active|focus|focus-visible|focus-within)\b/.test(selector)
          ) {
            continue;
          }
          out.push({
            selector,
            prop: decl.prop,
            value: decl.value.replace(/\s+/g, ' ').trim(),
            specificity: specificityOf(selector),
            important: decl.important,
            order,
            conditional,
          });
        }
      });
    });
  }
  declaredMemo.set(key, out);
  return out;
}

/** A selector happy-dom cannot parse is skipped, unless it names the trigger itself. */
function reaches(el: Element, selector: string): boolean {
  try {
    return el.matches(selector);
  } catch (error) {
    if (selector.includes('ui-collapsible-trigger')) throw error;
    return false;
  }
}

const winnerOn = (el: Element, all: Declared[]): Declared | null => {
  let best: Declared | null = null;
  for (const d of all) {
    if (d.conditional || !reaches(el, d.selector)) continue;
    const rank = best
      ? Number(d.important) - Number(best.important) ||
        bySpecificity(d.specificity, best.specificity) ||
        d.order - best.order
      : 1;
    if (rank > 0) best = d;
  }
  return best;
};

describe('the cascade helper itself', () => {
  it('ranks selectors by Selectors Level 4 specificity', () => {
    expect(specificityOf('.ui-collapsible-trigger')).toEqual([0, 1, 0]);
    expect(specificityOf('.settings-view .settings-section > .ui-collapsible-trigger')).toEqual([
      0, 3, 0,
    ]);
    expect(specificityOf('.dash-dock .ui-collapsible-trigger:not(:disabled)')).toEqual([0, 3, 0]);
    expect(specificityOf("button.a[data-x='.b #c']")).toEqual([0, 2, 1]);
    expect(specificityOf(':where(.a .b) .c:is(.d, #e)')).toEqual([1, 1, 0]);
  });
});

describe('the section title, as it cascades in each place it appears', () => {
  const EXPECTED = {
    'font-size': 'var(--fs-1)',
    'font-weight': '600',
    color: 'var(--t-subtext)',
    'letter-spacing': '0',
    'text-transform': 'none',
  } as const;
  const PROPS: [keyof typeof EXPECTED, RegExp][] = [
    ['font-size', /^font(?:-size)?$/],
    ['font-weight', /^font(?:-weight)?$/],
    ['color', /^color$/],
    ['letter-spacing', /^letter-spacing$/],
    ['text-transform', /^text-transform$/],
  ];

  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => ({
        ok: true,
        status: 200,
        json: async () =>
          url === '/ports'
            ? { available: true, ports: [] }
            : { available: true, sessions: [{ name: 'build', attached: false }] },
      })),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.documentElement.removeAttribute('data-mobile');
  });

  const others = sheetFiles.filter((file) => file !== 'ui/ui.css');
  const ORDERS: [string, string[]][] = [
    ['before every other stylesheet', ['ui/ui.css', ...others]],
    ['after every other stylesheet', [...others, 'ui/ui.css']],
  ];

  const CONTEXTS: [string, () => Promise<void>][] = [
    [
      'the kit on its own',
      async () => {
        render(
          <Collapsible title="Section">
            <p>Row</p>
          </Collapsible>,
        );
      },
    ],
    [
      'Settings',
      async () => {
        render(<SettingsFields settings={DEFAULTS} onChange={() => {}} />);
      },
    ],
    [
      'the New tab chooser',
      async () => {
        render(
          <DashboardBody
            webApps={[]}
            quickLinks={[]}
            onCreate={vi.fn()}
            onUpdateQuickLinks={vi.fn()}
          />,
        );
        await screen.findByTestId('dash-tmux-build');
      },
    ],
    // The drawer hosts the same two surfaces on a phone, under the mobile class and
    // inside its own wrappers (`.drawer-settings-body`, `.drawer-newtab-body`), so a
    // rule scoped to either of those — or to `:root[data-mobile]` — is a place the
    // kit's title can be restyled that the two desktop contexts cannot see.
    [
      "the mobile drawer's Settings",
      async () => {
        document.documentElement.setAttribute('data-mobile', 'true');
        render(
          <div className="drawer-settings-body">
            <SettingsFields settings={DEFAULTS} onChange={() => {}} />
          </div>,
        );
      },
    ],
    [
      "the mobile drawer's New tab chooser",
      async () => {
        document.documentElement.setAttribute('data-mobile', 'true');
        render(
          <div className="drawer-newtab-body">
            <DashboardBody
              webApps={[]}
              quickLinks={[]}
              onCreate={vi.fn()}
              onUpdateQuickLinks={vi.fn()}
            />
          </div>,
        );
        await screen.findByTestId('dash-tmux-build');
      },
    ],
  ];

  describe.each(CONTEXTS)('in %s', (_, mount) => {
    it.each(ORDERS)('shows the kit title style, ui.css loaded %s', async (__, order) => {
      await mount();
      const triggers = [...document.querySelectorAll<HTMLElement>('.ui-collapsible-trigger')];
      // A context that rendered no section would pass by checking nothing.
      expect(triggers.length).toBeGreaterThan(0);

      const wrong: string[] = [];
      for (const [prop, props] of PROPS) {
        const all = declared(order, props);
        for (const el of triggers) {
          const won = winnerOn(el, all);
          if (won?.value !== EXPECTED[prop]) {
            wrong.push(
              `${el.dataset['testid'] ?? el.className}: ${prop} is ${won?.value ?? '(unset)'} ` +
                `from ${won?.selector ?? '(nothing)'}, want ${EXPECTED[prop]}`,
            );
          }
        }
      }
      expect([...new Set(wrong)]).toEqual([]);

      // A media query is not evaluated here, so prove none of them can reach a
      // section title rather than letting one slip past unread.
      const conditional = PROPS.flatMap(([, props]) => declared(order, props)).filter(
        (d) => d.conditional && triggers.some((el) => reaches(el, d.selector)),
      );
      expect(conditional.map((d) => `${d.selector} { ${d.prop}: ${d.value} }`)).toEqual([]);
    });

    // A title is not always bare text: the New-tab chooser wraps its label (and a
    // count badge) in spans, and a rule that lands on the label restyles the words
    // while the trigger — the only element checked above — still reads correctly.
    // The label inherits the kit's type, so NOTHING may restate it; its colour may
    // only restate the kit's own. The count badge is a badge, not a title: it keeps
    // its own small type (scale migration is the dashboard stylesheet's job).
    it.each(ORDERS)(
      'lets the label inside the title inherit it, ui.css loaded %s',
      async (__, order) => {
        await mount();
        const labels = [...document.querySelectorAll<HTMLElement>('.ui-collapsible-trigger *')]
          .filter((el) => !el.closest('.ui-collapsible-chevron'))
          .filter((el) => !/count|badge/.test(el.className))
          .filter((el) =>
            [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim()),
          );
        // The chooser is the one place a title is wrapped; there, finding no label
        // would mean this test had stopped looking at anything.
        if (/New tab/.test(_)) expect(labels.length).toBeGreaterThan(0);
        const restated: string[] = [];
        for (const [prop, props] of PROPS) {
          const all = declared(order, props);
          for (const el of labels) {
            const won = winnerOn(el, all);
            if (won && !(prop === 'color' && won.value === EXPECTED.color)) {
              restated.push(`${el.className}: ${prop} is set to ${won.value} by ${won.selector}`);
            }
          }
        }
        expect([...new Set(restated)]).toEqual([]);
      },
    );
  });
});

// ── Focus rings: what a stylesheet may not do to them ────────────────────────
//
// The 'keyboard focus ring' block further up reads ui.css alone, and a ring is only
// as good as the LAST stylesheet that touches it: a consumer's
// `.settings-view .ui-input { outline: none }` erases it as surely as the kit's own
// old `.ui-input:focus { outline: none }` did, and ui.css would still read clean.
// So every client stylesheet is scanned. The detectors are proven on synthetic
// sheets first — one that matches nothing passes every real file.
//
// Two rules sit under this and they are different. A NON-editable control (button,
// switch, segmented item, section header, select trigger) rings on :focus-visible
// only, so no `:focus` rule may style it: a mouse click would show the ring.
// An EDITABLE field is the exception — Chromium matches :focus-visible on a
// focused text field whatever focused it, because the caret needs an indicator, so
// it may carry a plain `:focus` cue (the kit's border change) and its ring appears
// on any focus. Fighting that would mean tracking input modality by hand.
const RINGED_KIT_CONTROLS = [
  '.ui-btn',
  '.ui-icon-btn',
  '.ui-input',
  '.ui-switch',
  '.ui-seg-item',
  '.ui-collapsible-trigger',
  '.ui-select-trigger',
];

/** The kit's own ring selector, `.ui-btn:focus-visible`: a class and a pseudo-class. */
const RING_SPECIFICITY: Specificity = [0, 2, 0];

interface OutlineReset {
  selector: string;
  specificity: Specificity;
}

/** Every selector whose rule resets the outline: `none`, `hidden` or a zero width. */
function outlineResets(source: string): OutlineReset[] {
  const out: OutlineReset[] = [];
  parse(source).walkRules((rule) => {
    let resets = false;
    rule.walkDecls(/^outline(?:-style|-width)?$/, (decl) => {
      if (/^(?:none|hidden|0(?:px)?)(?![\w.-])/.test(decl.value.trim())) resets = true;
    });
    if (!resets) return;
    for (const selector of rule.selectors) {
      out.push({ selector, specificity: specificityOf(selector) });
    }
  });
  return out;
}

/** A reset that can cancel a kit control's ring: it names the control and ties or outranks it. */
const erasesKitRing = ({ selector, specificity }: OutlineReset): boolean =>
  RINGED_KIT_CONTROLS.some((control) =>
    new RegExp(`${escapeRe(control)}(?![\\w-])`).test(selector),
  ) && bySpecificity(specificity, RING_SPECIFICITY) >= 0;

/** Selectors that style the plain `:focus` state — not `:focus-visible`, not `:focus-within`. */
function plainFocusSelectors(source: string): string[] {
  const out: string[] = [];
  parse(source).walkRules((rule) => {
    for (const selector of rule.selectors) {
      if (/:focus(?![\w-])/.test(selector)) out.push(selector);
    }
  });
  return out;
}

/** Whether the compound carrying `:focus` is a text field, which is allowed that cue. */
function focusTargetsEditable(selector: string): boolean {
  const compound =
    selector.split(/[\s>+~]+/).find((part) => /:focus(?![\w-])/.test(part)) ?? selector;
  return /^(?:input|textarea)(?![\w-])|\.ui-input(?![\w-])|\[contenteditable/.test(compound);
}

/** The kit sheet, every settings sheet, and the settings rules inside index.css. */
const inKitOrSettings = (file: string, selector: string): boolean =>
  file === 'ui/ui.css' ||
  file.startsWith('settings/') ||
  /\.settings-(?:form|view)(?![\w-])|\.srow(?![\w-])|\.set-card(?![\w-])|\.drawer-settings-body/.test(
    selector,
  );

describe('the focus-ring detectors, proven on synthetic stylesheets', () => {
  it('flags a reset that could cancel a kit ring, and only that', () => {
    const erasers = outlineResets(`
      .ui-input:focus { outline: none; }
      .settings-view .ui-btn { outline: 0; }
      .ui-btn { outline: none; }
      .fine:focus-visible { outline: 2px solid red; }
      .fine-too:focus-visible { outline: 0.5px solid red; }
      .palette-input { outline: none; }
      a:focus, .ui-switch:hover { outline: hidden; }
      @media (min-width: 1px) { .ui-select-trigger:focus-visible { outline-style: none; } }
    `)
      .filter(erasesKitRing)
      .map((reset) => reset.selector);
    expect(erasers).toEqual([
      '.ui-input:focus',
      '.settings-view .ui-btn',
      '.ui-switch:hover',
      '.ui-select-trigger:focus-visible',
    ]);
  });

  it('lets a reset below the ring in specificity be, since it cannot win', () => {
    const [reset] = outlineResets('.ui-btn { outline: none; }');
    expect(reset && erasesKitRing(reset)).toBe(false);
  });

  it('finds a plain :focus selector and tells a text field from every other control', () => {
    const selectors = plainFocusSelectors(`
      .ui-btn:focus { outline: 2px solid red; }
      .ui-input:focus { border-color: red; }
      .settings-view .srow input[type='number']:focus { border-color: red; }
      .ui-seg-item:focus-visible { outline: 2px solid red; }
      .ui-collapsible-trigger:focus-within { color: red; }
      textarea:focus, .ui-switch:focus { color: red; }
    `);
    expect(selectors).toEqual([
      '.ui-btn:focus',
      '.ui-input:focus',
      ".settings-view .srow input[type='number']:focus",
      'textarea:focus',
      '.ui-switch:focus',
    ]);
    expect(selectors.filter((selector) => !focusTargetsEditable(selector))).toEqual([
      '.ui-btn:focus',
      '.ui-switch:focus',
    ]);
  });
});

describe('no stylesheet erases a keyboard focus ring', () => {
  it('has no outline reset that can cancel a kit control ring, in any stylesheet', () => {
    const offenders = sheetFiles.flatMap((file) =>
      outlineResets(readFileSync(join(SRC, file), 'utf8'))
        .filter(erasesKitRing)
        .map((reset) => `${file}: ${reset.selector}`),
    );
    expect(offenders).toEqual([]);
  });

  // settings-view.css says "nothing in this file resets an outline", and the plan
  // forbids restoring the blanket reset: pinned over everything that styles the
  // panel, whatever element a rule names (a bare `button:focus` is not a kit class).
  it('resets no outline anywhere in the settings stylesheets or the settings rules of index.css', () => {
    const offenders = sheetFiles.flatMap((file) =>
      outlineResets(readFileSync(join(SRC, file), 'utf8'))
        .filter((reset) => inKitOrSettings(file, reset.selector) && file !== 'ui/ui.css')
        .map((reset) => `${file}: ${reset.selector}`),
    );
    expect(offenders).toEqual([]);
  });
});

describe('only an editable field takes a plain :focus cue', () => {
  it('styles :focus in the kit and the settings sheets only on a text field', () => {
    const offenders = sheetFiles.flatMap((file) =>
      plainFocusSelectors(readFileSync(join(SRC, file), 'utf8'))
        .filter((selector) => inKitOrSettings(file, selector))
        .filter((selector) => !focusTargetsEditable(selector))
        .map((selector) => `${file}: ${selector}`),
    );
    expect(offenders).toEqual([]);
  });

  it('still gives the kit Input its :focus border and its keyboard ring', () => {
    // The scan above would pass a kit that had dropped both; this is the other side
    // of the exception — an editable field keeps a cue on ANY focus.
    const source = readFileSync(join(__dirname, 'ui.css'), 'utf8');
    expect(plainFocusSelectors(source)).toEqual(['.ui-input:focus']);
    expect(ruleBody(css, '.ui-input:focus')).toContain('border-color: var(--t-accent)');
    expect(css).toMatch(/\.ui-input:focus-visible/);
  });
});

// ── The Select, as it cascades ───────────────────────────────────────────────
//
// ui.css pins what the Select's rules SAY; this resolves what REACHES the rendered
// element once every other stylesheet has had its say, the same way the section
// title is resolved above. Two of the Select's promises are layout, and a consumer
// outranking either would break them silently: the trigger is exactly the control
// height (28px on a desktop, 36px under the mobile class) and a value too long for
// its box ends in an ellipsis on one line.
const NON_KIT_SHEETS = sheetFiles.filter((file) => file !== 'ui/ui.css');
const LOAD_ORDERS: [string, string[]][] = [
  ['before every other stylesheet', ['ui/ui.css', ...NON_KIT_SHEETS]],
  ['after every other stylesheet', [...NON_KIT_SHEETS, 'ui/ui.css']],
];

const indexCss = readFileSync(join(SRC, 'index.css'), 'utf8');

/** The last value a custom property is given under exactly `selector`. */
function tokenUnder(source: string, selector: string, token: string): string | undefined {
  let found: string | undefined;
  parse(source).walkRules((rule) => {
    if (!rule.selectors.map((s) => s.replaceAll('"', "'")).includes(selector)) return;
    rule.walkDecls(token, (decl) => {
      found = decl.value.trim();
    });
  });
  return found;
}

/** A length in px, given what `--ctl-h` is. Anything else is null, so an unreadable value fails loudly. */
function px(value: string | undefined, ctl: number): number | null {
  if (value === undefined) return null;
  const v = value
    .replace(/var\(--ctl-h\)/g, `${ctl}px`)
    .replace(/\s+/g, ' ')
    .trim();
  const lone = /^(-?\d+(?:\.\d+)?)px$/.exec(v);
  if (lone) return Number(lone[1]);
  const sum = /^calc\((-?\d+(?:\.\d+)?)px ([+-]) (\d+(?:\.\d+)?)px\)$/.exec(v);
  if (sum)
    return sum[2] === '+' ? Number(sum[1]) + Number(sum[3]) : Number(sum[1]) - Number(sum[3]);
  return null;
}

/** `--ctl-h` as index.css declares it: on `:root`, and raised under the mobile attribute. */
const ctlHeight = (mobile: boolean): number | null =>
  px(tokenUnder(indexCss, mobile ? ":root[data-mobile='true']" : ':root', '--ctl-h'), 0);

const setMobile = (on: boolean): void => {
  if (on) document.documentElement.setAttribute('data-mobile', 'true');
  else document.documentElement.removeAttribute('data-mobile');
};

describe('the length resolver the height proof stands on', () => {
  it('reads the control height from index.css, 28px on a desktop and 36px under the mobile class', () => {
    expect(ctlHeight(false)).toBe(28);
    expect(ctlHeight(true)).toBe(36);
  });

  it('resolves the forms a control height is written in, and refuses the rest', () => {
    expect(px('var(--ctl-h)', 28)).toBe(28);
    expect(px('var(--ctl-h)', 36)).toBe(36);
    expect(px('calc(var(--ctl-h) - 6px)', 36)).toBe(30);
    expect(px('calc(var(--ctl-h) + 2px)', 28)).toBe(30);
    expect(px('30px', 28)).toBe(30);
    expect(px('var(--mbtn-h, 30px)', 28)).toBeNull();
    expect(px('auto', 28)).toBeNull();
    expect(px(undefined, 28)).toBeNull();
  });

  it('measures border-box, which is what makes `height` the whole box', () => {
    expect(ruleBody(indexCss.replace(/\/\*[\s\S]*?\*\//g, ''), '*')).toContain(
      'box-sizing: border-box',
    );
  });
});

describe('the Select, as it cascades in each place it appears', () => {
  const OPTIONS = [
    { value: 'a', label: 'Alpha' },
    { value: 'b', label: 'Bravo' },
  ];

  afterEach(() => {
    setMobile(false);
  });

  const CONTEXTS: [string, () => void][] = [
    [
      'the kit on its own',
      () => {
        render(<Select value="a" onChange={vi.fn()} options={OPTIONS} data-testid="s" />);
      },
    ],
    [
      'Settings',
      () => {
        render(<SettingsFields settings={DEFAULTS} onChange={() => {}} />);
      },
    ],
    [
      "the mobile drawer's Settings",
      () => {
        render(
          <div className="drawer-settings-body">
            <SettingsFields settings={DEFAULTS} onChange={() => {}} />
          </div>,
        );
      },
    ],
  ];

  describe.each(CONTEXTS)('in %s', (_, mount) => {
    const triggers = (): HTMLElement[] => {
      mount();
      const found = [...document.querySelectorAll<HTMLElement>('.ui-select-trigger')];
      // A context that rendered no Select would pass by measuring nothing; for
      // Settings this is also "Font is a kit Select".
      expect(found.length).toBeGreaterThan(0);
      return found;
    };

    it.each(LOAD_ORDERS)(
      'draws the trigger exactly one control height tall, ui.css loaded %s',
      (__, order) => {
        const found = triggers();
        for (const [mobile, want] of [
          [false, 28],
          [true, 36],
        ] as const) {
          setMobile(mobile);
          const ctl = ctlHeight(mobile);
          expect(ctl, `--ctl-h at mobile=${mobile}`).toBe(want);
          for (const el of found) {
            const of = (props: RegExp) => winnerOn(el, declared(order, props));
            const label = `${el.dataset['testid'] ?? el.id ?? 'trigger'} at mobile=${mobile}`;
            expect(of(/^box-sizing$/)?.value, `${label}: box-sizing`).toBe('border-box');
            expect(px(of(/^height$/)?.value, ctl ?? 0), `${label}: height`).toBe(want);
            // A `min-height` above --ctl-h (the kit's 30px floor) would make the box
            // taller than it says; unset, or at most the control height, is fine.
            const min = of(/^min-height$/);
            expect(min ? px(min.value, ctl ?? 0) : 0, `${label}: min-height`).toBeLessThanOrEqual(
              want,
            );
            expect(of(/^max-height$/)?.value, `${label}: max-height`).toBeUndefined();
          }
        }
        // A media query is not evaluated here, so prove none can reach a trigger's
        // size rather than letting a narrow-screen override slip past unread.
        const conditional = declared(order, /^(?:min-|max-)?height$/).filter(
          (d) => d.conditional && found.some((el) => reaches(el, d.selector)),
        );
        expect(conditional.map((d) => `${d.selector} { ${d.prop}: ${d.value} }`)).toEqual([]);
      },
    );

    it.each(LOAD_ORDERS)(
      'keeps a long value on one line that ends in an ellipsis, ui.css loaded %s',
      (__, order) => {
        const found = triggers();
        const values = found.flatMap((el) => [
          ...el.querySelectorAll<HTMLElement>('[data-ui-select-value]'),
        ]);
        expect(values.length).toBe(found.length);
        const wrong: string[] = [];
        for (const [prop, want] of [
          ['white-space', 'nowrap'],
          ['overflow', 'hidden'],
          ['text-overflow', 'ellipsis'],
          ['min-width', '0'],
        ] as const) {
          const all = declared(order, new RegExp(`^${prop}$`));
          for (const el of values) {
            const won = winnerOn(el, all);
            if (won?.value !== want) {
              wrong.push(
                `${prop} is ${won?.value ?? '(unset)'} from ${won?.selector}, want ${want}`,
              );
            }
          }
        }
        expect([...new Set(wrong)]).toEqual([]);
        const conditional = declared(order, /^(?:white-space|overflow|text-overflow|min-width)$/)
          .filter((d) => d.conditional && values.some((el) => reaches(el, d.selector)))
          .map((d) => `${d.selector} { ${d.prop}: ${d.value} }`);
        expect(conditional).toEqual([]);
        // The full text is what the tooltip carries when the box cuts it short.
        for (const el of found) expect(el.getAttribute('title')).toBeTruthy();
      },
    );
  });

  describe('the popup', () => {
    const openPopup = (): HTMLElement => {
      render(<Select value="a" onChange={vi.fn()} options={OPTIONS} data-testid="s" />);
      fireEvent.click(screen.getByTestId('s'));
      return screen.getByRole('listbox');
    };

    it.each(LOAD_ORDERS)(
      'enters on the micro tier, from the side Radix placed it, ui.css loaded %s',
      (__, order) => {
        const popup = openPopup();
        const reaching = (props: RegExp) =>
          declared(order, props).filter((d) => !d.conditional && reaches(popup, d.selector));
        // The entrance is the shared menu surface's, and the Select restates none of it.
        const animation = reaching(/^animation/);
        expect(animation.map((d) => d.selector)).toEqual(['.ui-menu']);
        expect(animation[0]?.value).toMatch(/^ui-menu-in var\(--mo-micro\)/);
        const origin = winnerOn(popup, declared(order, /^transform-origin$/));
        expect(origin?.selector).toBe('.ui-select-content');
        expect(origin?.value).toBe('var(--radix-select-content-transform-origin)');
        // Reduced motion reaches it through the media query, which is not evaluated
        // here, so prove the one rule that does is the zero-duration override.
        const reduced = declared(order, /^animation-duration$/).filter(
          (d) => d.conditional && reaches(popup, d.selector),
        );
        expect(reduced.map((d) => `${d.value}${d.important ? ' !important' : ''}`)).toEqual([
          '0.001ms !important',
        ]);
      },
    );

    it.each(LOAD_ORDERS)('stacks above a Dialog it may sit in, ui.css loaded %s', (__, order) => {
      const popup = openPopup();
      const popupZ = Number(winnerOn(popup, declared(order, /^z-index$/))?.value);
      const dialogZ = Number(/z-index:\s*(\d+)/.exec(ruleBody(css, '.ui-dialog-content'))?.[1]);
      expect(popupZ).toBeGreaterThan(dialogZ);
    });
  });
});
