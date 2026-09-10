import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  sessionIdFromPath,
  popoutIdFromPath,
  popoutPath,
  readBootIntent,
  nextFreeId,
  wsUrlFor,
  openPopout,
  postReturnToMain,
  POPOUT_RETURN,
} from './session-url';

describe('sessionIdFromPath', () => {
  // It answers NULL rather than '0' now. "This path names no tab" and "this path
  // names tab 0" are different facts, and only the caller knows what to do with
  // the first — at boot it means "ask the window what it remembered".
  it('extracts a legacy id', () => {
    expect(sessionIdFromPath('/0')).toBe('0');
    expect(sessionIdFromPath('/12')).toBe('12');
    expect(sessionIdFromPath('/0007')).toBe('0007'); // leading zeros as written
  });

  it('is null for anything that is not a bare numeric path', () => {
    for (const p of ['/', '/x', '/1/2', '/12345', '/popout/3', '']) {
      expect(sessionIdFromPath(p), p).toBeNull();
    }
  });
});

describe('popoutIdFromPath / popoutPath', () => {
  it('round-trips', () => {
    expect(popoutIdFromPath(popoutPath('3'))).toBe('3');
    expect(popoutPath('12')).toBe('/popout/12');
  });

  it('tolerates a trailing slash and refuses everything else', () => {
    expect(popoutIdFromPath('/popout/3/')).toBe('3');
    for (const p of ['/popout', '/popout/', '/popout/abc', '/3', '/popout/12345', '/x/popout/3']) {
      expect(popoutIdFromPath(p), p).toBeNull();
    }
  });
});

describe('readBootIntent', () => {
  const at = (pathname: string, search = '') => readBootIntent({ pathname, search });

  it('reads the app itself', () => {
    expect(at('/')).toEqual({ kind: 'app' });
  });

  it('reads a pop-out from its route', () => {
    expect(at('/popout/3')).toEqual({ kind: 'popout', id: '3' });
  });

  // A window opened before the route existed may still be sitting there when its
  // client reloads, so the retired form has to keep resolving.
  it('still reads the retired /<id>?popout=1 form', () => {
    expect(at('/3', '?popout=1')).toEqual({ kind: 'popout', id: '3' });
  });

  it('reads the new-terminal intent', () => {
    expect(at('/', '?new=1')).toEqual({ kind: 'new' });
  });

  // `GET /new` redirects to `/?new=1`; if a legacy path ever carried the query
  // too, the INTENT has to win or the redirect would read as an address.
  it('lets the intent beat a legacy path', () => {
    expect(at('/3', '?new=1')).toEqual({ kind: 'new' });
  });

  it('reads a legacy address', () => {
    expect(at('/3')).toEqual({ kind: 'legacy', id: '3' });
  });

  it('never throws on a malformed query', () => {
    expect(() => at('/', '?%')).not.toThrow();
  });
});

describe('nextFreeId', () => {
  it('returns 0 for an empty list', () => {
    expect(nextFreeId([])).toBe('0');
  });

  it('returns the lowest free integer among taken ids', () => {
    expect(nextFreeId(['0', '1', '3'])).toBe('2');
  });

  it('ignores non-numeric ids and still returns the lowest free integer', () => {
    expect(nextFreeId(['a', 'b'])).toBe('0');
    expect(nextFreeId(['0', 'foo', '1'])).toBe('2');
  });
});

describe('wsUrlFor tmux target', () => {
  // Present-or-absent, never empty-as-absent: an EMPTY value is meaningful
  // (create a new unnamed session), so `null` and `undefined` must not collapse.
  it('omits the parameter entirely for a plain shell', () => {
    expect(wsUrlFor('5', 'terminal', 'k')).not.toContain('tmux');
    expect(wsUrlFor('5', 'terminal', 'k', undefined)).not.toContain('tmux');
  });

  it('sends an EMPTY value for a new unnamed session', () => {
    expect(wsUrlFor('5', 'terminal', 'k', null)).toContain('&tmux=');
    expect(wsUrlFor('5', 'terminal', 'k', null).endsWith('&tmux=')).toBe(true);
  });

  it('encodes a session name, so a space cannot split the query', () => {
    expect(wsUrlFor('5', 'terminal', 'k', 'my notes')).toContain('&tmux=my%20notes');
    expect(wsUrlFor('5', 'terminal', 'k', 'a&b=c')).toContain('&tmux=a%26b%3Dc');
  });
});

describe('wsUrlFor', () => {
  it('builds a /ws URL scoped to the session id', () => {
    expect(wsUrlFor('5')).toContain('/ws?session=5');
    expect(wsUrlFor('5').endsWith('/ws?session=5')).toBe(true);
  });
});

describe('pop-out helpers', () => {
  afterEach(() => vi.unstubAllGlobals());

  // A real ROUTE, not a query flag on a tab path: a separate window needs an
  // address, and hanging it off `/<id>` would tie it to per-tab paths that no
  // longer exist.
  it('openPopout opens /popout/<id> with a per-id window name (dedupe)', () => {
    const open = vi.fn().mockReturnValue({});
    vi.stubGlobal('window', { open });
    openPopout('3');
    expect(open).toHaveBeenCalledWith('/popout/3', 'palmux-3', expect.stringContaining('popup'));
  });

  it('postReturnToMain posts an origin-locked message to a live opener', () => {
    const postMessage = vi.fn();
    vi.stubGlobal('window', { opener: { closed: false, postMessage } });
    vi.stubGlobal('location', { origin: 'http://main.test' });
    expect(postReturnToMain('4')).toBe(true);
    expect(postMessage).toHaveBeenCalledWith(
      { type: POPOUT_RETURN, tabId: '4' },
      'http://main.test', // never '*'
    );
  });

  it('postReturnToMain returns false when the opener is gone', () => {
    vi.stubGlobal('window', { opener: null });
    expect(postReturnToMain('4')).toBe(false);
    vi.stubGlobal('window', { opener: { closed: true, postMessage: vi.fn() } });
    expect(postReturnToMain('4')).toBe(false);
  });
});
