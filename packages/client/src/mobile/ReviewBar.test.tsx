// The review bar: what takes the extra-keys bar's place while a review is the active
// tab. Its contract is one release-time pointer machine for taps and swipes, because
// a drawer swipe that began on Reviewed must not stage the file (design D12,
// SCM-R3-01). Nothing here loads a stylesheet into the DOM (happy-dom resolves no
// cascade), so what the CSS promises is read as text.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { parse } from 'postcss';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ScmGroup } from '@palmux/shared';
import { ReviewBar } from './ReviewBar';

afterEach(cleanup);

const spies = () => ({
  onFiles: vi.fn(),
  onPreviousFile: vi.fn(),
  onNextFile: vi.fn(),
  onReview: vi.fn(),
  onSwipe: vi.fn(),
});

function mount(group: ScmGroup = 'changes') {
  const s = spies();
  render(<ReviewBar group={group} {...s} />);
  return s;
}

/** The four buttons, by the spy each one calls. */
const BUTTONS = (group: ScmGroup = 'changes') =>
  [
    ['review-bar-files', 'onFiles'],
    ['review-bar-previous', 'onPreviousFile'],
    ['review-bar-next', 'onNextFile'],
    [group === 'staged' ? 'review-bar-unstage' : 'review-bar-reviewed', 'onReview'],
  ] as const;

const ACTIONS = ['onFiles', 'onPreviousFile', 'onNextFile', 'onReview'] as const;

const at = (x: number, y = 100, pointerId = 1) => ({
  pointerId,
  pointerType: 'touch',
  clientX: x,
  clientY: y,
});

/** A finger down on `el`, moved to (`x`, `y`), and lifted there. */
function drag(el: Element, from: number, to: number, y = 100) {
  fireEvent.pointerDown(el, at(from));
  fireEvent.pointerMove(el, at(to, y));
  fireEvent.pointerUp(el, at(to, y));
}

const tap = (el: Element) => {
  fireEvent.pointerDown(el, at(100));
  fireEvent.pointerUp(el, at(101, 101));
};

describe('what the bar holds', () => {
  it('is a toolbar of the file list, previous file, next file and Reviewed, and nothing else', () => {
    mount();
    expect(screen.getByRole('toolbar', { name: 'Review' })).toBe(screen.getByTestId('review-bar'));
    expect(screen.getAllByRole('button').map((b) => b.getAttribute('data-testid'))).toEqual([
      'review-bar-files',
      'review-bar-previous',
      'review-bar-next',
      'review-bar-reviewed',
    ]);
    // No terminal key can be on it: those are `.ek-key`s of the other bar.
    expect(document.querySelectorAll('.ek-key, [data-testid^="extra-key-"]')).toHaveLength(0);
    expect(document.getElementById('extra-keys-bar')).toBeNull();
  });

  it('names every button for assistive tech', () => {
    mount();
    expect(screen.getByTestId('review-bar-files')).toHaveAccessibleName('File list');
    expect(screen.getByTestId('review-bar-previous')).toHaveAccessibleName('Previous file');
    expect(screen.getByTestId('review-bar-next')).toHaveAccessibleName('Next file');
    expect(screen.getByTestId('review-bar-reviewed')).toHaveAccessibleName('Reviewed');
  });

  it('offers Reviewed in a Changes review and Unstage in a Staged one', () => {
    mount('changes');
    expect(screen.getByTestId('review-bar-reviewed')).toHaveTextContent('Reviewed');
    expect(screen.queryByTestId('review-bar-unstage')).toBeNull();
    cleanup();
    mount('staged');
    expect(screen.getByTestId('review-bar-unstage')).toHaveTextContent('Unstage');
    expect(screen.queryByTestId('review-bar-reviewed')).toBeNull();
  });

  it('draws an icon on each button', () => {
    mount();
    for (const [id] of BUTTONS()) {
      expect(screen.getByTestId(id).querySelector('svg'), id).not.toBeNull();
    }
  });
});

