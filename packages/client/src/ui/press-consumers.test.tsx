// The kit's pressed colour, held against a REAL consumer's stylesheets.
//
// ui.test.tsx reads ui.css on its own, where every :active rule follows the
// hover it overrides at equal specificity. A consumer that re-styles a kit
// button's hover is outside that file and can outrank it:
// `.dash-dock .dash-srow:not(:disabled):hover` is four classes to the ghost
// :active's three, so a held dashboard row kept its hover fill — and the fill is
// the kit's only press cue (it scales nothing), so the row showed no press at all.
// happy-dom does not cascade :hover or :active, so the cascade is resolved here:
// every rule of every stylesheet, matched against the rendered element with the
// pointer states stood in for by attributes, ranked by importance, specificity
// and source order.
//
// The last section holds the kit's own press consumer, Segmented's keepFocus
// press, to the gesture contract of panes/press.ts.

import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { act, createEvent, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { parse, type AtRule } from 'postcss';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardBody } from '../panes/DashboardBody';
import { Segmented } from './Segmented';

const SRC = join(__dirname, '..');

type Specificity = [number, number, number];

const LEGACY_PSEUDO_ELEMENTS = new Set(['before', 'after', 'first-line', 'first-letter']);

/** `a, b` split at the commas that separate selectors, not those inside `( )`. */
function splitSelectorList(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of list) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const higher = (a: Specificity, b: Specificity): number =>
  a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

const maxOf = (list: string): Specificity =>
  splitSelectorList(list)
    .map(specificity)
    .reduce((best, s) => (higher(s, best) > 0 ? s : best), [0, 0, 0] as Specificity);

/** Selectors Level 4 specificity: `:not/:is/:has` count their argument, `:where` nothing. */
function specificity(selector: string): Specificity {
  const s: Specificity = [0, 0, 0];
  const identEnd = (from: number): number => {
    let j = from;
    while (j < selector.length && /[\w-]/.test(selector[j] ?? '')) j += 1;
    return j;
  };
  let i = 0;
  while (i < selector.length) {
    const ch = selector[i] ?? '';
    if (ch === '#') {
      s[0] += 1;
      i = identEnd(i + 1);
    } else if (ch === '.') {
      s[1] += 1;
      i = identEnd(i + 1);
    } else if (ch === '[') {
      s[1] += 1;
      i = selector.indexOf(']', i) + 1;
    } else if (ch === ':') {
      const element = selector[i + 1] === ':';
      const nameStart = i + (element ? 2 : 1);
      i = identEnd(nameStart);
      const name = selector.slice(nameStart, i).toLowerCase();
      let arg = '';
      if (selector[i] === '(') {
        let depth = 0;
        const open = i;
        for (; i < selector.length; i += 1) {
          if (selector[i] === '(') depth += 1;
          else if (selector[i] === ')' && --depth === 0) break;
        }
        arg = selector.slice(open + 1, i);
        i += 1;
      }
      if (element || LEGACY_PSEUDO_ELEMENTS.has(name)) s[2] += 1;
      else if (name === 'not' || name === 'is' || name === 'has') {
        const [a, b, c] = maxOf(arg);
        s[0] += a;
        s[1] += b;
        s[2] += c;
      } else if (name !== 'where') s[1] += 1;
    } else if (/[a-z]/i.test(ch)) {
      s[2] += 1;
      i = identEnd(i);
    } else i += 1;
  }
  return s;
}

/** One declaration of the property under test, under one selector of a rule. */
interface Candidate {
  selector: string;
  /** The selector with :hover/:active turned into attributes the test can set. */
  simulated: string;
  specificity: Specificity;
  important: boolean;
  order: number;
  value: string;
  /** Inside `@media (prefers-reduced-motion: reduce)`. */
  reducedOnly: boolean;
  /** Inside any OTHER at-rule — not evaluated, but proven not to match. */
  excluded: boolean;
}

const simulate = (selector: string): string =>
  selector.replace(/:(hover|active|focus-visible|focus-within|focus)\b(?!-)/g, '[data-sim-$1]');

const stylesheets = (): string[] =>
  readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.css'))
    .map((f) => f.split(sep).join('/'))
    .toSorted();

