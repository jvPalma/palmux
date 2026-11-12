import { describe, expect, it } from 'vitest';
import { COLOR_PROFILES, deriveTabColors, TAB_KINDS, fileReviewUrl } from '@palmux/shared';
import {
  displayTitle,
  kindIcon,
  neighborAfterClose,
  reorderIds,
  resolveColorSlot,
  tabColorInk,
  tabColorValue,
  TAB_COLORS,
} from './tab-meta';

describe('displayTitle', () => {
  // An `editor` tab is TWO things, told apart by `url`: with an absolute path it
  // edits that file on disk (opened from the Explorer, and named after it),
  // without one it is the tab's own note. Naming both "notes" made a strip of
  // open files unreadable.
  it('names a file-backed editor tab after its file', () => {
    expect(displayTitle({ id: '3', kind: 'editor', url: '/home/user/.claude.json' })).toBe(
      '.claude.json',
    );
    expect(displayTitle({ id: '3', kind: 'editor', url: '/a/b/server.ts' })).toBe('server.ts');
  });

  it('still calls a note a note', () => {
    expect(displayTitle({ id: '3', kind: 'editor' })).toBe('notes');
  });

  it('lets an explicit name win over the file name', () => {
    expect(displayTitle({ id: '3', kind: 'editor', url: '/a/b.ts', name: 'scratch' })).toBe(
      'scratch',
    );
  });

  it('prefers the custom name over everything', () => {
    expect(displayTitle({ id: '0', kind: 'terminal', name: 'api', title: 'vim' })).toBe('api');
    expect(displayTitle({ id: '1', kind: 'web', name: 'SB', url: 'https://sb.local' })).toBe('SB');
  });

  it('falls back to the OSC title for terminals, then to "shell"', () => {
    expect(displayTitle({ id: '0', kind: 'terminal', title: 'vim' })).toBe('vim');
    expect(displayTitle({ id: '0', kind: 'terminal' })).toBe('shell');
  });

  it('uses the hostname for absolute web urls and the basename for same-origin paths', () => {
    expect(displayTitle({ id: '1', kind: 'web', url: 'https://sb.example.com/page' })).toBe(
      'sb.example.com',
    );
    expect(displayTitle({ id: '1', kind: 'web', url: '/artifacts/report.html' })).toBe(
      'report.html',
    );
    expect(displayTitle({ id: '1', kind: 'web' })).toBe('web');
  });

  it('has kind defaults for dashboard and editor', () => {
    expect(displayTitle({ id: '2', kind: 'dashboard' })).toBe('dashboard');
    expect(displayTitle({ id: '3', kind: 'editor' })).toBe('notes');
  });

  // A review tab is named for what it shows and which project it is about, so two
  // reviews of one project (Changes and Staged) and two projects stay apart.
  describe('review tabs', () => {
    it('names a single-file review after the file and the group', () => {
      expect(
        displayTitle({ id: '4', kind: 'review', url: fileReviewUrl('changes', '/work/p', 'src/a.ts') }),
      ).toBe('a.ts (Changes)');
      expect(
        displayTitle({ id: '4', kind: 'review', url: fileReviewUrl('staged', '/work/p', 'b.md') }),
      ).toBe('b.md (Staged)');
    });

    it('names Changes and Staged after the project folder', () => {
      expect(displayTitle({ id: '4', kind: 'review', url: 'changes:/work/palmux' })).toBe(
        'Changes · palmux',
      );
      expect(displayTitle({ id: '5', kind: 'review', url: 'staged:/work/palmux' })).toBe(
        'Staged · palmux',
      );
    });

    it('uses the last folder of a nested project, trailing slash or not', () => {
      expect(
        displayTitle({ id: '4', kind: 'review', url: 'changes:/home/user/projects/a b' }),
      ).toBe('Changes · a b');
      expect(displayTitle({ id: '4', kind: 'review', url: 'staged:/work/palmux/' })).toBe(
        'Staged · palmux',
      );
    });

    it('falls back to the whole path for a project at the root', () => {
      expect(displayTitle({ id: '4', kind: 'review', url: 'changes:/' })).toBe('Changes · /');
    });

    it('lets an explicit name win', () => {
      expect(
        displayTitle({ id: '4', kind: 'review', url: 'changes:/work/palmux', name: 'api review' }),
      ).toBe('api review');
    });

    it('is just "review" when the url is missing or is not a review url', () => {
      expect(displayTitle({ id: '4', kind: 'review' })).toBe('review');
      expect(displayTitle({ id: '4', kind: 'review', url: '/work/palmux' })).toBe('review');
      expect(displayTitle({ id: '4', kind: 'review', url: 'changes:relative' })).toBe('review');
    });
  });
});

