import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TAB_KINDS, type TabMeta } from '@palmux/shared';
import { Icon, IconFrame, ICON_NAMES, namedIcon } from './icons';
import { Collapsible } from './Collapsible';
import { KEY_ICON_NAMES, keyFace, namedIcon as keyNamedIcon } from '../mobile/key-icons';
import { DockPanel, ICONS as DOCK_ICONS } from '../session/DockPanel';
import { SessionDrawer } from '../session/SessionDrawer';
import { kindIcon } from '../session/tab-meta';
import { DEFAULTS } from '../settings/settings';
import { SearchBar } from '../terminal/SearchBar';

afterEach(cleanup);

// The names the plan (ui-rework 1.3) promises, so a rename cannot silently strand
// a call site that migrates to `<Icon name=…>`.
const PLANNED = [
  // the five that extra-keys.json already accepted
  'switch',
  'folder',
  'newline',
  'mic',
  'keyboard',
  'close',
  'menu',
  'check',
  'warning',
  'pin',
  'folder-open',
  'file',
  'book',
  'globe',
  'link',
  'pencil',
  'terminal',
  'upload',
  'download',
  'external',
  'back',
  'arrow-left',
  'arrow-right',
  'arrow-up',
  'arrow-down',
  'checkbox-on',
  'checkbox-off',
  'play',
  'pause',
  'record',
  'image',
  'dot',
  'plus',
  'split',
  'eject',
  'hourglass',
  'reload',
  'copy',
  'chevron-left',
  'chevron-right',
  'chevron-up',
  'chevron-down',
  'settings',
  'stop',
  'sessions',
  'rotate-row',
  'rotate-col',
  'dashboard',
];

// The solid glyphs: status marks that must not read as outlines. Everything else is
// stroke-only, and this list is the whole of the exception.
const FILLED = new Set(['dot', 'record']);

/** The drawn shapes of a registered icon, to compare against what a control
 *  rendered. Rendered into a detached node so `screen` never sees it. */
const shapes = (name: string): string | undefined => {
  const host = document.createElement('div');
  render(<Icon name={name} />, { container: host });
  return host.querySelector('svg')?.innerHTML;
};

const svgOf = (name: string): SVGElement => {
  const { container } = render(<Icon name={name} />);
  const svg = container.querySelector('svg');
  if (!svg) throw new Error(`${name} rendered no <svg>`);
  return svg;
};

describe('the registry', () => {
  it('holds every name the plan lists, once each', () => {
    expect(ICON_NAMES).toEqual(expect.arrayContaining(PLANNED));
    expect(new Set(ICON_NAMES).size).toBe(ICON_NAMES.length);
  });

  it('is what extra-keys.json accepts as `icon`', () => {
    expect(KEY_ICON_NAMES).toBe(ICON_NAMES);
    expect(keyNamedIcon).toBe(namedIcon);
  });
});

describe('Icon', () => {
  it.each(ICON_NAMES)('%s draws through the one frame', (name) => {
    const svg = svgOf(name);
    expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(svg.getAttribute('stroke-width')).toBe('1.75');
    expect(svg.getAttribute('stroke')).toBe('currentColor');
    expect(svg.getAttribute('stroke-linecap')).toBe('round');
    expect(svg.getAttribute('stroke-linejoin')).toBe('round');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('focusable')).toBe('false');
    expect(svg.children.length).toBeGreaterThan(0);
  });

  it.each(ICON_NAMES)('%s is a stroke glyph unless it is a documented solid one', (name) => {
    const solid = svgOf(name).querySelector('[fill="currentColor"]');
    if (FILLED.has(name)) expect(solid).not.toBeNull();
    else expect(solid).toBeNull();
  });

  it('sizes by attribute, 16 by default, and aligns itself without a stylesheet', () => {
    const small = svgOf('close');
    expect(small.getAttribute('width')).toBe('16');
    expect(small.getAttribute('height')).toBe('16');
    // display: inline-block beats the bundle's preflight `svg { display: block }`,
    // which stacked icons above their labels in non-flex parents (drawer footer).
    expect(small).toHaveStyle({ display: 'inline-block', verticalAlign: '-0.125em', flex: 'none' });

    cleanup();
    const { container } = render(<Icon name="close" size={22} />);
    const big = container.querySelector('svg');
    expect(big?.getAttribute('width')).toBe('22');
    expect(big?.getAttribute('height')).toBe('22');
  });

  it.each(['nope', '', 'constructor', '__proto__', 'toString'])(
    'renders nothing for the unknown name %j',
    (name) => {
      const { container } = render(<Icon name={name} />);
      expect(container).toBeEmptyDOMElement();
    },
  );
});

