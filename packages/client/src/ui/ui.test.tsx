// What the component kit promises. Two halves:
//
// 1. A grep over ui.css, in the spirit of xterm-css-contract.test.ts. The
//    theming rule ("no colour literal outside a color-mix over --t-*") has no
//    runtime symptom a render test can see — a hard-coded hex looks perfect
//    until someone switches to a light theme — so the stylesheet is checked as
//    text.
// 2. Render tests for the behaviour that is ours rather than Radix's: variant
//    classes, the Collapsible's per-device persistence, and the confirm path.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Button, Collapsible, Dialog, IconButton, Input, Segmented, Switch } from './index';

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
    expect(css).not.toContain('max-height');
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
