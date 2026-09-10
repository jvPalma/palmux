import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchTmuxSessions, filterSessions } from './tmux-sessions';

const mockFetch = (impl: () => Promise<unknown> | never) => {
  vi.stubGlobal('fetch', vi.fn(impl));
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchTmuxSessions', () => {
  it('parses a well-formed listing', async () => {
    mockFetch(async () => ({
      ok: true,
      json: async () => ({
        available: true,
        sessions: [
          { name: 'work', attached: true },
          { name: 'DB_BACKFILL-0', attached: false },
        ],
      }),
    }));
    expect(await fetchTmuxSessions()).toEqual({
      available: true,
      sessions: [
        { name: 'work', attached: true },
        { name: 'DB_BACKFILL-0', attached: false },
      ],
    });
  });

  // A picker that throws takes the whole new-tab chooser down with it, and the
  // chooser is how you open a plain terminal. Every failure degrades to "no tmux".
  it('reads a rejected fetch as "no tmux", not an error', async () => {
    mockFetch(async () => {
      throw new Error('offline');
    });
    expect(await fetchTmuxSessions()).toEqual({ available: false, sessions: [] });
  });

  it('reads a non-OK response as "no tmux"', async () => {
    mockFetch(async () => ({ ok: false, json: async () => ({}) }));
    expect(await fetchTmuxSessions()).toEqual({ available: false, sessions: [] });
  });

  it('drops malformed rows rather than rendering undefined', async () => {
    mockFetch(async () => ({
      ok: true,
      json: async () => ({
        available: true,
        sessions: [{ name: 'ok' }, { name: '' }, { attached: true }, null, 'nope'],
      }),
    }));
    expect(await fetchTmuxSessions()).toEqual({
      available: true,
      sessions: [{ name: 'ok', attached: false }],
    });
  });
});

describe('filterSessions', () => {
  const list = [
    { name: 'DB_BACKFILL-0', attached: false },
    { name: 'L0_PALMA-0', attached: true },
    { name: 'palmux', attached: false },
  ];

  it('keeps everything for an empty query', () => {
    expect(filterSessions(list, '   ')).toHaveLength(3);
  });

  it('matches case-insensitively anywhere in the name', () => {
    expect(filterSessions(list, 'palm').map((s) => s.name)).toEqual(['L0_PALMA-0', 'palmux']);
  });
});
