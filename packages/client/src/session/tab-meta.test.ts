import { describe, expect, it } from 'vitest';
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
});

describe('palette', () => {
  it('has 16 distinct ansi slots and an icon per kind', () => {
    expect(TAB_COLORS).toHaveLength(16);
    expect(new Set(TAB_COLORS.map((c) => c.value)).size).toBe(16);
    expect(new Set(TAB_COLORS.map((c) => c.name)).size).toBe(16);
    for (let n = 0; n < 16; n++) {
      expect(TAB_COLORS.find((c) => c.name === `ansi${n}`)?.value).toBe(`var(--tab-c-ansi${n})`);
    }
    for (const kind of ['terminal', 'web', 'dashboard', 'editor', 'markdown'] as const) {
      expect(kindIcon(kind)).toBeTruthy();
    }
  });

  describe('resolveColorSlot', () => {
    it('returns a valid slot name as-is', () => {
      expect(resolveColorSlot('ansi3')).toBe('ansi3');
      expect(resolveColorSlot('ansi0')).toBe('ansi0');
      expect(resolveColorSlot('ansi15')).toBe('ansi15');
    });

    it('maps every legacy name to its ansi slot, including both peach and maroon to ansi9', () => {
      expect(resolveColorSlot('red')).toBe('ansi1');
      expect(resolveColorSlot('green')).toBe('ansi2');
      expect(resolveColorSlot('yellow')).toBe('ansi3');
      expect(resolveColorSlot('blue')).toBe('ansi4');
      expect(resolveColorSlot('mauve')).toBe('ansi5');
      expect(resolveColorSlot('teal')).toBe('ansi6');
      expect(resolveColorSlot('gray')).toBe('ansi8');
      expect(resolveColorSlot('peach')).toBe('ansi9');
      expect(resolveColorSlot('maroon')).toBe('ansi9');
      expect(resolveColorSlot('lavender')).toBe('ansi12');
      expect(resolveColorSlot('pink')).toBe('ansi13');
      expect(resolveColorSlot('sky')).toBe('ansi14');
    });

    it('unknown/absent name → undefined', () => {
      expect(resolveColorSlot('nope')).toBeUndefined();
      expect(resolveColorSlot(undefined)).toBeUndefined();
    });
  });

  describe('tabColorValue', () => {
    it('resolves slots and legacy names to their accent var; unknown/absent → undefined', () => {
      expect(tabColorValue('ansi3')).toBe('var(--tab-c-ansi3)');
      expect(tabColorValue('green')).toBe('var(--tab-c-ansi2)');
      expect(tabColorValue('sky')).toBe('var(--tab-c-ansi14)');
      expect(tabColorValue('nope')).toBeUndefined();
      expect(tabColorValue(undefined)).toBeUndefined();
    });
  });

  describe('tabColorInk', () => {
    it('resolves slots and legacy names to their ink var; unknown/absent → undefined', () => {
      expect(tabColorInk('ansi3')).toBe('var(--tab-c-ansi3-ink)');
      expect(tabColorInk('peach')).toBe('var(--tab-c-ansi9-ink)');
      expect(tabColorInk('maroon')).toBe('var(--tab-c-ansi9-ink)');
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
