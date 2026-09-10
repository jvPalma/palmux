// ── Force the app to reload on the CURRENT build ──────────────────────────────
//
// `location.reload()` is not enough, and the difference costs real debugging
// time: it re-runs the page against whatever the HTTP cache already holds. A
// cached index.html still names the OLD hashed asset bundle, so a phone can sit
// on a build that was replaced days ago while the server has served the new one
// all along — indistinguishable, from the user's side, from "the fix didn't
// work". There is no reload button in an installed PWA either, so this is the
// only way out of that state on a phone.
//
// Three layers have to be cleared, cheapest first, and each is best-effort: a
// browser missing any of these APIs must still end up reloading.
//
//   1. Cache Storage — anything a past service-worker version stored. The
//      shipped worker caches nothing, but a previously-installed one might.
//   2. The service worker itself — `update()` pulls a fresh script.
//   3. The HTTP cache — re-fetching the document with `cache: 'reload'` forces
//      a revalidation and writes the fresh response into the cache, so the
//      reload that follows can't replay the stale one. New asset hashes then
//      miss the cache on their own.

export interface ReloadEnv {
  caches?: CacheStorage | undefined;
  serviceWorker?: ServiceWorkerContainer | undefined;
  fetch?: typeof fetch | undefined;
  href: string;
  reload: () => void;
}

function browserEnv(): ReloadEnv {
  return {
    caches: typeof caches === 'undefined' ? undefined : caches,
    serviceWorker: navigator.serviceWorker,
    fetch: typeof fetch === 'undefined' ? undefined : fetch,
    href: location.href,
    reload: () => location.reload(),
  };
}

/** True when a service worker controls this page (i.e. the PWA half applies). */
export function hasServiceWorker(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.serviceWorker?.controller;
}

/**
 * Drop every cached copy of the app and reload onto the current build. Always
 * reloads, even if each step before it failed — a reload that skipped a cache
 * is still better than staying put.
 */
export async function reloadApp(env: ReloadEnv = browserEnv()): Promise<void> {
  try {
    const keys = (await env.caches?.keys()) ?? [];
    await Promise.all(keys.map((k) => env.caches?.delete(k)));
  } catch {
    /* no Cache Storage, or it refused — fall through */
  }
  try {
    const reg = await env.serviceWorker?.getRegistration();
    await reg?.update();
  } catch {
    /* no worker registered, or the update failed — fall through */
  }
  try {
    // credentials: the app is cookie-gated, and an unauthenticated revalidation
    // would cache a 401 in place of the page.
    await env.fetch?.(env.href, { cache: 'reload', credentials: 'include' });
  } catch {
    /* offline, or the fetch was blocked — reload anyway */
  }
  env.reload();
}
