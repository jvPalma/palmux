import { describe, expect, it } from 'vitest';
import {
  encodeClientMessage,
  encodeServerMessage,
  isTabKind,
  isWindowId,
  parseClientMessage,
  parseServerMessage,
  TAB_KINDS,
} from '@palmux/shared';
import type { ClientMessage, ServerMessage } from '@palmux/shared';

const frame = (fields: Record<string, unknown>) =>
  parseServerMessage(JSON.stringify({ type: 'scmComments', ...fields }));
const send = (fields: Record<string, unknown>) =>
  parseClientMessage(JSON.stringify({ type: 'moveToWindow', ...fields }));

describe('parseServerMessage', () => {
  it('round-trips a ready message', () => {
    const msg: ServerMessage = {
      type: 'ready',
      cols: 80,
      rows: 24,
      maxUploadBytes: 52428800,
      webApps: [{ name: 'SilverBullet', url: 'https://sb.local' }],
      version: '2.0.0+abc1234',
    };
    expect(parseServerMessage(encodeServerMessage(msg))).toEqual(msg);
  });

  it('defaults maxUploadBytes and webApps when a ready message omits them (older server)', () => {
    const parsed = parseServerMessage(JSON.stringify({ type: 'ready', cols: 80, rows: 24 }));
    expect(parsed).toEqual({
      type: 'ready',
      cols: 80,
      rows: 24,
      maxUploadBytes: 50 * 1024 * 1024,
      webApps: [],
      version: '',
    });
  });

  it('drops malformed webApps entries', () => {
    const parsed = parseServerMessage(
      JSON.stringify({
        type: 'ready',
        cols: 1,
        rows: 1,
        webApps: [{ name: 'ok', url: 'https://x', icon: '📓' }, { name: 'no-url' }, 'junk', 7],
      }),
    );
    expect(parsed).toMatchObject({ webApps: [{ name: 'ok', url: 'https://x', icon: '📓' }] });
  });

  it('round-trips a settings message', () => {
    const msg: ServerMessage = {
      type: 'settings',
      settings: { fontSize: 14, theme: 'dark', nested: { a: [1, 2, 3] } },
    };
    expect(parseServerMessage(encodeServerMessage(msg))).toEqual(msg);
  });

  it('round-trips an empty settings object', () => {
    const msg: ServerMessage = { type: 'settings', settings: {} };
    expect(parseServerMessage(encodeServerMessage(msg))).toEqual(msg);
  });

  it('round-trips an extraKeys message', () => {
    const msg: ServerMessage = {
      type: 'extraKeys',
      extraKeys: { enabled: true, layout: [['ESC', 'TAB']] },
    };
    expect(parseServerMessage(encodeServerMessage(msg))).toEqual(msg);
  });

  it('round-trips a sessions message with tab metadata', () => {
    const msg: ServerMessage = {
      type: 'sessions',
      ids: ['0', '2'],
      titles: { '0': 'vim' },
      tabs: [
        {
          id: '0',
          kind: 'terminal',
          title: 'vim',
          name: 'edit',
          color: 'green',
          groupId: 'gabc123',
        },
        { id: '2', kind: 'web', url: 'https://sb.local' },
      ],
      groups: [{ id: 'gabc123', name: 'edit', color: 'blue' }],
    };
    expect(parseServerMessage(encodeServerMessage(msg))).toEqual(msg);
  });

  it('drops non-string ids and titles from a sessions message', () => {
    expect(
      parseServerMessage(
        JSON.stringify({
          type: 'sessions',
          ids: ['0', 1, null, '2'],
          titles: { '0': 7, '2': 'sh' },
        }),
      ),
    ).toMatchObject({ type: 'sessions', ids: ['0', '2'], titles: { '2': 'sh' } });
  });

  it('synthesizes terminal tabs from ids/titles when tabs is absent (older server)', () => {
    expect(
      parseServerMessage(
        JSON.stringify({ type: 'sessions', ids: ['0', '1'], titles: { '1': 'sh' } }),
      ),
    ).toEqual({
      type: 'sessions',
      ids: ['0', '1'],
      titles: { '1': 'sh' },
      tabs: [
        { id: '0', kind: 'terminal' },
        { id: '1', kind: 'terminal', title: 'sh' },
      ],
      groups: [],
    });
  });

  it('drops malformed tab entries (unknown kind, missing id)', () => {
    expect(
      parseServerMessage(
        JSON.stringify({
          type: 'sessions',
          ids: ['0'],
          titles: {},
          tabs: [{ id: '0', kind: 'terminal' }, { id: '9', kind: 'popup' }, { kind: 'web' }, null],
        }),
      ),
    ).toMatchObject({ tabs: [{ id: '0', kind: 'terminal' }] });
  });

  it('round-trips a tabCreated message and rejects a missing id', () => {
    const msg: ServerMessage = { type: 'tabCreated', id: '3' };
    expect(parseServerMessage(encodeServerMessage(msg))).toEqual(msg);
    expect(parseServerMessage(JSON.stringify({ type: 'tabCreated' }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ type: 'tabCreated', id: 3 }))).toBeNull();
  });

  it('round-trips an exit message with numeric code/signal', () => {
    const msg: ServerMessage = { type: 'exit', code: 0, signal: null };
    expect(parseServerMessage(encodeServerMessage(msg))).toEqual(msg);
  });

  it('coerces a missing/non-numeric exit code and signal to null', () => {
    expect(parseServerMessage(JSON.stringify({ type: 'exit' }))).toEqual({
      type: 'exit',
      code: null,
      signal: null,
    });
    expect(parseServerMessage(JSON.stringify({ type: 'exit', code: '1', signal: 'x' }))).toEqual({
      type: 'exit',
      code: null,
      signal: null,
    });
  });

  it('returns null for invalid JSON', () => {
    expect(parseServerMessage('not json')).toBeNull();
    expect(parseServerMessage('{')).toBeNull();
  });

  it('returns null for a JSON array', () => {
    expect(parseServerMessage('[1,2,3]')).toBeNull();
  });

  it('returns null for a JSON primitive', () => {
    expect(parseServerMessage('42')).toBeNull();
    expect(parseServerMessage('"hi"')).toBeNull();
    expect(parseServerMessage('null')).toBeNull();
  });

  it('returns null when type is missing or not a string', () => {
    expect(parseServerMessage(JSON.stringify({ cols: 1, rows: 1 }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ type: 7 }))).toBeNull();
  });

  it('returns null for an unknown type', () => {
    expect(parseServerMessage(JSON.stringify({ type: 'nope' }))).toBeNull();
  });

  it('returns null for ready with non-numeric dimensions', () => {
    expect(parseServerMessage(JSON.stringify({ type: 'ready', cols: '80', rows: 24 }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ type: 'ready' }))).toBeNull();
  });

  it('returns null for settings/extraKeys with a non-object payload', () => {
    expect(parseServerMessage(JSON.stringify({ type: 'settings', settings: 'x' }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ type: 'settings', settings: [1] }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ type: 'extraKeys', extraKeys: 5 }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ type: 'settings' }))).toBeNull();
  });

  it('round-trips an scmComments message', () => {
    const msg: ServerMessage = { type: 'scmComments', repo: '/work/palmux', rev: 12 };
    expect(parseServerMessage(encodeServerMessage(msg))).toEqual(msg);
    expect(
      parseServerMessage(JSON.stringify({ type: 'scmComments', repo: '/work/palmux', rev: 0 })),
    ).toEqual({ type: 'scmComments', repo: '/work/palmux', rev: 0 });
  });

  it('drops an scmComments frame without a usable repo or rev', () => {
    expect(frame({ rev: 1 })).toBeNull();
    expect(frame({ repo: '/work/palmux' })).toBeNull();
    expect(frame({ repo: '', rev: 1 })).toBeNull();
    expect(frame({ repo: 7, rev: 1 })).toBeNull();
    expect(frame({ repo: '/work/palmux', rev: '1' })).toBeNull();
    expect(frame({ repo: '/work/palmux', rev: -1 })).toBeNull();
    expect(frame({ repo: '/work/palmux', rev: 1.5 })).toBeNull();
    expect(frame({ repo: '/work/palmux', rev: null })).toBeNull();
  });

  it('keeps a review tab, with its url, in a sessions message', () => {
    const msg: ServerMessage = {
      type: 'sessions',
      ids: ['0', '1'],
      titles: {},
      tabs: [
        { id: '0', kind: 'terminal' },
        { id: '1', kind: 'review', url: 'changes:/work/palmux' },
      ],
      groups: [],
    };
    expect(parseServerMessage(encodeServerMessage(msg))).toEqual(msg);
  });
});

