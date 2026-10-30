import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  sessionIdFromPath,
  popoutIdFromPath,
  readBootIntent,
  nextFreeId,
  wsUrlFor,
  newWindowId,
  windowPath,
  windowIdFromPath,
  openDetached,
  wsControlUrl,
} from './session-url';
import { isWindowId } from '@palmux/shared';

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

// The retired pop-out address: a window opened at it before this change may still be sitting there
// when its client reloads, so it has to keep resolving (as a detached window, see `readBootIntent`).
describe('popoutIdFromPath', () => {
  it('reads the id of a retired /popout/<id> path', () => {
    expect(popoutIdFromPath('/popout/3')).toBe('3');
    expect(popoutIdFromPath('/popout/12')).toBe('12');
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

  // The retired pop-out addresses open a DETACHED window now: the window mints its own id (nobody
  // else knows it) and `legacy` tells App to claim `tab` itself, through the reclaim.
  describe('a retired pop-out address', () => {
    it('reads /popout/<id> as a detached window holding that tab', () => {
      const intent = at('/popout/3');
      expect(intent).toEqual({
        kind: 'detached',
        wid: expect.stringMatching(/^w[0-9a-z]{10}$/),
        tab: '3',
        legacy: true,
      });
      expect(isWindowId((intent as { wid: string }).wid)).toBe(true);
    });

    it('reads the retired /<id>?popout=1 form the same way', () => {
      expect(at('/3', '?popout=1')).toEqual({
        kind: 'detached',
        wid: expect.stringMatching(/^w[0-9a-z]{10}$/),
        tab: '3',
        legacy: true,
      });
    });

    // `/0007` is a legacy path as written, but it is no tab id: nothing could claim it.
    it('drops an id that is not a tab id, and keeps the window', () => {
      expect(at('/popout/0007')).toMatchObject({ kind: 'detached', tab: null, legacy: true });
    });

    it('mints a new window id for every read', () => {
      const first = at('/popout/3') as { wid: string };
      const second = at('/popout/3') as { wid: string };
      expect(first.wid).not.toBe(second.wid);
    });

    // An address that merely mentions `popout` is still the app: only the two real forms count.
    it('does not read a bare ?popout=1, or a non-numeric route, as one', () => {
      expect(at('/', '?popout=1')).toEqual({ kind: 'app' });
      expect(at('/popout/abc')).toEqual({ kind: 'app' });
    });

    // The window's own address wins when both are present, so a reloaded window keeps its id.
    it('lets a real /window/<wid> address beat the retired forms', () => {
      expect(at('/window/wq3k9x2m1a', '?popout=1&tab=2')).toEqual({
        kind: 'detached',
        wid: 'wq3k9x2m1a',
        tab: '2',
        legacy: false,
      });
    });

    it('beats the new-terminal intent, as a window address does', () => {
      expect(at('/popout/3', '?new=1')).toMatchObject({ kind: 'detached', tab: '3', legacy: true });
    });
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

  describe('a detached window', () => {
    it('reads its id from the route, with no tab', () => {
      expect(at('/window/wq3k9x2m1a')).toEqual({
        kind: 'detached',
        wid: 'wq3k9x2m1a',
        tab: null,
        legacy: false,
      });
    });

    it('reads the tab it was opened for from ?tab=', () => {
      expect(at('/window/wq3k9x2m1a', '?tab=3')).toEqual({
        kind: 'detached',
        wid: 'wq3k9x2m1a',
        tab: '3',
        legacy: false,
      });
    });

    it('drops a ?tab= that is not a tab id, and keeps the window', () => {
      for (const bad of ['?tab=', '?tab=abc', '?tab=01', '?tab=12345', '?tab=-1', '?other=3']) {
        expect(at('/window/wq3k9x2m1a', bad), bad).toEqual({
          kind: 'detached',
          wid: 'wq3k9x2m1a',
          tab: null,
          legacy: false,
        });
      }
    });

    it('tolerates a trailing slash', () => {
      expect(at('/window/wq3k9x2m1a/')).toMatchObject({ kind: 'detached', wid: 'wq3k9x2m1a' });
    });

    // A malformed address is the main window, never a detached one with a made-up id.
    it('falls through to the app for an id that fails isWindowId', () => {
      for (const p of [
        '/window/',
        '/window',
        '/window/abc',
        '/window/W3k9x2m1ab',
        '/window/wq3k9x2m1a/extra',
      ]) {
        expect(at(p, '?tab=3'), p).toEqual({ kind: 'app' });
      }
    });

    it('beats the new-terminal intent and a legacy path is not confused with it', () => {
      expect(at('/window/wq3k9x2m1a', '?new=1')).toMatchObject({ kind: 'detached' });
      expect(at('/3')).toEqual({ kind: 'legacy', id: '3' });
    });
  });
});

describe('newWindowId', () => {
  it("is 'w' plus 10 base-36 characters, and passes isWindowId", () => {
    for (let i = 0; i < 50; i++) {
      const id = newWindowId();
      expect(id).toMatch(/^w[0-9a-z]{10}$/);
      expect(isWindowId(id)).toBe(true);
    }
  });

  it('draws from crypto.getRandomValues, so two ids differ', () => {
    const spy = vi.spyOn(crypto, 'getRandomValues');
    const a = newWindowId();
    expect(spy).toHaveBeenCalled();
    expect(newWindowId()).not.toBe(a);
    spy.mockRestore();
  });

  it('maps every byte value to a base-36 character', () => {
    const spy = vi.spyOn(crypto, 'getRandomValues').mockImplementation((arr) => {
      (arr as Uint8Array).set([0, 1, 9, 10, 35, 36, 71, 72, 200, 255]);
      return arr;
    });
    expect(newWindowId()).toMatch(/^w[0-9a-z]{10}$/);
    spy.mockRestore();
  });
});

describe('windowPath / windowIdFromPath', () => {
  it('round-trips', () => {
    expect(windowPath('wq3k9x2m1a')).toBe('/window/wq3k9x2m1a');
    expect(windowIdFromPath(windowPath('wq3k9x2m1a'))).toBe('wq3k9x2m1a');
  });

  it('tolerates a trailing slash and refuses everything else', () => {
    expect(windowIdFromPath('/window/wq3k9x2m1a/')).toBe('wq3k9x2m1a');
    for (const p of [
      '',
      '/',
      '/window',
      '/window/',
      '/window/abc', // too short for isWindowId
      '/window/Wq3k9x2m1a', // uppercase
      '/window/q3k9x2m1ab', // no leading w
      '/window/wq3k9x2m1a/x',
      '/x/window/wq3k9x2m1a',
      '/popout/3',
    ]) {
      expect(windowIdFromPath(p), p).toBeNull();
    }
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

  // The window claim rides the attach URL, like the tmux target: a terminal exists only once a
  // data socket attaches, so a separate message could lose the race.
  it('carries the window id of a detached window, and nothing for the main window', () => {
    expect(wsUrlFor('5', 'terminal', 'k', undefined, 'wq3k9x2m1a')).toContain('&window=wq3k9x2m1a');
    expect(wsUrlFor('5', 'terminal', 'k')).not.toContain('window');
    expect(wsUrlFor('5', 'terminal', 'k', undefined, undefined)).not.toContain('window');
  });

  it('keeps the tmux target and the window together', () => {
    const url = wsUrlFor('5', 'terminal', 'k', 'dev', 'wq3k9x2m1a');
    expect(url).toContain('&tmux=dev');
    expect(url).toContain('&window=wq3k9x2m1a');
  });
});

describe('wsControlUrl', () => {
  it('is the bare control attach for the main window', () => {
    expect(wsControlUrl().endsWith('/ws?control=1')).toBe(true);
    expect(wsControlUrl(undefined).endsWith('/ws?control=1')).toBe(true);
  });

  it("names the window for a detached window's lease", () => {
    expect(wsControlUrl('wq3k9x2m1a').endsWith('/ws?control=1&window=wq3k9x2m1a')).toBe(true);
  });
});

describe('openDetached', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('opens /window/<wid>?tab=<id> under a per-window name, with the pop-out features', () => {
    const win = {};
    const open = vi.fn().mockReturnValue(win);
    vi.stubGlobal('window', { open });
    const out = openDetached('3');
    expect(isWindowId(out.wid)).toBe(true);
    expect(out.win).toBe(win);
    expect(open).toHaveBeenCalledWith(
      `/window/${out.wid}?tab=3`,
      `palmux-${out.wid}`,
      expect.stringContaining('popup'),
    );
  });

  it('mints a new window id every call', () => {
    vi.stubGlobal('window', { open: vi.fn().mockReturnValue({}) });
    expect(openDetached('3').wid).not.toBe(openDetached('3').wid);
  });

  // The caller needs the id even when the browser blocks the window: a null `win` is "show the
  // toast and move nothing", and it must not have to guess what was minted.
  it('answers a null window when the popup is blocked, still with the id', () => {
    vi.stubGlobal('window', { open: vi.fn().mockReturnValue(null) });
    const out = openDetached('3');
    expect(out.win).toBeNull();
    expect(isWindowId(out.wid)).toBe(true);
  });
});