// The settings glyph was a sun: the shape the dock drew before this module existed,
// kept through a refactor. It is the control that opens preferences, and a sun reads
// as "theme" or "brightness". The test pins what a gear IS rather than only what the
// sun was, so a different wrong glyph cannot slip in behind the same assertion.
describe('the settings glyph', () => {
  const settings = () => svgOf('settings');

  it('is not the old sun: no 3.5-radius disc and no ring of eight rays', () => {
    const svg = settings();
    expect(svg.querySelector('circle[r="3.5"]')).toBeNull();
    const d = [...svg.querySelectorAll('path')].map((p) => p.getAttribute('d') ?? '').join(' ');
    // The rays were eight short straight spokes: M<x> <y> V/H<n> moves with no curve between.
    expect(d).not.toContain('M12 2.5 V5');
    expect(d).not.toMatch(/M7\.05 7\.05 L5\.28 5\.28/);
  });

  it('is a gear: a hub circle inside one closed toothed outline', () => {
    const svg = settings();
    const hub = svg.querySelector('circle');
    expect(hub, 'a hub').not.toBeNull();
    expect(hub?.getAttribute('cx')).toBe('12');
    expect(hub?.getAttribute('cy')).toBe('12');
    const outline = svg.querySelector('path');
    expect(outline, 'an outline').not.toBeNull();
    const d = outline?.getAttribute('d') ?? '';
    // Closed (a gear has no loose ends), and eight teeth: eight arcs of the tooth tips.
    expect(d.trim().endsWith('Z')).toBe(true);
    expect(d.match(/\bA/g)?.length ?? 0).toBeGreaterThanOrEqual(16);
  });

  it('keeps inside the 24-unit frame with the stroke, and uses no fill', () => {
    const svg = settings();
    expect(svg.querySelector('[fill]:not([fill="none"])')).toBeNull();
    // Coordinates only: an arc's radii, rotation and flags are not points.
    const points = [...svg.querySelectorAll('path')].flatMap((p) =>
      [...(p.getAttribute('d') ?? '').matchAll(/([MLA])([^MLAZ]*)/g)].flatMap(([, cmd, args]) => {
        const n = (args ?? '')
          .trim()
          .split(/[\s,]+/)
          .map(Number);
        return cmd === 'A' ? n.slice(5) : n;
      }),
    );
    expect(points.length).toBeGreaterThan(40);
    // Half the 1.75 stroke hangs outside any path, so the geometry stops short of the edge.
    for (const n of points) {
      expect(n).toBeGreaterThanOrEqual(0.875);
      expect(n).toBeLessThanOrEqual(24 - 0.875);
    }
  });

  it('is a different shape from every other icon', () => {
    const own = shapes('settings');
    for (const name of ICON_NAMES.filter((n) => n !== 'settings')) {
      expect(shapes(name), name).not.toBe(own);
    }
  });
});

describe('namedIcon', () => {
  it('is an icon for a known name and null for anything else', () => {
    expect(namedIcon('mic')).not.toBeNull();
    expect(namedIcon(undefined)).toBeNull();
    expect(namedIcon('')).toBeNull();
    expect(namedIcon('nope')).toBeNull();
    // The old lookup was `NAMED[name]`, which answered a function for these.
    expect(namedIcon('constructor')).toBeNull();
    expect(namedIcon('__proto__')).toBeNull();
  });
});

describe('IconFrame', () => {
  it('carries arbitrary shapes in the same frame', () => {
    const { container } = render(
      <IconFrame size={10}>
        <path d="M0 0 L1 1" />
      </IconFrame>,
    );
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('stroke-width')).toBe('1.75');
    expect(svg?.getAttribute('width')).toBe('10');
  });
});