describe('tab kinds', () => {
  it('includes review, and still refuses an unknown kind', () => {
    expect(TAB_KINDS).toContain('review');
    expect(isTabKind('review')).toBe(true);
    expect(isTabKind('popup')).toBe(false);
  });
});

describe('parseClientMessage', () => {
  it('round-trips a resize message', () => {
    const msg: ClientMessage = { type: 'resize', cols: 120, rows: 40 };
    expect(parseClientMessage(encodeClientMessage(msg))).toEqual(msg);
  });

  it('round-trips a settings message', () => {
    const msg: ClientMessage = { type: 'settings', settings: { cursorBlink: false } };
    expect(parseClientMessage(encodeClientMessage(msg))).toEqual(msg);
  });

  it('round-trips an extraKeys message', () => {
    const msg: ClientMessage = { type: 'extraKeys', extraKeys: {} };
    expect(parseClientMessage(encodeClientMessage(msg))).toEqual(msg);
  });

  it('round-trips a kill message', () => {
    const msg: ClientMessage = { type: 'kill', id: '3' };
    expect(parseClientMessage(encodeClientMessage(msg))).toEqual(msg);
  });

  it('returns null for a kill message missing a string id', () => {
    expect(parseClientMessage(JSON.stringify({ type: 'kill' }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: 'kill', id: 3 }))).toBeNull();
  });

  it('round-trips createTab messages', () => {
    const full: ClientMessage = {
      type: 'createTab',
      kind: 'web',
      url: 'https://sb.local',
      name: 'notes',
      color: 'blue',
    };
    expect(parseClientMessage(encodeClientMessage(full))).toEqual(full);
    const bare: ClientMessage = { type: 'createTab', kind: 'terminal' };
    expect(parseClientMessage(encodeClientMessage(bare))).toEqual(bare);
  });

  it('round-trips a review createTab with its url', () => {
    const msg: ClientMessage = { type: 'createTab', kind: 'review', url: 'staged:/work/palmux' };
    expect(parseClientMessage(encodeClientMessage(msg))).toEqual(msg);
  });

  it('returns null for createTab with an unknown kind (forgiving drop, not a crash)', () => {
    expect(parseClientMessage(JSON.stringify({ type: 'createTab', kind: 'popup' }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: 'createTab' }))).toBeNull();
  });

  it('round-trips updateTab messages, including empty-string clears', () => {
    const msg: ClientMessage = { type: 'updateTab', id: '3', name: '', color: 'red' };
    expect(parseClientMessage(encodeClientMessage(msg))).toEqual(msg);
  });

  it('returns null for updateTab without a string id and drops non-string fields', () => {
    expect(parseClientMessage(JSON.stringify({ type: 'updateTab' }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: 'updateTab', id: 4 }))).toBeNull();
    expect(
      parseClientMessage(JSON.stringify({ type: 'updateTab', id: '4', name: 7, url: null })),
    ).toEqual({ type: 'updateTab', id: '4' });
  });

  it('returns null for invalid JSON', () => {
    expect(parseClientMessage('}{')).toBeNull();
  });

  it('returns null for resize with non-numeric dimensions', () => {
    expect(parseClientMessage(JSON.stringify({ type: 'resize', cols: 80 }))).toBeNull();
  });

  it('returns null for an unknown or server-only type', () => {
    expect(parseClientMessage(JSON.stringify({ type: 'ready', cols: 1, rows: 1 }))).toBeNull();
    expect(
      parseClientMessage(JSON.stringify({ type: 'scmComments', repo: '/work/palmux', rev: 1 })),
    ).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: 'bogus' }))).toBeNull();
  });

  it('returns null for a non-object frame', () => {
    expect(parseClientMessage('[]')).toBeNull();
    expect(parseClientMessage('true')).toBeNull();
  });
});

