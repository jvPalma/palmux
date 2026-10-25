// The mobile drawer: row anatomy, the gestures on a row (tap, long-press menu,
// long-press drag, swipe-left Close), the thumb-reach layout, the scrim and its
// motion, and the leaving rows. Nothing here loads a stylesheet into the DOM
// (happy-dom resolves no cascade), so what the CSS promises is read as text.

import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { parse } from 'postcss';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TabGroup, TabMeta } from '@palmux/shared';
import { SessionDrawer } from './SessionDrawer';
import { tabColorInk, tabColorValue } from './tab-meta';
import { TabSheet } from './TabSheet';
import { DEFAULTS } from '../settings/settings';
import {
  applyThemeTokens,
  COLOR_PROFILES,
  deriveUiTokens,
  getProfile,
  luminance,
  mix,
} from '../settings/themes';
import { Button, IconButton, Input, Segmented, Select } from '../ui';
import { Icon } from '../ui/icons';

// Controls inside the scrolling list activate on pointer UP (with a movement
// check), so a press is down THEN up. Fixed chrome still fires on down.
const tap = (el: Element) => {
  fireEvent.pointerDown(el);
  fireEvent.pointerUp(el);
};

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select, textarea, a[href], [tabindex]';

/**
 * A whole pointer press the way a browser delivers it, focus moves included,
 * which fireEvent alone does not model. A mouse fires its mousedown right after
 * pointerdown and a touch only after pointerup, and that mousedown moves focus to
 * the focusable control it lands in (or off everything, onto the body) unless it
 * is cancelled. A cancelled pointerdown sends no mousedown or mouseup at all. A
 * touch pointerup goes where the pointerdown went (touch is captured
 * implicitly); everything after it is hit-tested when it happens, so it lands on
 * whatever is there by then, which here is the pressed element if it is still in
 * the document, else the body. Answers whether the pointerdown was left alone,
 * which is what lets a list pan.
 */
const browserPress = (el: Element, pointerType: 'touch' | 'mouse'): boolean => {
  const at = { pointerId: 9, pointerType, clientX: 40, clientY: 40 };
  const mouse = { clientX: 40, clientY: 40, detail: 1 };
  const under = () => (el.isConnected ? el : document.body);
  const mouseDown = () => {
    const target = under();
    if (!fireEvent.mouseDown(target, mouse)) return;
    const into = target.closest<HTMLElement>(FOCUSABLE);
    if (into) into.focus();
    else if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  };
  const compat = fireEvent.pointerDown(el, at);
  if (compat && pointerType === 'mouse') mouseDown();
  fireEvent.pointerUp(pointerType === 'touch' ? el : under(), at);
  if (compat && pointerType === 'touch') mouseDown();
  if (compat) fireEvent.mouseUp(under(), mouse);
  fireEvent.click(under(), mouse);
  return compat;
};

const settingsBack = () => screen.getByTestId('drawer-settings-back');
const inThemes = () => screen.queryByTestId('theme-browser') !== null;
const inSettings = () => screen.queryByTestId('drawer-settings-body') !== null;
const user = () => userEvent.setup();
/** Press Tab (or Shift+Tab) until `el` holds focus: the keyboard's own way there. */
const tabTo = async (el: HTMLElement, shift = false): Promise<void> => {
  const u = user();
  // oxlint-disable-next-line no-await-in-loop -- each Tab starts where the last one left focus
  for (let i = 0; i < 40 && document.activeElement !== el; i++) await u.tab({ shift });
  expect(document.activeElement).toBe(el);
};

/** The drawn shapes of a registered icon, for comparing against what a control
 *  rendered. Rendered into a detached node so `screen` never sees it. */
const iconPaths = (name: string): string | undefined => {
  const host = document.createElement('div');
  render(<Icon name={name} />, { container: host });
  return host.querySelector('svg')?.innerHTML;
};

const INDEX_CSS = readFileSync(join(__dirname, '../index.css'), 'utf8');
const VIEWS_CSS = readFileSync(join(__dirname, 'drawer-views.css'), 'utf8');
const UI_CSS = readFileSync(join(__dirname, '../ui/ui.css'), 'utf8');

/** What `selector` declares, later declarations winning; `media` reads the rules inside at-rules instead. */
const declsOf = (css: string, selector: string, media = false): Map<string, string> => {
  const merged = new Map<string, string>();
  parse(css).walkRules((rule) => {
    if ((rule.parent?.type === 'atrule') !== media) return;
    if (!rule.selectors.some((s) => s.replace(/\s+/g, ' ').trim() === selector)) return;
    rule.walkDecls((d) => void merged.set(d.prop, d.value.replace(/\s+/g, ' ').trim()));
  });
  return merged;
};

const TABS: TabMeta[] = [
  { id: '0', kind: 'terminal', title: 'vim' },
  { id: '1', kind: 'web', url: 'https://sb.local', name: 'SB', color: 'teal' },
];

const GROUPED_TABS: TabMeta[] = [
  { id: '0', kind: 'terminal', title: 'vim', groupId: 'g1' },
  { id: '1', kind: 'web', url: 'https://sb.local', name: 'SB', color: 'teal' },
];

const GROUPS: TabGroup[] = [{ id: 'g1', name: 'dev', color: 'ansi3' }];

/** Props for a drawer over `TABS`, every callback a spy; `overrides` replace any of them. */
const baseProps = (overrides: Partial<Parameters<typeof SessionDrawer>[0]> = {}) => ({
  open: true,
  tabs: TABS,
  current: '0',
  onSwitch: vi.fn(),
  onCreate: vi.fn(),
  onKill: vi.fn(),
  onClose: vi.fn(),
  onTabMenu: vi.fn(),
  onMoveTab: vi.fn(),
  onMoveGroup: vi.fn(),
  actions: {
    uploadFile: vi.fn(() => false),
    uploadImages: vi.fn(() => false),
    downloadFile: vi.fn(),
    dictate: vi.fn(),
  },
  settings: DEFAULTS,
  onChangeSettings: vi.fn(),
  ...overrides,
});