describe('a tap acts on the button under the finger, once', () => {
  it.each(['changes', 'staged'] as const)(
    'in a %s review, each button calls its own action',
    (group) => {
      for (const [id, action] of BUTTONS(group)) {
        const s = mount(group);
        tap(screen.getByTestId(id));
        for (const name of ACTIONS)
          expect(s[name], `${id} → ${name}`).toHaveBeenCalledTimes(name === action ? 1 : 0);
        expect(s.onSwipe).not.toHaveBeenCalled();
        cleanup();
      }
    },
  );

  it('acts on RELEASE, not on the press: a finger that has only landed has done nothing', () => {
    const s = mount();
    fireEvent.pointerDown(screen.getByTestId('review-bar-reviewed'), at(100));
    for (const name of ACTIONS) expect(s[name]).not.toHaveBeenCalled();
    fireEvent.pointerUp(screen.getByTestId('review-bar-reviewed'), at(100));
    expect(s.onReview).toHaveBeenCalledTimes(1);
  });

  it('tolerates a fingertip’s wobble inside the slop', () => {
    const s = mount();
    const button = screen.getByTestId('review-bar-next');
    fireEvent.pointerDown(button, at(100, 100));
    fireEvent.pointerMove(button, at(106, 94));
    fireEvent.pointerUp(button, at(106, 94));
    expect(s.onNextFile).toHaveBeenCalledTimes(1);
  });

  it('is released on the bar, where capture delivers it, and still acts on the button it began on', () => {
    const s = mount();
    fireEvent.pointerDown(screen.getByTestId('review-bar-previous'), at(100));
    fireEvent.pointerUp(screen.getByTestId('review-bar'), at(100));
    expect(s.onPreviousFile).toHaveBeenCalledTimes(1);
  });

  it('is not acted on a second time by the click the press ends in', () => {
    const s = mount();
    const button = screen.getByTestId('review-bar-reviewed');
    tap(button);
    // A mouse's (or a touch's) own click carries a count.
    fireEvent.click(button, { detail: 1 });
    expect(s.onReview).toHaveBeenCalledTimes(1);
  });

  it('marks its gesture, so the click that lands on what the action redrew reaches nothing', () => {
    mount();
    const redrawn = document.createElement('button');
    document.body.append(redrawn);
    const reached = vi.fn();
    redrawn.addEventListener('click', reached);
    try {
      fireEvent.pointerDown(screen.getByTestId('review-bar-reviewed'), at(100));
      fireEvent.pointerUp(screen.getByTestId('review-bar-reviewed'), at(100));
      // The tap's trailing click lands on whatever is under the finger by then.
      fireEvent.click(redrawn, { detail: 1 });
      expect(reached).not.toHaveBeenCalled();
      // A keyboard or assistive-tech click has no count and is nobody's tail.
      fireEvent.click(redrawn, { detail: 0 });
      expect(reached).toHaveBeenCalledTimes(1);
    } finally {
      redrawn.remove();
    }
  });

  it('marks nothing when it does not act: a swipe leaves the next click alone', () => {
    mount();
    const other = document.createElement('button');
    document.body.append(other);
    const reached = vi.fn();
    other.addEventListener('click', reached);
    try {
      drag(screen.getByTestId('review-bar-reviewed'), 200, 100);
      fireEvent.click(other, { detail: 1 });
      expect(reached).toHaveBeenCalledTimes(1);
    } finally {
      other.remove();
    }
  });

  it('acts once on a click with no count: Enter, Space, assistive tech, element.click()', () => {
    for (const [id, action] of BUTTONS()) {
      const s = mount();
      fireEvent.click(screen.getByTestId(id)); // detail 0
      for (const name of ACTIONS)
        expect(s[name], `${id} → ${name}`).toHaveBeenCalledTimes(name === action ? 1 : 0);
      cleanup();
    }
  });

  it('ignores a counted click that no pointer press of the bar made', () => {
    const s = mount();
    fireEvent.click(screen.getByTestId('review-bar-reviewed'), { detail: 1 });
    expect(s.onReview).not.toHaveBeenCalled();
  });

  it('cancels the pointerdown, so it never takes focus from the keyboard textarea or a comment', () => {
    mount();
    for (const [id] of BUTTONS()) {
      // fireEvent answers false when a handler called preventDefault.
      expect(fireEvent.pointerDown(screen.getByTestId(id), at(100)), id).toBe(false);
      fireEvent.pointerCancel(screen.getByTestId(id), at(100));
    }
  });

  it('leaves a focused textarea focused through a tap, as a browser delivers one', () => {
    // happy-dom moves no focus on a press, and a browser does: an uncancelled
    // pointerdown is followed by a mousedown (a mouse's at once, a touch's after the
    // release) whose default focuses the button under it. A cancelled pointerdown
    // sends no mousedown at all. The mouse's comes before the release, so only the
    // cancelled pointerdown can save focus there, whatever the release then marks.
    const s = mount();
    const comment = document.createElement('textarea');
    document.body.append(comment);
    comment.focus();
    const next = screen.getByTestId('review-bar-next');
    const mouseDown = () => {
      if (fireEvent.mouseDown(next, { detail: 1 })) next.focus();
    };
    try {
      for (const pointerType of ['mouse', 'touch'] as const) {
        const compat = fireEvent.pointerDown(next, { ...at(100), pointerType });
        if (compat && pointerType === 'mouse') mouseDown();
        fireEvent.pointerUp(next, { ...at(101, 101), pointerType });
        if (compat && pointerType === 'touch') mouseDown();
        expect(comment, pointerType).toHaveFocus();
      }
      expect(s.onNextFile).toHaveBeenCalledTimes(2);
    } finally {
      comment.remove();
    }
  });
});

