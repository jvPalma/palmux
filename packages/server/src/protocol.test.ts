import { describe, expect, it } from 'vitest';
import {
  encodeClientMessage,
  encodeServerMessage,
  parseClientMessage,
  parseServerMessage,
} from '@palmux/shared';
import type { ClientMessage, ServerMessage } from '@palmux/shared';

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
