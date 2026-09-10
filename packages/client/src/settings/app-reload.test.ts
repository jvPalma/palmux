// A reload that skips the HTTP cache is the whole point: a cached index.html
// names the OLD hashed bundle, so `location.reload()` alone can keep a device
// on a build that was replaced days ago.

import { describe, expect, it, vi } from 'vitest';
import { reloadApp, type ReloadEnv } from './app-reload';

const env = (over: Partial<ReloadEnv> = {}) => {
  const deleted: string[] = [];
  const update = vi.fn(async () => {});
  const reload = vi.fn();
  const doFetch = vi.fn(async () => new Response(''));
  const base: ReloadEnv = {
    caches: {
      keys: async () => ['palmux-v1', 'palmux-v2'],
      delete: async (k: string) => {
        deleted.push(k);
        return true;
      },
    } as unknown as CacheStorage,
    serviceWorker: {
      getRegistration: async () => ({ update }) as unknown as ServiceWorkerRegistration,
    } as unknown as ServiceWorkerContainer,
    fetch: doFetch as unknown as typeof fetch,
    href: 'https://palmux.example/3',
    reload,
    ...over,
  };
  return { base, deleted, update, reload, doFetch };
};

describe('reloadApp', () => {
  it('clears caches, updates the worker, revalidates the document, then reloads', async () => {
    const { base, deleted, update, reload, doFetch } = env();

    await reloadApp(base);

    expect(deleted).toEqual(['palmux-v1', 'palmux-v2']);
    expect(update).toHaveBeenCalled();
    // `cache: 'reload'` is what forces a revalidation instead of replaying the
    // cached document; credentials because the app is cookie-gated and an
    // anonymous revalidation would cache a 401 in place of the page.
    expect(doFetch).toHaveBeenCalledWith('https://palmux.example/3', {
      cache: 'reload',
      credentials: 'include',
    });
    expect(reload).toHaveBeenCalled();
  });

  it('still reloads when every cache-busting step fails', async () => {
    const reload = vi.fn();
    const { base } = env({
      caches: {
        keys: async () => {
          throw new Error('no cache storage');
        },
      } as unknown as CacheStorage,
      serviceWorker: {
        getRegistration: async () => {
          throw new Error('blocked');
        },
      } as unknown as ServiceWorkerContainer,
      fetch: (async () => {
        throw new Error('offline');
      }) as unknown as typeof fetch,
      reload,
    });

    await reloadApp(base);

    expect(reload).toHaveBeenCalled();
  });

  it('works in a browser with no caches API and no service worker', async () => {
    const reload = vi.fn();
    const { base } = env({ caches: undefined, serviceWorker: undefined, reload });

    await reloadApp(base);

    expect(reload).toHaveBeenCalled();
  });
});