/** Every `prop` declaration in `files`, in that load order. */
function candidates(files: string[], prop: RegExp = /^background(?:-color)?$/): Candidate[] {
  const out: Candidate[] = [];
  let order = 0;
  for (const file of files) {
    parse(readFileSync(join(SRC, file), 'utf8')).walkRules((rule) => {
      const atRules: AtRule[] = [];
      for (let p = rule.parent; p && p.type !== 'root'; p = p.parent) {
        if (p.type === 'atrule') atRules.push(p as AtRule);
      }
      if (atRules.some((a) => a.name.endsWith('keyframes'))) return;
      const reducedOnly = atRules.some(
        (a) => a.name === 'media' && /prefers-reduced-motion:\s*reduce/.test(a.params),
      );
      const excluded = atRules.length > (reducedOnly ? 1 : 0);
      rule.walkDecls(prop, (decl) => {
        order += 1;
        for (const selector of rule.selectors) {
          // A pseudo-element paints a box of its own, not the button's.
          if (/::|:(?:before|after)\b/.test(selector)) continue;
          out.push({
            selector,
            simulated: simulate(selector),
            specificity: specificity(selector),
            important: decl.important,
            order,
            value: decl.value,
            reducedOnly,
            excluded,
          });
        }
      });
    });
  }
  return out;
}

type PointerState = 'hover' | 'active';

/** Run `fn` with `el` (and, as in a browser, its ancestors) in `states`. */
function inState<T>(el: Element, states: PointerState[], fn: () => T): T {
  const chain: Element[] = [];
  for (let e: Element | null = el; e; e = e.parentElement) chain.push(e);
  for (const e of chain) for (const s of states) e.setAttribute(`data-sim-${s}`, '');
  try {
    return fn();
  } finally {
    for (const e of chain) for (const s of states) e.removeAttribute(`data-sim-${s}`);
  }
}

/** The declaration of `all` that wins on `el`, or null when none matches. */
function winner(
  el: Element,
  all: Candidate[],
  states: PointerState[],
  reduced: boolean,
): Candidate | null {
  return inState(el, states, () => {
    let best: Candidate | null = null;
    for (const c of all) {
      if (c.excluded || (c.reducedOnly && !reduced) || !el.matches(c.simulated)) continue;
      const rank = best
        ? Number(c.important) - Number(best.important) ||
          higher(c.specificity, best.specificity) ||
          c.order - best.order
        : 1;
      if (rank > 0) best = c;
    }
    return best;
  });
}

const fill = (c: Candidate | null): string => c?.value ?? '(none)';
const why = (c: Candidate | null): string => (c ? `${c.selector} { ${c.value} }` : '(none)');

describe('the cascade helper itself', () => {
  it('ranks selectors by Selectors Level 4 specificity', () => {
    expect(specificity('.dash-dock .dash-srow:not(:disabled):hover')).toEqual([0, 4, 0]);
    expect(specificity('.ui-btn-ghost:not(:disabled):active')).toEqual([0, 3, 0]);
    expect(specificity('.settings-form .field button:hover:not(:disabled)')).toEqual([0, 4, 1]);
    expect(specificity(":root[data-mobile='true'] #x a::before")).toEqual([1, 2, 2]);
    expect(specificity(':where(.a .b) .c:is(.d, #e)')).toEqual([1, 1, 0]);
  });
});

/** Every enabled kit button the body draws, with both disclosures open. */
const renderButtons = async (): Promise<HTMLElement[]> => {
  render(
    <DashboardBody
      webApps={[{ name: 'grafana', url: 'https://grafana.test' }]}
      quickLinks={[{ name: 'docs', url: 'https://docs.test' }]}
      onCreate={vi.fn()}
      onUpdateQuickLinks={vi.fn()}
    />,
  );
  await screen.findByTestId('dash-tmux-build');
  await screen.findByTestId('dash-port-5173');
  for (const id of ['dash-open-url', 'dash-open-markdown']) {
    const tile = screen.getByTestId(id);
    act(() => {
      fireEvent.pointerDown(tile);
      fireEvent.pointerUp(tile);
    });
  }
  return [...document.querySelectorAll<HTMLElement>('.ui-btn, .ui-icon-btn')].filter(
    (b) => !b.matches(':disabled'),
  );
};