describe('parseClientMessage — reorderTabs', () => {
  it('round-trips a reorder', () => {
    const msg: ClientMessage = { type: 'reorderTabs', ids: ['2', '0', '1'] };
    expect(parseClientMessage(encodeClientMessage(msg))).toEqual(msg);
  });

  it('rejects non-arrays, invalid ids, and oversized lists', () => {
    expect(parseClientMessage(JSON.stringify({ type: 'reorderTabs' }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: 'reorderTabs', ids: 'x' }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: 'reorderTabs', ids: [1, 2] }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: 'reorderTabs', ids: ['01'] }))).toBeNull(); // non-canonical id shape
    expect(
      parseClientMessage(
        JSON.stringify({ type: 'reorderTabs', ids: Array.from({ length: 1001 }, () => '1') }),
      ),
    ).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: 'reorderTabs', ids: [] }))).toEqual({
      type: 'reorderTabs',
      ids: [],
    }); // empty = harmless no-op permutation
  });
});

describe('parseClientMessage — group ops', () => {
  it('round-trips groupCreate and groupUpdate', () => {
    const create: ClientMessage = {
      type: 'groupCreate',
      ids: ['0', '1'],
      name: 'proj',
      color: 'blue',
    };
    expect(parseClientMessage(encodeClientMessage(create))).toEqual(create);
    const update: ClientMessage = {
      type: 'groupUpdate',
      id: 'gabc123',
      addIds: ['2'],
      removeIds: ['3'],
      order: ['0', '2', '1'],
      name: 'x',
      color: 'green',
      dissolve: false,
    };
    expect(parseClientMessage(encodeClientMessage(update))).toEqual(update);
  });

  it('validates group vs tab ids distinctly', () => {
    // groupCreate ids are TAB ids
    expect(
      parseClientMessage(JSON.stringify({ type: 'groupCreate', ids: ['gabc123'] })),
    ).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: 'groupCreate' }))).toBeNull();
    // groupUpdate.id must be a GROUP id
    expect(parseClientMessage(JSON.stringify({ type: 'groupUpdate', id: '0' }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: 'groupUpdate', id: 'gbad' }))).toBeNull(); // too short
    // present-but-invalid member list rejects the whole op
    expect(
      parseClientMessage(JSON.stringify({ type: 'groupUpdate', id: 'gabc123', addIds: ['01'] })),
    ).toBeNull();
    // a bare valid groupUpdate (just the id) is accepted
    expect(parseClientMessage(JSON.stringify({ type: 'groupUpdate', id: 'gabc123' }))).toEqual({
      type: 'groupUpdate',
      id: 'gabc123',
    });
  });

  it('caps oversized id lists', () => {
    const ids = Array.from({ length: 1001 }, () => '1');
    expect(parseClientMessage(JSON.stringify({ type: 'groupCreate', ids }))).toBeNull();
  });
});