describe('rendered consumers', () => {
  it('the dock rail and its close button draw 1.75 strokes', () => {
    render(
      <DockPanel
        view="files"
        rail
        onView={vi.fn()}
        actions={[
          { id: 'upload', label: 'Upload a file', onRun: vi.fn() },
          { id: 'download', label: 'Download', onRun: vi.fn() },
        ]}
      />,
    );
    // Four views + two actions + the open view's close button.
    const buttons = [
      ...screen.getByTestId('dock-rail').querySelectorAll('button'),
      screen.getByTestId('dock-close'),
    ];
    expect(buttons).toHaveLength(7);
    for (const button of buttons) {
      const svg = button.querySelector('svg');
      expect(svg, button.getAttribute('aria-label') ?? '').not.toBeNull();
      expect(svg?.getAttribute('stroke-width')).toBe('1.75');
    }
  });

  // Which icon sits on which control is the rail's whole vocabulary: a swapped pair
  // would still draw 1.75 strokes everywhere.
  it('the dock rail draws one specific icon per control', () => {
    render(
      <DockPanel
        view="files"
        rail
        onView={vi.fn()}
        actions={[
          { id: 'upload', label: 'Upload a file', onRun: vi.fn() },
          { id: 'download', label: 'Download', onRun: vi.fn() },
        ]}
      />,
    );
    for (const [id, icon] of [
      ['dock-rail-settings', 'settings'],
      ['dock-rail-newtab', 'plus'],
      ['dock-rail-files', 'folder'],
      ['dock-rail-dictation', 'mic'],
      ['dock-rail-upload', 'upload'],
      ['dock-rail-download', 'download'],
      ['dock-close', 'close'],
    ] as const) {
      const button = screen.getByTestId(id);
      expect(button.querySelector('svg')?.innerHTML, id).toBe(shapes(icon));
      expect(button.textContent, id).toBe('');
      // No visible text, so the aria-label is the whole name.
      expect(button.getAttribute('aria-label'), id).toBeTruthy();
    }
  });

  it('the dock close button keeps its accessible name now that it has no text', () => {
    render(<DockPanel view="settings" rail={false} onView={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Close panel' })).toBe(
      screen.getByTestId('dock-close'),
    );
  });

  it("the drawer's view switcher draws 1.75 strokes", () => {
    const tabs: TabMeta[] = [{ id: '0', kind: 'terminal', title: 'vim' }];
    render(
      <SessionDrawer
        open
        tabs={tabs}
        current="0"
        onSwitch={vi.fn()}
        onCreate={vi.fn()}
        onKill={vi.fn()}
        onClose={vi.fn()}
        onTabMenu={vi.fn()}
        actions={{
          uploadFile: vi.fn(),
          uploadImages: vi.fn(),
          downloadFile: vi.fn(),
          dictate: vi.fn(),
        }}
        settings={DEFAULTS}
        onChangeSettings={vi.fn()}
      />,
    );
    const items = screen.getByTestId('drawer-view').querySelectorAll('button');
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.querySelector('svg')?.getAttribute('stroke-width')).toBe('1.75');
    }
  });
});

// A name typed wrong draws NOTHING: `<Icon>` answers null for an unknown name (that
// is the contract a config-supplied name needs), and `name` is a plain string, so
// a typo compiles. The glyph guard cannot see it either. The rail, the strip and
// the menus would each lose a button face with no error anywhere.
describe('the shared registry is what the chrome asks for', () => {
  it('the dock registry keeps its shape and draws the rail glyphs it always meant', () => {
    // newtab is a plus, files a folder, dictation a mic: the rail's identities
    // survive the move into the shared module.
    const expected = {
      sessions: 'sessions',
      settings: 'settings',
      newtab: 'plus',
      files: 'folder',
      dictation: 'mic',
      upload: 'upload',
      download: 'download',
    } as const;
    expect(Object.keys(DOCK_ICONS).toSorted()).toEqual(Object.keys(expected).toSorted());
    for (const [key, name] of Object.entries(expected) as [keyof typeof DOCK_ICONS, string][]) {
      const host = document.createElement('div');
      render(<>{DOCK_ICONS[key]}</>, { container: host });
      const svg = host.querySelector('svg');
      expect(svg, key).not.toBeNull();
      expect(svg?.innerHTML, key).toBe(shapes(name));
      expect(svg?.getAttribute('width'), key).toBe('15');
    }
  });

  it('every kind draws a registered icon, and they are all different', () => {
    expect(TAB_KINDS.map(kindIcon)).toEqual(['terminal', 'globe', 'dashboard', 'pencil', 'book']);
    for (const kind of TAB_KINDS) expect(ICON_NAMES).toContain(kindIcon(kind));
    expect(new Set(TAB_KINDS.map((kind) => shapes(kindIcon(kind)))).size).toBe(TAB_KINDS.length);
  });
});