describe('a swipe is never a tap', () => {
  // The scenario that matters: a finger lands on a button and slides across the bar.
  // Pressed buttons would have acted at pointerdown; this bar acts at release, and a
  // release that travelled is a swipe.
  describe.each(BUTTONS())('starting on %s', (id) => {
    it('right to left opens the drawer and activates nothing', () => {
      const s = mount();
      drag(screen.getByTestId(id), 300, 100);
      expect(s.onSwipe).toHaveBeenCalledTimes(1);
      expect(s.onSwipe).toHaveBeenCalledWith('left');
      for (const name of ACTIONS) expect(s[name], name).not.toHaveBeenCalled();
    });

    it('left to right goes back and activates nothing', () => {
      const s = mount();
      drag(screen.getByTestId(id), 100, 300);
      expect(s.onSwipe).toHaveBeenCalledTimes(1);
      expect(s.onSwipe).toHaveBeenCalledWith('right');
      for (const name of ACTIONS) expect(s[name], name).not.toHaveBeenCalled();
    });
  });

  it('starting on Staged’s Unstage does not unstage either', () => {
    const s = mount('staged');
    drag(screen.getByTestId('review-bar-unstage'), 300, 100);
    expect(s.onSwipe).toHaveBeenCalledWith('left');
    expect(s.onReview).not.toHaveBeenCalled();
  });

  it('is judged where the finger lifted, even if no move event said it had left the slop', () => {
    const s = mount();
    fireEvent.pointerDown(screen.getByTestId('review-bar-reviewed'), at(300));
    fireEvent.pointerUp(screen.getByTestId('review-bar-reviewed'), at(100));
    expect(s.onSwipe).toHaveBeenCalledWith('left');
    expect(s.onReview).not.toHaveBeenCalled();
  });

  it('is reported once however many moves it took', () => {
    const s = mount();
    const button = screen.getByTestId('review-bar-next');
    fireEvent.pointerDown(button, at(300));
    for (const x of [280, 240, 200, 160, 120]) fireEvent.pointerMove(button, at(x));
    fireEvent.pointerUp(button, at(100));
    expect(s.onSwipe).toHaveBeenCalledTimes(1);
  });

  it('a slide past the slop but short of the swipe distance is neither a tap nor a swipe', () => {
    const s = mount();
    drag(screen.getByTestId('review-bar-reviewed'), 100, 140); // 40px: past 10, short of 60
    expect(s.onSwipe).not.toHaveBeenCalled();
    for (const name of ACTIONS) expect(s[name], name).not.toHaveBeenCalled();
  });

  it('a mostly vertical drag is neither, however far it goes', () => {
    const s = mount();
    drag(screen.getByTestId('review-bar-reviewed'), 100, 130, 300);
    expect(s.onSwipe).not.toHaveBeenCalled();
    for (const name of ACTIONS) expect(s[name], name).not.toHaveBeenCalled();
  });

  it('a pointercancel (the OS’s own edge gesture) acts on nothing, and the bar works after it', () => {
    const s = mount();
    const button = screen.getByTestId('review-bar-reviewed');
    fireEvent.pointerDown(button, at(100));
    fireEvent.pointerCancel(button, at(100));
    fireEvent.pointerUp(button, at(100)); // a stray release after the cancel
    for (const name of ACTIONS) expect(s[name], name).not.toHaveBeenCalled();
    expect(s.onSwipe).not.toHaveBeenCalled();

    tap(button);
    expect(s.onReview).toHaveBeenCalledTimes(1);
  });

  it('a pointercancel after travel does not report a swipe', () => {
    const s = mount();
    const button = screen.getByTestId('review-bar-reviewed');
    fireEvent.pointerDown(button, at(300));
    fireEvent.pointerMove(button, at(100));
    fireEvent.pointerCancel(button, at(100));
    expect(s.onSwipe).not.toHaveBeenCalled();
    expect(s.onReview).not.toHaveBeenCalled();
  });

  it('a release that belongs to another pointer is not this press’s', () => {
    const s = mount();
    const button = screen.getByTestId('review-bar-reviewed');
    fireEvent.pointerDown(button, at(100, 100, 1));
    fireEvent.pointerUp(button, at(100, 100, 2));
    expect(s.onReview).not.toHaveBeenCalled();
    fireEvent.pointerUp(button, at(100, 100, 1));
    expect(s.onReview).toHaveBeenCalledTimes(1);
  });

  it('a second finger ends the first, which acts on nothing: only one action per gesture', () => {
    const s = mount();
    fireEvent.pointerDown(screen.getByTestId('review-bar-reviewed'), at(100, 100, 1));
    fireEvent.pointerDown(screen.getByTestId('review-bar-next'), at(200, 100, 2));
    fireEvent.pointerUp(screen.getByTestId('review-bar-reviewed'), at(100, 100, 1));
    expect(s.onReview).not.toHaveBeenCalled();
    fireEvent.pointerUp(screen.getByTestId('review-bar-next'), at(200, 100, 2));
    expect(s.onNextFile).toHaveBeenCalledTimes(1);
  });

  it('a mouse drag across the bar is a swipe too', () => {
    const s = mount();
    const button = screen.getByTestId('review-bar-reviewed');
    const mouse = { pointerType: 'mouse', pointerId: 1, clientY: 100 };
    fireEvent.pointerDown(button, { ...mouse, clientX: 300 });
    fireEvent.pointerUp(button, { ...mouse, clientX: 100 });
    // …and the click a mouse still sends to the button it began on is not a tap.
    fireEvent.click(button, { detail: 1 });
    expect(s.onSwipe).toHaveBeenCalledWith('left');
    expect(s.onReview).not.toHaveBeenCalled();
  });
});

