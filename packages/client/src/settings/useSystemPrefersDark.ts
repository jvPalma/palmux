// ── The client's own colour scheme, live ──────────────────────────────────────
//
// A store over `matchMedia('(prefers-color-scheme: dark)')`, so a component
// re-renders when THIS device flips between light and dark — the OS schedule at
// sunset, a manual switch, devtools emulation. The scheme is the client's, never
// a synced setting: two devices in different schemes each resolve their own theme.
//
// Read through `useSyncExternalStore` because the answer lives outside React and
// must be right on the first render (the theme is painted before anything else),
// not after an effect has run.

import { useSyncExternalStore } from 'react';
import { SYSTEM_DARK_QUERY, systemPrefersDark } from './settings';

const subscribe = (notify: () => void): (() => void) => {
  if (typeof window.matchMedia !== 'function') return () => {};
  const query = window.matchMedia(SYSTEM_DARK_QUERY);
  query.addEventListener('change', notify);
  return () => query.removeEventListener('change', notify);
};

// No server render exists, so the server snapshot is only a required argument.
const serverSnapshot = (): boolean => false;

export function useSystemPrefersDark(): boolean {
  return useSyncExternalStore(subscribe, systemPrefersDark, serverSnapshot);
}