const renderDrawer = (overrides: Partial<Parameters<typeof SessionDrawer>[0]> = {}) => {
  const props = baseProps(overrides);
  render(<SessionDrawer {...props} />);
  return props;
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
// A press marks its gesture for up to a second after it lets go, and the fake
// clock restarts every test, so a mark one test leaves can still be live in the
// next and swallow its first click. A keydown clears it.
afterEach(() => void fireEvent.keyDown(document));

describe('rows', () => {
  const row = (id: string) => screen.getByTestId(`drawer-session-${id}`);

  // dot · title · number, and the kind icon only where it says something.
  it('draw a dot, the title and the number; a non-terminal also draws its kind icon', () => {
    renderDrawer();
    const kindMark = (id: string) => row(id).querySelector('.drawer-session-id svg')?.innerHTML;
    // A terminal is the prompt every row would repeat, so it carries none.
    expect(kindMark('0')).toBeUndefined();
    expect(kindMark('1')).toBe(iconPaths('globe'));
    expect(row('0')).toHaveTextContent('vim');
    expect(row('1')).toHaveTextContent('SB');
    for (const id of ['0', '1']) expect(row(id).querySelector('.drawer-dot')).not.toBeNull();
  });

  it('shows the tab number as secondary text at the row end, on every row', () => {
    renderDrawer();
    for (const id of ['0', '1']) {
      const num = screen.getByTestId(`drawer-num-${id}`);
      expect(num).toHaveTextContent(new RegExp(`^${id}$`));
      expect(num.className).toBe('drawer-num');
      // After the title in the DOM, which is what puts it at the right.
      const title = row(id).querySelector('.drawer-session-title')!;
      expect(title.compareDocumentPosition(num) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it('has no numbered circle, no per-row terminal prompt and no always-visible close cell', () => {
    renderDrawer();
    // The number is text now: no fill, no round box, the subdued colour and size.
    const num = declsOf(INDEX_CSS, '.drawer-num');
    expect(num.get('background')).toBeUndefined();
    expect(num.get('border-radius')).toBeUndefined();
    expect(num.get('color')).toBe('var(--t-subtext)');
    expect(num.get('font-size')).toBe('var(--fs-1)');
    expect(screen.queryByTestId('drawer-kill-0')).toBeNull();
    expect(screen.queryByTestId('drawer-kill-1')).toBeNull();
    expect(document.querySelector('.drawer-kill')).toBeNull();
    // A tab's Close exists, but only behind the row, and it is out of the tab order.
    for (const id of ['0', '1']) {
      const close = screen.getByTestId(`drawer-row-close-${id}`);
      expect(close).toHaveAttribute('aria-hidden', 'true');
      expect(close).toHaveAttribute('tabindex', '-1');
    }
  });

  it('paints a coloured tab on its dot only: the row sets --tab-accent and nothing fills with it', () => {
    renderDrawer({ current: '1' });
    const coloured = row('1').closest('.drawer-row') as HTMLElement;
    expect(coloured).toHaveClass('active');
    expect(coloured.style.getPropertyValue('--tab-accent')).toBe('var(--tab-c-ansi6)');
    // The uncoloured tab sets nothing, so its dot falls back to the neutral.
    const plain = row('0').closest('.drawer-row') as HTMLElement;
    expect(plain.style.getPropertyValue('--tab-accent')).toBe('');
    // happy-dom resolves no cascade: the rules that decide where the colour goes are read.
    const active = declsOf(INDEX_CSS, '.drawer-row.active .drawer-session');
    expect(active.get('background')).toBe('var(--pill-fill)');
    for (const decl of active.values()) expect(decl).not.toContain('--tab-accent');
    expect(declsOf(INDEX_CSS, '.drawer-row.active').get('--ring')).toBe('var(--pill-ring)');
    expect(declsOf(INDEX_CSS, '.drawer-session .drawer-dot').get('background')).toBe(
      'var(--tab-accent, var(--t-subtext))',
    );
  });

  it('tap switches and closes the drawer', () => {
    const p = renderDrawer();
    tap(row('1'));
    expect(p.onSwitch).toHaveBeenCalledWith('1');
    expect(p.onClose).toHaveBeenCalled();
    expect(p.onTabMenu).not.toHaveBeenCalled();
  });

  // A keyboard or assistive-tech activation is a click with no pointer press behind
  // it (detail 0); a pointer press's own trailing click carries a count.
  it('answers a click with no pointer press (Enter, Space, assistive tech), once', () => {
    const p = renderDrawer();
    fireEvent.click(row('1'));
    expect(p.onSwitch).toHaveBeenCalledTimes(1);
    expect(p.onClose).toHaveBeenCalledTimes(1);
  });

  it('does not count a pointer press’s own trailing click as a second activation', () => {
    const p = renderDrawer();
    tap(row('1'));
    fireEvent.click(row('1'), { detail: 1 });
    expect(p.onSwitch).toHaveBeenCalledTimes(1);
  });

  it('the New tab button opens the new-tab flow', () => {
    const p = renderDrawer();
    const button = screen.getByTestId('drawer-new');
    expect(button.querySelector('svg')?.innerHTML).toBe(iconPaths('plus'));
    expect(button).toHaveTextContent(/^New tab$/);
    tap(button);
    expect(p.onCreate).toHaveBeenCalled();
  });

  it('group header gets member-active when the current tab is a member', () => {
    renderDrawer({ tabs: GROUPED_TABS, groups: GROUPS, current: '0' });
    expect(screen.getByTestId('drawer-group-g1')).toHaveClass('member-active');
  });

  it('group header omits member-active when the current tab is not a member', () => {
    renderDrawer({ tabs: GROUPED_TABS, groups: GROUPS, current: '1' });
    expect(screen.getByTestId('drawer-group-g1')).not.toHaveClass('member-active');
  });

  // The ▸ / ▾ pair is a chevron icon now, and it is still the open/closed cue:
  // right while the group is collapsed, down while it is open.
  it('group caret points right when collapsed and down when open', () => {
    const caret = () =>
      screen.getByTestId('drawer-group-g1').querySelector('.drawer-group-caret svg')?.innerHTML;
    renderDrawer({ tabs: GROUPED_TABS, groups: GROUPS, current: '1' });
    expect(caret()).toBe(iconPaths('chevron-down'));
    cleanup();
    renderDrawer({
      tabs: GROUPED_TABS,
      groups: GROUPS,
      current: '1',
      collapsed: new Set(['g1']),
    });
    expect(caret()).toBe(iconPaths('chevron-right'));
  });

  // The header keeps its four parts, and its type is the one the app's section titles
  // share: compared with the kit's own rule, so the two cannot drift apart unseen.
  // A filled chip carries the group's colour by being filled, so a dot on it would be
  // the same colour as its own ground.
  it('draws a group header as a chip: caret, label and member count, and no dot', () => {
    renderDrawer({
      tabs: [...GROUPED_TABS, { id: '2', kind: 'terminal', groupId: 'g1' }],
      groups: GROUPS,
      current: '1',
    });
    const header = screen.getByTestId('drawer-group-g1');
    expect(header.querySelector('.drawer-group-caret svg')).not.toBeNull();
    expect(header.querySelector('.drawer-dot')).toBeNull();
    expect(header.querySelector('.drawer-group-label')).toHaveTextContent(/^dev$/);
    expect(header.querySelector('.drawer-group-count')).toHaveTextContent(/^2$/);
  });

  it('names an unnamed group "group" rather than drawing an empty label', () => {
    renderDrawer({ tabs: GROUPED_TABS, groups: [{ id: 'g1', color: 'ansi3' }], current: '1' });
    expect(
      screen.getByTestId('drawer-group-g1').querySelector('.drawer-group-label'),
    ).toHaveTextContent(/^group$/);
  });

  it('wears the section-title type of the kit’s own headings', () => {
    const kit = declsOf(UI_CSS, '.ui-collapsible-trigger');
    const own = declsOf(INDEX_CSS, '.drawer-group');
    for (const prop of ['font-size', 'font-weight', 'letter-spacing', 'text-transform']) {
      expect(own.get(prop), prop).toBeDefined();
      expect(own.get(prop), prop).toBe(kit.get(prop));
    }
    // The one deliberate difference: the chip is a filled surface, so its text is the
    // group's ink rather than the kit's secondary colour (see 'pill rows' below).
    expect(own.get('color')).toBe('var(--group-ink)');
  });
});

// ── Rows as pills, groups as framed clusters ──────────────────────────────────
// ui-rework batch 6: the desktop strip's pills, in the drawer's vertical list. happy-dom
// resolves no cascade, so the look is read off the stylesheet and the frame off the classes
// each leaf carries.

/**
 * Every rule with a selector `test` accepts, each with its declarations: `hits` are the
 * selectors of the rule that matched, `selectors` every selector of its list.
 */
const rulesWhere = (css: string, test: (selector: string) => boolean) => {
  const found: { hits: string[]; selectors: string[]; decls: Map<string, string> }[] = [];
  parse(css).walkRules((rule) => {
    const selectors = rule.selectors.map((s) => s.replace(/\s+/g, ' ').trim());
    const hits = selectors.filter(test);
    if (hits.length === 0) return;
    const decls = new Map<string, string>();
    rule.walkDecls((d) => void decls.set(d.prop, d.value.replace(/\s+/g, ' ').trim()));
    found.push({ hits, selectors, decls });
  });
  return found;
};

/** A rule the drawer's rows own: not the list host, which is where the shared tokens live. */
const ownsRow = (s: string): boolean =>
  /\.drawer-(row|session|group|leaf)/.test(s) && s !== '.drawer-sessions';

/** The element a selector styles: its last compound. */
const subjectOf = (selector: string): string => selector.split(/\s+/).at(-1) ?? '';

describe('pill rows: the stylesheet', () => {
  const PILL_TOKENS = [
    '--pill-border',
    '--pill-fill',
    '--pill-ring',
    '--pill-text',
    '--cluster-pad',
  ];

  // One declaration for both hosts, so the list cannot drift from the strip.
  it('declares the pill tokens once, for the strip and for the list', () => {
    const declaring = rulesWhere(INDEX_CSS, () => true).filter((r) => r.decls.has('--pill-border'));
    expect(declaring).toHaveLength(1);
    expect(declaring[0]?.selectors.join(', ')).toBe('.session-tabs, .drawer-sessions, .drawer-top');
    for (const token of PILL_TOKENS) {
      expect(declsOf(INDEX_CSS, '.drawer-sessions').get(token), token).toBeDefined();
      expect(declsOf(INDEX_CSS, '.drawer-sessions').get(token), token).toBe(
        declsOf(INDEX_CSS, '.session-tabs').get(token),
      );
    }
  });

  it('draws a row as a pill: the strip’s border, radius and text, opaque at rest', () => {
    const rest = declsOf(INDEX_CSS, '.drawer-session');
    expect(rest.get('border')).toBe('1px solid var(--pill-border)');
    expect(rest.get('border-radius')).toBe('var(--r-2)');
    expect(rest.get('color')).toBe('var(--pill-text)');
    expect(rest.get('min-height')).toBe('var(--ctl-h)');
    // Opaque, because the swipe's Close waits behind it; the drawer's own ground, so no fill shows.
    expect(rest.get('background')).toBe('var(--t-mantle)');
    expect(declsOf(INDEX_CSS, '.drawer').get('background')).toBe('var(--t-mantle)');
  });

  it('raises the active row with the strip’s fill and ring, at full text and weight 600', () => {
    const active = declsOf(INDEX_CSS, '.drawer-row.active .drawer-session');
    expect(active.get('background')).toBe('var(--pill-fill)');
    expect(active.get('color')).toBe('var(--t-text)');
    expect(active.get('font-weight')).toBe('600');
    expect(declsOf(INDEX_CSS, '.drawer-row.active').get('--ring')).toBe('var(--pill-ring)');
    // The ring is a layer of the pill's shadow, composed with the lift's.
    expect(declsOf(INDEX_CSS, '.drawer-session').get('box-shadow')).toMatch(/var\(--ring/);
  });

  it('restates no colour mix of the pill tokens in a row rule', () => {
    for (const selector of [
      '.drawer-session',
      '.drawer-row.active',
      '.drawer-row.active .drawer-session',
    ]) {
      for (const [prop, value] of declsOf(INDEX_CSS, selector)) {
        expect(value, `${selector} { ${prop} }`).not.toContain('color-mix(');
      }
    }
    // Nothing of the drawer redeclares them; the one declaration is the shared host rule.
    for (const { hits, decls } of rulesWhere(INDEX_CSS, ownsRow)) {
      for (const token of PILL_TOKENS) expect(decls.has(token), `${hits} ${token}`).toBe(false);
    }
  });

  // Colour appears in the dot and nowhere else on a row; the old edge is gone.
  it('draws no accent edge on a row, active or not, and no spine on a member', () => {
    for (const { hits, decls } of rulesWhere(INDEX_CSS, (s) =>
      /\.drawer-(row|session|group)/.test(s),
    )) {
      for (const [prop, value] of decls) {
        expect(`${hits} { ${prop}: ${value} }`).not.toMatch(/inset 3px 0 0/);
      }
    }
    expect(declsOf(INDEX_CSS, '.drawer-row.active .drawer-session').has('box-shadow')).toBe(false);
    expect(declsOf(INDEX_CSS, '.drawer-row.grouped').size).toBe(0);
  });

  // The ring is outset, and the clip cuts whatever leaves its box: the room is the clip's
  // own side padding, and the row's own margin above and below.
  it('leaves the ring room inside the clip on all four sides', () => {
    const clip = declsOf(INDEX_CSS, '.drawer-leaf-inner');
    expect(clip.get('overflow')).toBe('hidden');
    expect(clip.get('padding-inline')).toBe('var(--cluster-pad)');
    expect(declsOf(INDEX_CSS, '.drawer-row').get('margin-block')).toBe('calc(var(--sp-1) / 2)');
    // 1.5px of ring fits in 2px of room, and two halves make the row gap.
    expect(declsOf(INDEX_CSS, '.drawer-sessions').get('--cluster-pad')).toBe('2px');
  });

  it('keeps the pressed, armed, lifted and drop states apart from the active ring', () => {
    expect(declsOf(INDEX_CSS, '.drawer-session:active').get('background')).toBe('var(--t-surface)');
    expect(declsOf(INDEX_CSS, '.drawer-row.armed .drawer-session').get('background')).toBe(
      'var(--t-surface)',
    );
    // The lift is a shadow, held in --lift so an active row keeps its ring while lifted.
    expect(declsOf(INDEX_CSS, '.drawer-row.lifted').get('--lift')).toMatch(/^0 4px 12px /);
    expect(declsOf(INDEX_CSS, '.drawer-row.lifted .drawer-session').get('transition')).toBe('none');
    // A drop on a header is a ring of the accent over the chip, with the chip's ink inside it.
    const drop = declsOf(INDEX_CSS, '.drawer-row.drop-inside').get('--ring');
    expect(drop).toContain('var(--t-accent)');
    expect(drop).toContain('var(--group-ink)');
    expect(declsOf(INDEX_CSS, '.drawer-row.drop-inside .drawer-group').has('background')).toBe(
      false,
    );
  });
});

describe('framed groups: the stylesheet', () => {
  const POSITIONS = ['group-first', 'group-mid', 'group-last', 'group-bridge'] as const;
  const BORDER = /^border(?!-radius)/;

  // B6-03: a drag translates and scales the row, so a segment on it would leave a hole.
  // The leaf holds the slot still, and it is the one box as tall as the slot at every
  // moment: its grid item (.drawer-leaf-inner) is shorter than it while a track runs
  // between 1fr and 0fr, which opened the frame between the rows either side of an enter
  // or a leave when the segments were drawn on it. happy-dom has no layout, so this pins
  // where the segments are, and the smoke screenshots pin that it works.
  it('draws every frame segment on the stationary leaf, never on the row or its clip', () => {
    for (const position of POSITIONS) {
      const rules = rulesWhere(INDEX_CSS, (s) => s.includes(position));
      expect(rules.length, position).toBeGreaterThan(0);
    }
    for (const { hits, decls } of rulesWhere(INDEX_CSS, (s) =>
      /group-(first|mid|last|bridge)/.test(s),
    )) {
      for (const [prop, value] of decls) {
        if (!BORDER.test(prop) && !prop.includes('radius')) continue;
        for (const hit of hits) {
          expect(subjectOf(hit), `${hit} { ${prop}: ${value} }`).toMatch(
            /^\.drawer-leaf\.group-(first|mid|last|bridge)$/,
          );
        }
      }
    }
    for (const { hits, decls } of rulesWhere(INDEX_CSS, (s) => subjectOf(s) === '.drawer-row')) {
      for (const prop of decls.keys()) {
        expect(prop, `${hits}`).not.toMatch(/^border-(left|right|top|bottom)/);
      }
    }
    // The clip carries no border at all: it is the grid item that runs shorter than the slot.
    for (const prop of declsOf(INDEX_CSS, '.drawer-leaf-inner').keys()) {
      expect(prop, '.drawer-leaf-inner').not.toMatch(/^border/);
    }
  });

  it('gives first, mid, last and bridge both sides, and only first and last an end', () => {
    const sides = (position: string) => declsOf(INDEX_CSS, `.drawer-leaf.${position}`);
    // One rule carries the side colour for all four positions.
    const sideRule = rulesWhere(INDEX_CSS, (s) => s.includes('group-bridge')).find((r) =>
      r.decls.has('border-left-color'),
    );
    expect(sideRule?.decls.get('border-left-color')).toBe('var(--group-frame)');
    expect(sideRule?.decls.get('border-right-color')).toBe('var(--group-frame)');
    for (const position of POSITIONS) {
      expect(sideRule?.selectors.join(', '), position).toContain(position);
    }
    expect(sides('group-first').get('border-top')).toBe('1px solid var(--group-frame)');
    expect(sides('group-first').has('border-bottom')).toBe(false);
    expect(sides('group-last').get('border-bottom')).toBe('1px solid var(--group-frame)');
    expect(sides('group-last').has('border-top')).toBe(false);
    // The bridge shrinks with its slot to nothing, so it draws no end that would hold it open.
    for (const prop of sides('group-bridge').keys()) {
      expect(prop, 'bridge').not.toMatch(/^border-(top|bottom)/);
    }
    expect(sides('group-first').get('border-top-left-radius')).toBe('var(--r-3)');
    expect(sides('group-last').get('border-bottom-right-radius')).toBe('var(--r-3)');
  });

  // B6-CODE-001: the frame lane has its own colour so a bridge can carry the frame of a
  // group it is not in (an emptied header leaving from inside the group its tab joined)
  // while its chip fades in its own colours. Every other leaf's lane is its own group's.
  it('draws the frame from its own lane colour, the leaf’s group colour unless set inline', () => {
    expect(declsOf(INDEX_CSS, '.drawer-leaf').get('--group-frame')).toBe('var(--group-accent)');
    for (const { hits, decls } of rulesWhere(INDEX_CSS, (s) =>
      /group-(first|mid|last|bridge)/.test(s),
    )) {
      for (const [prop, value] of decls) {
        if (BORDER.test(prop) && !prop.includes('radius') && value.includes('var(')) {
          expect(value, `${hits} { ${prop} }`).toContain('var(--group-frame)');
        }
      }
    }
  });

  it('keeps a plain row on the same edge as a member: a transparent lane where a frame would be', () => {
    const leaf = declsOf(INDEX_CSS, '.drawer-leaf');
    expect(leaf.get('border-left')).toBe('1px solid transparent');
    expect(leaf.get('border-right')).toBe('1px solid transparent');
  });

  // The leaf's own fade would take a bridge's sides down with it, and the frame would open
  // between the header and the row below for the whole leave.
  it('fades a bridge’s row, not its leaf, and collapses its slot as any leave does', () => {
    const leaf = declsOf(INDEX_CSS, ".drawer-leaf.group-bridge[data-phase='leaving']");
    expect(leaf.get('opacity')).toBe('1');
    expect(leaf.has('grid-template-rows')).toBe(false); // the base leaving rule still collapses it
    expect(declsOf(INDEX_CSS, ".drawer-leaf[data-phase='leaving']").get('grid-template-rows')).toBe(
      '0fr',
    );
    expect(declsOf(INDEX_CSS, '.drawer-leaf.group-bridge .drawer-row').get('transition')).toBe(
      'opacity var(--mo-micro) ease',
    );
    expect(
      declsOf(INDEX_CSS, ".drawer-leaf.group-bridge[data-phase='leaving'] .drawer-row").get(
        'opacity',
      ),
    ).toBe('0');
    for (const prop of declsOf(INDEX_CSS, '.drawer-leaf.group-bridge').keys()) {
      expect(prop, 'the bridge leaf').not.toMatch(/opacity|transition/);
    }
    expect(
      declsOf(INDEX_CSS, '.drawer-leaf.group-bridge .drawer-row', true).get('transition'),
    ).toBe('none');
  });

  it('wears the group’s colours on the chip, and lets member-active change nothing', () => {
    // A group with no colour falls back to the app accent, as the strip's cluster does.
    expect(declsOf(INDEX_CSS, '.drawer-leaf').get('--group-accent')).toBe('var(--t-accent)');
    expect(declsOf(INDEX_CSS, '.drawer-leaf').get('--group-ink')).toBe('var(--t-accent-ink)');
    const chip = declsOf(INDEX_CSS, '.drawer-group');
    expect(chip.get('background')).toBe('var(--group-accent)');
    expect(chip.get('color')).toBe('var(--group-ink)');
    expect(chip.get('border-radius')).toBe('var(--r-2)');
    // The caret, the label and the count take the chip's ink by declaring no colour of their own.
    for (const part of ['.drawer-group-caret', '.drawer-group-label', '.drawer-group-count']) {
      expect(declsOf(INDEX_CSS, part).has('color'), part).toBe(false);
    }
    expect(declsOf(INDEX_CSS, '.drawer-group.member-active').size).toBe(0);
  });
});

// B6-CODE-002: the chip is filled with --group-accent, which can be the app accent itself:
// Catppuccin Mocha's ansi2 IS its accent, and a group with no colour wears the accent. A drop
// line or a focus ring drawn in the accent alone vanishes into the chip there. happy-dom
// resolves no cascade, so the colours are resolved by hand from the three places they come
// from: the theme's tokens as applyThemeTokens publishes them on :root, the leaf's defaults
// in the stylesheet, and the leaf's inline values as the drawer renders them.
/** `value` with every `var(--x[, fallback])` substituted, innermost first. */
const resolve = (value: string, vars: (name: string) => string | undefined): string => {
  let out = value;
  for (let i = 0; i < 10 && out.includes('var('); i++) {
    out = out.replace(
      /var\((--[\w-]+)(?:,\s*([^()]*))?\)/g,
      (_m, name: string, fallback: string | undefined) =>
        vars(name) ?? fallback?.trim() ?? `unresolved(${name})`,
    );
  }
  return out;
};
const hexes = (value: string): number[] =>
  [...value.matchAll(/#([0-9a-f]{6})\b/gi)].map((m) => Number.parseInt(m[1] ?? '', 16));
// The ink is picked by luminance on the other side of 0.5 from its fill, so a real ink
// clears its fill by well over 0.4; a colour that matches the fill clears it by 0.
const standsOff = (colour: number, fill: number): boolean =>
  Math.abs(luminance(colour) - luminance(fill)) > 0.4;

describe('a group header’s drop lines and focus ring, over its own fill', () => {
  let rootStyle: string | null = null;
  beforeEach(() => {
    rootStyle = document.documentElement.getAttribute('style');
    applyThemeTokens(getProfile('catppuccin-mocha'));
  });
  afterEach(() => {
    if (rootStyle === null) document.documentElement.removeAttribute('style');
    else document.documentElement.setAttribute('style', rootStyle);
  });

  const LEAF_DEFAULTS = declsOf(INDEX_CSS, '.drawer-leaf');
  /** A custom property as the header's leaf sees it: inline, else the stylesheet, else :root. */
  const lookup =
    (leaf: HTMLElement) =>
    (name: string): string | undefined =>
      leaf.style.getPropertyValue(name) ||
      LEAF_DEFAULTS.get(name) ||
      document.documentElement.style.getPropertyValue(name) ||
      undefined;

  const CHIPS = [
    ['an ansi2 group, which is Mocha’s accent', 'ansi2'],
    ['a group with no colour, which wears the accent', 'not-a-slot'],
  ] as const;

  const header = (color: string) => {
    renderDrawer({ tabs: members(1), groups: [{ id: 'g1', name: 'dev', color }], current: '0' });
    const vars = lookup(leafOf(HEADER) as HTMLElement);
    const fill = hexes(resolve(declsOf(INDEX_CSS, '.drawer-group').get('background') ?? '', vars));
    expect(fill).toHaveLength(1);
    return { vars, fill: fill[0]! };
  };

  it.each(CHIPS)('gives the before and after lines a band that stands off %s', (_name, color) => {
    const { vars, fill } = header(color);
    // The premise: the line's own colour IS the fill, so the line alone cannot be seen.
    const line = resolve(
      declsOf(INDEX_CSS, '.drawer-row.drop-before::before').get('background') ?? '',
      vars,
    );
    expect(hexes(line)).toEqual([fill]);
    for (const selector of [
      '.drawer-row-group.drop-before::before',
      '.drawer-row-group.drop-after::after',
    ]) {
      const band = resolve(declsOf(INDEX_CSS, selector).get('box-shadow') ?? '', vars);
      expect(
        hexes(band).some((c) => standsOff(c, fill)),
        `${selector}: ${band}`,
      ).toBe(true);
    }
  });

  it.each(CHIPS)('draws the keyboard ring in a colour that stands off %s', (_name, color) => {
    const { vars, fill } = header(color);
    const ring = resolve(
      declsOf(INDEX_CSS, '.drawer-group:focus-visible').get('outline') ?? '',
      vars,
    );
    expect(hexes(ring), ring).toHaveLength(1);
    expect(standsOff(hexes(ring)[0]!, fill), ring).toBe(true);
    // Inset, as every drawer ring is: the leaf's clip would cut an outset one.
    expect(declsOf(INDEX_CSS, '.drawer-group:focus-visible').get('outline-offset')).toBe('-2px');
  });

  // An insertion is one EDGE, a join is a RING: the band is the line's own shape moved one
  // line-width into the chip, never a spread around it.
  it('keeps an insertion on one edge of the chip and a join a ring around it', () => {
    expect(declsOf(INDEX_CSS, '.drawer-row-group.drop-before::before').get('box-shadow')).toBe(
      '0 2px 0 var(--group-ink)',
    );
    expect(declsOf(INDEX_CSS, '.drawer-row-group.drop-after::after').get('box-shadow')).toBe(
      '0 -2px 0 var(--group-ink)',
    );
    expect(declsOf(INDEX_CSS, '.drawer-row.drop-before::before').get('height')).toBe('2px');
    expect(declsOf(INDEX_CSS, '.drawer-row.drop-inside').get('--ring')).toMatch(
      /^inset 0 0 0 \d+px var\(--t-accent\), inset 0 0 0 \d+px var\(--group-ink\)$/,
    );
  });

  // Every other drawer control keeps the accent ring: only the filled chip needs its ink.
  it('leaves the accent ring on every other drawer control', () => {
    for (const selector of ['.drawer-session:focus-visible', '.drawer-row-close:focus-visible']) {
      expect(declsOf(INDEX_CSS, selector).get('outline'), selector).toBe(
        '2px solid var(--t-accent)',
      );
    }
  });
});

const GROUP: TabGroup[] = [{ id: 'g1', name: 'dev', color: 'ansi3' }];
/** `n` terminals, all in group g1. */
const members = (n: number): TabMeta[] =>
  Array.from({ length: n }, (_, i) => ({ id: String(i), kind: 'terminal', groupId: 'g1' }));
const PLAIN: TabMeta = { id: '9', kind: 'terminal' };
const HEADER = 'drawer-group-g1';
const tab = (id: number) => `drawer-session-${id}`;
const leafOf = (testId: string) => screen.getByTestId(testId).closest('.drawer-leaf')!;

const term = (id: string, groupId: string): TabMeta => ({ id, kind: 'terminal', groupId });
const keys = () =>
  [...document.querySelectorAll<HTMLElement>('.drawer-leaf')].map((l) => l.dataset['rowKey']);
/** The leaves between `gid`'s first and last segment that draw none: holes in its frame. */
const holes = (gid: string): string[] => {
  const leaves = [...document.querySelectorAll<HTMLElement>('.drawer-leaf')];
  const from = leaves.findIndex((l) => l.dataset['rowKey'] === `g:${gid}`);
  const to = leaves.findIndex((l, i) => i >= from && l.classList.contains('group-last'));
  expect(leaves[from]).toHaveClass('group-first');
  expect(to).toBeGreaterThan(from);
  return leaves
    .slice(from + 1, to)
    .filter((l) => !l.classList.contains('group-mid') && !l.classList.contains('group-bridge'))
    .map((l) => l.dataset['rowKey'] ?? '');
};

describe('framed groups: the leaf classes', () => {
  const frame = (testId: string) =>
    [...leafOf(testId).classList].filter((c) => c.startsWith('group-'));

  it('marks an open group of two first, mid and last, and a plain row not at all', () => {
    renderDrawer({ tabs: [...members(2), PLAIN], groups: GROUP, current: '9' });
    expect(frame(HEADER)).toEqual(['group-first']);
    expect(frame(tab(0))).toEqual(['group-mid']);
    expect(frame(tab(1))).toEqual(['group-last']);
    expect(frame('drawer-session-9')).toEqual([]);
  });

  it('marks a folded group’s header as both first and last', () => {
    renderDrawer({
      tabs: [...members(2), PLAIN],
      groups: GROUP,
      current: '9',
      collapsed: new Set(['g1']),
    });
    expect(frame(HEADER)).toEqual(['group-first', 'group-last']);
    expect(screen.queryByTestId(tab(0))).toBeNull();
  });

  describe('as a member leaves', () => {
    const closing = (gone: number[]) => {
      const p = baseProps({ tabs: [...members(3), PLAIN], groups: GROUP, current: '9' });
      const view = render(<SessionDrawer {...p} />);
      const rest = [...members(3).filter((m) => !gone.includes(Number(m.id))), PLAIN];
      view.rerender(<SessionDrawer {...p} tabs={rest} />);
      for (const id of gone) expect(leafOf(tab(id))).toHaveAttribute('data-phase', 'leaving');
      return view;
    };

    // Trailing: nothing of its group below it. A bottom edge on the leaf would be cut off by
    // its own shrinking clip long before it unmounts, so the frame closes above it at once.
    it('moves group-last up at once when the LAST member closes, and draws nothing on it', () => {
      closing([2]);
      expect(frame(tab(2))).toEqual([]);
      expect(frame(tab(1))).toEqual(['group-last']);
      expect(frame(tab(0))).toEqual(['group-mid']);
      expect(frame(HEADER)).toEqual(['group-first']);
    });

    // Interior: rows of its group above AND below, so it bridges the frame's two sides.
    it('bridges the frame when the FIRST member closes', () => {
      closing([0]);
      expect(frame(tab(0))).toEqual(['group-bridge']);
      expect(frame(HEADER)).toEqual(['group-first']);
      expect(frame(tab(1))).toEqual(['group-mid']);
      expect(frame(tab(2))).toEqual(['group-last']);
    });

    it('bridges the frame when a MIDDLE member closes', () => {
      closing([1]);
      expect(frame(tab(1))).toEqual(['group-bridge']);
      expect(frame(HEADER)).toEqual(['group-first']);
      expect(frame(tab(0))).toEqual(['group-mid']);
      expect(frame(tab(2))).toEqual(['group-last']);
    });

    it('bridges every row of a run that closes between surviving rows', () => {
      closing([0, 1]);
      expect(frame(tab(0))).toEqual(['group-bridge']);
      expect(frame(tab(1))).toEqual(['group-bridge']);
      expect(frame(tab(2))).toEqual(['group-last']);
    });

    it('draws nothing on a run that closes at the end, and closes the frame on the row above', () => {
      closing([1, 2]);
      expect(frame(tab(1))).toEqual([]);
      expect(frame(tab(2))).toEqual([]);
      expect(frame(tab(0))).toEqual(['group-last']);
    });

    it('drops the bridge with the row once its leave is over', () => {
      closing([1]);
      act(() => void vi.advanceTimersByTime(140));
      expect(screen.queryByTestId(tab(1))).toBeNull();
      expect(frame(tab(0))).toEqual(['group-mid']);
      expect(frame(tab(2))).toEqual(['group-last']);
    });

    // A collapse: every member is trailing, and the header closes the frame by itself.
    it('leaves a folding group’s members unframed, and makes its header first and last', () => {
      const p = baseProps({ tabs: [...members(3), PLAIN], groups: GROUP, current: '9' });
      const view = render(<SessionDrawer {...p} />);
      view.rerender(<SessionDrawer {...p} collapsed={new Set(['g1'])} />);
      for (const id of [0, 1, 2]) {
        expect(leafOf(tab(id))).toHaveAttribute('data-phase', 'leaving');
        expect(frame(tab(id)), `member ${id}`).toEqual([]);
      }
      expect(frame(HEADER)).toEqual(['group-first', 'group-last']);
    });

    it('brings the members back framed when the group unfolds again', () => {
      const p = baseProps({
        tabs: [...members(2), PLAIN],
        groups: GROUP,
        current: '9',
        collapsed: new Set(['g1']),
      });
      const view = render(<SessionDrawer {...p} />);
      view.rerender(<SessionDrawer {...p} collapsed={new Set()} />);
      expect(frame(HEADER)).toEqual(['group-first']);
      expect(frame(tab(0))).toEqual(['group-mid']);
      expect(frame(tab(1))).toEqual(['group-last']);
    });
  });

  describe('colours', () => {
    it('sets the group’s accent and ink on every leaf of the group, from the tab-colour helpers', () => {
      renderDrawer({ tabs: [...members(2), PLAIN], groups: GROUP, current: '9' });
      for (const id of [HEADER, tab(0), tab(1)]) {
        const style = (leafOf(id) as HTMLElement).style;
        expect(style.getPropertyValue('--group-accent'), id).toBe(tabColorValue('ansi3'));
        expect(style.getPropertyValue('--group-ink'), id).toBe(tabColorInk('ansi3'));
      }
      expect(tabColorValue('ansi3')).toBe('var(--tab-c-ansi3)');
      expect(tabColorInk('ansi3')).toBe('var(--tab-c-ansi3-ink)');
      const plain = (leafOf('drawer-session-9') as HTMLElement).style;
      expect(plain.getPropertyValue('--group-accent')).toBe('');
      expect(plain.getPropertyValue('--group-ink')).toBe('');
    });

    // A colour name no slot resolves (an old or foreign value) is a group with no colour.
    it('sets neither for a group with no colour, so the stylesheet’s accent fallback shows', () => {
      renderDrawer({
        tabs: members(2),
        groups: [{ id: 'g1', name: 'dev', color: 'not-a-slot' }],
        current: '0',
      });
      for (const id of [HEADER, tab(0)]) {
        const style = (leafOf(id) as HTMLElement).style;
        expect(style.getPropertyValue('--group-accent'), id).toBe('');
        expect(style.getPropertyValue('--group-ink'), id).toBe('');
      }
    });

    it('carries them on a leaf that is leaving, so it fades in its own colours', () => {
      const p = baseProps({ tabs: [...members(3), PLAIN], groups: GROUP, current: '9' });
      const view = render(<SessionDrawer {...p} />);
      view.rerender(<SessionDrawer {...p} tabs={[...members(2), PLAIN]} />);
      const style = (leafOf(tab(2)) as HTMLElement).style;
      expect(style.getPropertyValue('--group-accent')).toBe(tabColorValue('ansi3'));
    });
  });

  // B6-CODE-001: a regroup that empties a group. App moves the membership at once
  // (moveTabInTree) and the tree omits a group with no members, so the emptied group's
  // header leaves, and a leaving row keeps its place: right after the live row above it.
  // When that row belongs to the group the tab joined and the tab lands below it, the
  // header leaves from INSIDE another group's frame.
  describe('as the sole member of one group joins another', () => {
    const GB: TabGroup = { id: 'gb', name: 'b', color: 'ansi4' };
    const GA: TabGroup = { id: 'ga', name: 'a', color: 'ansi1' };
    /** [header B, b, header A, a] (A folded when `folded`), then a moves into B, landing `after` b or before it. */
    const regroupFollowing = (landing: 'after' | 'before', groups = [GB, GA], folded = false) => {
      const p = baseProps({
        tabs: [term('0', 'gb'), term('1', 'ga')],
        groups,
        current: '0',
        collapsed: new Set(folded ? ['ga'] : []),
      });
      const view = render(<SessionDrawer {...p} />);
      const joined = [term('0', 'gb'), term('1', 'gb')];
      view.rerender(
        <SessionDrawer {...p} tabs={landing === 'after' ? joined : [joined[1]!, joined[0]!]} />,
      );
      expect(leafOf('drawer-group-ga')).toHaveAttribute('data-phase', 'leaving');
    };

    it.each([
      ['open', false],
      ['folded', true],
    ] as const)(
      'bridges the frame across the emptied header of the %s group below, when its tab lands last',
      (_state, folded) => {
        regroupFollowing('after', [GB, GA], folded);
        expect(keys()).toEqual(['g:gb', 't:0', 'g:ga', 't:1']);
        expect(frame('drawer-group-gb')).toEqual(['group-first']);
        expect(frame(tab(0))).toEqual(['group-mid']);
        expect(frame('drawer-group-ga')).toEqual(['group-bridge']);
        expect(frame(tab(1))).toEqual(['group-last']);
        expect(holes('gb')).toEqual([]);
      },
    );

    it('leaves the emptied header below the frame when its tab lands first', () => {
      regroupFollowing('before');
      expect(keys()).toEqual(['g:gb', 't:1', 't:0', 'g:ga']);
      expect(frame('drawer-group-ga')).toEqual([]);
      expect(frame(tab(0))).toEqual(['group-last']);
      expect(holes('gb')).toEqual([]);
    });

    // The bridge's sides are the frame it holds together, so they are the colour of the
    // live group around it; the chip fading in that slot keeps its own.
    it('draws the bridge’s sides in the colour of the group it bridges, and the chip in its own', () => {
      regroupFollowing('after');
      const style = (leafOf('drawer-group-ga') as HTMLElement).style;
      expect(style.getPropertyValue('--group-frame')).toBe(tabColorValue('ansi4'));
      expect(style.getPropertyValue('--group-accent')).toBe(tabColorValue('ansi1'));
      expect(style.getPropertyValue('--group-ink')).toBe(tabColorInk('ansi1'));
    });

    it('draws the bridge in the accent fallback when the group it bridges has no colour', () => {
      regroupFollowing('after', [{ ...GB, color: 'not-a-slot' }, GA]);
      const style = (leafOf('drawer-group-ga') as HTMLElement).style;
      expect(style.getPropertyValue('--group-frame')).toBe('var(--t-accent)');
      expect(style.getPropertyValue('--group-accent')).toBe(tabColorValue('ansi1'));
    });

    // The mirror: the emptied group sits ABOVE the one its tab joins. A leaving row stays
    // after the live row before it, and nothing of the joined group is before it, so it
    // leaves above that frame wherever the tab lands in it.
    it.each(['before', 'after'] as const)(
      'leaves the emptied header of the group above outside the frame, its tab landing %s the member',
      (landing) => {
        const p = baseProps({
          tabs: [term('0', 'ga'), term('1', 'gb')],
          groups: [GA, GB],
          current: '1',
        });
        const view = render(<SessionDrawer {...p} />);
        const joined = [term('0', 'gb'), term('1', 'gb')];
        view.rerender(
          <SessionDrawer {...p} tabs={landing === 'before' ? joined : [joined[1]!, joined[0]!]} />,
        );
        expect(leafOf('drawer-group-ga')).toHaveAttribute('data-phase', 'leaving');
        expect(keys()[0]).toBe('g:ga');
        expect(frame('drawer-group-ga')).toEqual([]);
        expect(holes('gb')).toEqual([]);
      },
    );
  });

  it('keeps the colours and the segments off the row itself', () => {
    renderDrawer({ tabs: [...members(2), PLAIN], groups: GROUP, current: '9' });
    for (const id of [HEADER, tab(0), tab(1)]) {
      const row = screen.getByTestId(id).closest('.drawer-row') as HTMLElement;
      expect(row.className, id).not.toMatch(/group-(first|mid|last|bridge)/);
      expect(row.style.getPropertyValue('--group-accent'), id).toBe('');
    }
  });
});

describe('footer', () => {
  it('draws one icon per cell: four <svg>, labelled by their text or aria-label', () => {
    renderDrawer();
    for (const [id, name] of [
      ['drawer-upload', 'upload'],
      ['drawer-download', 'download'],
      ['drawer-dictate', 'mic'],
      ['drawer-upload-images', 'image'],
    ] as const) {
      const cell = screen.getByTestId(id);
      expect(cell.querySelectorAll('svg')).toHaveLength(1);
      expect(cell.querySelector('svg')?.innerHTML).toBe(iconPaths(name));
    }
    expect(document.querySelectorAll('.drawer-footer svg')).toHaveLength(4);
    expect(screen.getByTestId('drawer-upload')).toHaveTextContent('Upload');
    expect(screen.getByTestId('drawer-download')).toHaveTextContent('Download');
    expect(screen.getByTestId('drawer-dictate')).toHaveAttribute('aria-label', 'Dictate');
    expect(screen.getByTestId('drawer-upload-images')).toHaveAttribute(
      'aria-label',
      'Upload images',
    );
  });

  it('Images opens the image picker and closes the drawer', () => {
    const p = renderDrawer();
    fireEvent.pointerDown(screen.getByTestId('drawer-upload-images'));
    expect(p.actions.uploadImages).toHaveBeenCalled();
    expect(p.actions.uploadFile).not.toHaveBeenCalled();
    expect(p.onClose).toHaveBeenCalled();
  });

  it('has no keyboard cell — ESC long-press and the bar swipe already raise it', () => {
    renderDrawer();
    expect(screen.queryByTestId('drawer-keyboard')).toBeNull();
  });

  it('has no mic cell — the remote-mic bridge is gone', () => {
    renderDrawer();
    expect(screen.queryByTestId('drawer-mic')).toBeNull();
  });
});

describe('header', () => {
  // Settings is the top button, not a segment and not a wordmark row: one entry,
  // at the end of the drawer the thumb reaches least.
  it('has no brand row and one settings control, the icon button at the top', () => {
    renderDrawer();
    expect(document.querySelector('.drawer-head')).toBeNull();
    expect(screen.queryByText('palmux')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Settings' })).toEqual([
      screen.getByTestId('drawer-settings'),
    ]);
    expect(screen.queryByTestId('drawer-view-settings')).toBeNull();
  });

  it('the settings button opens the view, and its header goes back', () => {
    renderDrawer();
    expect(screen.queryByTestId('drawer-settings-body')).toBeNull();

    fireEvent.pointerDown(screen.getByTestId('drawer-settings'));
    expect(screen.getByTestId('drawer-settings-body')).toBeTruthy();

    // The ‹ is the left chevron now; the word still names the header.
    const back = screen.getByTestId('drawer-settings-back');
    expect(back.querySelector('svg')?.innerHTML).toBe(iconPaths('chevron-left'));
    expect(back).toHaveTextContent(/^Settings$/);
    fireEvent.pointerDown(back);
    expect(screen.queryByTestId('drawer-settings-body')).toBeNull();
  });

  // The theme browser is a sub-view of Settings, and the drawer's own back header
  // is the back stack: it pops the browser to the settings list FIRST, and only a
  // second press leaves Settings. With the state inside the form the header could
  // only ever leave, and a phone would lose the panel to step back from one list.
  describe('the theme sub-view', () => {
    const openThemes = () => {
      fireEvent.pointerDown(screen.getByTestId('drawer-settings'));
      fireEvent.click(screen.getByTestId('set-theme'));
    };

    it('opens inside the drawer, over the settings list', () => {
      renderDrawer();
      openThemes();
      expect(screen.getByTestId('theme-browser')).toBeTruthy();
      expect(screen.getByTestId('drawer-settings-body')).toContainElement(
        screen.getByTestId('theme-browser'),
      );
      expect(screen.queryByTestId('settings-section-appearance')).toBeNull();
    });

    it('is popped by the drawer’s back header before Settings is left', () => {
      renderDrawer();
      openThemes();

      fireEvent.pointerDown(screen.getByTestId('drawer-settings-back'));
      expect(screen.queryByTestId('theme-browser')).toBeNull();
      expect(screen.getByTestId('settings-section-appearance')).toBeTruthy();
      expect(screen.getByTestId('drawer-settings-body')).toBeTruthy(); // still in Settings

      fireEvent.pointerDown(screen.getByTestId('drawer-settings-back'));
      expect(screen.queryByTestId('drawer-settings-body')).toBeNull(); // now it left
    });

    it('is popped by its own back control the same way', () => {
      renderDrawer();
      openThemes();
      fireEvent.click(screen.getByTestId('settings-themes-back'));
      expect(screen.queryByTestId('theme-browser')).toBeNull();
      expect(screen.getByTestId('drawer-settings-body')).toBeTruthy();
      // And the header, with nothing to pop, leaves.
      fireEvent.pointerDown(screen.getByTestId('drawer-settings-back'));
      expect(screen.queryByTestId('drawer-settings-body')).toBeNull();
    });

    it('applies a pick and stays open for the next', () => {
      const { onChangeSettings } = renderDrawer();
      openThemes();
      const first = document.querySelector<HTMLElement>(
        "[data-testid^='theme-opt-']:not([data-state='checked'])",
      );
      expect(first).not.toBeNull();
      const id = first!.dataset['testid']!.replace('theme-opt-', '');
      fireEvent.click(first!);
      expect(onChangeSettings).toHaveBeenCalledWith({ themeId: id });
      expect(screen.getByTestId('theme-browser')).toBeTruthy();
    });

    // Import lives in the sub-view now (batch 12), in the drawer as in the dock, and
    // the drawer hands the host the target along with the source.
    it('offers Import first in the sub-view, and tags it with the target', () => {
      const onImportTheme = vi.fn();
      renderDrawer({ onImportTheme });
      expect(screen.queryByTestId('set-theme-import')).toBeNull(); // not in the form
      openThemes();
      const section = screen.getByRole('group', { name: 'Import' });
      expect(section).toContainElement(screen.getByTestId('set-theme-import'));
      expect(section.compareDocumentPosition(screen.getByRole('group', { name: 'Dark' }))).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );

      // fireEvent, not userEvent: this file runs on a fake clock, which a typing
      // simulation waits on forever.
      const field = screen.getByTestId('set-theme-import');
      fireEvent.change(field, { target: { value: 'Nord' } });
      fireEvent.keyDown(field, { key: 'Enter' });
      expect(onImportTheme).toHaveBeenCalledWith('Nord', { mode: 'fixed' });
    });

    it('lets Match system be chosen from the drawer', () => {
      const { onChangeSettings } = renderDrawer();
      openThemes();
      fireEvent.click(screen.getByTestId('set-theme-mode-system'));
      expect(onChangeSettings).toHaveBeenCalledWith({
        themeMode: 'system',
        themeDark: DEFAULTS.themeId,
        themeLight: DEFAULTS.themeId,
      });
    });

    // Settings draws no switcher, so the way out is the back header: its first
    // press pops the browser, its second leaves. (A host moving the view out from
    // under an OPEN browser is the controlled-host case below.)
    it('does not come back with Settings: leaving and returning shows the list', () => {
      renderDrawer();
      openThemes();
      fireEvent.pointerDown(settingsBack());
      expect(inThemes()).toBe(false);
      fireEvent.pointerDown(settingsBack());
      expect(inSettings()).toBe(false);
      fireEvent.pointerDown(screen.getByTestId('drawer-settings'));
      expect(screen.queryByTestId('theme-browser')).toBeNull();
      expect(screen.getByTestId('settings-section-appearance')).toBeTruthy();
    });

    // A controlled host owns `view`, so the drawer never gets to reset it by
    // itself — the sub-view has to be dropped when the view changes under it.
    it('is dropped when a controlled host moves the view away and back', () => {
      const props = {
        open: true,
        tabs: TABS,
        current: '0',
        onSwitch: vi.fn(),
        onCreate: vi.fn(),
        onKill: vi.fn(),
        onClose: vi.fn(),
        onTabMenu: vi.fn(),
        actions: {
          uploadFile: vi.fn(),
          uploadImages: vi.fn(),
          downloadFile: vi.fn(),
          dictate: vi.fn(),
        },
        settings: DEFAULTS,
        onChangeSettings: vi.fn(),
        onView: vi.fn(),
      };
      const view = render(<SessionDrawer {...props} view="settings" />);
      fireEvent.click(screen.getByTestId('set-theme'));
      expect(screen.getByTestId('theme-browser')).toBeTruthy();

      // The header pops the browser without reporting a view change.
      fireEvent.pointerDown(screen.getByTestId('drawer-settings-back'));
      expect(screen.queryByTestId('theme-browser')).toBeNull();
      expect(props.onView).not.toHaveBeenCalled();

      fireEvent.click(screen.getByTestId('set-theme'));
      view.rerender(<SessionDrawer {...props} view="sessions" />);
      view.rerender(<SessionDrawer {...props} view="settings" />);
      expect(screen.queryByTestId('theme-browser')).toBeNull();
      expect(screen.getByTestId('settings-section-appearance')).toBeTruthy();
    });

    it('names the sub-view in a heading, so the header’s ‹ Settings is not its only label', () => {
      renderDrawer();
      openThemes();
      expect(screen.getByTestId('drawer-settings-body')).toContainElement(
        screen.getByRole('heading', { name: 'Theme' }),
      );
    });

    it('changes no setting by opening the browser or by popping it', () => {
      const { onChangeSettings } = renderDrawer();
      openThemes();
      fireEvent.pointerDown(screen.getByTestId('drawer-settings-back'));
      fireEvent.pointerDown(screen.getByTestId('drawer-settings-back'));
      expect(onChangeSettings).not.toHaveBeenCalled();
    });

    // Reopening always lands on the session list. A theme browser that survived a
    // close would put the next opening three steps from where the user expects.
    it('is gone when the drawer is closed and opened again', () => {
      const props = {
        open: true,
        tabs: TABS,
        current: '0',
        onSwitch: vi.fn(),
        onCreate: vi.fn(),
        onKill: vi.fn(),
        onClose: vi.fn(),
        onTabMenu: vi.fn(),
        actions: {
          uploadFile: vi.fn(),
          uploadImages: vi.fn(),
          downloadFile: vi.fn(),
          dictate: vi.fn(),
        },
        settings: DEFAULTS,
        onChangeSettings: vi.fn(),
      };
      const view = render(<SessionDrawer {...props} />);
      fireEvent.pointerDown(screen.getByTestId('drawer-settings'));
      fireEvent.click(screen.getByTestId('set-theme'));
      expect(screen.getByTestId('theme-browser')).toBeTruthy();

      view.rerender(<SessionDrawer {...props} open={false} />);
      view.rerender(<SessionDrawer {...props} open />);
      expect(screen.queryByTestId('theme-browser')).toBeNull();
      expect(screen.queryByTestId('drawer-settings-body')).toBeNull();
      // And Settings, reached again, opens on the list rather than the browser.
      fireEvent.pointerDown(screen.getByTestId('drawer-settings'));
      expect(screen.getByTestId('settings-section-appearance')).toBeTruthy();
      expect(screen.queryByTestId('theme-browser')).toBeNull();
    });

    // Edit config.json lives in the dock, which has the room for an editor; the
    // drawer passes no `onEditConfig`, so the row must not be there.
    it('has no Edit config.json row in the drawer', () => {
      renderDrawer();
      fireEvent.pointerDown(screen.getByTestId('drawer-settings'));
      expect(screen.queryByTestId('edit-config')).toBeNull();
    });
  });

  // In the theme sub-view the header is the ONLY back control (the form's own is
  // hidden by settings-view.css), so it has to answer every way a button is
  // activated: a pointer, Enter, Space, and a bare click from assistive tech or
  // `element.click()`. A pointer press is down → up → the click the browser adds,
  // and that click must not count as a second press.
  describe('the back header as a button', () => {
    // user-event awaits real timers (RTL drains with a setTimeout(0) the fake
    // clock never fires), so this block runs on the real clock and fakes it only
    // where a test needs time to pass.
    beforeEach(() => vi.useRealTimers());
    const openThemes = () => {
      fireEvent.pointerDown(screen.getByTestId('drawer-settings'));
      fireEvent.click(screen.getByTestId('set-theme'));
      expect(inThemes()).toBe(true);
    };

    it('is the one visible, focusable, named back control in the theme view', () => {
      // happy-dom does not load imported CSS, so the hiding rule is applied by
      // hand — it is what takes the form's own `‹ Settings` out of the tree.
      const style = document.createElement('style');
      style.textContent = readFileSync(join(__dirname, '../settings/settings-view.css'), 'utf8');
      document.head.append(style);
      try {
        renderDrawer();
        openThemes();
        expect(screen.getAllByRole('button', { name: 'Settings' })).toEqual([settingsBack()]);
        expect(settingsBack().tagName).toBe('BUTTON');
        expect(settingsBack()).toHaveAccessibleName('Settings');
        settingsBack().focus();
        expect(document.activeElement).toBe(settingsBack());
      } finally {
        style.remove();
      }
    });

    // Popping hands focus to the Theme row (see "focus across the theme
    // sub-view"), so the second Enter is pressed back on the header.
    it('Enter pops the theme sub-view, and Enter on it again leaves Settings', async () => {
      renderDrawer();
      openThemes();
      settingsBack().focus();
      await user().keyboard('{Enter}');
      expect(inThemes()).toBe(false);
      expect(inSettings()).toBe(true);
      await tabTo(settingsBack(), true);
      await user().keyboard('{Enter}');
      expect(inSettings()).toBe(false);
    });

    it('Space pops the theme sub-view', async () => {
      renderDrawer();
      openThemes();
      settingsBack().focus();
      await user().keyboard(' ');
      expect(inThemes()).toBe(false);
      expect(inSettings()).toBe(true);
    });

    it('a click with no pointer press before it (assistive tech, element.click()) pops it', () => {
      renderDrawer();
      openThemes();
      // A bare `click()` is outside React's act(), unlike fireEvent; wrap it so
      // the state it sets has rendered before the assertion.
      act(() => settingsBack().click());
      expect(inThemes()).toBe(false);
      expect(inSettings()).toBe(true);
      fireEvent.click(settingsBack());
      expect(inSettings()).toBe(false);
    });

    it('a real pointer press — down, up, then its click — pops exactly one level', async () => {
      renderDrawer();
      openThemes();
      fireEvent.pointerDown(settingsBack());
      fireEvent.pointerUp(settingsBack());
      fireEvent.click(settingsBack(), { detail: 1 });
      expect(inThemes()).toBe(false);
      expect(inSettings()).toBe(true); // the trailing click did not also leave

      // The same through user-event's full sequence (pointer + mouse + click).
      fireEvent.click(screen.getByTestId('set-theme'));
      await user().click(settingsBack());
      expect(inThemes()).toBe(false);
      expect(inSettings()).toBe(true);
    });

    it('a held press still pops one level: its click is measured from the release', () => {
      vi.useFakeTimers();
      renderDrawer();
      openThemes();
      fireEvent.pointerDown(settingsBack());
      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      fireEvent.pointerUp(settingsBack());
      fireEvent.click(settingsBack(), { detail: 1 });
      expect(inThemes()).toBe(false);
      expect(inSettings()).toBe(true);
    });

    it('from the settings list it still returns to sessions, by key or by click', async () => {
      renderDrawer();
      fireEvent.pointerDown(screen.getByTestId('drawer-settings'));
      settingsBack().focus();
      await user().keyboard('{Enter}');
      expect(inSettings()).toBe(false);
      expect(screen.getByTestId('drawer-session-0')).toBeVisible();

      fireEvent.pointerDown(screen.getByTestId('drawer-settings'));
      act(() => settingsBack().click());
      expect(inSettings()).toBe(false);

      fireEvent.pointerDown(screen.getByTestId('drawer-settings'));
      await user().click(settingsBack());
      expect(inSettings()).toBe(false);
    });

    // A touch press may never be followed by a click on this control (the
    // finger slid off, or the browser dropped it). That press must not sit there
    // and eat the next activation that arrives by another route.
    it('a press whose click never came does not swallow a later key or click', async () => {
      renderDrawer();
      openThemes();
      fireEvent.pointerDown(settingsBack());
      fireEvent.pointerUp(settingsBack());
      expect(inThemes()).toBe(false);
      settingsBack().focus();
      await user().keyboard('{Enter}'); // immediately after: a key is never a pointer's tail
      expect(inSettings()).toBe(false);

      fireEvent.pointerDown(screen.getByTestId('drawer-settings'));
      fireEvent.click(screen.getByTestId('set-theme'));
      vi.useFakeTimers();
      fireEvent.pointerDown(settingsBack());
      fireEvent.pointerUp(settingsBack());
      act(() => {
        vi.advanceTimersByTime(2_000);
      });
      act(() => settingsBack().click()); // long after: an assistive-tech click is its own press
      expect(inSettings()).toBe(false);
    });
  });

  // The theme switch replaces the control that holds focus. Here the form's own
  // `‹ Settings` is hidden (settings-view.css), so the first control the sub-view
  // draws is the Fixed segment of the mode switch, one Shift+Tab below this header; the way out is
  // the header, and it hands focus back to the Theme row. Every step is a key:
  // no focus() call stands in for one.
  describe('focus across the theme sub-view', () => {
    beforeEach(() => vi.useRealTimers());
    // happy-dom loads no imported CSS, so the drawer's hiding rule is applied by
    // hand: it is what makes Tab skip the form's own back control, as a browser does.
    let sheet: HTMLStyleElement;
    beforeEach(() => {
      sheet = document.createElement('style');
      sheet.textContent = readFileSync(join(__dirname, '../settings/settings-view.css'), 'utf8');
      document.head.append(sheet);
    });
    afterEach(() => sheet.remove());

    // Realigned (batch 12): the sub-view now opens on the mode switch, so the first
    // control it draws — where focus lands, the drawer having hidden ‹ Settings —
    // is its Fixed segment, one Tab above Import and the list.
    const firstControl = () => screen.getByTestId('set-theme-mode-fixed');

    it.each([
      ['Enter', '{Enter}'],
      ['Space', ' '],
    ])('%s: in to the first control, out through the header to the Theme row', async (_, key) => {
      renderDrawer();
      fireEvent.pointerDown(screen.getByTestId('drawer-settings'));
      await tabTo(screen.getByTestId('set-theme'));

      await user().keyboard(key);
      expect(inThemes()).toBe(true);
      expect(document.activeElement).toBe(firstControl());

      await tabTo(settingsBack(), true);
      await user().keyboard(key);
      expect(inThemes()).toBe(false);
      expect(inSettings()).toBe(true);
      expect(document.activeElement).toBe(screen.getByTestId('set-theme'));

      // And the header, reached again by key, now leaves Settings.
      await tabTo(settingsBack(), true);
      await user().keyboard(key);
      expect(inSettings()).toBe(false);
    });

    // A pick is a button's click, so Enter and Space must pick exactly once: a
    // control that also acted on the keydown would apply the theme twice.
    it.each([
      ['Enter', '{Enter}'],
      ['Space', ' '],
    ])('%s on a theme entry picks it once, and the browser stays open', async (_, key) => {
      const p = renderDrawer();
      fireEvent.pointerDown(screen.getByTestId('drawer-settings'));
      await tabTo(screen.getByTestId('set-theme'));
      await user().keyboard('{Enter}');
      expect(inThemes()).toBe(true);
      const pick = [...document.querySelectorAll<HTMLElement>("[data-testid^='theme-opt-']")].find(
        (opt) => opt.getAttribute('aria-current') !== 'true',
      )!;
      await tabTo(pick);
      await user().keyboard(key);
      expect(p.onChangeSettings).toHaveBeenCalledTimes(1);
      expect(p.onChangeSettings).toHaveBeenCalledWith({
        themeId: pick.dataset['testid']!.replace('theme-opt-', ''),
      });
      expect(inThemes()).toBe(true);
    });

    // The Theme row, its label and the entries sit in the scrolling settings list,
    // so a touch that moves on any of them is a scroll and must act on nothing.
    it('a touch that moves on the Theme row, its label or an entry scrolls and acts on nothing', () => {
      const p = renderDrawer();
      fireEvent.pointerDown(screen.getByTestId('drawer-settings'));
      const slide = (el: Element) => {
        const at = { pointerId: 3, pointerType: 'touch', clientX: 40, clientY: 200 };
        expect(fireEvent.pointerDown(el, at)).toBe(true); // the pan stays the browser's
        fireEvent.pointerMove(el, { ...at, clientY: 150 });
        fireEvent.pointerUp(el, { ...at, clientY: 150 });
      };
      slide(screen.getByTestId('set-theme'));
      expect(inThemes()).toBe(false);
      slide(document.querySelector('label[for="set-theme"]')!);
      expect(inThemes()).toBe(false);

      act(() => screen.getByTestId('set-theme').click());
      expect(inThemes()).toBe(true);
      slide(document.querySelector("[data-testid^='theme-opt-']")!);
      expect(p.onChangeSettings).not.toHaveBeenCalled();
      expect(inThemes()).toBe(true);
    });

    // The drawer's pointer convention keeps #mobile-kbd focused so the soft
    // keyboard stays up, and every control of the theme round trip has to keep it:
    // the Theme row (or its label) in, a pick, the header out. Nothing here moves
    // focus by hand. Each press is the browser's own sequence (`browserPress`),
    // whose mousedown moves focus unless the control took it, so a control that
    // lets it move fails here; a bare click on the row could not see that, which
    // is how a press that dismissed the keyboard passed before.
    describe('leaves #mobile-kbd holding focus through a pointer round trip', () => {
      let kbd: HTMLTextAreaElement;
      beforeEach(() => {
        kbd = document.createElement('textarea');
        kbd.id = 'mobile-kbd';
        document.body.append(kbd);
        kbd.focus();
      });
      afterEach(() => kbd.remove());

      const themeRow = () => screen.getByTestId('set-theme');
      const themeLabel = () => document.querySelector<HTMLElement>('label[for="set-theme"]')!;
      const otherTheme = () =>
        [...document.querySelectorAll<HTMLElement>("[data-testid^='theme-opt-']")].find(
          (opt) => opt.getAttribute('aria-current') !== 'true',
        )!;

      it.each([
        ['touch', 'the row', themeRow],
        ['mouse', 'the row', themeRow],
        ['touch', 'its label', themeLabel],
        ['mouse', 'its label', themeLabel],
      ] as const)('%s: in by %s, a pick, and out', (pointerType, _, entry) => {
        const p = renderDrawer();
        browserPress(screen.getByTestId('drawer-settings'), pointerType);
        expect(inSettings()).toBe(true);
        expect(document.activeElement).toBe(kbd);

        // The Theme row lives in the scrolling settings list: a touch that lands
        // on it must leave the pan to the browser.
        expect(browserPress(entry(), pointerType)).toBe(pointerType === 'touch');
        expect(inThemes()).toBe(true);
        expect(document.activeElement).toBe(kbd);

        const pick = otherTheme();
        const themeId = pick.dataset['testid']!.replace('theme-opt-', '');
        expect(browserPress(pick, pointerType)).toBe(pointerType === 'touch');
        expect(p.onChangeSettings).toHaveBeenCalledTimes(1);
        expect(p.onChangeSettings).toHaveBeenCalledWith({ themeId });
        expect(inThemes()).toBe(true); // a pick keeps the browser open
        expect(document.activeElement).toBe(kbd);

        browserPress(settingsBack(), pointerType);
        expect(inThemes()).toBe(false);
        expect(inSettings()).toBe(true);
        expect(document.activeElement).toBe(kbd);
      });
    });
  });

  // The switcher wears the dock rail's own icons (one shared registry), each
  // beside a visible name, so it needs no aria-label of its own. Settings is the
  // button above the list, with the same icon.
  it("the view switcher draws the rail's icons beside each view's name", () => {
    renderDrawer({ hostedViews: ['files', 'dictation'] });
    for (const [view, icon, name] of [
      ['sessions', 'sessions', 'Sessions'],
      ['files', 'folder', 'Explorer'],
      ['dictation', 'mic', 'Dictation'],
    ] as const) {
      const item = screen.getByTestId(`drawer-view-${view}`);
      expect(item.querySelectorAll('svg'), view).toHaveLength(1);
      expect(item.querySelector('svg')?.innerHTML, view).toBe(iconPaths(icon));
      expect(item.querySelector('.drawer-view-name'), view).toHaveTextContent(name);
    }
    expect(screen.getByTestId('drawer-settings').querySelector('svg')?.innerHTML).toBe(
      iconPaths('settings'),
    );
  });
});

// The view switcher. Files and Dictation have no body of their own, so the
// host renders them — and availability has to be DECLARED, not inferred from
// the body: the body can only exist for the view that is already selected, so
// inferring it left both views disabled forever and unreachable.
describe('view switching', () => {
  const options = () =>
    Object.fromEntries(
      [...document.querySelectorAll('[data-testid^="drawer-view-"]')].map((e) => [
        (e as HTMLElement).dataset['testid']!.replace('drawer-view-', ''),
        !(e as HTMLButtonElement).disabled,
      ]),
    );

  it('disables a hosted view the host has not declared', () => {
    renderDrawer();
    expect(options()).toEqual({ sessions: true, files: false, dictation: false });
  });

  it('enables a declared hosted view even before any body exists', () => {
    renderDrawer({ hostedViews: ['files', 'dictation'] });
    expect(options()).toMatchObject({ files: true, dictation: true });
  });

  // The full round trip the old rule made impossible: select → host reacts →
  // body appears. A controlled host owns `view`, so the drawer only reports it.
  it('selecting a declared view reports it, and its body renders once supplied', () => {
    const onView = vi.fn();
    const props = {
      open: true,
      tabs: TABS,
      current: '0',
      onSwitch: vi.fn(),
      onCreate: vi.fn(),
      onKill: vi.fn(),
      onClose: vi.fn(),
      onTabMenu: vi.fn(),
      actions: {
        uploadFile: vi.fn(),
        uploadImages: vi.fn(),
        downloadFile: vi.fn(),
        dictate: vi.fn(),
      },
      settings: DEFAULTS,
      onChangeSettings: vi.fn(),
      hostedViews: ['files'] as const,
      onView,
    };
    const view = render(<SessionDrawer {...props} view="sessions" />);

    fireEvent.click(screen.getByTestId('drawer-view-files'));
    expect(onView).toHaveBeenCalledWith('files');
    expect(screen.queryByTestId('host-files')).toBeNull(); // nothing yet

    view.rerender(
      <SessionDrawer {...props} view="files" viewContent={<div data-testid="host-files" />} />,
    );
    expect(screen.getByTestId('host-files')).toBeTruthy();
    expect(screen.getByTestId('drawer-view-body')).toBeTruthy();
  });
});

// `+ New tab` used to CLOSE the drawer and leave the host to float the chooser
// somewhere else — on a phone that was a box in the screen corner. The chooser
// belongs in the container that is already open.
describe('new tab', () => {
  it('closes the drawer only when the host renders no chooser of its own', () => {
    const { onCreate, onClose } = renderDrawer();
    tap(screen.getByTestId('drawer-new'));
    expect(onCreate).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled(); // legacy host: nothing here to show
  });

  it('keeps the drawer open when the host will render the chooser inside it', () => {
    const { onCreate, onClose } = renderDrawer({ onNewTabBack: vi.fn() });
    tap(screen.getByTestId('drawer-new'));
    expect(onCreate).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows the chooser in place of the session list, with a way back', () => {
    const onNewTabBack = vi.fn();
    renderDrawer({
      onNewTabBack,
      newTabContent: <div data-testid="host-chooser">chooser</div>,
    });

    expect(screen.getByTestId('host-chooser')).toBeTruthy();
    expect(screen.getByTestId('drawer-newtab-body')).toBeTruthy();
    // The list is still mounted (its rows keep their state) but not shown.
    expect(screen.getByTestId('drawer-session-0').closest('.drawer-sessions')).toHaveAttribute(
      'hidden',
    );

    const back = screen.getByTestId('drawer-newtab-back');
    expect(back.querySelector('svg')?.innerHTML).toBe(iconPaths('chevron-left'));
    expect(back).toHaveTextContent(/^New tab$/);
    fireEvent.pointerDown(back);
    expect(onNewTabBack).toHaveBeenCalled();
  });

  // `+ New tab` acts on pointer UP and swaps the whole view for the chooser, so
  // the rest of the tap (its mouse events and its click) arrives on a chooser row
  // that the finger never pressed.
  it('opens the chooser and stays open: the rest of the tap reaches nothing in it', () => {
    const props = baseProps();
    const row = { click: vi.fn(), mouseDown: vi.fn() };
    const Host = () => {
      const [chooser, setChooser] = useState(false);
      return (
        <SessionDrawer
          {...props}
          onCreate={() => setChooser(true)}
          onNewTabBack={() => setChooser(false)}
          newTabContent={
            chooser ? (
              <button data-testid="chooser-row" onClick={row.click} onMouseDown={row.mouseDown}>
                tmux build
              </button>
            ) : undefined
          }
        />
      );
    };
    render(<Host />);
    const touch = { pointerId: 1, pointerType: 'touch' };
    const button = screen.getByTestId('drawer-new');
    fireEvent.pointerDown(button, touch);
    fireEvent.pointerUp(button, touch);
    const under = screen.getByTestId('chooser-row');
    fireEvent.mouseDown(under, { detail: 1 });
    fireEvent.mouseUp(under, { detail: 1 });
    fireEvent.click(under, { detail: 1 });
    expect(row.mouseDown).not.toHaveBeenCalled();
    expect(row.click).not.toHaveBeenCalled();
    expect(screen.getByTestId('drawer-newtab-body')).toBeInTheDocument();
    expect(props.onClose).not.toHaveBeenCalled();

    // A later, separate tap on the row is the user's own.
    fireEvent.pointerDown(under, { pointerId: 2, pointerType: 'touch' });
    fireEvent.pointerUp(under, { pointerId: 2, pointerType: 'touch' });
    fireEvent.click(under, { detail: 1 });
    expect(row.click).toHaveBeenCalledTimes(1);
  });

  // The chooser hides the session list, so this header is the only way back to
  // it from inside the drawer: it must answer Enter, Space and a bare click too,
  // and a pointer press (down → up → its click) must still count once.
  describe('the back header as a button', () => {
    // Real clock: user-event drains with a setTimeout(0) the fake one never fires.
    beforeEach(() => vi.useRealTimers());
    const renderChooser = () => {
      const onNewTabBack = vi.fn();
      renderDrawer({ onNewTabBack, newTabContent: <div>chooser</div> });
      return { onNewTabBack, back: screen.getByTestId('drawer-newtab-back') };
    };

    it('Enter leaves the chooser', async () => {
      const { onNewTabBack, back } = renderChooser();
      back.focus();
      await user().keyboard('{Enter}');
      expect(onNewTabBack).toHaveBeenCalledTimes(1);
    });

    it('Space leaves the chooser', async () => {
      const { onNewTabBack, back } = renderChooser();
      back.focus();
      await user().keyboard(' ');
      expect(onNewTabBack).toHaveBeenCalledTimes(1);
    });

    it('a click with no pointer press before it (assistive tech, element.click()) leaves', () => {
      const { onNewTabBack, back } = renderChooser();
      act(() => back.click());
      expect(onNewTabBack).toHaveBeenCalledTimes(1);
    });

    it('a real pointer press — down, up, then its click — leaves exactly once', async () => {
      const { onNewTabBack, back } = renderChooser();
      fireEvent.pointerDown(back);
      fireEvent.pointerUp(back);
      fireEvent.click(back, { detail: 1 });
      expect(onNewTabBack).toHaveBeenCalledTimes(1);

      await user().click(back); // user-event's full pointer + mouse + click sequence
      expect(onNewTabBack).toHaveBeenCalledTimes(2);
    });
  });
});

// The footer cells are fixed, focusable buttons, so they get the same rule as the
// back headers. Dictate is the one where a double fire shows: it is a TOGGLE, so a
// pointer press whose trailing click also acted would start and stop it at once.
describe('footer cells as buttons', () => {
  beforeEach(() => vi.useRealTimers());
  const CELLS = [
    ['drawer-upload', 'uploadFile'],
    ['drawer-download', 'downloadFile'],
    ['drawer-dictate', 'dictate'],
    ['drawer-upload-images', 'uploadImages'],
  ] as const;

  it.each(CELLS)('%s acts once on Enter, and closes the drawer', async (id, action) => {
    const p = renderDrawer();
    screen.getByTestId(id).focus();
    await user().keyboard('{Enter}');
    expect(p.actions[action]).toHaveBeenCalledTimes(1);
    expect(p.onClose).toHaveBeenCalledTimes(1);
  });

  it.each(CELLS)('%s acts once on Space', async (id, action) => {
    const p = renderDrawer();
    screen.getByTestId(id).focus();
    await user().keyboard(' ');
    expect(p.actions[action]).toHaveBeenCalledTimes(1);
  });

  it.each(CELLS)('%s acts once on a click with no pointer press before it', (id, action) => {
    const p = renderDrawer();
    act(() => screen.getByTestId(id).click());
    expect(p.actions[action]).toHaveBeenCalledTimes(1);
  });

  it.each(CELLS)('%s acts once for a pointer press — down, up, then its click', (id, action) => {
    const p = renderDrawer();
    const cell = screen.getByTestId(id);
    fireEvent.pointerDown(cell);
    fireEvent.pointerUp(cell);
    fireEvent.click(cell, { detail: 1 });
    expect(p.actions[action]).toHaveBeenCalledTimes(1);
    expect(p.onClose).toHaveBeenCalledTimes(1);
  });
});

// Every fixed button acts on pointerdown, and most of them redraw the spot under
// the finger: the ⚙ puts the back header where it was, the back header puts the ⚙
// back, and a footer cell closes the drawer. The browser hit-tests the press's
// click only after the release, so the click lands on what the press put there.
// Measured with emulated touch: the ⚙ opened Settings, its click hit the back
// header, and Settings shut again in the same tap, 4 times out of 4.
describe('a press’s own click, landing on what the press put under the finger', () => {
  beforeEach(() => vi.useRealTimers());
  const touch = { pointerId: 1, pointerType: 'touch' };
  /** The rest of a tap whose pointerdown already acted: the release and its click, on `el`. */
  const release = (el: Element) => {
    fireEvent.pointerUp(el, touch);
    fireEvent.click(el, { detail: 1 });
  };
  const openSettings = () => {
    fireEvent.pointerDown(screen.getByTestId('drawer-settings'), touch);
    release(settingsBack());
  };

  it('the ⚙ opens Settings, and its click on the back header does not shut it', () => {
    renderDrawer();
    openSettings();
    expect(inSettings()).toBe(true);
  });

  it('the back header leaves Settings, and its click on the ⚙ does not reopen it', () => {
    renderDrawer();
    openSettings();
    fireEvent.pointerDown(settingsBack(), touch);
    release(screen.getByTestId('drawer-settings'));
    expect(inSettings()).toBe(false);
  });

  it('the back header pops the theme sub-view, and its click on the Theme row does not reopen it', () => {
    renderDrawer();
    openSettings();
    const themeRow = screen.getByTestId('set-theme');
    fireEvent.pointerDown(themeRow, touch);
    release(themeRow);
    expect(inThemes()).toBe(true);

    fireEvent.pointerDown(settingsBack(), touch);
    release(screen.getByTestId('set-theme'));
    expect(inThemes()).toBe(false);
    expect(inSettings()).toBe(true);
  });

  it.each([
    ['drawer-upload', 'uploadFile'],
    ['drawer-download', 'downloadFile'],
    ['drawer-dictate', 'dictate'],
    ['drawer-upload-images', 'uploadImages'],
  ] as const)(
    '%s closes the drawer, and its click on what was under it does nothing',
    (id, action) => {
      const props = baseProps();
      const under = vi.fn();
      // The host really closes the drawer, the way App does.
      const Host = () => {
        const [open, setOpen] = useState(true);
        return (
          <>
            <button data-testid="under-drawer" onClick={under}>
              terminal
            </button>
            <SessionDrawer {...props} open={open} onClose={() => setOpen(false)} />
          </>
        );
      };
      render(<Host />);
      fireEvent.pointerDown(screen.getByTestId(id), touch);
      expect(screen.getByTestId('drawer')).not.toHaveClass('open');
      release(screen.getByTestId('under-drawer'));
      expect(under).not.toHaveBeenCalled();
      expect(props.actions[action]).toHaveBeenCalledTimes(1);
    },
  );

  it('a second tap on the back header is a press of its own, and leaves Settings', () => {
    renderDrawer();
    openSettings();
    fireEvent.pointerDown(settingsBack(), touch);
    expect(inSettings()).toBe(false);
  });

  it('Enter on the back header right after the press still leaves Settings', async () => {
    renderDrawer();
    fireEvent.pointerDown(screen.getByTestId('drawer-settings'), touch);
    fireEvent.pointerUp(settingsBack(), touch); // its click has not arrived yet
    settingsBack().focus();
    await user().keyboard('{Enter}');
    expect(inSettings()).toBe(false);
  });
});

// ── Thumb-reach layout ────────────────────────────────────────────────────────
// Bottom to top: the footer, the bottom-anchored list, and at the very top one row:
// the Settings gear, the switcher, Close.
describe('reach order', () => {
  const FOLLOWING = Node.DOCUMENT_POSITION_FOLLOWING;

  it('puts Settings first in the tab order, then the switcher and Close, the footer last', () => {
    renderDrawer();
    const nav = screen.getByTestId('drawer');
    const focusable = [...nav.querySelectorAll<HTMLElement>('button, [tabindex]')].filter(
      (el) => el.getAttribute('tabindex') !== '-1',
    );
    const settings = screen.getByTestId('drawer-settings');
    const switcher = screen.getByTestId('drawer-view');
    const close = screen.getByTestId('drawer-close');
    expect(focusable[0]).toBe(settings);
    expect(focusable).toContain(switcher);
    expect(focusable).toContain(close);
    const list = nav.querySelector('.drawer-sessions')!;
    const footer = nav.querySelector('.drawer-footer')!;
    // Gear, switcher, Close, then the list, then the footer: the DOM is the tab order.
    expect(settings.compareDocumentPosition(switcher) & FOLLOWING).toBeTruthy();
    expect(switcher.compareDocumentPosition(close) & FOLLOWING).toBeTruthy();
    expect(close.compareDocumentPosition(list) & FOLLOWING).toBeTruthy();
    expect(list.compareDocumentPosition(footer) & FOLLOWING).toBeTruthy();
    expect(footer.nextElementSibling).toBeNull();
  });

  it('keeps the list pinned to the bottom, above the footer', () => {
    expect(declsOf(INDEX_CSS, '.drawer-sessions').get('margin-top')).toBe('auto');
  });

  it('offers the switcher Sessions, Explorer and Dictation, and not Settings', () => {
    renderDrawer({ hostedViews: ['files', 'dictation'] });
    const items = [...screen.getByTestId('drawer-view').querySelectorAll('button')];
    expect(items.map((i) => i.dataset['testid'])).toEqual([
      'drawer-view-sessions',
      'drawer-view-files',
      'drawer-view-dictation',
    ]);
  });

  // The top row belongs to the root level. Settings and the chooser are sub-surfaces
  // under a back header, which is their top control; a row above it would push the
  // way back down the screen and name Settings twice.
  it('shows the top row in the session list and in a hosted view, not under a back header', () => {
    const view = render(<SessionDrawer {...baseProps()} />);
    expect(screen.queryByTestId('drawer-settings')).not.toBeNull();
    view.rerender(
      <SessionDrawer {...baseProps()} view="files" hostedViews={['files']} viewContent={<div />} />,
    );
    expect(screen.queryByTestId('drawer-settings')).not.toBeNull();
    view.rerender(<SessionDrawer {...baseProps()} view="settings" />);
    expect(screen.queryByTestId('drawer-settings')).toBeNull();
    expect(screen.queryByTestId('drawer-close')).toBeNull();
    expect(settingsBack()).toBeTruthy();
    view.rerender(<SessionDrawer {...baseProps()} newTabContent={<div />} />);
    expect(screen.queryByTestId('drawer-settings')).toBeNull();
    expect(screen.getByTestId('drawer-newtab-back')).toBeTruthy();
  });

  // Settings is a sub-surface under a back header, so another view is one back press
  // away rather than one tap on a switcher: the same depth as the New-tab chooser.
  it('has no switcher under Settings, and one back press reaches it again', () => {
    renderDrawer();
    tap(screen.getByTestId('drawer-settings'));
    expect(inSettings()).toBe(true);
    expect(screen.queryByTestId('drawer-view')).toBeNull();
    tap(settingsBack());
    expect(inSettings()).toBe(false);
    tap(screen.getByTestId('drawer-view-sessions'));
    expect(inSettings()).toBe(false);
  });
});

// ── The view switcher lives in the top row ────────────────────────────────────
// Owner decision (2026-10-25): it does not sit at the bottom. At the root views the
// top row is ONE line, gear · switcher · close, and the two sub-surfaces, which have a
// back header for their top control, draw no switcher at all.
describe('the view switcher in the top row', () => {
  const FOLLOWING = Node.DOCUMENT_POSITION_FOLLOWING;

  it('draws the top row as the gear, the switcher, then Close, in that order', () => {
    renderDrawer({ hostedViews: ['files', 'dictation'] });
    const top = document.querySelector('.drawer-top')!;
    expect([...top.children]).toEqual([
      screen.getByTestId('drawer-settings'),
      screen.getByTestId('drawer-view'),
      screen.getByTestId('drawer-close'),
    ]);
  });

  it('keeps the switcher out of the space above the footer', () => {
    renderDrawer({ hostedViews: ['files', 'dictation'] });
    const nav = screen.getByTestId('drawer');
    const switcher = screen.getByTestId('drawer-view');
    const footer = nav.querySelector('.drawer-footer')!;
    expect(nav.querySelector('.drawer-views')).toBeNull();
    // The list is what sits above the footer now; the switcher is up in the top row.
    const list = nav.querySelector('.drawer-sessions')!;
    expect(footer.previousElementSibling).toBe(list);
    expect(switcher.compareDocumentPosition(list) & FOLLOWING).toBeTruthy();
    expect(switcher.closest('.drawer-footer')).toBeNull();
  });

  it('is drawn in a hosted view too, with that view selected', () => {
    render(
      <SessionDrawer
        {...baseProps({ hostedViews: ['files'] })}
        view="files"
        viewContent={<div />}
      />,
    );
    expect(screen.getByTestId('drawer-view').closest('.drawer-top')).not.toBeNull();
    expect(screen.getByTestId('drawer-view-files')).toHaveAttribute('data-state', 'on');
  });

  it('is not drawn under Settings, which has its own back header', () => {
    renderDrawer();
    expect(screen.queryByTestId('drawer-view')).not.toBeNull();
    tap(screen.getByTestId('drawer-settings'));
    expect(inSettings()).toBe(true);
    expect(screen.queryByTestId('drawer-view')).toBeNull();
    expect(screen.queryByTestId('drawer-view-sessions')).toBeNull();
    expect(settingsBack()).toBeTruthy();
  });

  it('is not drawn under the New-tab chooser, which has its own back header', () => {
    const view = render(<SessionDrawer {...baseProps()} />);
    expect(screen.queryByTestId('drawer-view')).not.toBeNull();
    view.rerender(<SessionDrawer {...baseProps()} newTabContent={<div />} />);
    expect(screen.queryByTestId('drawer-view')).toBeNull();
    expect(screen.getByTestId('drawer-newtab-back')).toBeTruthy();
  });

  it('comes back with the root: Settings, then back, shows it again', () => {
    renderDrawer();
    tap(screen.getByTestId('drawer-settings'));
    tap(settingsBack());
    expect(screen.getByTestId('drawer-view').closest('.drawer-top')).not.toBeNull();
  });
});

// ── The top switcher, as it cascades ──────────────────────────────────────────
// Two things the owner reported: the unselected icons read as disabled (the kit's
// `--t-subtext` on the drawer's mantle), and — found while planning — hovering the
// SELECTED segment put pale text on the accent fill, because the kit's
// `.ui-seg-item:not(:disabled):hover` out-specifies its own selected rule. happy-dom
// resolves no cascade, so every rule of every stylesheet is matched against the
// rendered segment and ranked by importance, specificity and source order, once with
// the kit's sheet loaded before everything else and once after. Interaction states
// are evaluated by hand: a rule naming `:hover` or `:active` counts only in a state
// that has it (a press on a pointer device also hovers).
type Specificity = [number, number, number];
type PointerState = 'rest' | 'hover' | 'active';

const bySpecificity = (a: Specificity, b: Specificity): number =>
  a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** Selectors Level 4 specificity: `:not/:is/:has` take their most specific argument, `:where` nothing. */
const specificityOf = (selector: string): Specificity => {
  const total: Specificity = [0, 0, 0];
  let rest = selector;
  for (let previous = ''; previous !== rest;) {
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
  }
  // An attribute's value can hold a `.` or `#`, so attributes are counted and removed first.
  const attributes = rest.match(/\[[^\]]*\]/g)?.length ?? 0;
  rest = rest.replace(/\[[^\]]*\]/g, ' ');
  total[0] += rest.match(/#[\w-]+/g)?.length ?? 0;
  total[1] += attributes + (rest.match(/\.[\w-]+|(?<!:):(?!:)[\w-]+/g)?.length ?? 0);
  total[2] += rest.match(/::[\w-]+|(?:^|[\s>+~])[a-z][\w-]*/gi)?.length ?? 0;
  return total;
};

interface Declared {
  selector: string;
  value: string;
  specificity: Specificity;
  important: boolean;
  order: number;
}

const SRC_DIR = join(__dirname, '..');
const ALL_SHEETS = readdirSync(SRC_DIR, { recursive: true, encoding: 'utf8' })
  .filter((file) => file.endsWith('.css'))
  .map((file) => file.split(sep).join('/'))
  .toSorted();

/** Every unconditional declaration of a property matching `props`, with `files` loaded in that order. */
const declaredAcross = (files: string[], props: RegExp): Declared[] => {
  const out: Declared[] = [];
  let order = 0;
  for (const file of files) {
    parse(readFileSync(join(SRC_DIR, file), 'utf8')).walkRules((rule) => {
      // Media queries and keyframes are not the rest state, and are not evaluated.
      for (let up = rule.parent; up && up.type !== 'root'; up = up.parent) {
        if (up.type === 'atrule') return;
      }
      rule.walkDecls(props, (decl) => {
        order += 1;
        for (const selector of rule.selectors) {
          out.push({
            selector,
            value: decl.value.replace(/\s+/g, ' ').trim(),
            specificity: specificityOf(selector),
            important: decl.important,
            order,
          });
        }
      });
    });
  }
  return out;
};

const POINTER_PSEUDOS = /:(hover|active|focus-visible|focus-within|focus)(?![\w-])/g;
const LIVE: Record<PointerState, string[]> = {
  rest: [],
  hover: ['hover'],
  active: ['hover', 'active'],
};

/** The declaration that wins on `el` in `state`, or null when nothing reaches it. */
const winnerOn = (el: Element, all: Declared[], state: PointerState): Declared | null => {
  let best: Declared | null = null;
  for (const d of all) {
    if (d.selector.includes('::')) continue;
    const wanted = [...d.selector.matchAll(POINTER_PSEUDOS)].map((m) => m[1] ?? '');
    if (wanted.some((name) => !LIVE[state].includes(name))) continue;
    const bare = d.selector.replace(POINTER_PSEUDOS, '').trim();
    let hit = false;
    try {
      hit = bare !== '' && el.matches(bare);
    } catch {
      // A selector happy-dom cannot parse is not one that styles a Segmented.
    }
    if (!hit) continue;
    const rank = best
      ? Number(d.important) - Number(best.important) ||
        bySpecificity(d.specificity, best.specificity) ||
        d.order - best.order
      : 1;
    if (rank > 0) best = d;
  }
  return best;
};

/** A custom property inherits: the nearest ancestor (or the element) that declares it wins. */
const inheritedFrom = (el: Element, all: Declared[]): Declared | null => {
  for (let at: Element | null = el; at; at = at.parentElement) {
    const found = winnerOn(at, all, 'rest');
    if (found) return found;
  }
  return null;
};

const unselected = () => screen.getByTestId('drawer-view-files');
const selected = () => screen.getByTestId('drawer-view-sessions');

describe('the top switcher, as it cascades', () => {
  const others = ALL_SHEETS.filter((file) => file !== 'ui/ui.css');
  const ORDERS: [string, string[]][] = [
    ['before every other stylesheet', ['ui/ui.css', ...others]],
    ['after every other stylesheet', [...others, 'ui/ui.css']],
  ];
  const COLOR = /^color$/;
  const FILL = /^background(?:-color)?$/;

  const renderSwitcher = () => renderDrawer({ hostedViews: ['files', 'dictation'] });

  describe.each(ORDERS)('with ui.css loaded %s', (_, files) => {
    const colour = declaredAcross(files, COLOR);
    const fill = declaredAcross(files, FILL);

    it.each(['rest', 'hover', 'active'] as const)(
      'draws the selected segment in the accent ink on the accent fill, %s',
      (state) => {
        renderSwitcher();
        expect(selected()).toHaveAttribute('data-state', 'on');
        expect(winnerOn(selected(), colour, state)?.value, `${state} colour`).toBe(
          'var(--t-accent-ink)',
        );
        expect(winnerOn(selected(), fill, state)?.value, `${state} fill`).toBe('var(--t-accent)');
      },
    );

    it('draws an unselected segment in the strip’s inactive text, brightening on hover and press', () => {
      renderSwitcher();
      expect(unselected()).toHaveAttribute('data-state', 'off');
      expect(winnerOn(unselected(), colour, 'rest')?.value).toBe('var(--pill-text)');
      expect(winnerOn(unselected(), colour, 'hover')?.value).toBe('var(--t-text)');
      expect(winnerOn(unselected(), colour, 'active')?.value).toBe('var(--t-text)');
    });

    it('leaves every other Segmented on the kit’s own colours', () => {
      render(
        <Segmented
          label="Elsewhere"
          value="a"
          onValueChange={() => {}}
          options={[
            { value: 'a', label: 'A' },
            { value: 'b', label: 'B' },
          ]}
          data-testid="elsewhere"
        />,
      );
      const off = screen.getByTestId('elsewhere-b');
      const on = screen.getByTestId('elsewhere-a');
      expect(winnerOn(off, colour, 'rest')?.value).toBe('var(--t-subtext)');
      expect(winnerOn(off, colour, 'hover')?.value).toBe('var(--t-text)');
      expect(winnerOn(on, colour, 'rest')?.value).toBe('var(--t-accent-ink)');
    });

    // `--pill-text` is declared for the strip and the list. The switcher is in
    // neither, so a colour naming it would be an invalid value (and so fall back to
    // inherited text) unless the top row's scope declares it too.
    it('has a --pill-text in scope that is the strip’s own mix', () => {
      renderSwitcher();
      const tokens = declaredAcross(files, /^--pill-text$/);
      const inScope = inheritedFrom(unselected(), tokens);
      expect(inScope, 'no ancestor of the switcher declares --pill-text').not.toBeNull();
      const strip = tokens.find((d) => d.selector === '.session-tabs');
      expect(strip).toBeDefined();
      expect(inScope?.value).toBe(strip?.value);
    });
  });

  // The complaint was contrast, so the fix is held to a number: in every built-in
  // theme the unselected glyph sits further from the drawer's own ground (the
  // mantle) than the --t-subtext it replaces.
  it('reads further from the drawer ground than --t-subtext, in every built-in theme', () => {
    const m = /^color-mix\(in srgb, var\(--t-(\w+)\) ([\d.]+)%, var\(--t-(\w+)\)\)$/.exec(
      declsOf(INDEX_CSS, '.session-tabs').get('--pill-text') ?? '',
    );
    expect(m, '--pill-text is a two-token srgb mix').not.toBeNull();
    const [, toward, pct, from] = m!;
    expect(COLOR_PROFILES.length).toBeGreaterThan(5);
    for (const profile of COLOR_PROFILES) {
      const t = deriveUiTokens(profile) as unknown as Record<string, number>;
      const pill = mix(t[from!]!, t[toward!]!, Number(pct) / 100);
      const away = (n: number) => Math.abs(luminance(n) - luminance(t['mantle']!));
      expect(away(pill), profile.id).toBeGreaterThan(away(t['subtext']!));
    }
  });
});

// ── The top buttons ───────────────────────────────────────────────────────────
describe('the top buttons', () => {
  it('Close closes through onClose, with no request attached', () => {
    const p = renderDrawer();
    fireEvent.pointerDown(screen.getByTestId('drawer-close'));
    expect(p.onClose).toHaveBeenCalledTimes(1);
    expect(p.onClose).toHaveBeenCalledWith();
  });

  it('Settings names itself and opens the settings view', () => {
    renderDrawer();
    const button = screen.getByRole('button', { name: 'Settings' });
    expect(button).toBe(screen.getByTestId('drawer-settings'));
    expect(button.querySelector('svg')?.innerHTML).toBe(iconPaths('settings'));
    fireEvent.pointerDown(button);
    expect(inSettings()).toBe(true);
  });

  // Both are focusable buttons, so Enter, Space and an assistive-tech click reach
  // them as well; a pointer press (down, up, then its click) acts once.
  describe('as buttons', () => {
    beforeEach(() => vi.useRealTimers());

    it.each([
      ['Enter', '{Enter}'],
      ['Space', ' '],
    ])('Close acts once on %s', async (_, key) => {
      const p = renderDrawer();
      screen.getByTestId('drawer-close').focus();
      await user().keyboard(key);
      expect(p.onClose).toHaveBeenCalledTimes(1);
    });

    it('Settings acts on Enter', async () => {
      renderDrawer();
      screen.getByTestId('drawer-settings').focus();
      await user().keyboard('{Enter}');
      expect(inSettings()).toBe(true);
    });

    it('Settings acts on Space, and on a click with no pointer press before it', async () => {
      renderDrawer();
      screen.getByTestId('drawer-settings').focus();
      await user().keyboard(' ');
      expect(inSettings()).toBe(true);
      fireEvent.pointerDown(settingsBack());
      expect(inSettings()).toBe(false);
      act(() => screen.getByTestId('drawer-settings').click());
      expect(inSettings()).toBe(true);
    });

    it('Close acts once for a click with no pointer press before it, and once for a real press', () => {
      const p = renderDrawer();
      const close = screen.getByTestId('drawer-close');
      act(() => close.click());
      expect(p.onClose).toHaveBeenCalledTimes(1);
      fireEvent.pointerDown(close);
      fireEvent.pointerUp(close);
      fireEvent.click(close, { detail: 1 });
      expect(p.onClose).toHaveBeenCalledTimes(2);
    });
  });
});

// ── The scrim, and what moves on which tier ───────────────────────────────────
describe('the scrim', () => {
  it('is open while the drawer is, and a press on it closes through onClose()', () => {
    const p = renderDrawer();
    const scrim = screen.getByTestId('drawer-scrim');
    expect(scrim).toHaveClass('open');
    fireEvent.pointerDown(scrim);
    expect(p.onClose).toHaveBeenCalledTimes(1);
    expect(p.onClose).toHaveBeenCalledWith();
  });

  // The scrim closes the drawer as the finger lands, which uncovers the terminal
  // under it. The browser hit-tests the rest of the tap after the release, so its
  // mouse events and its click land on the terminal, which under mouse reporting
  // turns them into a click report to tmux (it can move the focused pane).
  it('closes the drawer, and the rest of its tap reaches nothing on the terminal under it', () => {
    const props = baseProps();
    const terminal = { click: vi.fn(), mouseDown: vi.fn(), mouseUp: vi.fn() };
    const Host = () => {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button
            data-testid="terminal"
            onClick={terminal.click}
            onMouseDown={terminal.mouseDown}
            onMouseUp={terminal.mouseUp}
          >
            terminal
          </button>
          <SessionDrawer {...props} open={open} onClose={() => setOpen(false)} />
        </>
      );
    };
    render(<Host />);
    const touch = { pointerId: 1, pointerType: 'touch' };
    fireEvent.pointerDown(screen.getByTestId('drawer-scrim'), touch);
    expect(screen.getByTestId('drawer')).not.toHaveClass('open');
    const under = screen.getByTestId('terminal');
    fireEvent.pointerUp(under, touch);
    fireEvent.mouseDown(under, { detail: 1 });
    fireEvent.mouseUp(under, { detail: 1 });
    fireEvent.click(under, { detail: 1 });
    expect(terminal.mouseDown).not.toHaveBeenCalled();
    expect(terminal.mouseUp).not.toHaveBeenCalled();
    expect(terminal.click).not.toHaveBeenCalled();

    // A later, separate tap is the user's own, and reaches it.
    fireEvent.pointerDown(under, { pointerId: 2, pointerType: 'touch' });
    fireEvent.pointerUp(under, { pointerId: 2, pointerType: 'touch' });
    fireEvent.click(under, { detail: 1 });
    expect(terminal.click).toHaveBeenCalledTimes(1);
  });

  /** A drawer the host really closes, over a stand-in for the terminal it uncovers. */
  const overTerminal = () => {
    const props = baseProps();
    const terminal = { click: vi.fn(), mouseDown: vi.fn(), mouseUp: vi.fn() };
    const Host = () => {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button
            data-testid="terminal"
            onClick={terminal.click}
            onMouseDown={terminal.mouseDown}
            onMouseUp={terminal.mouseUp}
          >
            terminal
          </button>
          <SessionDrawer {...props} open={open} onClose={() => setOpen(false)} />
        </>
      );
    };
    render(<Host />);
    return { terminal, under: () => screen.getByTestId('terminal') };
  };

  // The scrim acts as the finger lands, so a long hold puts the release, and the
  // click behind it, well past any window measured from the press.
  it('still swallows the click of a press held for five seconds', () => {
    const { terminal, under } = overTerminal();
    const touch = { pointerId: 1, pointerType: 'touch' };
    fireEvent.pointerDown(screen.getByTestId('drawer-scrim'), touch);
    expect(screen.getByTestId('drawer')).not.toHaveClass('open');
    act(() => void vi.advanceTimersByTime(5_000));
    fireEvent.pointerUp(under(), touch);
    fireEvent.mouseDown(under(), { detail: 1 });
    fireEvent.mouseUp(under(), { detail: 1 });
    fireEvent.click(under(), { detail: 1 });
    expect(terminal.mouseDown).not.toHaveBeenCalled();
    expect(terminal.mouseUp).not.toHaveBeenCalled();
    expect(terminal.click).not.toHaveBeenCalled();
  });

  // A mouse's pointerdown is prevented, so the browser sends no mousedown or
  // mouseup after it, but the click still comes and lands on the terminal.
  it('swallows the click of a mouse press too, and not the next one', () => {
    const { terminal, under } = overTerminal();
    const mouse = { pointerId: 1, pointerType: 'mouse' };
    fireEvent.pointerDown(screen.getByTestId('drawer-scrim'), mouse);
    expect(screen.getByTestId('drawer')).not.toHaveClass('open');
    fireEvent.pointerUp(under(), mouse);
    fireEvent.click(under(), { detail: 1 });
    expect(terminal.click).not.toHaveBeenCalled();

    fireEvent.pointerDown(under(), { pointerId: 2, pointerType: 'mouse' });
    fireEvent.pointerUp(under(), { pointerId: 2, pointerType: 'mouse' });
    fireEvent.click(under(), { detail: 1 });
    expect(terminal.click).toHaveBeenCalledTimes(1);
  });

  it('stays mounted when closed, so there is something to fade out', () => {
    renderDrawer({ open: false });
    expect(screen.getByTestId('drawer-scrim')).not.toHaveClass('open');
    expect(screen.getByTestId('drawer')).not.toHaveClass('open');
  });
});

// The drawer never blurs `#mobile-kbd` itself, so a keyboard that was up when it
// opened is still up when it closes: the scrim, the top buttons, the footer and the
// switcher take their press with the default prevented, which is what keeps focus.
// (A control inside the scrolling list does not, on touch: that would cancel the pan.)
describe('the soft keyboard', () => {
  let kbd: HTMLTextAreaElement;
  beforeEach(() => {
    kbd = document.createElement('textarea');
    kbd.id = 'mobile-kbd';
    document.body.append(kbd);
    kbd.focus();
  });
  afterEach(() => kbd.remove());

  it.each([
    'drawer-scrim',
    'drawer-close',
    'drawer-settings',
    'drawer-upload',
    'drawer-download',
    'drawer-dictate',
    'drawer-upload-images',
    'drawer-view-sessions',
  ])('a touch press on %s is default-prevented, and #mobile-kbd keeps focus', (id) => {
    renderDrawer();
    const notPrevented = fireEvent.pointerDown(screen.getByTestId(id), {
      pointerId: 1,
      pointerType: 'touch',
    });
    expect(notPrevented).toBe(false);
    expect(document.activeElement).toBe(kbd);
  });

  it('is neither blurred nor refocused by the drawer opening and closing', () => {
    const p = baseProps({ open: false });
    const view = render(<SessionDrawer {...p} />);
    view.rerender(<SessionDrawer {...p} open />);
    expect(document.activeElement).toBe(kbd);
    view.rerender(<SessionDrawer {...p} open={false} />);
    expect(document.activeElement).toBe(kbd);
  });
});

// The test above reads only the pointerdown's return value, which is all a control
// that acts on pointerdown can leak through. A control in the list acts on the
// pointer going UP and leaves the pointerdown alone so the list can pan, and then
// a touch's compatibility mousedown arrives AFTER the release and moves focus
// unless something took it. So this runs the browser's whole sequence
// (`browserPress`) on every control of the drawer with `#mobile-kbd` focused, touch
// and mouse, and asks that the press acted exactly once AND left focus put.
describe('the soft keyboard through a whole press', () => {
  let kbd: HTMLTextAreaElement;
  beforeEach(() => {
    kbd = document.createElement('textarea');
    kbd.id = 'mobile-kbd';
    document.body.append(kbd);
    kbd.focus();
  });
  afterEach(() => kbd.remove());

  type Over = Partial<Parameters<typeof SessionDrawer>[0]>;
  type Props = ReturnType<typeof baseProps>;
  const CONTROLS: [string, () => Over, (p: Props) => void][] = [
    ['drawer-scrim', () => ({}), (p) => expect(p.onClose).toHaveBeenCalledTimes(1)],
    ['drawer-close', () => ({}), (p) => expect(p.onClose).toHaveBeenCalledTimes(1)],
    ['drawer-upload', () => ({}), (p) => expect(p.actions.uploadFile).toHaveBeenCalledTimes(1)],
    ['drawer-download', () => ({}), (p) => expect(p.actions.downloadFile).toHaveBeenCalledTimes(1)],
    ['drawer-dictate', () => ({}), (p) => expect(p.actions.dictate).toHaveBeenCalledTimes(1)],
    [
      'drawer-upload-images',
      () => ({}),
      (p) => expect(p.actions.uploadImages).toHaveBeenCalledTimes(1),
    ],
    ['drawer-new', () => ({}), (p) => expect(p.onCreate).toHaveBeenCalledTimes(1)],
    [
      'drawer-view-files',
      () => ({ hostedViews: ['files'], view: 'sessions', onView: vi.fn() }),
      (p) => expect(p.onView).toHaveBeenCalledTimes(1),
    ],
    ['drawer-session-1', () => ({}), (p) => expect(p.onSwitch).toHaveBeenCalledTimes(1)],
    [
      'drawer-group-g1',
      () => ({ tabs: GROUPED_TABS, groups: GROUPS, onToggleGroup: vi.fn() }),
      (p) => expect(p.onToggleGroup).toHaveBeenCalledTimes(1),
    ],
  ];

  it.each(
    CONTROLS.flatMap(([id, over, acted]) =>
      (['touch', 'mouse'] as const).map((pointerType) => [id, pointerType, over, acted] as const),
    ),
  )(
    '%s: a whole %s press acts once and leaves #mobile-kbd focused',
    (id, pointerType, over, acted) => {
      const p = renderDrawer(over());
      browserPress(screen.getByTestId(id), pointerType);
      acted(p);
      expect(document.activeElement).toBe(kbd);
    },
  );

  // The table above presses one segment. This walks the whole switcher, now in the
  // top row, the way a thumb does, each press landing on what the last one drew.
  it.each(['touch', 'mouse'] as const)(
    'the top switcher: a %s tap through Explorer, Dictation and Sessions never takes focus',
    (pointerType) => {
      renderDrawer({ hostedViews: ['files', 'dictation'] });
      const top = document.querySelector('.drawer-top')!;
      for (const view of ['files', 'dictation', 'sessions'] as const) {
        const item = screen.getByTestId(`drawer-view-${view}`);
        expect(top.contains(item), view).toBe(true);
        browserPress(item, pointerType);
        expect(item, view).toHaveAttribute('data-state', 'on');
        expect(document.activeElement, view).toBe(kbd);
      }
    },
  );

  // Without this the table could pass for the wrong reason: it would hold for a
  // harness whose mousedown never moved focus at all.
  it.each(['touch', 'mouse'] as const)(
    'the harness itself: a %s press on a control nothing guards does take focus',
    (pointerType) => {
      render(<button data-testid="bare">bare</button>);
      browserPress(screen.getByTestId('bare'), pointerType);
      expect(document.activeElement).toBe(screen.getByTestId('bare'));
    },
  );
});

describe('the drawer stylesheet', () => {
  // The strip is the scrim showing past the drawer's edge, so the scrim must span the
  // viewport UNDER the drawer and the drawer must stop short of the left edge.
  it('lets the scrim reach the strip: it spans the viewport, below a drawer anchored right', () => {
    const scrim = declsOf(INDEX_CSS, '.drawer-scrim');
    const drawer = declsOf(INDEX_CSS, '.drawer');
    expect(scrim.get('position')).toBe('fixed');
    expect(scrim.get('inset')).toBe('0');
    expect(Number(scrim.get('z-index'))).toBeLessThan(Number(drawer.get('z-index')));
    expect(drawer.get('position')).toBe('fixed');
    expect(drawer.get('left')).toBeUndefined();
    // 44px is the touch-target floor.
    expect(Number.parseInt(drawer.get('--drawer-strip') ?? '', 10)).toBeGreaterThanOrEqual(44);
  });

  it('leaves a 44px scrim strip: the drawer is all but that wide, from the right edge', () => {
    const drawer = declsOf(INDEX_CSS, '.drawer');
    expect(drawer.get('--drawer-strip')).toBe('44px');
    expect(drawer.get('width')).toBe('calc(100% - var(--drawer-strip))');
    expect(drawer.get('right')).toBe('0');
    // Still bounded by the visible viewport, so the footer clears the keyboard.
    expect(drawer.get('top')).toBe('var(--app-top, 0)');
    expect(drawer.get('height')).toBe('var(--app-height, 100dvh)');
    expect(INDEX_CSS).not.toContain('min(78vw');
  });

  it('dims with the same token mix the kit Dialog overlay uses, and is inert until open', () => {
    const scrim = declsOf(INDEX_CSS, '.drawer-scrim');
    expect(scrim.get('background')).toBe('color-mix(in srgb, var(--t-base) 72%, transparent)');
    expect(scrim.get('pointer-events')).toBe('none');
    expect(scrim.get('opacity')).toBe('0');
    const open = declsOf(INDEX_CSS, '.drawer-scrim.open');
    expect(open.get('pointer-events')).toBe('auto');
    expect(open.get('opacity')).toBe('1');
  });

  it('fades the scrim in on the surface tier and out on the micro tier', () => {
    expect(declsOf(INDEX_CSS, '.drawer-scrim.open').get('transition')).toBe(
      'opacity var(--mo-surface) var(--mo-ease)',
    );
    expect(declsOf(INDEX_CSS, '.drawer-scrim').get('transition')).toBe(
      'opacity var(--mo-micro) ease',
    );
  });

  it('slides the drawer on the surface tier in and the micro tier out, not 0.18s', () => {
    expect(declsOf(INDEX_CSS, '.drawer.open').get('transition')).toBe(
      'transform var(--mo-surface) var(--mo-ease)',
    );
    expect(declsOf(INDEX_CSS, '.drawer').get('transition')).toBe('transform var(--mo-micro) ease');
    const drawerSection = INDEX_CSS.slice(
      INDEX_CSS.indexOf('/* ── Session drawer (mobile'),
      INDEX_CSS.indexOf('/* ── Dictation ──'),
    );
    expect(drawerSection).not.toMatch(/\b0?\.18s\b/);
    // Every duration in the drawer is a token.
    for (const [, value] of drawerSection.matchAll(/transition(?:-duration)?:([^;]+);/g)) {
      expect(value, value).not.toMatch(/\d(?:ms|s)\b/);
    }
  });

  it('has no slide and no fade under reduced motion', () => {
    for (const selector of ['.drawer', '.drawer.open', '.drawer-scrim', '.drawer-scrim.open']) {
      expect(declsOf(INDEX_CSS, selector, true).get('transition'), selector).toBe('none');
    }
  });

  it('declares no colour literal in any drawer rule: every colour is a token', () => {
    const colours = [...INDEX_CSS.matchAll(/\.drawer[^{}]*\{[^}]*\}/g)].flatMap((m) =>
      [...m[0].matchAll(/#[0-9a-f]{3,8}\b|rgba?\(/gi)].map((c) => c[0]),
    );
    expect(colours).toEqual([]);
  });

  // One box with two jobs, so a drag costs the list no height: `+ New tab` at rest, the
  // top level's drop area while a row is lifted — as tall as a row, never taller than
  // the tail, and hit-tested by coordinates, so it takes no pointer events itself.
  it('shows the root area only while dragging, over `+ New tab`, at least one row tall', () => {
    const area = declsOf(INDEX_CSS, '.drawer-root-drop');
    expect(area.get('visibility')).toBe('hidden');
    expect(area.get('position')).toBe('absolute');
    expect(area.get('inset')).toBe('0');
    expect(area.get('pointer-events')).toBe('none');
    expect(
      declsOf(INDEX_CSS, '.drawer-sessions.dragging .drawer-root-drop').get('visibility'),
    ).toBe('visible');
    expect(declsOf(INDEX_CSS, '.drawer-sessions.dragging .drawer-new').get('visibility')).toBe(
      'hidden',
    );
    expect(declsOf(INDEX_CSS, '.drawer-tail').get('position')).toBe('relative');
    // The tail is as tall as `+ New tab`, which is as tall as a row.
    expect(declsOf(INDEX_CSS, '.drawer-new').get('min-height')).toBe('var(--ctl-h)');
    expect(declsOf(INDEX_CSS, '.drawer-new').get('min-height')).toBe(
      declsOf(INDEX_CSS, '.drawer-session').get('min-height'),
    );
  });

  it('claims the vertical pan for the list and the horizontal move for the swipe', () => {
    expect(declsOf(INDEX_CSS, '.drawer-session').get('touch-action')).toBe('pan-y');
    expect(declsOf(INDEX_CSS, '.drawer-group').get('touch-action')).toBe('pan-y');
  });
});

describe('kit controls hosted in the drawer', () => {
  // The kit sizes its controls off --ctl-h itself (28px on desktop, 36px under the
  // mobile class), so a Button, Input, Select or IconButton the drawer hosts is
  // already the drawer's control height. The drawer used to restate that in rules
  // of its own, because the kit read --mbtn-h (30px, off the scale); with the kit
  // on the token those rules would only be a second place to keep in step.
  const KIT_CONTROL = /\.ui-(btn|icon-btn|input|select-trigger)\b/;
  const SIZE = new Set(['min-height', 'height', 'width']);

  it('are resized by no drawer rule', () => {
    const overrides: string[] = [];
    for (const css of [INDEX_CSS, VIEWS_CSS]) {
      parse(css).walkRules((rule) => {
        if (!rule.selectors.some((s) => s.includes('.drawer') && KIT_CONTROL.test(s))) return;
        rule.walkDecls((d) => {
          if (SIZE.has(d.prop)) overrides.push(`${rule.selector} { ${d.prop}: ${d.value} }`);
        });
      });
    }
    expect(overrides).toEqual([]);
  });

  it('size every drawer-owned control off --ctl-h, never --mbtn-h', () => {
    const consumers: string[] = [];
    for (const css of [INDEX_CSS, VIEWS_CSS]) {
      parse(css).walkRules((rule) => {
        if (rule.parent?.type === 'atrule' || !rule.selector.startsWith('.drawer')) return;
        rule.walkDecls((decl) => {
          if (decl.prop !== '--mbtn-h' && decl.value.includes('--mbtn-h')) {
            consumers.push(`${rule.selector} { ${decl.prop}: ${decl.value} }`);
          }
        });
      });
    }
    expect(consumers).toEqual([]);
  });

  // The pin existed only to hold the kit's fallback at 30px in here; nothing in
  // the kit reads the variable now, so a pin would be a value nobody consumes.
  it('pins no --mbtn-h on the drawer, and the kit reads none', () => {
    expect(declsOf(INDEX_CSS, '.drawer').has('--mbtn-h')).toBe(false);
    const readers: string[] = [];
    parse(UI_CSS).walkRules((rule) => {
      rule.walkDecls((d) => {
        if (!d.value.includes('--mbtn-h')) return;
        readers.push(`${rule.selector} { ${d.prop}: ${d.value} }`);
      });
    });
    expect(readers).toEqual([]);
  });

  // The rules above are read as text; this renders the REAL kit elements inside
  // each surface the drawer hosts and resolves the size the kit's own rules give
  // them, so a renamed kit class or a size moved out of the kit fails here
  // instead of on a phone.
  describe('take the control height from the kit, in every hosted surface', () => {
    const hosted = (
      <>
        <Button data-testid="h-btn">Go</Button>
        <Button size="sm" data-testid="h-btn-sm">
          Go
        </Button>
        <IconButton label="One" data-testid="h-icon">
          <Icon name="plus" />
        </IconButton>
        <IconButton label="Two" size="sm" data-testid="h-icon-sm">
          <Icon name="plus" />
        </IconButton>
        <Input aria-label="Filter" data-testid="h-input" />
        <Select
          aria-label="Pick"
          value="a"
          onChange={() => {}}
          options={[{ value: 'a', label: 'A' }]}
          data-testid="h-select"
        />
      </>
    );

    /** The size declarations of every plain (no pseudo-class) rule in `css` that selects `el`, in source order. */
    const sizeOf = (css: string, el: Element, scope = ''): Map<string, string> => {
      const sized = new Map<string, string>();
      parse(css).walkRules((rule) => {
        if (rule.parent?.type === 'atrule') return;
        const hit = rule.selectors.some(
          (s) => s.startsWith(scope) && !s.includes(':') && el.matches(s),
        );
        if (!hit) return;
        rule.walkDecls((d) => {
          if (SIZE.has(d.prop)) sized.set(d.prop, d.value);
        });
      });
      return sized;
    };
    const kit = (id: string) => sizeOf(UI_CSS, screen.getByTestId(id));

    const CTL = 'var(--ctl-h)';
    const SMALL = 'calc(var(--ctl-h) - var(--sp-1))';
    const surfaces = {
      'the new-tab chooser': () =>
        renderDrawer({ newTabContent: <div>{hosted}</div>, onNewTabBack: vi.fn() }),
      'a hosted view (Explorer, Dictation)': () =>
        renderDrawer({
          view: 'files',
          hostedViews: ['files'],
          viewContent: <div>{hosted}</div>,
        }),
    };

    it.each(Object.keys(surfaces) as (keyof typeof surfaces)[])('%s', (name) => {
      surfaces[name]();
      const hostedIn = screen.getByTestId('h-btn').closest('.drawer');
      expect(hostedIn).toBe(screen.getByTestId('drawer'));

      expect(kit('h-btn').get('min-height')).toBe(CTL);
      expect([kit('h-icon').get('width'), kit('h-icon').get('height')]).toEqual([CTL, CTL]);
      expect(kit('h-input').get('min-height')).toBe(CTL);
      expect(kit('h-select').get('height')).toBe(CTL);
      // A small control stays small.
      expect(kit('h-btn-sm').get('min-height')).toBe(SMALL);
      expect([kit('h-icon-sm').get('width'), kit('h-icon-sm').get('height')]).toEqual([
        SMALL,
        SMALL,
      ]);
      // And nothing scoped to the drawer reaches any of them.
      for (const id of ['h-btn', 'h-btn-sm', 'h-icon', 'h-icon-sm', 'h-input', 'h-select']) {
        expect(sizeOf(INDEX_CSS, screen.getByTestId(id), '.drawer').size, id).toBe(0);
      }
    });
  });

  it('gives every control the drawer draws itself the control height', () => {
    for (const selector of [
      '.drawer-session',
      '.drawer-group',
      '.drawer-new',
      '.drawer-action',
      '.drawer-back',
    ]) {
      expect(declsOf(INDEX_CSS, selector).get('min-height'), selector).toBe('var(--ctl-h)');
    }
    // The switcher takes the kit's own height (its OUTER box is --ctl-h), so the
    // drawer restates none: a full --ctl-h item made the box 6px too tall.
    expect(declsOf(VIEWS_CSS, '.drawer-views-seg .ui-seg-item').get('min-height')).toBeUndefined();
  });
});

// ── The footer and the picker hold ────────────────────────────────────────────
// Upload and Images close the drawer around a native picker that can take the IME
// with it, so the host keeps the layout held until the picker returns. That is only
// right if a picker really opened: the action runs FIRST and says so.
describe('footer pickers', () => {
  it.each([
    ['drawer-upload', 'uploadFile'],
    ['drawer-upload-images', 'uploadImages'],
  ] as const)('%s opens the picker first, then closes holding for it', (id, action) => {
    const p = renderDrawer();
    vi.mocked(p.actions[action]).mockReturnValue(true);
    fireEvent.pointerDown(screen.getByTestId(id));
    expect(p.onClose).toHaveBeenCalledTimes(1);
    expect(p.onClose).toHaveBeenCalledWith({ holdUntil: 'picker' });
    expect(vi.mocked(p.actions[action]).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(p.onClose).mock.invocationCallOrder[0]!,
    );
  });

  it.each([
    ['drawer-upload', 'uploadFile'],
    ['drawer-upload-images', 'uploadImages'],
  ] as const)('%s closes plainly when no picker opened (a toast, not a picker)', (id, action) => {
    const p = renderDrawer();
    vi.mocked(p.actions[action]).mockReturnValue(false);
    fireEvent.pointerDown(screen.getByTestId(id));
    expect(p.onClose).toHaveBeenCalledTimes(1);
    expect(p.onClose).toHaveBeenCalledWith();
  });

  it.each([
    ['drawer-download', 'downloadFile'],
    ['drawer-dictate', 'dictate'],
  ] as const)('%s closes plainly and acts', (id, action) => {
    const p = renderDrawer();
    fireEvent.pointerDown(screen.getByTestId(id));
    expect(p.onClose).toHaveBeenCalledWith();
    expect(p.actions[action]).toHaveBeenCalledTimes(1);
  });

  // The hold is asked for by what the action ANSWERED, never by the kind of tab in
  // front: an editor, a markdown or a web tab, and a terminal whose input is gone,
  // all answer false (they toast), and those must close like any other press.
  it.each([
    ['drawer-upload', 'uploadFile'],
    ['drawer-upload-images', 'uploadImages'],
  ] as const)(
    '%s asks for no hold over a non-terminal tab whose picker did not open',
    (id, action) => {
      const p = renderDrawer({ current: '1' }); // the web tab
      vi.mocked(p.actions[action]).mockReturnValue(false);
      fireEvent.pointerDown(screen.getByTestId(id));
      expect(p.onClose).toHaveBeenCalledTimes(1);
      expect(p.onClose).toHaveBeenCalledWith();
    },
  );

  it.each(['drawer-download', 'drawer-dictate'] as const)(
    '%s never asks for a hold, whatever the tab',
    (id) => {
      const p = renderDrawer({ current: '1' });
      fireEvent.pointerDown(screen.getByTestId(id));
      expect(p.onClose).not.toHaveBeenCalledWith({ holdUntil: 'picker' });
    },
  );
});

// Every way to press a footer cell reaches the same place: the action first, then one
// close, held only if a picker is up. A route that closed before the action, or acted
// twice (a press and its own trailing click), would open two pickers or hold for none.
describe('footer pickers by every route', () => {
  beforeEach(() => vi.useRealTimers());

  const ROUTES: [string, (cell: HTMLElement) => void | Promise<void>][] = [
    [
      'Enter',
      async (cell) => {
        cell.focus();
        await user().keyboard('{Enter}');
      },
    ],
    [
      'Space',
      async (cell) => {
        cell.focus();
        await user().keyboard(' ');
      },
    ],
    ['a click with no pointer press', (cell) => void act(() => cell.click())],
    [
      'a pointer press and its trailing click',
      (cell) => {
        fireEvent.pointerDown(cell);
        fireEvent.pointerUp(cell);
        fireEvent.click(cell, { detail: 1 });
      },
    ],
  ];

  const CELLS = [
    ['drawer-upload', 'uploadFile'],
    ['drawer-upload-images', 'uploadImages'],
  ] as const;

  describe.each(CELLS)('%s', (id, action) => {
    it.each(ROUTES)('on %s: a picker that opened holds the layout, once', async (_, route) => {
      const p = renderDrawer();
      vi.mocked(p.actions[action]).mockReturnValue(true);
      await route(screen.getByTestId(id));
      expect(p.actions[action]).toHaveBeenCalledTimes(1);
      expect(p.onClose).toHaveBeenCalledTimes(1);
      expect(p.onClose).toHaveBeenCalledWith({ holdUntil: 'picker' });
      expect(vi.mocked(p.actions[action]).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(p.onClose).mock.invocationCallOrder[0]!,
      );
    });

    it.each(ROUTES)('on %s: no picker means a plain close, once', async (_, route) => {
      const p = renderDrawer();
      vi.mocked(p.actions[action]).mockReturnValue(false);
      await route(screen.getByTestId(id));
      expect(p.actions[action]).toHaveBeenCalledTimes(1);
      expect(p.onClose).toHaveBeenCalledTimes(1);
      expect(p.onClose).toHaveBeenCalledWith();
    });
  });
});

// Upload and Download reach the browser's picker and its save by calling `click()`
// on an <input type="file"> or a link from INSIDE the press that is acting. That
// synthetic click carries no count, so the press's mark must let it through, while
// the gesture's own trailing click, which does carry one, must still be swallowed.
describe('a click the action makes itself, inside its own press', () => {
  const touch = { pointerId: 1, pointerType: 'touch' };

  it.each([
    ['drawer-upload', 'uploadFile'],
    ['drawer-upload-images', 'uploadImages'],
    ['drawer-download', 'downloadFile'],
  ] as const)(
    '%s: it reaches its target once, and the press’s own click does not',
    (id, action) => {
      const picker = vi.fn();
      const clickPicker = () => void screen.getByTestId('picker').click();
      const props = baseProps({
        actions: {
          uploadFile: vi.fn(() => {
            clickPicker();
            return true;
          }),
          uploadImages: vi.fn(() => {
            clickPicker();
            return true;
          }),
          downloadFile: vi.fn(clickPicker),
          dictate: vi.fn(),
        },
      });
      render(
        <>
          <button data-testid="picker" onClick={picker}>
            picker
          </button>
          <SessionDrawer {...props} />
        </>,
      );
      const cell = screen.getByTestId(id);
      fireEvent.pointerDown(cell, touch);
      expect(picker).toHaveBeenCalledTimes(1);
      fireEvent.pointerUp(cell, touch);
      fireEvent.click(cell, { detail: 1 });
      expect(props.actions[action]).toHaveBeenCalledTimes(1);
      expect(picker).toHaveBeenCalledTimes(1);
    },
  );
});

// `+ New tab` is a `pressMove` control in the scrolling list. It acts when the
// pointer goes UP and answers a click as well, so for a real press the click that
// ends it is the one that must NOT act: `pressMove` takes every click that reaches
// it, and a press's own click stays away only because the press marked its
// gesture. Lose the mark and every pointer route below runs twice.
describe('+ New tab by every route', () => {
  beforeEach(() => vi.useRealTimers());

  const ROUTES: [string, (el: HTMLElement) => void | Promise<void>][] = [
    [
      'Enter',
      async (el) => {
        el.focus();
        await user().keyboard('{Enter}');
      },
    ],
    [
      'Space',
      async (el) => {
        el.focus();
        await user().keyboard(' ');
      },
    ],
    ['a click with no pointer press', (el) => void act(() => el.click())],
    ['a touch press with the mouse events a browser adds', (el) => void browserPress(el, 'touch')],
    ['a mouse press', (el) => void browserPress(el, 'mouse')],
  ];

  it.each(ROUTES)('acts once on %s', async (_, route) => {
    const p = renderDrawer();
    await route(screen.getByTestId('drawer-new'));
    expect(p.onCreate).toHaveBeenCalledTimes(1);
    expect(p.onClose).toHaveBeenCalledTimes(1); // a host with no chooser of its own
  });

  it('acts on nothing for a touch that moved past the slop: that is a scroll', () => {
    const p = renderDrawer();
    const button = screen.getByTestId('drawer-new');
    const at = { pointerId: 1, pointerType: 'touch', clientX: 40, clientY: 200 };
    fireEvent.pointerDown(button, at);
    fireEvent.pointerMove(button, { ...at, clientY: 150 });
    fireEvent.pointerUp(button, { ...at, clientY: 150 });
    expect(p.onCreate).not.toHaveBeenCalled();
  });

  // A mouse cannot pan, so a drag released on the control still ends in a click on
  // it, and that click is not an activation. The next click that is its own is.
  it('acts on nothing for a mouse drag released on it, nor for the click that ends it', () => {
    const p = renderDrawer();
    const button = screen.getByTestId('drawer-new');
    const at = { pointerId: 1, pointerType: 'mouse', clientX: 40, clientY: 40 };
    fireEvent.pointerDown(button, at);
    fireEvent.pointerMove(button, { ...at, clientX: 90 });
    fireEvent.pointerUp(button, { ...at, clientX: 90 });
    fireEvent.click(button, { detail: 1 });
    expect(p.onCreate).not.toHaveBeenCalled();

    act(() => button.click());
    expect(p.onCreate).toHaveBeenCalledTimes(1);
  });
});

// ── Row gestures ──────────────────────────────────────────────────────────────
// Driven the way the browser drives them: pointer events, and a long-press as time
// passing between a down and an up. happy-dom lays nothing out, so the boxes a drag
// reads are given: the list starts at LIST_TOP, every row is ROW_H tall in DOM order,
// and the list ends one row below the last (the tail: `+ New tab`, or the root area).
describe('row gestures', () => {
  const ROW_H = 40;
  const LIST_TOP = 100;

  // Five rows: a group header and its two members, then two top-level tabs.
  //   g:g1  100–140   t:0  140–180   t:1  180–220   t:2  220–260   t:3  260–300
  // and the list's own box is 100–340.
  const TREE_TABS: TabMeta[] = [
    { id: '0', kind: 'terminal', groupId: 'g1' },
    { id: '1', kind: 'terminal', groupId: 'g1' },
    { id: '2', kind: 'terminal' },
    { id: '3', kind: 'terminal' },
  ];
  const tree = (overrides: Partial<Parameters<typeof SessionDrawer>[0]> = {}) =>
    renderDrawer({ tabs: TREE_TABS, groups: GROUPS_G1, current: '2', ...overrides });
  const GROUPS_G1: TabGroup[] = [{ id: 'g1', name: 'dev', color: 'ansi3' }];

  const box = (top: number, height: number): DOMRect =>
    ({
      top,
      bottom: top + height,
      left: 0,
      right: 300,
      height,
      width: 300,
      x: 0,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;

  const setPointerCapture = vi.fn();
  let frames: FrameRequestCallback[] = [];
  const flushFrames = () =>
    act(() => {
      const run = frames;
      frames = [];
      for (const callback of run) callback(0);
    });

  beforeEach(() => {
    setPointerCapture.mockClear();
    Object.defineProperty(Element.prototype, 'setPointerCapture', {
      value: setPointerCapture,
      configurable: true,
      writable: true,
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('drawer-sessions')) {
          return box(LIST_TOP, (this.querySelectorAll('[data-row-key]').length + 1) * ROW_H);
        }
        const list = this.closest('.drawer-sessions');
        if (list && this.hasAttribute('data-row-key')) {
          const leaves = [...list.querySelectorAll('[data-row-key]')];
          return box(LIST_TOP + leaves.indexOf(this) * ROW_H, ROW_H);
        }
        return box(0, 0);
      },
    );
    frames = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => frames.push(cb));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(Element.prototype, 'setPointerCapture');
    Reflect.deleteProperty(navigator, 'vibrate');
  });

  const touch = (x: number, y: number) => ({
    pointerId: 1,
    pointerType: 'touch',
    clientX: x,
    clientY: y,
  });
  const down = (el: Element, x: number, y: number) => fireEvent.pointerDown(el, touch(x, y));
  const move = (el: Element, x: number, y: number) => fireEvent.pointerMove(el, touch(x, y));
  const up = (el: Element, x: number, y: number) => fireEvent.pointerUp(el, touch(x, y));
  const hold = (ms = 500) => act(() => void vi.advanceTimersByTime(ms));

  const tabRow = (id: string) => screen.getByTestId(`drawer-session-${id}`);
  const groupRow = () => screen.getByTestId('drawer-group-g1');
  const visualRow = (el: Element) => el.closest('.drawer-row') as HTMLElement;
  const list = () => document.querySelector('.drawer-sessions') as HTMLElement;
  const touchmove = (el: Element): boolean => {
    const event = new Event('touchmove', { bubbles: true, cancelable: true });
    el.dispatchEvent(event);
    return event.defaultPrevented;
  };

  describe('long-press', () => {
    it('arms at 450ms, with a tick of haptics, and opens the menu only on release', () => {
      const vibrate = vi.fn();
      Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true });
      const p = renderDrawer();
      const row = tabRow('1');
      down(row, 50, 0);
      hold(449);
      expect(visualRow(row)).not.toHaveClass('armed');
      expect(vibrate).not.toHaveBeenCalled();
      hold(1);
      expect(visualRow(row)).toHaveClass('armed');
      expect(vibrate).toHaveBeenCalledWith(8);
      expect(p.onTabMenu).not.toHaveBeenCalled(); // the menu waits for the release
      up(row, 50, 0);
      expect(p.onTabMenu).toHaveBeenCalledTimes(1);
      expect(p.onTabMenu).toHaveBeenCalledWith('1');
      expect(p.onSwitch).not.toHaveBeenCalled();
      expect(p.onClose).not.toHaveBeenCalled();
      expect(visualRow(row)).not.toHaveClass('armed');
    });

    it('tolerates a fingertip’s wobble: a hold that drifts 5px is still a hold', () => {
      const p = renderDrawer();
      const row = tabRow('1');
      down(row, 50, 0);
      move(row, 53, 4);
      hold();
      move(row, 52, 5);
      up(row, 52, 5);
      expect(p.onTabMenu).toHaveBeenCalledWith('1');
      expect(setPointerCapture).not.toHaveBeenCalled();
    });

    it('a tab opens no menu if the hold is cancelled by the browser', () => {
      const p = renderDrawer();
      const row = tabRow('1');
      down(row, 50, 0);
      hold();
      fireEvent.pointerCancel(row, touch(50, 0));
      expect(visualRow(row)).not.toHaveClass('armed');
      up(row, 50, 0); // a late up finds no press
      expect(p.onTabMenu).not.toHaveBeenCalled();
      expect(p.onSwitch).not.toHaveBeenCalled();
    });

    it('a long-pressed group header opens no menu: it has none', () => {
      const p = tree();
      down(groupRow(), 50, 120);
      hold();
      up(groupRow(), 50, 120);
      expect(p.onTabMenu).not.toHaveBeenCalled();
      expect(p.onToggleGroup).toBeUndefined();
    });

    it('a mouse arms the same way, and keeps focus where it was (pointerdown is prevented)', () => {
      const p = renderDrawer();
      const row = tabRow('1');
      const downEvent = new MouseEvent('pointerdown', { bubbles: true, cancelable: true });
      Object.assign(downEvent, { pointerId: 1, pointerType: 'mouse', clientX: 50, clientY: 0 });
      act(() => void row.dispatchEvent(downEvent));
      expect(downEvent.defaultPrevented).toBe(true);
      hold();
      up(row, 50, 0);
      expect(p.onTabMenu).toHaveBeenCalledWith('1');
    });
  });

  describe('a move before arming is a scroll', () => {
    it('starts no menu and no drag, and does not switch', () => {
      const p = renderDrawer({ onToggleGroup: vi.fn() });
      const row = tabRow('1');
      down(row, 50, 200);
      move(row, 50, 170);
      hold();
      expect(visualRow(row)).not.toHaveClass('armed');
      up(row, 50, 170);
      expect(p.onTabMenu).not.toHaveBeenCalled();
      expect(p.onSwitch).not.toHaveBeenCalled();
      expect(p.onMoveTab).not.toHaveBeenCalled();
      expect(setPointerCapture).not.toHaveBeenCalled();
    });

    it('is not a swipe either when it is mostly vertical, however far left it drifts later', () => {
      renderDrawer();
      const row = tabRow('1');
      down(row, 200, 200);
      move(row, 195, 150); // vertical first: the browser is panning
      move(row, 100, 150); // a leftward travel afterwards is the same gesture
      expect(visualRow(row)).not.toHaveClass('revealed');
    });

    it('cancels the long-press timer once it leaves the slop', () => {
      const vibrate = vi.fn();
      Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true });
      renderDrawer();
      const row = tabRow('1');
      down(row, 50, 200);
      move(row, 50, 215);
      hold();
      expect(vibrate).not.toHaveBeenCalled();
    });
  });

  // Pointer capture changes where events go; it does not stop the browser's pan. The
  // one non-passive listener is what takes the gesture, and ONLY once it is armed.
  describe('taking the gesture from the browser’s pan', () => {
    it('lets a touchmove through before arming, cancels it while armed and dragging, then lets go', () => {
      renderDrawer();
      const row = tabRow('1');
      down(row, 50, 200);
      expect(touchmove(row)).toBe(false); // pressed: still a scroll
      hold();
      expect(touchmove(row)).toBe(true); // armed
      move(row, 50, 150);
      expect(touchmove(row)).toBe(true); // dragging
      up(row, 50, 150);
      expect(touchmove(row)).toBe(false); // over: the list pans again
    });

    it('does not cancel a touchmove that is already uncancelable', () => {
      renderDrawer();
      const row = tabRow('1');
      down(row, 50, 200);
      hold();
      const event = new Event('touchmove', { bubbles: true, cancelable: false });
      // `defaultPrevented` cannot tell: it stays false for an uncancelable event whether
      // or not the handler tried. A browser logs an intervention for the attempt, so the
      // call itself is what must not happen.
      const prevent = vi.spyOn(event, 'preventDefault');
      row.dispatchEvent(event);
      expect(prevent).not.toHaveBeenCalled();
      // And the control: a cancelable one, in the same state, is prevented.
      const cancelable = new Event('touchmove', { bubbles: true, cancelable: true });
      const preventCancelable = vi.spyOn(cancelable, 'preventDefault');
      row.dispatchEvent(cancelable);
      expect(preventCancelable).toHaveBeenCalledTimes(1);
    });

    it('stops cancelling after pointercancel, touchcancel and touchend', () => {
      renderDrawer();
      const row = tabRow('1');
      for (const end of [
        () => fireEvent.pointerCancel(row, touch(50, 200)),
        () => row.dispatchEvent(new Event('touchcancel', { bubbles: true })),
        () => row.dispatchEvent(new Event('touchend', { bubbles: true })),
      ]) {
        down(row, 50, 200);
        hold();
        expect(touchmove(row)).toBe(true);
        act(() => void end());
        expect(touchmove(row)).toBe(false);
        expect(visualRow(row)).not.toHaveClass('armed');
      }
    });

    it('removes its listener on unmount', () => {
      const add = vi.spyOn(HTMLElement.prototype, 'addEventListener');
      const remove = vi.spyOn(HTMLElement.prototype, 'removeEventListener');
      const view = render(<SessionDrawer {...baseProps()} />);
      // React registers its own (passive) touchmove on the root; this one is ours.
      const added = add.mock.calls.filter(
        ([type, , options]) =>
          type === 'touchmove' && (options as AddEventListenerOptions)?.passive === false,
      );
      expect(added).toHaveLength(1);
      const [, listener] = added[0]!;
      view.unmount();
      expect(remove.mock.calls.some(([type, fn]) => type === 'touchmove' && fn === listener)).toBe(
        true,
      );
    });

    it('removes every listener it added on unmount, not just the touchmove', () => {
      const add = vi.spyOn(HTMLElement.prototype, 'addEventListener');
      const remove = vi.spyOn(HTMLElement.prototype, 'removeEventListener');
      const view = render(<SessionDrawer {...baseProps()} />);
      // React's own root listeners are registered on the container too; ours are on the list.
      const onList = add.mock.calls
        .map(([type, listener], i) => ({ type, listener, context: add.mock.contexts[i] }))
        .filter(({ type, context }) => type.startsWith('touch') && context === list());
      expect(onList.map(({ type }) => type).toSorted()).toEqual([
        'touchcancel',
        'touchend',
        'touchmove',
      ]);
      view.unmount();
      for (const { type, listener } of onList) {
        expect(
          remove.mock.calls.some(([t, fn]) => t === type && fn === listener),
          type,
        ).toBe(true);
      }
    });

    it('registers one non-passive touchmove listener on the list root, however often it re-renders', () => {
      const add = vi.spyOn(HTMLElement.prototype, 'addEventListener');
      const p = baseProps();
      const view = render(<SessionDrawer {...p} />);
      view.rerender(<SessionDrawer {...p} tabs={[...TABS, { id: '2', kind: 'terminal' }]} />);
      view.rerender(<SessionDrawer {...p} current="1" />);
      const nonPassive = add.mock.calls
        .map((call, i) => ({ call, context: add.mock.contexts[i] }))
        .filter(
          ({ call: [type, , options] }) =>
            type === 'touchmove' && (options as AddEventListenerOptions)?.passive === false,
        );
      expect(nonPassive).toHaveLength(1);
      expect(nonPassive[0]!.context).toBe(list());
    });

    // A press that has moved on is the browser's: a scroll is a pan, a swipe is a
    // horizontal move the list does not claim. Nothing there may be cancelled.
    it('lets a touchmove through once the press has moved on before arming, scroll or swipe', () => {
      renderDrawer();
      const row = tabRow('1');
      down(row, 200, 200);
      move(row, 200, 160); // vertical, past the slop: the list is panning
      expect(touchmove(row)).toBe(false);
      hold(); // the long-press timer died with the move: it never arms
      expect(touchmove(row)).toBe(false);
      up(row, 200, 160);

      down(row, 200, 100);
      move(row, 150, 100); // a swipe left
      expect(touchmove(row)).toBe(false);
      hold();
      expect(touchmove(row)).toBe(false);
      up(row, 150, 100);
    });

    it('cancels the pan anywhere in the list once armed, not only over the pressed row', () => {
      renderDrawer();
      down(tabRow('1'), 50, 0);
      hold();
      expect(touchmove(list())).toBe(true);
      expect(touchmove(tabRow('0'))).toBe(true);
      expect(touchmove(screen.getByTestId('drawer-new'))).toBe(true);
    });

    it('carries a broadcast mid-press: the hold, the cancel and the release all still hold', () => {
      const p = baseProps();
      const view = render(<SessionDrawer {...p} />);
      down(tabRow('1'), 50, 0);
      hold();
      view.rerender(<SessionDrawer {...p} tabs={[...TABS, { id: '2', kind: 'terminal' }]} />);
      expect(visualRow(tabRow('1'))).toHaveClass('armed');
      expect(touchmove(tabRow('1'))).toBe(true);
      up(tabRow('1'), 50, 0);
      expect(p.onTabMenu).toHaveBeenCalledWith('1');
    });

    it('arms nothing after the drawer unmounts mid-press', () => {
      const vibrate = vi.fn();
      Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true });
      const p = baseProps();
      const view = render(<SessionDrawer {...p} />);
      down(tabRow('1'), 50, 0);
      view.unmount();
      hold();
      expect(vibrate).not.toHaveBeenCalled();
      expect(p.onTabMenu).not.toHaveBeenCalled();
    });

    // The slop is 10px: a move of exactly that is still a hold, the next pixel is not.
    it('reads 10px as still holding and 11px as the start of a drag, once armed', () => {
      renderDrawer();
      const row = tabRow('1');
      down(row, 50, 100);
      hold();
      move(row, 50, 110);
      expect(setPointerCapture).not.toHaveBeenCalled();
      expect(visualRow(row)).toHaveClass('armed');
      move(row, 50, 111);
      expect(setPointerCapture).toHaveBeenCalledTimes(1);
      expect(visualRow(row)).toHaveClass('lifted');
    });

    it('reads 10px as still pressing and 11px as a scroll, before arming', () => {
      const p = renderDrawer();
      const row = tabRow('1');
      down(row, 50, 100);
      move(row, 50, 110);
      hold();
      expect(visualRow(row)).toHaveClass('armed'); // the timer survived 10px
      up(row, 50, 110);
      expect(p.onTabMenu).toHaveBeenCalledWith('1');

      down(row, 50, 100);
      move(row, 50, 111);
      hold();
      expect(visualRow(row)).not.toHaveClass('armed'); // 11px cancelled it
    });
  });

  // The pan belongs to the list: a touch pointerdown that is prevented cancels it, so
  // no press that starts in the list may prevent one — and a mouse, which cannot pan,
  // is prevented so that focus stays where it was.
  describe('the pan', () => {
    it('is not cancelled by a touch pointerdown on a row, a header, `+ New tab` or Close', () => {
      tree({ onToggleGroup: vi.fn() });
      for (const target of [
        tabRow('2'),
        groupRow(),
        screen.getByTestId('drawer-new'),
        screen.getByTestId('drawer-row-close-2'),
      ]) {
        const notPrevented = fireEvent.pointerDown(target, touch(50, 120));
        expect(notPrevented, target.getAttribute('data-testid') ?? '').toBe(true);
        fireEvent.pointerCancel(target, touch(50, 120));
      }
    });

    it('is left alone by a touch pointerup that ends a scroll', () => {
      renderDrawer();
      const row = tabRow('1');
      down(row, 50, 200);
      move(row, 50, 160);
      expect(fireEvent.pointerUp(row, touch(50, 160))).toBe(true);
    });

    it('ends an unarmed press when the pointer leaves the list, so a late release acts on nothing', () => {
      const p = renderDrawer();
      const row = tabRow('1');
      down(row, 50, 0);
      hold();
      expect(visualRow(row)).toHaveClass('armed');
      fireEvent.pointerLeave(list(), touch(50, 0));
      expect(visualRow(row)).not.toHaveClass('armed');
      up(row, 50, 0);
      expect(p.onTabMenu).not.toHaveBeenCalled();
      expect(p.onSwitch).not.toHaveBeenCalled();
    });
  });

  // Another window can close the pressed tab, or dissolve the pressed group, while the
  // finger is still down. App reads a switch to an id it does not have as a FRESH
  // terminal, so a release that acted on the saved key re-spawned the tab just closed.
  describe('a press whose row leaves the tree', () => {
    const release = vi.fn();
    beforeEach(() => {
      release.mockClear();
      Object.defineProperty(Element.prototype, 'releasePointerCapture', {
        value: release,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(Element.prototype, 'hasPointerCapture', {
        value: () => setPointerCapture.mock.calls.length > release.mock.calls.length,
        configurable: true,
        writable: true,
      });
    });
    afterEach(() => {
      Reflect.deleteProperty(Element.prototype, 'releasePointerCapture');
      Reflect.deleteProperty(Element.prototype, 'hasPointerCapture');
    });
    // TABS is 0 (current) and 1: pressing 1 is pressing an INACTIVE tab.
    const WITHOUT_1 = TABS.slice(0, 1);

    it('does not switch to it, or close the drawer, when the tap is released', () => {
      const p = baseProps();
      const view = render(<SessionDrawer {...p} />);
      down(tabRow('1'), 50, 0);
      view.rerender(<SessionDrawer {...p} tabs={WITHOUT_1} />);
      up(list(), 50, 0);
      expect(p.onSwitch).not.toHaveBeenCalled();
      expect(p.onClose).not.toHaveBeenCalled();
    });

    it('cancels the long-press timer: no arming, and no menu on release', () => {
      const vibrate = vi.fn();
      Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true });
      const p = baseProps();
      const view = render(<SessionDrawer {...p} />);
      down(tabRow('1'), 50, 0);
      view.rerender(<SessionDrawer {...p} tabs={WITHOUT_1} />);
      hold();
      expect(vibrate).not.toHaveBeenCalled();
      expect(document.querySelector('.drawer-row.armed')).toBeNull();
      up(list(), 50, 0);
      expect(p.onTabMenu).not.toHaveBeenCalled();
      expect(p.onSwitch).not.toHaveBeenCalled();
    });

    it('opens no menu for a row that was already armed, and gives the pan back', () => {
      const p = baseProps();
      const view = render(<SessionDrawer {...p} />);
      down(tabRow('1'), 50, 0);
      hold();
      expect(touchmove(list())).toBe(true); // armed: the pan is held
      view.rerender(<SessionDrawer {...p} tabs={WITHOUT_1} />);
      expect(touchmove(list())).toBe(false);
      up(list(), 50, 0);
      expect(p.onTabMenu).not.toHaveBeenCalled();
      expect(p.onSwitch).not.toHaveBeenCalled();
    });

    it('commits nothing for a drag whose row leaves mid-drag, even released without another move', () => {
      const p = baseProps({ tabs: TREE_TABS, groups: GROUPS_G1, current: '2' });
      const view = render(<SessionDrawer {...p} />);
      down(tabRow('3'), 50, 280);
      hold();
      move(tabRow('3'), 50, 225); // over t:2's top half: a drop the release would commit
      expect(document.querySelector('.drop-before')).not.toBeNull();
      expect(setPointerCapture).toHaveBeenCalledTimes(1);

      view.rerender(<SessionDrawer {...p} tabs={TREE_TABS.slice(0, 3)} />);
      expect(release).toHaveBeenCalledWith(1);
      expect(list()).not.toHaveClass('dragging');
      expect(document.querySelector('.drop-before, .drop-after, .drop-inside')).toBeNull();
      expect(touchmove(list())).toBe(false);
      up(list(), 50, 225);
      expect(p.onMoveTab).not.toHaveBeenCalled();
    });

    // No render runs between this down and up, so only the release's own check stands
    // between the press and a switch to a tab that is already gone.
    it('acts on nothing when the press began on a row already on its way out', () => {
      const vibrate = vi.fn();
      Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true });
      const p = baseProps();
      const view = render(<SessionDrawer {...p} />);
      view.rerender(<SessionDrawer {...p} tabs={WITHOUT_1} />);
      const leaving = tabRow('1'); // still drawn, collapsing for the micro tier
      down(leaving, 50, 0);
      up(leaving, 50, 0);
      expect(p.onSwitch).not.toHaveBeenCalled();
      expect(p.onClose).not.toHaveBeenCalled();

      down(leaving, 50, 0); // a hold: the timer fires with no render in between either
      hold();
      expect(vibrate).not.toHaveBeenCalled();
      expect(touchmove(list())).toBe(false);
      up(leaving, 50, 0);
      expect(p.onTabMenu).not.toHaveBeenCalled();
    });

    it('ends a press on a group header whose group dissolved', () => {
      const p = baseProps({
        tabs: TREE_TABS,
        groups: GROUPS_G1,
        current: '2',
        onToggleGroup: vi.fn(),
      });
      const view = render(<SessionDrawer {...p} />);
      down(groupRow(), 50, 120);
      // g1 dissolved: the same tabs, none of them grouped, and no group left.
      const dissolved = {
        ...p,
        tabs: TREE_TABS.map(({ groupId: _gone, ...rest }) => rest),
        groups: [],
      };
      view.rerender(<SessionDrawer {...dissolved} />);
      up(list(), 50, 120);
      expect(p.onToggleGroup).not.toHaveBeenCalled();
    });
  });

  describe('drag', () => {
    const dragTo = (id: string, from: number, to: number, x = 50) => {
      const row = tabRow(id);
      down(row, x, from);
      hold();
      move(row, x, to);
      return row;
    };

    it('lifts the row on transform alone, captures the pointer on the list, and shows the root area', () => {
      tree();
      const row = tabRow('3');
      down(row, 50, 280);
      hold();
      expect(visualRow(row).style.transform).toBe('');
      expect(list()).not.toHaveClass('dragging');
      move(row, 50, 225);
      expect(setPointerCapture).toHaveBeenCalledWith(1);
      expect(setPointerCapture.mock.contexts[0]).toBe(list());
      expect(visualRow(row)).toHaveClass('lifted');
      expect(row.closest('.drawer-leaf')).toHaveAttribute('data-lifted', 'true');
      // 225 − 280: the row follows the finger by exactly its travel.
      expect(visualRow(row).style.transform).toBe('translate3d(0, -55px, 0) scale(1.02)');
      expect(list()).toHaveClass('dragging');
      expect(screen.getByTestId('drawer-root-drop')).toHaveTextContent('Drop here to ungroup');
      move(row, 50, 240);
      expect(visualRow(row).style.transform).toBe('translate3d(0, -40px, 0) scale(1.02)');
      up(row, 50, 240);
      expect(visualRow(row).style.transform).toBe('');
      expect(visualRow(row)).not.toHaveClass('lifted');
      expect(list()).not.toHaveClass('dragging');
    });

    // B6-03: the lift moves the row and its clip stays, so the frame closed around the slot
    // must be on the clip's leaf, whichever member of the group is the one held.
    //   g:g1 100–140   t:0 140–180   t:1 180–220
    it.each([
      ['the header', () => groupRow(), 120, ['group-first']],
      ['a middle member', () => tabRow('0'), 160, ['group-mid']],
      ['the last member', () => tabRow('1'), 200, ['group-last']],
    ] as const)(
      'keeps the frame closed in place while %s is lifted',
      (_name, pick, y, expected) => {
        tree();
        const row = pick();
        down(row, 50, y);
        hold();
        move(row, 50, y + 60);
        expect(visualRow(row)).toHaveClass('lifted');
        const leaf = row.closest('.drawer-leaf')!;
        expect(leaf).toHaveAttribute('data-lifted', 'true');
        expect([...leaf.classList].filter((c) => c.startsWith('group-'))).toEqual([...expected]);
        // What follows the finger carries no segment.
        expect(visualRow(row).className).not.toMatch(/group-/);
      },
    );

    it('moves a tab before a row: the top half of a tab row drops before it', () => {
      const p = tree();
      const row = dragTo('3', 280, 225); // t:2 spans 220–260; 225 is its top half
      expect(visualRow(tabRow('2'))).toHaveClass('drop-before');
      up(row, 50, 225);
      expect(p.onMoveTab).toHaveBeenCalledTimes(1);
      expect(p.onMoveTab).toHaveBeenCalledWith('3', { target: 't:2', position: 'before' });
      expect(p.onSwitch).not.toHaveBeenCalled();
      expect(p.onTabMenu).not.toHaveBeenCalled();
    });

    it('moves a tab after a row: the bottom half drops after it', () => {
      const p = tree();
      const row = dragTo('0', 160, 250);
      expect(visualRow(tabRow('2'))).toHaveClass('drop-after');
      up(row, 50, 250);
      expect(p.onMoveTab).toHaveBeenCalledWith('0', { target: 't:2', position: 'after' });
    });

    it('joins a group: the middle of its header drops inside it, and the header shows a ring', () => {
      const p = tree();
      const row = dragTo('3', 280, 120);
      expect(visualRow(groupRow())).toHaveClass('drop-inside');
      up(row, 50, 120);
      expect(p.onMoveTab).toHaveBeenCalledWith('3', { target: 'g:g1', position: 'inside' });
    });

    it('leaves a group by dropping among top-level rows', () => {
      const p = tree();
      const row = dragTo('1', 200, 235); // t:1 is a member; t:2 is top-level
      up(row, 50, 235);
      expect(p.onMoveTab).toHaveBeenCalledWith('1', { target: 't:2', position: 'before' });
    });

    it('drops on the root area below the last row, which names itself while hovered', () => {
      const p = tree();
      const row = dragTo('0', 160, 320); // below t:3 (ends 300), inside the list (ends 340)
      expect(screen.getByTestId('drawer-root-drop')).toHaveClass('over');
      up(row, 50, 320);
      expect(p.onMoveTab).toHaveBeenCalledWith('0', { target: null, position: 'inside' });
    });

    it('does not name the root area as a target while another row is', () => {
      tree();
      dragTo('3', 280, 225);
      expect(screen.getByTestId('drawer-root-drop')).not.toHaveClass('over');
    });

    // The root area is permanent: it exists when EVERY tab is in a group, which is the
    // one case with no top-level row to drop among, and it is how a tab gets out then.
    describe('the root area', () => {
      const root = () => screen.getByTestId('drawer-root-drop');

      it('exists at rest, labelled but not marked, whatever the list holds', () => {
        const ALL: TabMeta[] = [
          { id: '0', kind: 'terminal', groupId: 'g1' },
          { id: '1', kind: 'terminal', groupId: 'g1' },
        ];
        renderDrawer({ tabs: ALL, groups: GROUPS_G1, current: '0' });
        expect(root()).toHaveTextContent('Drop here to ungroup');
        expect(root()).toHaveAttribute('aria-hidden', 'true');
        expect(root()).not.toHaveClass('over');
        expect(list()).not.toHaveClass('dragging');
      });

      it('ungroups a tab when every tab is grouped: the only target there is', () => {
        const ALL: TabMeta[] = [
          { id: '0', kind: 'terminal', groupId: 'g1' },
          { id: '1', kind: 'terminal', groupId: 'g1' },
        ];
        // g:g1 100–140  t:0 140–180  t:1 180–220, and the list ends at 260.
        const p = renderDrawer({ tabs: ALL, groups: GROUPS_G1, current: '0' });
        const row = tabRow('1');
        down(row, 50, 200);
        hold();
        move(row, 50, 240); // below the last row
        expect(root()).toHaveClass('over');
        expect(document.querySelector('.drop-before, .drop-after, .drop-inside')).toBeNull();
        up(row, 50, 240);
        expect(p.onMoveTab).toHaveBeenCalledTimes(1);
        expect(p.onMoveTab).toHaveBeenCalledWith('1', { target: null, position: 'inside' });
      });

      it('lets the only member of the only group leave it', () => {
        const ONE: TabMeta[] = [{ id: '0', kind: 'terminal', groupId: 'g1' }];
        // g:g1 100–140  t:0 140–180, and the list ends at 220.
        const p = renderDrawer({ tabs: ONE, groups: GROUPS_G1, current: '0' });
        const row = tabRow('0');
        down(row, 50, 160);
        hold();
        move(row, 50, 200);
        expect(root()).toHaveClass('over');
        up(row, 50, 200);
        expect(p.onMoveTab).toHaveBeenCalledWith('0', { target: null, position: 'inside' });
      });

      it('names no target for the tab that is already LAST at the top level: nothing moves', () => {
        const p = tree();
        const row = dragTo('3', 280, 320); // t:3 is the last top-level node
        expect(root()).not.toHaveClass('over');
        up(row, 50, 320);
        expect(p.onMoveTab).not.toHaveBeenCalled();
      });

      // The root is "the END of the top level", so a top-level tab that is not last
      // there yet moves (the DGSL tree refused every top-level node here).
      it('sends a top-level tab that is not last to the end of the top level', () => {
        const p = tree();
        const row = dragTo('2', 240, 320); // t:2 220–260, then t:3
        expect(root()).toHaveClass('over');
        up(row, 50, 320);
        expect(p.onMoveTab).toHaveBeenCalledWith('2', { target: null, position: 'inside' });
      });

      it('is a drop for a tab dragged out of an open group in a mixed list too', () => {
        const p = tree();
        const row = dragTo('1', 200, 320);
        expect(root()).toHaveClass('over');
        up(row, 50, 320);
        expect(p.onMoveTab).toHaveBeenCalledWith('1', { target: null, position: 'inside' });
      });
    });

    it('moves a group header as a block, after a top-level row', () => {
      const p = tree();
      const header = groupRow();
      down(header, 50, 120);
      hold();
      move(header, 50, 290); // t:3 spans 260–300; 290 is its bottom half
      expect(visualRow(tabRow('3'))).toHaveClass('drop-after');
      up(header, 50, 290);
      expect(p.onMoveGroup).toHaveBeenCalledWith('g1', { target: 't:3', position: 'after' });
      expect(p.onMoveTab).not.toHaveBeenCalled();
    });

    it('draws a drop after an open group under its LAST member, not under the header', () => {
      tree();
      dragTo('3', 280, 135); // the bottom quarter of the header: after the whole block
      expect(visualRow(tabRow('1'))).toHaveClass('drop-after');
      expect(visualRow(groupRow())).not.toHaveClass('drop-after');
    });

    // The lifted row follows the finger on transform, so a mark drawn on it would
    // travel with the finger instead of marking the slot.
    it('draws it under the member above when the LAST member is the one lifted', () => {
      const p = tree();
      const row = dragTo('1', 200, 135); // t:1 is g1's last member; 130–140 is the header's bottom quarter
      expect(visualRow(row)).toHaveClass('lifted');
      expect(visualRow(row)).not.toHaveClass('drop-after');
      expect(visualRow(tabRow('0'))).toHaveClass('drop-after');
      up(row, 50, 135);
      expect(p.onMoveTab).toHaveBeenCalledWith('1', { target: 'g:g1', position: 'after' });
    });

    it('draws it under the header when the lifted tab is the group’s only visible member', () => {
      renderDrawer({
        tabs: [
          { id: '0', kind: 'terminal', groupId: 'g1' },
          { id: '2', kind: 'terminal' },
        ],
        groups: GROUPS_G1,
        current: '2',
      });
      // g:g1 100–140, t:0 140–180, t:2 180–220.
      const row = dragTo('0', 160, 135);
      expect(visualRow(row)).not.toHaveClass('drop-after');
      expect(visualRow(groupRow())).toHaveClass('drop-after');
    });

    it('draws it under the header itself when the group is folded', () => {
      renderDrawer({
        tabs: TREE_TABS,
        groups: GROUPS_G1,
        current: '2',
        collapsed: new Set(['g1']),
      });
      // Folded: g:g1 100–140, t:2 140–180, t:3 180–220.
      down(tabRow('3'), 50, 200);
      hold();
      move(tabRow('3'), 50, 135);
      expect(visualRow(groupRow())).toHaveClass('drop-after');
    });

    // The model's refusals are the UI's: nothing is marked and a release moves nothing.
    it.each([
      ['its own place', '3', 280],
      ['the place it already is (just after the row above)', '3', 255],
      ['outside the list, above it', '3', 50],
      ['outside the list, below it', '3', 400],
    ])('refuses a drop on %s: no mark, and the release commits nothing', (_, id, y) => {
      const p = tree();
      const row = dragTo(id, 280, y);
      expect(document.querySelector('.drop-before, .drop-after, .drop-inside')).toBeNull();
      expect(screen.getByTestId('drawer-root-drop')).not.toHaveClass('over');
      up(row, 50, y);
      expect(p.onMoveTab).not.toHaveBeenCalled();
      expect(p.onSwitch).not.toHaveBeenCalled();
      expect(visualRow(row).style.transform).toBe('');
    });

    it('refuses a group dropped into itself (onto one of its own members)', () => {
      const p = tree();
      const header = groupRow();
      down(header, 50, 120);
      hold();
      move(header, 50, 165); // t:0, a member
      expect(document.querySelector('.drop-before, .drop-after, .drop-inside')).toBeNull();
      up(header, 50, 165);
      expect(p.onMoveGroup).not.toHaveBeenCalled();
    });

    it('moving off a target clears its mark, and a cancel mid-drag commits nothing', () => {
      const p = tree();
      const row = dragTo('3', 280, 225);
      expect(document.querySelector('.drop-before')).not.toBeNull();
      move(row, 50, 400);
      expect(document.querySelector('.drop-before')).toBeNull();
      move(row, 50, 225);
      fireEvent.pointerCancel(row, touch(50, 225));
      expect(p.onMoveTab).not.toHaveBeenCalled();
      expect(visualRow(row).style.transform).toBe('');
      expect(list()).not.toHaveClass('dragging');
    });

    // A drag outlives other windows' edits: the tab in the finger may be gone by the
    // time it lands, and a drop against a tree that no longer holds it is refused.
    it('refuses a drop when another window closed the dragged tab mid-drag', () => {
      const p = baseProps({ tabs: TREE_TABS, groups: GROUPS_G1, current: '2' });
      const view = render(<SessionDrawer {...p} />);
      const row = tabRow('3');
      down(row, 50, 280);
      hold();
      move(row, 50, 225);
      expect(document.querySelector('.drop-before')).not.toBeNull();
      view.rerender(<SessionDrawer {...p} tabs={TREE_TABS.slice(0, 3)} />);
      move(row, 50, 224);
      expect(document.querySelector('.drop-before')).toBeNull();
      up(row, 50, 224);
      expect(p.onMoveTab).not.toHaveBeenCalled();
    });

    it('scrolls the list while the finger is within 40px of an edge, and the lift keeps up', () => {
      tree();
      const el = list();
      let scrollTop = 0;
      Object.defineProperty(el, 'scrollTop', {
        get: () => scrollTop,
        set: (value: number) => void (scrollTop = value),
        configurable: true,
      });
      Object.defineProperty(el, 'clientHeight', { value: 240, configurable: true });
      Object.defineProperty(el, 'scrollHeight', { value: 600, configurable: true });
      const row = tabRow('3');
      down(row, 50, 280);
      hold();
      frames = [];
      move(row, 50, 330); // 10px from the list's bottom edge (340)
      expect(frames).toHaveLength(1);
      flushFrames();
      // ceil((40 − 10) / 40 × 12) = 9 px a frame.
      expect(scrollTop).toBe(9);
      // The finger moved 50, the list scrolled 9: the row travelled 59 to stay under it.
      expect(visualRow(row).style.transform).toBe('translate3d(0, 59px, 0) scale(1.02)');
      expect(frames).toHaveLength(1); // and it asked for the next frame
      flushFrames();
      expect(scrollTop).toBe(18);
      move(row, 50, 220); // the middle: the frame already asked for finds nothing to do
      flushFrames();
      expect(scrollTop).toBe(18);
      expect(frames).toHaveLength(0);
      up(row, 50, 220);
    });

    it('does not scroll a list that has nowhere to go, and stops at the top', () => {
      tree();
      const el = list();
      Object.defineProperty(el, 'clientHeight', { value: 240, configurable: true });
      Object.defineProperty(el, 'scrollHeight', { value: 240, configurable: true });
      const row = tabRow('3');
      down(row, 50, 280);
      hold();
      frames = [];
      move(row, 50, 330);
      expect(frames).toHaveLength(0);
      move(row, 50, 105); // the top edge, at scrollTop 0
      Object.defineProperty(el, 'scrollHeight', { value: 600, configurable: true });
      move(row, 50, 106);
      expect(frames).toHaveLength(0); // already at the top
    });

    it('cancels a pending edge scroll when the drag ends', () => {
      tree();
      const el = list();
      Object.defineProperty(el, 'clientHeight', { value: 240, configurable: true });
      Object.defineProperty(el, 'scrollHeight', { value: 600, configurable: true });
      const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame');
      const row = tabRow('3');
      down(row, 50, 280);
      hold();
      move(row, 50, 330);
      up(row, 50, 330);
      expect(cancelFrame).toHaveBeenCalledTimes(1);
    });

    it('keeps a drag in the drawer: it drops nothing over the scrim strip', () => {
      const p = tree();
      const row = tabRow('3');
      down(row, 50, 280);
      hold();
      move(row, -20, 225); // left of the list, over the scrim
      up(row, -20, 225);
      expect(p.onMoveTab).not.toHaveBeenCalled();
    });

    it('commits a drop without closing the drawer, switching tab or opening a menu', () => {
      const p = tree();
      const row = dragTo('3', 280, 225);
      up(row, 50, 225);
      expect(p.onMoveTab).toHaveBeenCalledTimes(1);
      expect(p.onClose).not.toHaveBeenCalled();
      expect(p.onSwitch).not.toHaveBeenCalled();
      expect(p.onTabMenu).not.toHaveBeenCalled();
    });

    // A header is a target for the WHOLE block it heads. Its top quarter is "before
    // the group", its bottom quarter "after it" — both top-level placements — and only
    // the middle joins.
    describe('over a group header', () => {
      it('drops before the whole group on its top quarter', () => {
        const p = tree();
        const row = dragTo('3', 280, 105); // 100–140: the top quarter ends at 110
        expect(visualRow(groupRow())).toHaveClass('drop-before');
        up(row, 50, 105);
        expect(p.onMoveTab).toHaveBeenCalledWith('3', { target: 'g:g1', position: 'before' });
      });

      it('drops after the whole group on its bottom quarter', () => {
        const p = tree();
        const row = dragTo('3', 280, 135); // the bottom quarter starts at 130
        up(row, 50, 135);
        expect(p.onMoveTab).toHaveBeenCalledWith('3', { target: 'g:g1', position: 'after' });
      });

      it('joins anywhere in the header’s middle half: 111 and 129 both drop inside', () => {
        const p = tree();
        const row = dragTo('3', 280, 111);
        expect(visualRow(groupRow())).toHaveClass('drop-inside');
        move(row, 50, 129);
        expect(visualRow(groupRow())).toHaveClass('drop-inside');
        up(row, 50, 129);
        expect(p.onMoveTab).toHaveBeenCalledWith('3', { target: 'g:g1', position: 'inside' });
      });

      it('takes a member out of its group when it is dropped before its own header', () => {
        const p = tree();
        const row = dragTo('0', 160, 105);
        up(row, 50, 105);
        expect(p.onMoveTab).toHaveBeenCalledWith('0', { target: 'g:g1', position: 'before' });
      });

      // Inside a header means "as its LAST member", so for a member that is not last
      // already it is a move within its own group (the DGSL tree refused it).
      it('moves a member dropped on its own header’s middle to the end of its group', () => {
        const p = tree();
        const row = dragTo('0', 160, 120); // g1 = [0, 1]
        expect(visualRow(groupRow())).toHaveClass('drop-inside');
        up(row, 50, 120);
        expect(p.onMoveTab).toHaveBeenCalledWith('0', { target: 'g:g1', position: 'inside' });
      });

      it('refuses its own header’s middle for the member that is already last', () => {
        const p = tree();
        const row = dragTo('1', 200, 120);
        expect(document.querySelector('.drop-inside')).toBeNull();
        up(row, 50, 120);
        expect(p.onMoveTab).not.toHaveBeenCalled();
      });
    });

    // One level deep: a group is never inside a group, and may sit before or after one.
    describe('a group dragged over another', () => {
      const G2: TabGroup[] = [...GROUPS_G1, { id: 'g2', name: 'ops', color: 'ansi5' }];
      const TWO: TabMeta[] = [
        { id: '0', kind: 'terminal', groupId: 'g1' },
        { id: '1', kind: 'terminal', groupId: 'g1' },
        { id: '2', kind: 'terminal', groupId: 'g2' },
        { id: '3', kind: 'terminal', groupId: 'g2' },
      ];
      // g:g1 100–140  t:0 140–180  t:1 180–220  g:g2 220–260  t:2 260–300  t:3 300–340
      const two = () => renderDrawer({ tabs: TWO, groups: G2, current: '0' });
      const header = (gid: string) => screen.getByTestId(`drawer-group-${gid}`);

      it('is refused on the middle of the other header: no group inside a group', () => {
        const p = two();
        down(header('g1'), 50, 120);
        hold();
        move(header('g1'), 50, 240); // g:g2's middle half is 230–250
        expect(document.querySelector('.drop-before, .drop-after, .drop-inside')).toBeNull();
        up(header('g1'), 50, 240);
        expect(p.onMoveGroup).not.toHaveBeenCalled();
      });

      it('lands after the other whole group on its bottom quarter, marked under its last member', () => {
        const p = two();
        down(header('g1'), 50, 120);
        hold();
        move(header('g1'), 50, 255);
        expect(visualRow(tabRow('3'))).toHaveClass('drop-after');
        up(header('g1'), 50, 255);
        expect(p.onMoveGroup).toHaveBeenCalledWith('g1', { target: 'g:g2', position: 'after' });
      });

      it('lands before the other group on the top quarter of its header', () => {
        const p = two();
        down(header('g2'), 50, 240);
        hold();
        move(header('g2'), 50, 105);
        expect(visualRow(header('g1'))).toHaveClass('drop-before');
        up(header('g2'), 50, 105);
        expect(p.onMoveGroup).toHaveBeenCalledWith('g2', { target: 'g:g1', position: 'before' });
      });

      it('is refused on a member of the other group', () => {
        const p = two();
        down(header('g1'), 50, 120);
        hold();
        move(header('g1'), 50, 285); // t:2, inside g2
        expect(document.querySelector('.drop-before, .drop-after, .drop-inside')).toBeNull();
        up(header('g1'), 50, 285);
        expect(p.onMoveGroup).not.toHaveBeenCalled();
      });
    });

    // A row that is on its way out is still in the DOM for the micro tier, collapsing.
    // It is not somewhere to drop.
    it('does not offer a row that is leaving as a drop target', () => {
      // `current` is t:3: the drawer appends a current tab the list lacks, which would keep t:2 alive.
      const p = baseProps({ tabs: TREE_TABS, groups: GROUPS_G1, current: '3' });
      const view = render(<SessionDrawer {...p} />);
      const row = tabRow('0');
      down(row, 50, 160);
      hold();
      // Another window closes t:2 mid-drag: DOM order g:g1, t:0, t:1, t:2 (leaving), t:3.
      view.rerender(<SessionDrawer {...p} tabs={TREE_TABS.filter((t) => t.id !== '2')} />);
      expect(tabRow('2').closest('.drawer-leaf')).toHaveAttribute('data-phase', 'leaving');
      move(row, 50, 235); // inside the leaving row's slot, 220–260
      expect(visualRow(tabRow('2'))).not.toHaveClass('drop-before');
      expect(visualRow(tabRow('2'))).not.toHaveClass('drop-after');
      expect(visualRow(tabRow('3'))).toHaveClass('drop-before');
      up(row, 50, 235);
      expect(p.onMoveTab).toHaveBeenCalledWith('0', { target: 't:3', position: 'before' });
    });

    it('ends the press when the drawer closes mid-hold', () => {
      const p = baseProps({ tabs: TREE_TABS, groups: GROUPS_G1 });
      const view = render(<SessionDrawer {...p} />);
      down(tabRow('3'), 50, 280);
      hold();
      expect(visualRow(tabRow('3'))).toHaveClass('armed');
      view.rerender(<SessionDrawer {...p} open={false} />);
      expect(visualRow(tabRow('3'))).not.toHaveClass('armed');
    });
  });

  describe('swipe left', () => {
    const closeOf = (id: string) => screen.getByTestId(`drawer-row-close-${id}`);

    it('reveals Close past 32px, and a tap on it closes that tab through onKill', () => {
      const p = renderDrawer();
      const row = tabRow('1');
      down(row, 200, 100);
      move(row, 170, 102); // 30px: not yet
      expect(visualRow(row)).not.toHaveClass('revealed');
      move(row, 160, 102); // 40px
      expect(visualRow(row)).toHaveClass('revealed');
      up(row, 160, 102);
      expect(p.onSwitch).not.toHaveBeenCalled();
      expect(p.onTabMenu).not.toHaveBeenCalled();

      // Shown, it is a button like any other: named, focusable, not hidden.
      expect(closeOf('1')).toHaveAttribute('tabindex', '0');
      expect(closeOf('1')).not.toHaveAttribute('aria-hidden');
      expect(closeOf('1')).toHaveAccessibleName('Close tab 1');
      tap(closeOf('1'));
      expect(p.onKill).toHaveBeenCalledTimes(1);
      expect(p.onKill).toHaveBeenCalledWith('1');
      // It goes back whatever the host answers: a cancelled confirm leaves the row put.
      expect(visualRow(row)).not.toHaveClass('revealed');
    });

    it('slides the row on transform, on the micro tier', () => {
      const slide = declsOf(INDEX_CSS, '.drawer-row.revealed .drawer-session');
      expect(slide.get('transform')).toBe('translateX(calc(-1 * var(--dr-reveal)))');
      expect(declsOf(INDEX_CSS, '.drawer-session').get('transition')).toBe(
        'transform var(--mo-micro) ease, background var(--mo-micro) ease',
      );
    });

    it('is hidden by CSS until revealed, and out of the tab order meanwhile', () => {
      expect(declsOf(INDEX_CSS, '.drawer-row-close').get('visibility')).toBe('hidden');
      expect(declsOf(INDEX_CSS, '.drawer-row.revealed .drawer-row-close').get('visibility')).toBe(
        'visible',
      );
    });

    it('is hidden again by a press anywhere else, which does not also switch or arm', () => {
      const p = renderDrawer();
      down(tabRow('1'), 200, 100);
      move(tabRow('1'), 150, 100);
      up(tabRow('1'), 150, 100);
      expect(visualRow(tabRow('1'))).toHaveClass('revealed');
      // A press on another row only puts the open one back.
      down(tabRow('0'), 50, 100);
      expect(visualRow(tabRow('1'))).not.toHaveClass('revealed');
      hold();
      expect(visualRow(tabRow('0'))).not.toHaveClass('armed');
      up(tabRow('0'), 50, 100);
      expect(p.onSwitch).not.toHaveBeenCalled();
      // And the next press is an ordinary one again.
      tap(tabRow('0'));
      expect(p.onSwitch).toHaveBeenCalledWith('0');
    });

    it('is hidden by a swipe right on the open row, and by a press outside the rows', () => {
      renderDrawer();
      const reveal = () => {
        down(tabRow('1'), 200, 100);
        move(tabRow('1'), 150, 100);
        up(tabRow('1'), 150, 100);
        expect(visualRow(tabRow('1'))).toHaveClass('revealed');
      };
      reveal();
      down(tabRow('1'), 150, 100); // the right swipe starts with this press
      move(tabRow('1'), 200, 100);
      up(tabRow('1'), 200, 100);
      expect(visualRow(tabRow('1'))).not.toHaveClass('revealed');
      reveal();
      fireEvent.pointerDown(screen.getByTestId('drawer-view'));
      expect(visualRow(tabRow('1'))).not.toHaveClass('revealed');
    });

    it('is hidden by a scroll of the list, and by the drawer closing', () => {
      const p = baseProps();
      const view = render(<SessionDrawer {...p} />);
      const reveal = () => {
        down(tabRow('1'), 200, 100);
        move(tabRow('1'), 150, 100);
        up(tabRow('1'), 150, 100);
        expect(visualRow(tabRow('1'))).toHaveClass('revealed');
      };
      reveal();
      fireEvent.scroll(list());
      expect(visualRow(tabRow('1'))).not.toHaveClass('revealed');
      reveal();
      view.rerender(<SessionDrawer {...p} open={false} />);
      expect(visualRow(tabRow('1'))).not.toHaveClass('revealed');
    });

    it('reveals nothing on a group header, which has no Close', () => {
      tree();
      down(groupRow(), 200, 120);
      move(groupRow(), 140, 120);
      up(groupRow(), 140, 120);
      expect(document.querySelector('.revealed')).toBeNull();
    });

    // A reveal that needs a swipe is no use to a keyboard: ArrowLeft is the swipe, and
    // the revealed Close takes focus, ArrowRight the way back.
    it('is reachable from the keyboard: ArrowLeft reveals it and moves focus there', () => {
      renderDrawer();
      tabRow('1').focus();
      fireEvent.keyDown(tabRow('1'), { key: 'ArrowLeft' });
      expect(visualRow(tabRow('1'))).toHaveClass('revealed');
      expect(document.activeElement).toBe(closeOf('1'));
      fireEvent.keyDown(closeOf('1'), { key: 'ArrowRight' });
      expect(visualRow(tabRow('1'))).not.toHaveClass('revealed');
      expect(document.activeElement).toBe(tabRow('1'));
    });

    it('is not offered to the keyboard on a group header', () => {
      tree();
      groupRow().focus();
      fireEvent.keyDown(groupRow(), { key: 'ArrowLeft' });
      expect(document.querySelector('.revealed')).toBeNull();
    });

    // Close lives in the scrolling list, so it takes the list's rule: it acts on the
    // pointer going UP, and not at all if the finger wandered on the way.
    it('acts on pointer-up only, and not for a press that wandered more than 10px', () => {
      const p = renderDrawer();
      down(tabRow('1'), 200, 100);
      move(tabRow('1'), 150, 100);
      up(tabRow('1'), 150, 100);
      expect(visualRow(tabRow('1'))).toHaveClass('revealed');

      fireEvent.pointerDown(closeOf('1'), touch(300, 100));
      expect(p.onKill).not.toHaveBeenCalled(); // a finger that has only landed may be scrolling
      fireEvent.pointerMove(closeOf('1'), touch(300, 130));
      fireEvent.pointerUp(closeOf('1'), touch(300, 130));
      expect(p.onKill).not.toHaveBeenCalled(); // it was a scroll
      expect(visualRow(tabRow('1'))).toHaveClass('revealed');

      fireEvent.pointerDown(closeOf('1'), touch(300, 100));
      fireEvent.pointerMove(closeOf('1'), touch(303, 104)); // a fingertip's wobble
      fireEvent.pointerUp(closeOf('1'), touch(303, 104));
      expect(p.onKill).toHaveBeenCalledTimes(1);
      expect(p.onKill).toHaveBeenCalledWith('1');
    });

    it('reveals nothing for a swipe to the right, nor for a leftward drift under 32px', () => {
      renderDrawer();
      const row = tabRow('1');
      down(row, 100, 100);
      move(row, 180, 100);
      up(row, 180, 100);
      expect(visualRow(row)).not.toHaveClass('revealed');
      down(row, 200, 100);
      move(row, 175, 100);
      up(row, 175, 100);
      expect(visualRow(row)).not.toHaveClass('revealed');
    });

    it('is not a swipe once the hold has armed: a leftward move then lifts the row instead', () => {
      renderDrawer();
      const row = tabRow('1');
      down(row, 200, 100);
      hold();
      move(row, 150, 102);
      expect(setPointerCapture).toHaveBeenCalledTimes(1);
      expect(visualRow(row)).toHaveClass('lifted');
      expect(visualRow(row)).not.toHaveClass('revealed');
      up(row, 150, 102);
      expect(visualRow(row)).not.toHaveClass('revealed');
    });

    it('closes only the tab swiped, not the one whose Close is next to it', () => {
      const p = renderDrawer();
      down(tabRow('0'), 200, 100);
      move(tabRow('0'), 150, 100);
      up(tabRow('0'), 150, 100);
      tap(closeOf('0'));
      expect(p.onKill).toHaveBeenCalledTimes(1);
      expect(p.onKill).toHaveBeenCalledWith('0');
    });

    // The whole route by keys alone, nothing standing in for a key: the arrow IS the
    // swipe, focus follows onto the Close it revealed, and Enter or Space close.
    describe('from the keyboard alone', () => {
      beforeEach(() => vi.useRealTimers());

      it.each([
        ['Enter', '{Enter}'],
        ['Space', ' '],
      ])('ArrowLeft, then %s, closes the tab once', async (_, key) => {
        const p = renderDrawer();
        tabRow('1').focus();
        await user().keyboard('{ArrowLeft}');
        expect(document.activeElement).toBe(closeOf('1'));
        await user().keyboard(key);
        expect(p.onKill).toHaveBeenCalledTimes(1);
        expect(p.onKill).toHaveBeenCalledWith('1');
        expect(visualRow(tabRow('1'))).not.toHaveClass('revealed');
      });

      it('ArrowLeft then ArrowRight hands focus back to the row and closes nothing', async () => {
        const p = renderDrawer();
        tabRow('1').focus();
        await user().keyboard('{ArrowLeft}{ArrowRight}');
        expect(document.activeElement).toBe(tabRow('1'));
        expect(p.onKill).not.toHaveBeenCalled();
      });
    });

    it('closes on a click with no pointer press behind it, and once for a real press', () => {
      const p = renderDrawer();
      fireEvent.keyDown(tabRow('1'), { key: 'ArrowLeft' });
      fireEvent.click(closeOf('1')); // Enter, Space, assistive tech
      expect(p.onKill).toHaveBeenCalledTimes(1);

      fireEvent.keyDown(tabRow('1'), { key: 'ArrowLeft' });
      tap(closeOf('1'));
      fireEvent.click(closeOf('1'), { detail: 1 });
      expect(p.onKill).toHaveBeenCalledTimes(2);
    });

    // Close is a `pressMove` control: it takes EVERY click that reaches it, and a
    // press's own click stays away only because the press marked its gesture.
    describe('by a whole pointer press', () => {
      const swipeOpen = (id: string) => {
        down(tabRow(id), 200, 100);
        move(tabRow(id), 150, 100);
        up(tabRow(id), 150, 100);
        expect(visualRow(tabRow(id))).toHaveClass('revealed');
      };

      it.each(['touch', 'mouse'] as const)(
        '%s: closes the tab once, and its click does not',
        (pt) => {
          const p = renderDrawer();
          swipeOpen('1');
          browserPress(closeOf('1'), pt);
          expect(p.onKill).toHaveBeenCalledTimes(1);
          expect(p.onKill).toHaveBeenCalledWith('1');
        },
      );

      it.each(['touch', 'mouse'] as const)('%s: leaves #mobile-kbd focused', (pt) => {
        const kbd = document.createElement('textarea');
        kbd.id = 'mobile-kbd';
        document.body.append(kbd);
        try {
          renderDrawer();
          swipeOpen('1');
          kbd.focus();
          browserPress(closeOf('1'), pt);
          expect(document.activeElement).toBe(kbd);
        } finally {
          kbd.remove();
        }
      });

      // The host asks before it closes a shell, and `window.confirm` blocks for as
      // long as the user takes. The click the press ends with is dispatched only
      // after the answer, to a row that is still there when the answer was no, so
      // its window opens when the action RETURNS, not when the finger lifted. Were
      // it measured from the release, that click would land on Close a second
      // time and ask the same question again.
      it('keeps the click swallowed after a confirm that blocked for 1.5s', () => {
        const p = renderDrawer({
          onKill: vi.fn(() => {
            vi.advanceTimersByTime(1_500);
          }),
        });
        swipeOpen('1');
        fireEvent.pointerDown(closeOf('1'), touch(300, 100));
        fireEvent.pointerUp(closeOf('1'), touch(300, 100));
        expect(p.onKill).toHaveBeenCalledTimes(1);
        fireEvent.click(closeOf('1'), { detail: 1 });
        expect(p.onKill).toHaveBeenCalledTimes(1);

        // A separate press, answered no the first time, is the user's own.
        fireEvent.pointerDown(closeOf('1'), touch(300, 100));
        fireEvent.pointerUp(closeOf('1'), touch(300, 100));
        expect(p.onKill).toHaveBeenCalledTimes(2);
      });

      it('acts on nothing for a mouse drag released on it, nor for the click that ends it', () => {
        const p = renderDrawer();
        swipeOpen('1');
        const mouse = { pointerId: 1, pointerType: 'mouse', clientX: 300, clientY: 100 };
        fireEvent.pointerDown(closeOf('1'), mouse);
        fireEvent.pointerMove(closeOf('1'), { ...mouse, clientX: 360 });
        fireEvent.pointerUp(closeOf('1'), { ...mouse, clientX: 360 });
        fireEvent.click(closeOf('1'), { detail: 1 });
        expect(p.onKill).not.toHaveBeenCalled();
      });
    });
  });

  describe('tap', () => {
    it('on a group header folds it and leaves the drawer open', () => {
      const onToggleGroup = vi.fn();
      const p = tree({ onToggleGroup });
      tap(groupRow());
      expect(onToggleGroup).toHaveBeenCalledWith('g1');
      expect(p.onClose).not.toHaveBeenCalled();
      expect(p.onSwitch).not.toHaveBeenCalled();
    });

    it('on a group header, by keyboard click, folds it once', () => {
      const onToggleGroup = vi.fn();
      tree({ onToggleGroup });
      fireEvent.click(groupRow());
      expect(onToggleGroup).toHaveBeenCalledTimes(1);
    });

    it('puts #mobile-kbd back after a tap, so the soft keyboard survives it', () => {
      const kbd = document.createElement('textarea');
      kbd.id = 'mobile-kbd';
      document.body.append(kbd);
      try {
        tree({ onToggleGroup: vi.fn() });
        kbd.focus();
        down(groupRow(), 50, 120);
        groupRow().focus(); // what a touch press does to focus
        up(groupRow(), 50, 120);
        expect(document.activeElement).toBe(kbd);
      } finally {
        kbd.remove();
      }
    });

    it('stops the browser’s own context menu over a row', () => {
      renderDrawer();
      const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      tabRow('1').dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    });

    // A touch delivers its compatibility mousedown AFTER pointerup, and that
    // mousedown moves focus, so putting #mobile-kbd back at pointerup alone was
    // undone a moment later. The whole sequence, nothing focused by hand.
    it.each([
      ['a tab row, which switches and closes', () => tabRow('3')],
      ['a group header, which folds', () => groupRow()],
    ])('keeps #mobile-kbd through the whole tap on %s', (_, row) => {
      const kbd = document.createElement('textarea');
      kbd.id = 'mobile-kbd';
      document.body.append(kbd);
      try {
        const acted = vi.fn();
        tree({ onSwitch: acted, onToggleGroup: acted });
        kbd.focus();
        expect(browserPress(row(), 'touch')).toBe(true); // the pan is the browser's
        expect(acted).toHaveBeenCalledTimes(1);
        expect(document.activeElement).toBe(kbd);
      } finally {
        kbd.remove();
      }
    });

    // A press that acted on nothing marks nothing, so the click it ends with DOES
    // reach the row. Only a click with no count (a key, assistive tech) activates a
    // row, so that click must not switch tab or fold a group.
    describe('a click that carries a count is never a row activation', () => {
      const mouse = { pointerId: 1, pointerType: 'mouse', clientX: 50, clientY: 100 };

      it('after a mouse drag released on the row', () => {
        const p = renderDrawer();
        fireEvent.pointerDown(tabRow('1'), mouse);
        fireEvent.pointerMove(tabRow('1'), { ...mouse, clientX: 120 });
        fireEvent.pointerUp(tabRow('1'), { ...mouse, clientX: 120 });
        fireEvent.click(tabRow('1'), { detail: 1 });
        expect(p.onSwitch).not.toHaveBeenCalled();
        expect(p.onClose).not.toHaveBeenCalled();
      });

      it('after a press that only put a revealed Close back', () => {
        const p = renderDrawer();
        down(tabRow('1'), 200, 100);
        move(tabRow('1'), 150, 100);
        up(tabRow('1'), 150, 100);
        expect(visualRow(tabRow('1'))).toHaveClass('revealed');
        fireEvent.pointerDown(tabRow('0'), mouse); // puts the open Close back, nothing more
        fireEvent.pointerUp(tabRow('0'), mouse);
        fireEvent.click(tabRow('0'), { detail: 1 });
        expect(visualRow(tabRow('1'))).not.toHaveClass('revealed');
        expect(p.onSwitch).not.toHaveBeenCalled();
        expect(p.onClose).not.toHaveBeenCalled();
      });

      it('after a hold released on a group header, which has no menu', () => {
        const onToggleGroup = vi.fn();
        tree({ onToggleGroup });
        down(groupRow(), 50, 120);
        hold();
        up(groupRow(), 50, 120);
        fireEvent.click(groupRow(), { detail: 1 });
        expect(onToggleGroup).not.toHaveBeenCalled();
      });
    });
  });

  // A tap that switches tab closes the drawer over the terminal, and a hold
  // released in place opens the row menu (TabSheet) over the list. Both redraw the
  // spot under the finger, and the browser delivers the rest of the tap (its
  // compatibility mousedown and mouseup, then its click) to whatever is there by
  // then. So both mark the gesture BEFORE acting. A press that acted on nothing
  // marks nothing, so the next click, wherever it lands, is the user's own.
  describe('a row press’s own click, landing on what the press put under the finger', () => {
    /** The rest of a tap after its pointerup, on `el`. */
    const tail = (el: Element) => {
      fireEvent.mouseDown(el, { detail: 1 });
      fireEvent.mouseUp(el, { detail: 1 });
      fireEvent.click(el, { detail: 1 });
    };
    const second = { pointerId: 2, pointerType: 'touch' };
    /** A separate tap, which ends a stale mark with its pointerdown. */
    const tapAgain = (el: Element) => {
      fireEvent.pointerDown(el, second);
      fireEvent.pointerUp(el, second);
      fireEvent.click(el, { detail: 1 });
    };

    type DrawerOverrides = Partial<Parameters<typeof SessionDrawer>[0]>;
    /** A drawer the host really closes, over a stand-in for the terminal. */
    const overTerminal = () => {
      const props = baseProps({ tabs: TREE_TABS, groups: GROUPS_G1, current: '2' });
      const terminal = { click: vi.fn(), mouseDown: vi.fn(), mouseUp: vi.fn() };
      const Host = (over: DrawerOverrides) => {
        const [open, setOpen] = useState(true);
        return (
          <>
            <button
              data-testid="terminal"
              onClick={terminal.click}
              onMouseDown={terminal.mouseDown}
              onMouseUp={terminal.mouseUp}
            >
              terminal
            </button>
            <SessionDrawer
              {...props}
              onToggleGroup={vi.fn()}
              {...over}
              open={open}
              onClose={() => {
                props.onClose();
                setOpen(false);
              }}
            />
          </>
        );
      };
      const view = render(<Host />);
      return {
        props,
        terminal,
        under: () => screen.getByTestId('terminal'),
        rerender: (over: DrawerOverrides) => view.rerender(<Host {...over} />),
      };
    };

    it('a tap switches and closes, and the rest of it reaches nothing on the terminal', () => {
      const { props, terminal, under } = overTerminal();
      down(tabRow('3'), 50, 280);
      up(tabRow('3'), 50, 280);
      expect(props.onSwitch).toHaveBeenCalledWith('3');
      expect(screen.getByTestId('drawer')).not.toHaveClass('open');
      tail(under());
      expect(terminal.mouseDown).not.toHaveBeenCalled();
      expect(terminal.mouseUp).not.toHaveBeenCalled();
      expect(terminal.click).not.toHaveBeenCalled();

      tapAgain(under());
      expect(terminal.click).toHaveBeenCalledTimes(1);
    });

    it('a hold released in place opens the menu, and the rest of it reaches nothing in it', () => {
      const props = baseProps({ tabs: TREE_TABS, groups: GROUPS_G1, current: '2' });
      const onRecolor = vi.fn();
      const Host = () => {
        const [sheetFor, setSheetFor] = useState<string | null>(null);
        const tab = TREE_TABS.find((t) => t.id === sheetFor);
        return (
          <>
            <SessionDrawer {...props} onTabMenu={setSheetFor} />
            {tab && (
              <TabSheet
                tab={tab}
                onRename={vi.fn()}
                onRecolor={onRecolor}
                onCloseTab={vi.fn()}
                onDismiss={() => setSheetFor(null)}
              />
            )}
          </>
        );
      };
      render(<Host />);
      down(tabRow('3'), 50, 280);
      hold();
      up(tabRow('3'), 50, 280);
      // What the sheet put under the finger: a colour swatch.
      const swatch = screen.getByTestId('sheet-color-ansi4');
      tail(swatch);
      expect(onRecolor).not.toHaveBeenCalled();
      expect(screen.getByTestId('tab-sheet')).toBeInTheDocument();

      tapAgain(swatch);
      expect(onRecolor).toHaveBeenCalledTimes(1);
      expect(onRecolor).toHaveBeenCalledWith('3', 'ansi4');
    });

    // A mouse's pointerdown is prevented, so the browser sends it no mousedown or
    // mouseup, but the click still comes, and it lands on the terminal all the same.
    it('a mouse tap switches and closes, and its click reaches nothing on the terminal', () => {
      const { props, terminal, under } = overTerminal();
      const mouse = { pointerId: 1, pointerType: 'mouse', clientX: 50, clientY: 280 };
      fireEvent.pointerDown(tabRow('3'), mouse);
      fireEvent.pointerUp(tabRow('3'), mouse);
      expect(props.onSwitch).toHaveBeenCalledWith('3');
      expect(screen.getByTestId('drawer')).not.toHaveClass('open');
      fireEvent.click(under(), { detail: 1 });
      expect(terminal.click).not.toHaveBeenCalled();

      fireEvent.pointerDown(under(), { pointerId: 2, pointerType: 'mouse' });
      fireEvent.pointerUp(under(), { pointerId: 2, pointerType: 'mouse' });
      fireEvent.click(under(), { detail: 1 });
      expect(terminal.click).toHaveBeenCalledTimes(1);
    });

    // A Switch that answers a keyboard (detail 0) must not be taken for a tail.
    it('Enter on a row right after a tap still switches: a key is never a pointer’s tail', () => {
      const { props } = overTerminal();
      down(tabRow('3'), 50, 280);
      up(tabRow('3'), 50, 280);
      expect(props.onSwitch).toHaveBeenCalledTimes(1);
      fireEvent.click(tabRow('2')); // no count: Enter, Space or assistive tech
      expect(props.onSwitch).toHaveBeenCalledTimes(2);
      expect(props.onSwitch).toHaveBeenLastCalledWith('2');
    });

    type Ctx = ReturnType<typeof overTerminal>;
    const NOTHING: [string, (ctx: Ctx) => void][] = [
      [
        'a scroll',
        () => {
          down(tabRow('3'), 50, 280);
          move(tabRow('3'), 50, 200);
          up(tabRow('3'), 50, 200);
        },
      ],
      [
        'a swipe that reveals Close',
        () => {
          down(tabRow('3'), 200, 280);
          move(tabRow('3'), 150, 280);
          up(tabRow('3'), 150, 280);
          expect(visualRow(tabRow('3'))).toHaveClass('revealed');
        },
      ],
      [
        'a drag and its drop',
        ({ props }: Ctx) => {
          down(tabRow('3'), 50, 280);
          hold();
          move(tabRow('3'), 50, 225);
          up(tabRow('3'), 50, 225);
          expect(props.onMoveTab).toHaveBeenCalledTimes(1);
        },
      ],
      [
        'a hold on a group header, which has no menu',
        () => {
          down(groupRow(), 50, 120);
          hold();
          up(groupRow(), 50, 120);
        },
      ],
      [
        'a press cancelled by the browser',
        () => {
          down(tabRow('3'), 50, 280);
          fireEvent.pointerCancel(tabRow('3'), touch(50, 280));
          up(list(), 50, 280);
        },
      ],
      [
        'a press that left the list',
        () => {
          down(tabRow('3'), 50, 280);
          fireEvent.pointerLeave(list(), touch(50, 280));
          up(list(), 50, 280);
        },
      ],
      [
        'a tap on a row that left the tree before the release',
        ({ rerender }: Ctx) => {
          down(tabRow('3'), 50, 280);
          rerender({ tabs: TREE_TABS.slice(0, 3) });
          up(list(), 50, 280);
        },
      ],
    ];
    it.each(NOTHING)('%s acts on nothing and marks nothing', (_, gesture) => {
      const ctx = overTerminal();
      gesture(ctx);
      expect(ctx.props.onSwitch).not.toHaveBeenCalled();
      expect(ctx.props.onTabMenu).not.toHaveBeenCalled();
      expect(ctx.props.onClose).not.toHaveBeenCalled();
      fireEvent.click(ctx.under(), { detail: 1 });
      expect(ctx.terminal.click).toHaveBeenCalledTimes(1);
    });
  });
});