describe('palette', () => {
  it('has the fifteen named colours, each its own var, and an icon per kind', () => {
    expect(TAB_COLORS.map((c) => c.name)).toEqual([
      'white',
      'gray',
      'pink',
      'magenta',
      'purple',
      'blue',
      'light-blue',
      'cyan',
      'green',
      'lime',
      'yellow',
      'orange',
      'red',
      'crimson-red',
      'black',
    ]);
    for (const c of TAB_COLORS) expect(c.value).toBe(`var(--tab-c-${c.name})`);
    for (const kind of ['terminal', 'web', 'dashboard', 'editor', 'markdown', 'review'] as const) {
      expect(kindIcon(kind)).toBeTruthy();
    }
    // The strip tells kinds apart by icon, so no two share one.
    expect(new Set(TAB_KINDS.map(kindIcon)).size).toBe(TAB_KINDS.length);
  });

  // Six of the fifteen are not ANSI hues and are derived. A derivation that
  // collapses two names would leave a swatch that repeats another: reusing
  // deriveAccents put two names on one colour in every built-in theme (purple on
  // magenta in ten, pink on magenta in the two Catppuccins). The anchors are the
  // theme's own slots, so where a theme's slot already sits on the in-between
  // hue the pair is close (Catppuccin's magenta is pink: 18): the floor is "never
  // the same colour", not "always far apart".
  it('derives fifteen distinguishable colours in every built-in theme', () => {
    const rgb = (n: number) => [(n >> 16) & 255, (n >> 8) & 255, n & 255] as const;
    const dist = (a: number, b: number) => {
      const [x, y] = [rgb(a), rgb(b)];
      return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
    };
    for (const p of COLOR_PROFILES) {
      const colors = deriveTabColors(p);
      expect(Object.keys(colors)).toEqual(TAB_COLORS.map((c) => c.name));
      const entries = Object.entries(colors);
      for (let i = 0; i < entries.length; i++) {
        for (let j = i + 1; j < entries.length; j++) {
          const [[an, a], [bn, b]] = [entries[i]!, entries[j]!];
          expect(dist(a, b), `${p.id}: ${an} ~ ${bn}`).toBeGreaterThanOrEqual(15);
        }
      }
    }
  });

  // A name must draw its own hue, whatever the theme's slot is. Ayu Dark's
  // magenta slot is orange (50°), which made purple green and pink orange until
  // the anchors were held inside their bands.
  it('draws every chromatic name inside its hue band in every built-in theme', () => {
    const BANDS: { [name: string]: [number, number] } = {
      red: [320, 30],
      'crimson-red': [320, 20],
      pink: [300, 355],
      magenta: [240, 350],
      purple: [230, 300],
      blue: [175, 275],
      'light-blue': [150, 235],
      cyan: [115, 215],
      green: [55, 170],
      lime: [45, 110],
      yellow: [25, 75],
      orange: [5, 40],
    };
    const hue = (n: number) => {
      const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255) as [
        number,
        number,
        number,
      ];
      const [max, min] = [Math.max(r, g, b), Math.min(r, g, b)];
      const d = max - min;
      const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      return h * 60;
    };
    for (const p of COLOR_PROFILES) {
      const colors = deriveTabColors(p);
      for (const [name, [from, to]] of Object.entries(BANDS)) {
        const h = hue(colors[name as keyof typeof colors]);
        const inside = from <= to ? h >= from && h <= to : h >= from || h <= to;
        expect(inside, `${p.id}: ${name} at ${Math.round(h)}°`).toBe(true);
      }
    }
  });

  describe('resolveColorSlot', () => {
    it('returns a palette name as-is', () => {
      for (const c of TAB_COLORS) expect(resolveColorSlot(c.name)).toBe(c.name);
    });

    // tabs.json and groups.json are never rewritten, and the server still
    // assigns the pre-ANSI names to a new group, so every older name resolves.
    it('maps every ansi slot to its hue, the bright ones included, and 8 to gray', () => {
      const hues = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];
      for (let n = 0; n < 16; n++) {
        expect(resolveColorSlot(`ansi${n}`), `ansi${n}`).toBe(n === 8 ? 'gray' : hues[n % 8]);
      }
    });

    it('maps every pre-ANSI name to its nearest colour', () => {
      expect(resolveColorSlot('mauve')).toBe('purple');
      expect(resolveColorSlot('teal')).toBe('cyan');
      expect(resolveColorSlot('peach')).toBe('orange');
      expect(resolveColorSlot('maroon')).toBe('crimson-red');
      expect(resolveColorSlot('lavender')).toBe('light-blue');
      expect(resolveColorSlot('sky')).toBe('light-blue');
      for (const same of ['red', 'green', 'yellow', 'blue', 'gray', 'pink']) {
        expect(resolveColorSlot(same)).toBe(same);
      }
    });

    it('unknown/absent name → undefined', () => {
      expect(resolveColorSlot('nope')).toBeUndefined();
      expect(resolveColorSlot('grimson-red')).toBeUndefined();
      expect(resolveColorSlot(undefined)).toBeUndefined();
    });
  });

  describe('tabColorValue', () => {
    it('resolves names and older names to their var; unknown/absent → undefined', () => {
      expect(tabColorValue('light-blue')).toBe('var(--tab-c-light-blue)');
      expect(tabColorValue('ansi11')).toBe('var(--tab-c-yellow)');
      expect(tabColorValue('sky')).toBe('var(--tab-c-light-blue)');
      expect(tabColorValue('nope')).toBeUndefined();
      expect(tabColorValue(undefined)).toBeUndefined();
    });
  });

  describe('tabColorInk', () => {
    it('resolves names and older names to their ink var; unknown/absent → undefined', () => {
      expect(tabColorInk('crimson-red')).toBe('var(--tab-c-crimson-red-ink)');
      expect(tabColorInk('peach')).toBe('var(--tab-c-orange-ink)');
      expect(tabColorInk('maroon')).toBe('var(--tab-c-crimson-red-ink)');
      expect(tabColorInk('nope')).toBeUndefined();
      expect(tabColorInk(undefined)).toBeUndefined();
    });
  });
});