describe('isWindowId', () => {
  it('accepts w plus 6-16 lowercase base-36 characters', () => {
    expect(isWindowId('wq3k9x2m1a')).toBe(true);
    expect(isWindowId('w123456')).toBe(true); // 6 after the w
    expect(isWindowId(`w${'a'.repeat(16)}`)).toBe(true);
  });

  it('rejects everything else', () => {
    expect(isWindowId('w12345')).toBe(false); // 5 after the w
    expect(isWindowId(`w${'a'.repeat(17)}`)).toBe(false);
    expect(isWindowId('Wq3k9x2m1a')).toBe(false); // prefix is lowercase
    expect(isWindowId('q3k9x2m1ab')).toBe(false); // no w prefix
    expect(isWindowId('wQ3k9x2m1a')).toBe(false); // uppercase body
    expect(isWindowId('wq3k9-x2m1a')).toBe(false);
    expect(isWindowId('wq3k9x2m1a\n')).toBe(false); // $ must not allow a trailing newline
    expect(isWindowId('g3f9k2a1')).toBe(false); // a group id is not a window id
    expect(isWindowId('3')).toBe(false); // nor is a tab id
    expect(isWindowId('')).toBe(false);
    expect(isWindowId(null)).toBe(false);
    expect(isWindowId(undefined)).toBe(false);
    expect(isWindowId(7)).toBe(false);
  });
});