describe('a kit button keeps its pressed colour inside DashboardBody', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => ({
        ok: true,
        status: 200,
        json: async () =>
          url === '/ports'
            ? { available: true, ports: [{ port: 5173, pid: 42, process: 'node' }] }
            : { available: true, sessions: [{ name: 'build', attached: true }] },
      })),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const files = stylesheets();
  const ORDERS: [string, string[]][] = [
    ['before every other stylesheet', ['ui/ui.css', ...files.filter((f) => f !== 'ui/ui.css')]],
    ['after every other stylesheet', [...files.filter((f) => f !== 'ui/ui.css'), 'ui/ui.css']],
  ];

  it.each(ORDERS)(
    'shows a pressed fill distinct from hover and from rest, ui.css loaded %s',
    async (_, order) => {
      const all = candidates(order);
      const buttons = await renderButtons();
      const rows = buttons.filter((b) => b.classList.contains('dash-srow'));
      // Rot guards: the rows are the consumer this exists for, and a matcher that
      // never matched `:not(:disabled)` would make every fill '(none)' and pass.
      expect(rows.map((r) => r.dataset['testid'])).toEqual([
        'dash-tmux-new',
        'dash-tmux-build',
        'dash-port-5173',
        'dash-webapp-grafana',
        'dash-link-docs',
      ]);
      expect(buttons.length).toBeGreaterThanOrEqual(rows.length + 7);
      const primary = screen.getByTestId('dash-new-terminal');
      expect(winner(primary, all, ['hover', 'active'], false)?.selector).toBe(
        '.ui-btn-primary:not(:disabled):active',
      );

      for (const button of buttons) {
        const name = button.dataset['testid'] ?? button.className;
        const pressed = winner(button, all, ['hover', 'active'], false);
        for (const reduced of [false, true]) {
          const mode = reduced ? 'reduced motion' : 'full motion';
          const held = winner(button, all, ['hover', 'active'], reduced);
          const hovered = winner(button, all, ['hover'], reduced);
          // A touch press need not carry :hover, so pressed is also held against rest.
          const tapped = winner(button, all, ['active'], reduced);
          const rest = winner(button, all, [], reduced);
          expect(fill(held), `${name}, held, ${mode}: ${why(held)} vs ${why(hovered)}`).not.toBe(
            fill(hovered),
          );
          expect(fill(tapped), `${name}, tapped, ${mode}: ${why(tapped)} vs ${why(rest)}`).not.toBe(
            fill(rest),
          );
          // The colour is the whole press, so the motion setting must not change it.
          expect(fill(held), `${name}, ${mode}`).toBe(fill(pressed));
        }
      }
    },
  );

  // The create row is the one accent row, and the ghost :active's own text
  // colour must not wash that out for as long as a finger holds it.
  it.each(ORDERS)(
    'keeps the create row accent in every pointer state, ui.css loaded %s',
    async (_, order) => {
      const colours = candidates(order, /^color$/);
      await renderButtons();
      const row = screen.getByTestId('dash-tmux-new');
      for (const states of [[], ['hover'], ['active'], ['hover', 'active']] as PointerState[][]) {
        expect(fill(winner(row, colours, states, true)), states.join('+') || 'rest').toBe(
          'var(--t-accent)',
        );
      }
    },
  );

  // The hit-area guard across EVERY stylesheet, on the buttons that need it: these
  // rows press through pressKbdMove, which cancels its gesture on pointerleave, so a
  // held row that shrank (or slid) out from under the finger acted on nothing.
  it.each(ORDERS)(
    'moves no held kit button off its rest box, ui.css loaded %s',
    async (_, order) => {
      const transforms = candidates(order, /^(?:transform|scale|translate|rotate)$/);
      const box = (c: Candidate | null): string => (c && c.value !== 'none' ? why(c) : 'none');
      const buttons = await renderButtons();
      for (const button of buttons) {
        const name = button.dataset['testid'] ?? button.className;
        for (const reduced of [false, true]) {
          const mode = reduced ? 'reduced motion' : 'full motion';
          const rest = box(winner(button, transforms, [], reduced));
          expect(
            box(winner(button, transforms, ['hover', 'active'], reduced)),
            `${name}, ${mode}`,
          ).toBe(rest);
          expect(box(winner(button, transforms, ['active'], reduced)), `${name}, ${mode}`).toBe(
            rest,
          );
        }
      }
    },
  );

  it('excludes no at-rule that could restyle these buttons', async () => {
    const outside = candidates(files).filter((c) => c.excluded);
    const buttons = await renderButtons();
    const reaching = outside.filter((c) =>
      buttons.some((b) => inState(b, ['hover', 'active'], () => b.matches(c.simulated))),
    );
    expect(reaching.map(why)).toEqual([]);
  });
});