describe('reorderIds', () => {
  const ids = ['0', '1', '2', '3'];

  it('moves a tab to an insertion index over the current list', () => {
    expect(reorderIds(ids, '3', 1)).toEqual(['0', '3', '1', '2']); // drag left
    expect(reorderIds(ids, '0', 3)).toEqual(['1', '2', '0', '3']); // drag right
    expect(reorderIds(ids, '0', 4)).toEqual(['1', '2', '3', '0']); // append
  });

  it('dropping a tab on its own position is identity', () => {
    expect(reorderIds(ids, '1', 1)).toEqual(ids);
    expect(reorderIds(ids, '1', 2)).toEqual(ids); // right half of itself
  });

  it('is total: unknown id and out-of-range indices are safe', () => {
    expect(reorderIds(ids, '9', 1)).toEqual(ids);
    expect(reorderIds(ids, '2', -5)).toEqual(['2', '0', '1', '3']);
    expect(reorderIds(ids, '2', 99)).toEqual(['0', '1', '3', '2']);
  });
});

describe('neighborAfterClose', () => {
  const s = (...ids: string[]) => new Set(ids);

  it('prefers the LEFT strip neighbor', () => {
    expect(neighborAfterClose(['0', '1', '2'], '1', s('0', '2'))).toBe('0');
  });

  it('falls back to the right neighbor at the left edge', () => {
    expect(neighborAfterClose(['0', '1', '2'], '0', s('1', '2'))).toBe('1');
  });

  it('skips tabs that died in the same broadcast', () => {
    expect(neighborAfterClose(['0', '1', '2'], '2', s('0'))).toBe('0');
  });

  it('null when nothing survives (show the New-tab page)', () => {
    expect(neighborAfterClose(['0'], '0', s())).toBeNull();
  });

  it('unknown closed id falls back to the first survivor', () => {
    expect(neighborAfterClose(['0', '1'], '9', s('0', '1'))).toBe('0');
    expect(neighborAfterClose([], '9', s())).toBeNull();
  });
});
