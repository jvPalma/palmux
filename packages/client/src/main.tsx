import { createRoot } from 'react-dom/client';
import '@xterm/xterm/css/xterm.css';
import './index.css';
import './ui/ui.css';
import { App } from './App';
import { loadSettings } from './settings/settings';
import { applyThemeTokens, getProfile } from './settings/themes';
import { installConsoleCapture } from './diagnostics/console-capture';
import { capturePwaInstall } from './settings/pwa-install';

// Capture warn/error into a ring from the very start, for the diagnostics report.
installConsoleCapture();

// The browser offers `beforeinstallprompt` once, early — well before anyone opens
// Settings. Catch it here or the Install row has nothing to replay.
capturePwaInstall();

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');

// Skin the app to the persisted theme BEFORE the first paint — no flash of the
// default palette when a non-default theme is saved.
applyThemeTokens(getProfile(loadSettings().themeId));

// No StrictMode: the imperative xterm + WebSocket + native-listener wiring must
// not be double-mounted.
createRoot(root).render(<App />);

// Belt-and-braces portrait lock. The manifest's `orientation` is what actually
// pins an INSTALLED app; this call covers engines that honour the Screen
// Orientation API but not the manifest field. It legitimately rejects in a plain
// browser tab (the API requires an installed/fullscreen context) and is absent on
// iOS Safari entirely — both are no-ops, never fatal.
// (cast: our TS lib.dom predates ScreenOrientation.lock, which Chrome ships.)
const orientation = screen.orientation as
  | (ScreenOrientation & { lock?: (o: 'portrait-primary') => Promise<void> })
  | undefined;
void orientation?.lock?.('portrait-primary')?.catch(() => {});

// Register the (cache-less) service worker so the browser offers PWA install on
// mobile — Android Chrome requires a controlled SW with a fetch handler. Only
// works in a secure context (HTTPS/localhost); failures are non-fatal.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
