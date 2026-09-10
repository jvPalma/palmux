import { beforeEach, describe, expect, it, vi } from 'vitest';

/** The event carries methods the DOM Event constructor knows nothing about. */
function installEvent(outcome: 'accepted' | 'dismissed' = 'accepted') {
  const event = new Event('beforeinstallprompt', { cancelable: true }) as Event & {
    prompt: () => Promise<void>;
    userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
  };
  event.prompt = vi.fn(async () => {});
  event.userChoice = Promise.resolve({ outcome });
  return event;
}

/** A fresh module registry per test — the store is module-level on purpose. */
async function load() {
  vi.resetModules();
  const mod = await import('./pwa-install');
  mod.capturePwaInstall();
  return mod;
}

beforeEach(() => {
  // happy-dom reports no display-mode by default; be explicit so a change in its
  // defaults can't quietly turn every case into 'installed'.
  window.matchMedia = vi.fn(() => ({ matches: false }) as unknown as MediaQueryList);
});

describe('pwa install', () => {
  it('is unavailable until the browser offers a prompt', async () => {
    const { pwaInstallState } = await load();
    expect(pwaInstallState()).toBe('unavailable');
  });

  it('becomes available on beforeinstallprompt, and suppresses the browser bar', async () => {
    const { pwaInstallState } = await load();
    const event = installEvent();
    window.dispatchEvent(event);
    expect(pwaInstallState()).toBe('available');
    expect(event.defaultPrevented).toBe(true);
  });

  it('notifies subscribers that registered before the event fired', async () => {
    const { onPwaInstallChange } = await load();
    const seen: string[] = [];
    onPwaInstallChange((s) => seen.push(s));
    window.dispatchEvent(installEvent());
    expect(seen).toEqual(['available']);
  });

  it('unsubscribes', async () => {
    const { onPwaInstallChange } = await load();
    const fn = vi.fn();
    onPwaInstallChange(fn)();
    window.dispatchEvent(installEvent());
    expect(fn).not.toHaveBeenCalled();
  });

  it('prompts once and reports the outcome', async () => {
    const { promptPwaInstall, pwaInstallState } = await load();
    const event = installEvent('accepted');
    window.dispatchEvent(event);
    await expect(promptPwaInstall()).resolves.toBe('accepted');
    expect(event.prompt).toHaveBeenCalledTimes(1);
    expect(pwaInstallState()).toBe('installed');
  });

  it('cannot replay a spent prompt', async () => {
    const { promptPwaInstall, pwaInstallState } = await load();
    window.dispatchEvent(installEvent('dismissed'));
    await expect(promptPwaInstall()).resolves.toBe('dismissed');
    // Dismissed is not installed — but the event is gone, so the row goes quiet.
    expect(pwaInstallState()).toBe('unavailable');
    await expect(promptPwaInstall()).resolves.toBe('unavailable');
  });

  it('prompting without an offer is a no-op, not a throw', async () => {
    const { promptPwaInstall } = await load();
    await expect(promptPwaInstall()).resolves.toBe('unavailable');
  });

  it('survives a prompt() that rejects', async () => {
    const { promptPwaInstall } = await load();
    const event = installEvent();
    event.prompt = vi.fn(async () => {
      throw new Error('not allowed outside a gesture');
    });
    window.dispatchEvent(event);
    await expect(promptPwaInstall()).resolves.toBe('unavailable');
  });

  it('appinstalled flips the state and drops the prompt', async () => {
    const { pwaInstallState, onPwaInstallChange } = await load();
    const seen: string[] = [];
    onPwaInstallChange((s) => seen.push(s));
    window.dispatchEvent(installEvent());
    window.dispatchEvent(new Event('appinstalled'));
    expect(pwaInstallState()).toBe('installed');
    expect(seen).toEqual(['available', 'installed']);
  });

  it('reports installed when already running standalone', async () => {
    window.matchMedia = vi.fn(
      (q: string) => ({ matches: q.includes('standalone') }) as unknown as MediaQueryList,
    );
    const { pwaInstallState } = await load();
    expect(pwaInstallState()).toBe('installed');
  });

  it('reports installed on iOS navigator.standalone', async () => {
    Object.defineProperty(navigator, 'standalone', { value: true, configurable: true });
    try {
      const { pwaInstallState } = await load();
      expect(pwaInstallState()).toBe('installed');
    } finally {
      Object.defineProperty(navigator, 'standalone', { value: undefined, configurable: true });
    }
  });
});
