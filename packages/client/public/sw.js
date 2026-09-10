// Minimal service worker — exists ONLY to satisfy the browser's PWA-install
// requirement (Android Chrome offers "Install app" only for a page controlled
// by a service worker with a fetch handler; desktop Chrome doesn't, which is why
// install showed on desktop but not mobile).
//
// It caches NOTHING: every request goes straight to the network. That keeps the
// deliberate no-offline / no-cache-staleness posture (a stale terminal shell is
// useless and cached auth pages fight the cookie gate) while still making palmux
// installable as a standalone app. Requires a secure context (HTTPS/localhost).

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
// A fetch handler must exist for installability; passthrough = no caching.
self.addEventListener('fetch', () => {
  /* network passthrough — do not call respondWith, let the browser fetch */
});
