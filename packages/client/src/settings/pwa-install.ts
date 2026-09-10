// ── PWA install prompt ────────────────────────────────────────────────────────
//
// A page cannot install itself. The ONLY lever a site has is Chromium's
// `beforeinstallprompt`: the browser hands over an event whose `prompt()` opens
// the native install dialog, and that call is only honoured inside a user
// gesture. So "Install app" is a button that replays a prompt the browser
// already offered — nothing more is possible, and no polyfill exists.
//
// The capture has to happen at STARTUP, not in the settings component: the event
// fires as soon as the page is judged installable, which is long before anyone
// opens Settings. A listener registered on mount would find the event already
// gone and the row permanently dead. Hence a module-level store + `capture()`
// from main.tsx, and a subscription for whoever renders it later.
//
// Where the row is unavailable it must SAY so instead of showing a dead button:
//   • iOS/iPadOS Safari never fires the event at all — install is Share → Add to
//     Home Screen, a manual gesture we cannot trigger.
//   • Chromium withholds it when the app is already installed, when the context
//     is not secure (plain HTTP off localhost), or while the manifest/worker
//     criteria are unmet.
// Those cases are indistinguishable from each other from in here, so the hint
// names the likely ones rather than guessing one.

/** The Chromium-only event; not in our TS lib.dom. */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export type PwaInstallState =
  /** A prompt is in hand — the button works. */
  | 'available'
  /** Running as an installed app, or the browser reported an install. */
  | 'installed'
  /** No prompt: iOS, an insecure context, or criteria unmet. */
  | 'unavailable';

let deferred: BeforeInstallPromptEvent | null = null;
let installed = false;
const listeners = new Set<(state: PwaInstallState) => void>();

/** True when this document is running as an installed app rather than a tab. */
function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  // `navigator.standalone` is the iOS-only signal; the media query covers the rest.
  if ((navigator as Navigator & { standalone?: boolean }).standalone === true) return true;
  try {
    return !!window.matchMedia?.('(display-mode: standalone)').matches;
  } catch {
    return false;
  }
}

export function pwaInstallState(): PwaInstallState {
  if (installed || isStandalone()) return 'installed';
  return deferred ? 'available' : 'unavailable';
}

function emit(): void {
  const state = pwaInstallState();
  for (const fn of listeners) fn(state);
}

/**
 * Start listening for the browser's install offer. Call once, at startup —
 * see the note above on why this cannot live in the component.
 */
export function capturePwaInstall(): void {
  if (typeof window === 'undefined') return;
  window.addEventListener('beforeinstallprompt', (e) => {
    // Suppressing the browser's own mini-infobar is the point of preventDefault:
    // the offer moves into our Settings row, where it survives being dismissed.
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    emit();
  });
  window.addEventListener('appinstalled', () => {
    installed = true;
    deferred = null;
    emit();
  });
}

/** Subscribe to state changes; returns the unsubscribe. */
export function onPwaInstallChange(fn: (state: PwaInstallState) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Show the native install dialog. Must be called from a user gesture or the
 * browser ignores it. The event is SINGLE-USE — a dismissed prompt cannot be
 * replayed, which is why it is dropped either way and the row goes quiet until
 * the browser offers another one.
 */
export async function promptPwaInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  const event = deferred;
  if (!event) return 'unavailable';
  deferred = null;
  try {
    await event.prompt();
    const { outcome } = await event.userChoice;
    if (outcome === 'accepted') installed = true;
    emit();
    return outcome;
  } catch {
    emit();
    return 'unavailable';
  }
}