describe('detached windows — server messages', () => {
  it('keeps a valid window on a tab and drops an invalid one', () => {
    const parsed = parseServerMessage(
      JSON.stringify({
        type: 'sessions',
        ids: ['0', '1', '2'],
        titles: {},
        tabs: [
          { id: '0', kind: 'terminal', window: 'wq3k9x2m1a' },
          { id: '1', kind: 'terminal', window: 'main' },
          { id: '2', kind: 'terminal', window: 7 },
        ],
      }),
    );
    expect(parsed).toMatchObject({
      tabs: [{ id: '0', kind: 'terminal', window: 'wq3k9x2m1a' }, { id: '1' }, { id: '2' }],
    });
    if (!parsed || parsed.type !== 'sessions') throw new Error('not a sessions frame');
    expect(parsed.tabs[1]).not.toHaveProperty('window');
    expect(parsed.tabs[2]).not.toHaveProperty('window');
  });

  it('round-trips detached.moved and drops anything but true', () => {
    const moved: ServerMessage = { type: 'detached', moved: true };
    expect(parseServerMessage(encodeServerMessage(moved))).toEqual(moved);
    for (const bad of [false, 'true', 1, null]) {
      expect(parseServerMessage(JSON.stringify({ type: 'detached', moved: bad }))).toEqual({
        type: 'detached',
      });
    }
    expect(parseServerMessage(JSON.stringify({ type: 'detached' }))).toEqual({ type: 'detached' });
  });

  it('round-trips ready.detachedWindows and drops anything but true', () => {
    const msg: ServerMessage = {
      type: 'ready',
      cols: 80,
      rows: 24,
      maxUploadBytes: 52428800,
      webApps: [],
      version: '',
      detachedWindows: true,
    };
    expect(parseServerMessage(encodeServerMessage(msg))).toEqual(msg);
    for (const bad of [false, 'true', 1, null]) {
      const parsed = parseServerMessage(
        JSON.stringify({ type: 'ready', cols: 80, rows: 24, detachedWindows: bad }),
      );
      expect(parsed).not.toBeNull();
      expect(parsed).not.toHaveProperty('detachedWindows');
    }
    // An older server omits the flag entirely.
    expect(
      parseServerMessage(JSON.stringify({ type: 'ready', cols: 80, rows: 24 })),
    ).not.toHaveProperty('detachedWindows');
  });
});

describe('detached windows — client messages', () => {
  it('round-trips moveToWindow to a window and to the main window', () => {
    const toWindow: ClientMessage = { type: 'moveToWindow', ids: ['3', '5'], window: 'wq3k9x2m1a' };
    expect(parseClientMessage(encodeClientMessage(toWindow))).toEqual(toWindow);
    const toMain: ClientMessage = { type: 'moveToWindow', ids: ['3'], window: null };
    expect(parseClientMessage(encodeClientMessage(toMain))).toEqual(toMain);
    const none: ClientMessage = { type: 'moveToWindow', ids: [], window: null };
    expect(parseClientMessage(encodeClientMessage(none))).toEqual(none);
  });

  it('rejects a moveToWindow with a non-tab id, a bad window or an oversized list', () => {
    expect(send({ ids: ['01'], window: null })).toBeNull(); // not a canonical tab id
    expect(send({ ids: ['g3f9k2a1'], window: null })).toBeNull(); // a group id
    expect(send({ ids: [3], window: null })).toBeNull();
    expect(send({ ids: 'x', window: null })).toBeNull();
    expect(send({ window: null })).toBeNull(); // ids missing
    expect(send({ ids: ['1'], window: 'main' })).toBeNull(); // not a window id
    expect(send({ ids: ['1'], window: '' })).toBeNull();
    expect(send({ ids: ['1'] })).toBeNull(); // window must be present: null or an id
    expect(send({ ids: ['1'], window: 7 })).toBeNull();
    expect(send({ ids: Array.from({ length: 1001 }, () => '1'), window: null })).toBeNull();
    expect(send({ ids: Array.from({ length: 1000 }, () => '1'), window: null })).not.toBeNull();
  });

  it('round-trips windowClosing, which carries no fields', () => {
    const msg: ClientMessage = { type: 'windowClosing' };
    expect(parseClientMessage(encodeClientMessage(msg))).toEqual(msg);
  });

  it('keeps a valid window on createTab and drops a bad one', () => {
    const full: ClientMessage = { type: 'createTab', kind: 'editor', window: 'wq3k9x2m1a' };
    expect(parseClientMessage(encodeClientMessage(full))).toEqual(full);
    for (const bad of ['main', '', 7, null]) {
      const parsed = parseClientMessage(
        JSON.stringify({ type: 'createTab', kind: 'editor', window: bad }),
      );
      expect(parsed).toEqual({ type: 'createTab', kind: 'editor' });
    }
  });
});