describe('press feedback', () => {
  it('shows a press while it can still be a tap, and clears it the moment it is a slide', () => {
    mount();
    const button = screen.getByTestId('review-bar-reviewed');
    fireEvent.pointerDown(button, at(100));
    expect(button).toHaveClass('pressed');
    fireEvent.pointerMove(button, at(140));
    expect(button).not.toHaveClass('pressed');
    fireEvent.pointerUp(button, at(140));
    expect(button).not.toHaveClass('pressed');
  });

  it('clears on release and on cancel', () => {
    mount();
    const button = screen.getByTestId('review-bar-next');
    tap(button);
    expect(button).not.toHaveClass('pressed');
    fireEvent.pointerDown(button, at(100));
    fireEvent.pointerCancel(button, at(100));
    expect(button).not.toHaveClass('pressed');
  });
});

// ── The code ─────────────────────────────────────────────────────────────────

const SOURCE = readFileSync(join(__dirname, 'ReviewBar.tsx'), 'utf8');
const BAR_SOURCE = readFileSync(join(__dirname, 'ExtraKeysBar.tsx'), 'utf8');
const CSS = readFileSync(join(__dirname, 'review-bar.css'), 'utf8');
const INDEX_CSS = readFileSync(join(__dirname, '../index.css'), 'utf8');

