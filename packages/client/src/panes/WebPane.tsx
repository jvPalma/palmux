// ── Web pane ──────────────────────────────────────────────────────────────────
//
// An embedded page in a tab. The iframe stays mounted while the tab exists
// (background tabs keep navigation/scroll state — that's the point of tabs).
// Sites that refuse framing (X-Frame-Options / frame-ancestors) show a blank
// frame; that is a hard browser limit and NOT detectable cross-origin, so the
// header's ⧉ open-externally button is the permanent, honest fallback.
//
// Back/forward: the framed page's own `history` is cross-origin-unreachable, so
// the only lever is the TOP-LEVEL joint session history — a navigation inside a
// nested browsing context pushes an entry there, and that is precisely what the
// browser's own back button walks. Two consequences, stated plainly: palmux's
// tab switches push entries too (App's switchSession), so ← can pop a tab
// switch rather than a page — the same entanglement a real browser has — and an
// installed PWA has no browser chrome at all, which is why these buttons must
// exist here.

import { useRef, useState } from 'react';
import type { TabMeta } from '@palmux/shared';
import { isEmbeddableUrl, isSameOriginUrl, normalizeUrl } from './normalize-url';
import { isProxiedUrl, proxiedFrameUrl } from './webproxy-url';

interface WebPaneProps {
  tab: TabMeta;
  onChangeUrl: (url: string) => void;
  /** Mobile: opens the session drawer (iframes swallow edge swipes). */
  onMenu?: (() => void) | undefined;
}

export const WebPane = ({ tab, onChangeUrl, onMenu }: WebPaneProps) => {
  const [reloadNonce, setReloadNonce] = useState(0);
  const [draft, setDraft] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const url = tab.url ?? '';
  // Defense in depth: the server already rejects non-embeddable urls, but never
  // hand a `javascript:`/`data:` url to an iframe src (it would run in our
  // authenticated origin). A bad value renders a blank frame instead.
  // A loopback url means a port on the PALMUX HOST, which the browser cannot
  // reach — it goes through the same-origin proxy instead (webproxy-url.ts).
  const frameUrl = isEmbeddableUrl(url) ? proxiedFrameUrl(url) : 'about:blank';
  // `allow-scripts` + `allow-same-origin` together is a sandbox escape for
  // SAME-ORIGIN framed pages (our /artifacts/*): they'd inherit our origin and
  // could script the app / make credentialed requests. Cross-origin sites keep
  // their own origin, so allow-same-origin is safe (and often required) there.
  //
  // A PROXIED page is same-origin by construction and still needs it — not as a
  // nicety, but because without it the feature cannot work at all. An opaque
  // origin makes every sub-resource request cross-origin, and an ESM module
  // fetch is CORS-mode with `same-origin` credentials, so the cookie is
  // omitted. Measured: a Vite build's `<script type="module" crossorigin>`
  // assets then reach palmux's origin uncredentialed and are bounced — by the
  // Cloud Workstations ingress with a 302 to `_workstation/forwardAuthCookie`,
  // or by palmux's own cookie gate with a 401. Stripping the `crossorigin`
  // attribute does not help: module fetches are CORS-mode regardless of it.
  //
  // The price is real and worth stating: a proxied app runs IN palmux's origin
  // and can therefore script the app and open /ws — i.e. reach the shell. The
  // proxy only reaches loopback ports on the palmux host, so this trusts what
  // you already chose to run there. /artifacts/* keeps the opaque origin.
  const proxied = isProxiedUrl(url);
  const sandbox =
    isSameOriginUrl(frameUrl) && !proxied
      ? 'allow-scripts allow-forms allow-popups allow-downloads'
      : 'allow-scripts allow-same-origin allow-forms allow-popups allow-downloads';

  const commitUrl = () => {
    if (draft === null) return;
    const normalized = normalizeUrl(draft);
    if (normalized && normalized !== url) onChangeUrl(normalized);
    setDraft(null);
    inputRef.current?.blur();
  };

  return (
    <div className="pane-frame" data-testid={`web-pane-${tab.id}`}>
      <div className="pane-header">
        {onMenu && (
          <button
            className="pane-btn"
            aria-label="Open drawer"
            data-testid="pane-menu"
            onPointerDown={(e) => {
              e.preventDefault();
              onMenu();
            }}
          >
            ☰
          </button>
        )}
        {/* Availability is unknowable cross-origin (no `history.length` for a
            foreign context), so both stay enabled and a dead press is a no-op. */}
        <button
          className="pane-btn"
          title="Back"
          aria-label="Back"
          data-testid="pane-back"
          onClick={() => history.back()}
        >
          ←
        </button>
        <button
          className="pane-btn"
          title="Forward"
          aria-label="Forward"
          data-testid="pane-forward"
          onClick={() => history.forward()}
        >
          →
        </button>
        <input
          ref={inputRef}
          className="pane-url"
          data-testid="pane-url"
          value={draft ?? url}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitUrl();
            else if (e.key === 'Escape') {
              setDraft(null);
              inputRef.current?.blur();
            }
          }}
          onBlur={() => setDraft(null)}
        />
        <button
          className="pane-btn"
          title="Reload"
          aria-label="Reload"
          data-testid="pane-reload"
          onClick={() => setReloadNonce((n) => n + 1)}
        >
          ⟳
        </button>
        <button
          className="pane-btn"
          title="Open in browser tab (for sites that refuse embedding)"
          aria-label="Open externally"
          data-testid="pane-external"
          onClick={() => window.open(url, '_blank', 'noopener')}
        >
          ⧉
        </button>
      </div>
      {/* Remount ONLY when the sandbox class flips or on an explicit reload.
          The attribute is read at NAVIGATION time, so a same-origin url must
          never be loaded into a frame still carrying a cross-origin frame's
          allow-same-origin — a remount is the only way to re-apply it. Keying
          on the url instead (as this did) destroyed the browsing context on
          every url-bar commit, pruning the pane's session-history entries and
          leaving ← nothing to walk back to. A plain `src` change navigates the
          surviving context, which is what pushes the history entry. */}
      <iframe
        key={`${sandbox}#${reloadNonce}`}
        className="pane-iframe"
        src={frameUrl}
        title={tab.name ?? url}
        sandbox={sandbox}
        data-testid={`pane-iframe-${tab.id}`}
      />
    </div>
  );
};