// ── Segmented's keepFocus press marks its gesture ─────────────────────────────
//
// The drawer's view switcher selects on pointerdown, and selecting swaps the
// drawer's whole body, so the tap's compatibility mousedown, mouseup and click
// land on whatever the new view drew under the finger. The mousedown would move
// focus off `#mobile-kbd` and dismiss the soft keyboard; the click would press
// the newcomer. The press therefore marks its gesture, as `pressClick` does.

const touch = { pointerId: 1, pointerType: 'touch' };

/** A keepFocus switcher whose second view draws a plain button under the finger. */
const renderSwitcher = () => {
  const newcomer = { click: vi.fn(), mouseDown: vi.fn() };
  const onValueChange = vi.fn();
  const Switcher = () => {
    const [view, setView] = useState<'a' | 'b'>('a');
    return (
      <>
        <Segmented
          keepFocus
          label="View"
          value={view}
          onValueChange={(next) => {
            onValueChange(next);
            setView(next);
          }}
          options={[
            { value: 'a', label: 'A' },
            { value: 'b', label: 'B' },
          ]}
        />
        {view === 'b' && (
          <button data-testid="newcomer" onClick={newcomer.click} onMouseDown={newcomer.mouseDown}>
            new
          </button>
        )}
      </>
    );
  };
  render(<Switcher />);
  return { newcomer, onValueChange };
};

/** The rest of a touch tap whose pointerdown already acted, landing on `el`. */
const finishTapOn = (el: HTMLElement, pointer = touch) => {
  fireEvent.pointerUp(el, pointer);
  const down = createEvent.mouseDown(el, { detail: 1, cancelable: true });
  fireEvent(el, down);
  if (!down.defaultPrevented) el.focus(); // the focus move a mousedown makes
  fireEvent.mouseUp(el, { detail: 1 });
  fireEvent.click(el, { detail: 1 });
};

describe('Segmented keepFocus marks its gesture', () => {
  afterEach(() => {
    document.getElementById('mobile-kbd')?.remove();
    // A press whose click a test never sent leaves its mark armed; a key ends it.
    fireEvent.keyDown(document);
  });

  it('the tap reaches nothing the new view put under the finger, and keeps #mobile-kbd', () => {
    const kbd = document.createElement('textarea');
    kbd.id = 'mobile-kbd';
    document.body.append(kbd);
    kbd.focus();
    const { newcomer, onValueChange } = renderSwitcher();

    fireEvent.pointerDown(screen.getByTestId('ui-segmented-b'), touch);
    expect(onValueChange).toHaveBeenCalledWith('b');
    finishTapOn(screen.getByTestId('newcomer'));

    expect(newcomer.mouseDown).not.toHaveBeenCalled();
    expect(newcomer.click).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(kbd);
  });

  it('a later, separate tap on the newcomer reaches it', () => {
    const { newcomer } = renderSwitcher();
    fireEvent.pointerDown(screen.getByTestId('ui-segmented-b'), touch);
    finishTapOn(screen.getByTestId('newcomer'));

    const next = screen.getByTestId('newcomer');
    fireEvent.pointerDown(next, touch);
    finishTapOn(next);
    expect(newcomer.mouseDown).toHaveBeenCalledTimes(1);
    expect(newcomer.click).toHaveBeenCalledTimes(1);
  });

  // A key, assistive tech or `click()` reaches a segment as a click with no count.
  it('still selects on a click with no count while a press is marked', () => {
    const { onValueChange } = renderSwitcher();
    fireEvent.pointerDown(screen.getByTestId('ui-segmented-b'), touch); // released later
    act(() => screen.getByTestId('ui-segmented-a').click());
    expect(onValueChange).toHaveBeenLastCalledWith('a');
  });

  // The mouse takes the same path. A browser may follow a prevented pointerdown
  // with a mousedown anyway, and the mark has to cancel its focus move too.
  it('a mouse press keeps #mobile-kbd and reaches nothing the new view drew', () => {
    const mouse = { pointerId: 1, pointerType: 'mouse' };
    const kbd = document.createElement('textarea');
    kbd.id = 'mobile-kbd';
    document.body.append(kbd);
    kbd.focus();
    const { newcomer, onValueChange } = renderSwitcher();

    fireEvent.pointerDown(screen.getByTestId('ui-segmented-b'), mouse);
    finishTapOn(screen.getByTestId('newcomer'), mouse);

    expect(onValueChange).toHaveBeenCalledTimes(1);
    expect(newcomer.mouseDown).not.toHaveBeenCalled();
    expect(newcomer.click).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(kbd);
  });
});