const constant = (source: string, name: string): number | undefined => {
  const match = new RegExp(`const ${name}\\s*=\\s*(\\d+)`).exec(source);
  return match ? Number(match[1]) : undefined;
};

describe('the same gesture as the extra-keys bar', () => {
  it('uses its two thresholds: 10px of travel ends a tap, 60px of it is a swipe', () => {
    expect(constant(BAR_SOURCE, 'MOVE_CANCEL_PX')).toBe(10);
    expect(constant(BAR_SOURCE, 'DRAWER_SWIPE_PX')).toBe(60);
    // The copies here must not drift from the bar they copy.
    expect(constant(SOURCE, 'SLOP_PX')).toBe(constant(BAR_SOURCE, 'MOVE_CANCEL_PX'));
    expect(constant(SOURCE, 'SWIPE_PX')).toBe(constant(BAR_SOURCE, 'DRAWER_SWIPE_PX'));
  });

  it('reports a swipe by gesture direction and has an opinion on nothing else, like the bar', () => {
    expect(SOURCE).toMatch(/dx > 0 \? 'right' : 'left'/);
    expect(BAR_SOURCE).toMatch(/dx > 0 \? 'right' : 'left'/);
  });

  it('takes no `press*` helper: it acts at release, and only consumeGesture comes from there', () => {
    const imports = /import \{([^}]*)\} from '\.\.\/panes\/press'/.exec(SOURCE);
    expect(imports?.[1]?.split(',').map((name) => name.trim())).toEqual(['consumeGesture']);
    expect(SOURCE).not.toMatch(/\bpress(?:Move|Click|Kbd|KbdMove)?\(/);
  });
});