describe('keyFace', () => {
  // The arrow and symbol faces draw inside the shared frame, so the extra-keys bar
  // keeps one stroke weight with the rest of the app.
  it.each(['UP', 'DOWN', 'LEFT', 'RIGHT', 'ARROWUP', 'TAB', '-', '/', '~'])(
    '%s draws in the shared frame',
    (id) => {
      const { container } = render(<>{keyFace(id)}</>);
      const svg = container.querySelector('svg');
      expect(svg).not.toBeNull();
      expect(svg?.getAttribute('stroke-width')).toBe('1.75');
      expect(svg?.getAttribute('stroke')).toBe('currentColor');
      expect(svg?.getAttribute('viewBox')).toBe('0 0 24 24');
    },
  );

  it('leaves word keys to their text label', () => {
    for (const id of ['', 'CTRL', 'ALT', 'SHIFT', 'ESC', 'ENTER', 'nope']) {
      expect(keyFace(id), id).toBeNull();
    }
  });

  it('draws the four arrows differently', () => {
    const faces = ['UP', 'DOWN', 'LEFT', 'RIGHT'].map((id) => {
      const host = document.createElement('div');
      render(<>{keyFace(id)}</>, { container: host });
      return host.querySelector('svg')?.innerHTML;
    });
    expect(new Set(faces).size).toBe(4);
  });
});

describe('SearchBar', () => {
  // Its three buttons held ↑ ↓ ✕ characters and a hover title. The icon is
  // aria-hidden, so the aria-label is the accessible name, and the title (which
  // carries the shortcut) stays.
  it('draws prev, next and close as the named icons and keeps each named', () => {
    const onClose = vi.fn();
    render(<SearchBar search={() => null} onClose={onClose} />);
    for (const [label, title, icon] of [
      ['Previous match', 'Previous (Shift+Enter)', 'arrow-up'],
      ['Next match', 'Next (Enter)', 'arrow-down'],
      ['Close search', 'Close (Esc)', 'close'],
    ] as const) {
      const button = screen.getByRole('button', { name: label });
      expect(button).toHaveAttribute('title', title);
      expect(button.textContent).toBe('');
      expect(button.querySelectorAll('svg')).toHaveLength(1);
      expect(button.querySelector('svg')?.innerHTML, label).toBe(shapes(icon));
    }
    fireEvent.click(screen.getByRole('button', { name: 'Close search' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('Collapsible', () => {
  // ui.css turns the chevron 90 degrees when the trigger is open, so the icon must
  // be the closed shape in BOTH states: swapping it for a chevron-down on open
  // would rotate it a second time. The span keeps its class for that rule.
  it('keeps one rotatable chevron, the same shape open and closed', () => {
    render(<Collapsible title="Keys">body</Collapsible>);
    const trigger = screen.getByTestId('ui-collapsible-trigger');
    const chevron = () => trigger.querySelector('.ui-collapsible-chevron');
    expect(chevron()).toHaveAttribute('aria-hidden', 'true');
    expect(chevron()?.querySelectorAll('svg')).toHaveLength(1);
    expect(chevron()?.textContent).toBe('');
    expect(chevron()?.querySelector('svg')?.innerHTML).toBe(shapes('chevron-right'));

    expect(trigger).toHaveAttribute('data-state', 'open');
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('data-state', 'closed');
    expect(chevron()?.querySelector('svg')?.innerHTML).toBe(shapes('chevron-right'));
    // The label is still the trigger's name: the chevron adds no text to it.
    expect(trigger).toHaveTextContent(/^Keys$/);
  });
});