// ── Rows entering and leaving ─────────────────────────────────────────────────
describe('rows entering and leaving', () => {
  const leaf = (id: string) => screen.getByTestId(`drawer-session-${id}`).closest('.drawer-leaf')!;

  it('draws a closed tab as leaving for the micro tier, then drops it', () => {
    const p = baseProps();
    const view = render(<SessionDrawer {...p} />);
    view.rerender(<SessionDrawer {...p} tabs={[TABS[0]!]} />);
    expect(leaf('1')).toHaveAttribute('data-phase', 'leaving');
    // `inert`, not `aria-hidden`: a row closed from its revealed Close still holds
    // focus, and focus inside an aria-hidden subtree is an accessibility violation.
    expect(leaf('1')).toHaveAttribute('inert');
    expect(leaf('1')).not.toHaveAttribute('aria-hidden');
    expect(leaf('0')).not.toHaveAttribute('inert');
    expect(leaf('0')).not.toHaveAttribute('data-phase', 'leaving');
    act(() => void vi.advanceTimersByTime(139));
    expect(screen.queryByTestId('drawer-session-1')).not.toBeNull();
    act(() => void vi.advanceTimersByTime(1));
    expect(screen.queryByTestId('drawer-session-1')).toBeNull();
  });

  it('cancels the leave when the tab comes back in time', () => {
    const p = baseProps();
    const view = render(<SessionDrawer {...p} />);
    view.rerender(<SessionDrawer {...p} tabs={[TABS[0]!]} />);
    view.rerender(<SessionDrawer {...p} />);
    expect(leaf('1')).not.toHaveAttribute('data-phase', 'leaving');
    expect(leaf('1')).not.toHaveAttribute('inert');
    act(() => void vi.advanceTimersByTime(500));
    expect(screen.queryByTestId('drawer-session-1')).not.toBeNull();
  });

  it('lets a folded group’s members leave the same way', () => {
    const p = baseProps({ tabs: GROUPED_TABS, groups: GROUPS });
    const view = render(<SessionDrawer {...p} />);
    view.rerender(<SessionDrawer {...p} collapsed={new Set(['g1'])} />);
    expect(leaf('0')).toHaveAttribute('data-phase', 'leaving');
    act(() => void vi.advanceTimersByTime(140));
    expect(screen.queryByTestId('drawer-session-0')).toBeNull();
    expect(screen.getByTestId('drawer-group-g1')).toBeTruthy();
  });

  it('runs the first fill on the stagger tier and a later insertion on the micro tier', () => {
    const p = baseProps();
    const view = render(<SessionDrawer {...p} />);
    for (const id of ['0', '1']) expect(leaf(id)).toHaveAttribute('data-enter', 'stagger');
    view.rerender(<SessionDrawer {...p} tabs={[...TABS, { id: '2', kind: 'terminal' }]} />);
    expect(leaf('2')).toHaveAttribute('data-enter', 'micro');
    expect(leaf('2')).toHaveAttribute('data-phase', 'entering');
    expect(leaf('0')).toHaveAttribute('data-enter', 'stagger'); // nothing replays
  });

  it('numbers each row for the stagger delay', () => {
    renderDrawer();
    expect((leaf('0') as HTMLElement).style.getPropertyValue('--dr-i')).toBe('0');
    expect((leaf('1') as HTMLElement).style.getPropertyValue('--dr-i')).toBe('1');
  });

  // The wrapper animates its own occupied space, with opacity, on the micro tier, so
  // the rows below glide instead of jumping when the node finally unmounts.
  it('transitions grid-template-rows and opacity on --mo-micro, and none under reduced motion', () => {
    const wrapper = declsOf(INDEX_CSS, '.drawer-leaf');
    expect(wrapper.get('display')).toBe('grid');
    // A flex item that cannot shrink: the list scrolls, its rows are not squashed.
    expect(wrapper.get('flex')).toBe('0 0 auto');
    expect(declsOf(INDEX_CSS, '.drawer-tail').get('flex')).toBe('0 0 auto');
    expect(wrapper.get('grid-template-rows')).toBe('1fr');
    expect(wrapper.get('transition')).toBe(
      'grid-template-rows var(--mo-micro) ease, opacity var(--mo-micro) ease',
    );
    const gone = declsOf(INDEX_CSS, ".drawer-leaf[data-phase='leaving']");
    expect(gone.get('grid-template-rows')).toBe('0fr');
    expect(gone.get('opacity')).toBe('0');
    expect(declsOf(INDEX_CSS, '.drawer-leaf-inner').get('overflow')).toBe('hidden');
    expect(declsOf(INDEX_CSS, '.drawer-leaf', true).get('transition')).toBe('none');
  });

  it('runs the first fill on --mo-enter with a stagger step, capped', () => {
    const first = declsOf(INDEX_CSS, ".drawer-leaf[data-enter='stagger']");
    expect(first.get('transition-duration')).toBe('var(--mo-enter)');
    expect(first.get('transition-delay')).toBe('calc(min(var(--dr-i, 0), 10) * var(--mo-stagger))');
  });

  // Half the row gap sits above and half below each row, inside the clip: two rows are
  // --sp-1 apart, and a leaving row takes both halves with it. The clip itself holds no
  // vertical padding, because padding on it would keep the leaf open at 0fr.
  it('takes the row’s gap with it: the margin sits inside the clip, not on the list', () => {
    expect(declsOf(INDEX_CSS, '.drawer-row').get('margin-block')).toBe('calc(var(--sp-1) / 2)');
    expect(declsOf(INDEX_CSS, '.drawer-row').has('margin-bottom')).toBe(false);
    expect(declsOf(INDEX_CSS, '.drawer-sessions').get('gap')).toBeUndefined();
    const clip = declsOf(INDEX_CSS, '.drawer-leaf-inner');
    for (const prop of ['padding', 'padding-block', 'padding-top', 'padding-bottom']) {
      expect(clip.has(prop), prop).toBe(false);
    }
  });

  // The enter is the leave run backwards: it starts collapsed and clear and ends at the
  // rest state, so the rows below make room as it arrives instead of being pushed.
  it('starts an entering row collapsed and clear and rests at one full track', () => {
    const entering = declsOf(INDEX_CSS, ".drawer-leaf[data-phase='entering']");
    expect(entering.get('grid-template-rows')).toBe('0fr');
    expect(entering.get('opacity')).toBe('0');
    const rest = declsOf(INDEX_CSS, '.drawer-leaf');
    expect(rest.get('grid-template-rows')).toBe('1fr');
    expect(rest.get('opacity')).toBe('1');
  });

  // The stagger rule only retimes: if it restated `transition` or its property list,
  // it would outrank the reduced-motion `transition: none` and animate regardless.
  it('lets the stagger tier retime the transition without naming what transitions', () => {
    const first = declsOf(INDEX_CSS, ".drawer-leaf[data-enter='stagger']");
    expect(first.has('transition')).toBe(false);
    expect(first.has('transition-property')).toBe(false);
  });

  describe('the first fill', () => {
    beforeEach(() => {
      // The flip from `entering` to `present` waits two animation frames: fake them.
      // The file's own clock is already running and a second install is a no-op, so
      // it is stopped first.
      vi.useRealTimers();
      vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'],
      });
    });
    const leaves = () => [...document.querySelectorAll('.drawer-leaf')];
    const tiers = () => leaves().map((l) => l.getAttribute('data-enter'));
    const phases = () => leaves().map((l) => l.getAttribute('data-phase'));

    it('runs every initial row on the stagger tier, in order, and never the micro one', () => {
      renderDrawer({ tabs: [...TABS, { id: '2', kind: 'terminal' }] });
      expect(tiers()).toEqual(['stagger', 'stagger', 'stagger']);
      expect(leaves().map((l) => (l as HTMLElement).style.getPropertyValue('--dr-i'))).toEqual([
        '0',
        '1',
        '2',
      ]);
      expect(document.querySelector("[data-enter='micro']")).toBeNull();
      // Once present the tier stays on the row: the transition reads it on the style it ends on.
      act(() => void vi.advanceTimersByTime(40));
      expect(phases()).toEqual(['present', 'present', 'present']);
      expect(tiers()).toEqual(['stagger', 'stagger', 'stagger']);
    });

    it('counts a drawer that mounts empty and fills on its first broadcast as the first fill', () => {
      const p = baseProps({ tabs: [], current: '' });
      const view = render(<SessionDrawer {...p} />);
      expect(leaves()).toHaveLength(0);
      view.rerender(<SessionDrawer {...p} tabs={TABS} />);
      expect(tiers()).toEqual(['stagger', 'stagger']);
    });

    // A legacy `/<id>` boot names its tab before any broadcast, and the drawer draws
    // that one row for it: that row is the first fill, and the broadcast's others
    // arrive as insertions. CLAUDE.md says so; this keeps it true.
    it('counts the one row drawn for a not-yet-broadcast current as the first fill', () => {
      const p = baseProps({ tabs: [], current: '0' });
      const view = render(<SessionDrawer {...p} />);
      expect(tiers()).toEqual(['stagger']);
      view.rerender(<SessionDrawer {...p} tabs={TABS} />);
      expect(tiers()).toEqual(['stagger', 'micro']);
    });

    it('runs a refill after the list emptied on the micro tier: that is not a first fill', () => {
      const p = baseProps();
      const view = render(<SessionDrawer {...p} />);
      act(() => void vi.advanceTimersByTime(40));
      view.rerender(<SessionDrawer {...p} tabs={[]} current="" />);
      act(() => void vi.advanceTimersByTime(140));
      expect(leaves()).toHaveLength(0);
      view.rerender(<SessionDrawer {...p} tabs={TABS} />);
      expect(tiers()).toEqual(['micro', 'micro']);
    });
  });

  // The stylesheet zeroes the tokens under reduced motion, and the hook checks the
  // query itself: a row that is told to wait for a transition that never runs would
  // linger invisibly for a duration of nothing.
  describe('under reduced motion', () => {
    const original = window.matchMedia;
    beforeEach(() => {
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        writable: true,
        value: (query: string) =>
          ({
            matches: query.includes('prefers-reduced-motion'),
            media: query,
            addEventListener: () => {},
            removeEventListener: () => {},
          }) as unknown as MediaQueryList,
      });
    });
    afterEach(() => {
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        writable: true,
        value: original,
      });
    });

    it('drops a closed tab at once, with no leaving phase', () => {
      const p = baseProps();
      const view = render(<SessionDrawer {...p} />);
      view.rerender(<SessionDrawer {...p} tabs={[TABS[0]!]} />);
      expect(screen.queryByTestId('drawer-session-1')).toBeNull();
      expect(document.querySelector("[data-phase='leaving']")).toBeNull();
    });

    it('draws every row present from its first frame, the first fill and a later one alike', () => {
      const p = baseProps();
      const view = render(<SessionDrawer {...p} />);
      for (const id of ['0', '1']) expect(leaf(id)).toHaveAttribute('data-phase', 'present');
      view.rerender(<SessionDrawer {...p} tabs={[...TABS, { id: '2', kind: 'terminal' }]} />);
      expect(leaf('2')).toHaveAttribute('data-phase', 'present');
    });
  });
});