describe('the stylesheet', () => {
  const decls = new Map<string, Map<string, string>>();
  parse(CSS).walkRules((rule) => {
    const held = decls.get(rule.selector) ?? new Map<string, string>();
    rule.walkDecls((d) => void held.set(d.prop, d.value.replace(/\s+/g, ' ').trim()));
    decls.set(rule.selector, held);
  });

  it('sizes every button one step below the control height: the extra-keys bar’s own key', () => {
    expect(decls.get('.rb-btn')?.get('height')).toBe('calc(var(--ctl-h) - var(--sp-1))');
    expect(INDEX_CSS).toMatch(/:root\[data-mobile='true'\]\s*{[^}]*--ctl-h:\s*36px/);
  });

  // The owner (2026-10-26): the review loses too much height on a phone. The bar was
  // 45px (a 36px button, 4px above and below, a hairline) beside an extra-keys bar of
  // 67px; it is one key row now, and no taller than that bar however it is counted.
  it('is no taller than the extra-keys bar it replaces, and one key row tall', () => {
    const scale = (name: string): number =>
      Number(new RegExp(`--${name}:\\s*(\\d+)px`).exec(INDEX_CSS)?.[1]);
    const ctl = Number(
      /:root\[data-mobile='true'\]\s*{[^}]*--ctl-h:\s*(\d+)px/.exec(INDEX_CSS)?.[1],
    );
    const button = ctl - scale('sp-1');
    const padding = decls.get('.review-bar')?.get('padding') ?? '';
    // `2px side calc(2px + safe-area)`: the vertical padding is the 2px either end.
    expect(padding).toMatch(
      /^2px var\(--sp-2\) calc\(2px \+ env\(safe-area-inset-bottom, 0px\)\)$/,
    );
    expect(decls.get('.review-bar')?.get('border-top')).toBe('1px solid var(--t-surface)');
    const bar = 1 + 2 + button + 2;
    expect(bar).toBe(37);
    const key = Number(/\.ek-key\s*{[^}]*min-height:\s*(\d+)px/.exec(INDEX_CSS)?.[1]);
    const rows = 2;
    // The extra-keys bar: its rows of keys and the hairline above them.
    expect(bar).toBeLessThanOrEqual(rows * key + 1);
    // And one key row of it (the key's hit area, a hairline, and the bar's 4px of padding).
    expect(bar).toBeLessThanOrEqual(key + 1 + 2 * 2);
    expect(button).toBeLessThanOrEqual(key);
  });

  it('sizes the buttons by content and an equal share of the rest', () => {
    expect(decls.get('.rb-btn')?.get('flex')).toBe('1 1 auto');
    expect(decls.get('.rb-btn')?.get('min-width')).toBe('0');
    expect(decls.get('.review-bar')?.get('display')).toBe('flex');
  });

  it('leaves every button its whole label and the 44px touch floor on a 390px phone', () => {
    const scale = (name: string): number =>
      Number(new RegExp(`--${name}:\\s*(\\d+)px`).exec(INDEX_CSS)?.[1]);
    const padding = scale('sp-2');
    const gap = scale('sp-1');
    expect(decls.get('.review-bar')?.get('padding')).toMatch(/^2px var\(--sp-2\)/);
    expect(decls.get('.review-bar')?.get('gap')).toBe('var(--sp-1)');
    expect(decls.get('.rb-btn')?.get('padding')).toBe('0 var(--sp-2)');
    expect(decls.get('.rb-btn')?.get('gap')).toBe('var(--sp-1)');

    // What `flex: 1 1 auto` does, modelled: each button is its content, then the
    // room left over is shared equally. A label is 7px a character at the 12px
    // semi-bold label, beside a 16px icon and the button's padding and 1px borders.
    const label = (text: string): number => (text ? 7 * text.length + gap : 0);
    // The labels, in order: the file list, the two arrows, Reviewed ("Unstage" is shorter).
    const content = ['Files', '', '', 'Reviewed'].map((text) => label(text) + 16 + 2 * padding + 2);
    const room = 390 - 2 * padding - 3 * gap;
    const used = content.reduce((sum, width) => sum + width, 0);
    // Everything fits at its own width…
    expect(used).toBeLessThanOrEqual(room);
    // …and after the leftover is shared, even the arrows clear the touch floor.
    const grown = content.map((width) => width + (room - used) / content.length);
    for (const width of grown) expect(width).toBeGreaterThanOrEqual(44);
  });

  it('takes no touch pan on a button: the bar reads the swipes itself', () => {
    expect(decls.get('.rb-btn')?.get('touch-action')).toBe('none');
  });

  it('is in normal flow, on the extra-keys bar’s own ground, so the review sits above it', () => {
    const bar = decls.get('.review-bar');
    expect(bar?.get('position')).toBeUndefined();
    expect(bar?.get('background')).toBe('var(--t-mantle)');
    expect(bar?.get('border-top')).toBe('1px solid var(--t-surface)');
    expect(bar?.get('flex')).toBe('0 0 auto');
  });

  it('holds no colour literal and reads only the eight tokens', () => {
    expect(CSS).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(CSS).not.toMatch(/\b(?:rgba?|hsla?)\(/i);
    const used = new Set([...CSS.matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map((m) => m[1]));
    const allowed =
      /^--(?:t-(?:base|mantle|surface|text|subtext|accent|accent-alt|accent-ink)|sp-\d|fs-\d|r-\d|ctl-h|mo-micro)$/;
    expect([...used].filter((name) => name === undefined || !allowed.test(name))).toEqual([]);
    expect(CSS).not.toMatch(/--t-crust\b/);
  });

  it('animates only on the micro tier, and the press itself is instant', () => {
    expect(decls.get('.rb-btn')?.get('transition')).toBe('background-color var(--mo-micro) ease');
    expect(decls.get('.rb-btn.pressed')?.get('transition-duration')).toBe('0ms');
  });

  it('keeps the keyboard’s focus ring', () => {
    expect(decls.get('.rb-btn:focus-visible')?.get('outline')).toMatch(/solid var\(--t-accent\)/);
    expect(CSS).not.toMatch(/outline:\s*(?:none|0)\b/);
  });
});