// ── A segment that stays under the finger ─────────────────────────────────────
//
// In the drawer the switcher is not replaced by its own selection: the body above
// it is. So the tap's mouse events and click land on the SAME segment, whose own
// Radix click handler selects. A parent that has not applied the change yet (or
// that refuses it) shows what that costs: a second `onValueChange` for one tap.

/** A keepFocus switcher whose parent never changes the value, and a bystander. */
const renderRefusing = () => {
  const onValueChange = vi.fn();
  const bystander = vi.fn();
  render(
    <>
      <Segmented
        keepFocus
        label="View"
        value="a"
        onValueChange={onValueChange}
        options={[
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' },
          { value: 'c', label: 'C', disabled: true },
        ]}
      />
      <button data-testid="bystander" onClick={bystander}>
        bystander
      </button>
    </>,
  );
  return { onValueChange, bystander };
};

describe('Segmented keepFocus selects once per gesture', () => {
  afterEach(() => {
    fireEvent.keyDown(document); // ends a mark a test left armed
  });

  it.each(['touch', 'mouse'])(
    'a %s press selects once, however its own click lands on the same segment',
    (pointerType) => {
      const { onValueChange } = renderRefusing();
      const pointer = { pointerId: 1, pointerType };
      const segment = screen.getByTestId('ui-segmented-b');

      // Selecting on pointerdown only keeps the keyboard if the press is prevented.
      const down = createEvent.pointerDown(segment, { ...pointer, cancelable: true });
      fireEvent(segment, down);
      expect(down.defaultPrevented).toBe(true);

      finishTapOn(segment, pointer);
      expect(onValueChange).toHaveBeenCalledTimes(1);
      expect(onValueChange).toHaveBeenCalledWith('b');
    },
  );

  it.each([
    ['Enter', '{Enter}'],
    ['Space', ' '],
  ])('%s on a focused segment selects once', async (_, keys) => {
    const { onValueChange } = renderRefusing();
    act(() => screen.getByTestId('ui-segmented-b').focus());
    await userEvent.setup().keyboard(keys);
    expect(onValueChange).toHaveBeenCalledTimes(1);
    expect(onValueChange).toHaveBeenCalledWith('b');
  });

  it('an assistive-tech click on a segment selects once', () => {
    const { onValueChange } = renderRefusing();
    act(() => screen.getByTestId('ui-segmented-b').click());
    expect(onValueChange).toHaveBeenCalledTimes(1);
  });

  // A disabled segment acts on nothing, so it must not mark a gesture: the click
  // after it is a press on something else.
  it('a press on a disabled segment selects nothing and swallows no click', () => {
    const { onValueChange, bystander } = renderRefusing();
    const disabled = screen.getByTestId('ui-segmented-c');

    fireEvent.pointerDown(disabled, touch);
    fireEvent.pointerUp(disabled, touch);
    fireEvent.click(screen.getByTestId('bystander'), { detail: 1 });

    expect(onValueChange).not.toHaveBeenCalled();
    expect(bystander).toHaveBeenCalledTimes(1);
  });

  // Not a keepFocus switcher: pointerdown is not a selection there, and it must
  // not mark a gesture either, or the normal click that selects would be eaten.
  it('without keepFocus a press selects on its click and marks nothing', () => {
    const onValueChange = vi.fn();
    render(
      <Segmented
        label="View"
        value="a"
        onValueChange={onValueChange}
        options={[
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' },
        ]}
      />,
    );
    const segment = screen.getByTestId('ui-segmented-b');
    fireEvent.pointerDown(segment, touch);
    fireEvent.pointerUp(segment, touch);
    expect(onValueChange).not.toHaveBeenCalled();
    fireEvent.click(segment, { detail: 1 });
    expect(onValueChange).toHaveBeenCalledTimes(1);
  });
});
