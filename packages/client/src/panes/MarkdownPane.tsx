// ── Markdown viewer pane ──────────────────────────────────────────────────────
//
// Read-only rendered markdown for a `markdown` tab. Two views over one tab:
//   • document — the file at tab.url rendered (lazy marked+dompurify chunk),
//     with relative .md links navigating IN PLACE (updateTab keeps the path
//     synced/persisted exactly like a web tab's url);
//   • browser — the configured markdownRoots as a click-through tree (server
//     /md-list, roots-confined), shown when the tab has no path or via 📂.
// Editing is the editor tab's job; this pane never writes.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import type { TabMeta } from '@palmux/shared';
import { renderMarkdown } from './markdown-render';
import { loadSettings, onSettingsChange } from '../settings/settings';

interface Listing {
  dir: string | null;
  /** The configured root containing `dir` — breadcrumbs never go above it. */
  root: string | null;
  dirs: string[];
  files: string[];
}

interface MarkdownPaneProps {
  tab: TabMeta;
  /** Persist a new file path for this tab (routes through updateTab{url}). */
  onChangePath: (path: string) => void;
  /** Mobile: opens the session drawer. */
  onMenu?: (() => void) | undefined;
}

const baseName = (p: string): string => p.split('/').pop() ?? p;

export const MarkdownPane = ({ tab, onChangePath, onMenu }: MarkdownPaneProps) => {
  const path = tab.url;
  const [browsing, setBrowsing] = useState(path === undefined);
  const [browseDir, setBrowseDir] = useState<string | null>(null);
  const [listing, setListing] = useState<Listing | null>(null);
  const [html, setHtml] = useState('');
  // Prose base size follows the terminal font size (matches the editor's +1),
  // so the markdown tab scales like every other tab. All prose uses em units,
  // so setting the base scales headings/code/etc. proportionally.
  const [mdFontSize, setMdFontSize] = useState(() => loadSettings().fontSize + 1);
  useEffect(() => onSettingsChange((s) => setMdFontSize(s.fontSize + 1)), []);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [nonce, setNonce] = useState(0); // refresh = re-fetch the same path

  // A path appearing (created-with-path, or navigation) shows the document; a
  // path-less tab only ever browses. Adjusting `browsing` on a path CHANGE during
  // render (not in an effect) avoids the extra render pass — `browsing` is also
  // toggled by the 📂 button, so it can't be pure-derived.
  const prevPath = useRef(path);
  if (prevPath.current !== path) {
    prevPath.current = path;
    setBrowsing(path === undefined);
  }

  // Document view: fetch + render, newest request wins.
  useEffect(() => {
    if (path === undefined || browsing) return;
    let stale = false;
    setStatus('loading');
    void (async () => {
      try {
        const res = await fetch(`/md-file?path=${encodeURIComponent(path)}`);
        if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
        const rendered = await renderMarkdown(await res.text(), path);
        if (stale) return;
        setHtml(rendered);
        setStatus('ready');
      } catch (err) {
        if (stale) return;
        setError(err instanceof Error ? err.message : String(err));
        setStatus('error');
      }
    })();
    return () => {
      stale = true;
    };
  }, [path, browsing, nonce]);

  // Browser view: list the roots (dir null) or a confined directory.
  useEffect(() => {
    if (!browsing) return;
    let stale = false;
    setStatus('loading');
    void (async () => {
      try {
        const q = browseDir === null ? '' : `?dir=${encodeURIComponent(browseDir)}`;
        const res = await fetch(`/md-list${q}`);
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `HTTP ${res.status}`);
        }
        const data = (await res.json()) as Listing;
        if (stale) return;
        setListing(data);
        setStatus('ready');
      } catch (err) {
        if (stale) return;
        setError(err instanceof Error ? err.message : String(err));
        setStatus('error');
      }
    })();
    return () => {
      stale = true;
    };
  }, [browsing, browseDir]);

  // Internal .md links (rewritten by the renderer) navigate this same tab —
  // EXCEPT a modified click (ctrl/cmd/shift/middle), which the browser should
  // handle via the link's real /md-file fallback href (open raw in a new tab).
  const onBodyClick = useCallback(
    (e: ReactMouseEvent) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
      const link = (e.target as HTMLElement).closest('a[data-md-path]');
      const target = link?.getAttribute('data-md-path');
      if (!target) return;
      e.preventDefault();
      onChangePath(target);
    },
    [onChangePath],
  );

  // Open a browsed file: just change the path — the [path] effect flips OUT of
  // the browser view once it lands, so there is no blank-document flash (and if
  // the round-trip never completes, the browser view stays put, not a blank).
  const openFile = useCallback((file: string) => onChangePath(file), [onChangePath]);

  // Breadcrumbs clamp to the containing root — never render ancestors ABOVE it
  // (those lie outside the confined roots and would only 403). The root itself
  // shows as one crumb; deeper segments follow.
  const crumbs = (() => {
    if (!browsing || !browseDir) return [];
    const root = listing?.root;
    const rootSegs = root ? root.split('/').filter(Boolean).length : 0;
    const all = browseDir.split('/').filter(Boolean);
    return all
      .map((seg, i) => ({ label: seg, path: `/${all.slice(0, i + 1).join('/')}`, depth: i + 1 }))
      .filter((c) => c.depth >= rootSegs); // root crumb + everything below it
  })();

  return (
    <div className="pane-frame" data-testid="markdown-pane">
      <div className="pane-header">
        {onMenu && (
          <button
            className="pane-btn"
            aria-label="Menu"
            onPointerDown={(e) => (e.preventDefault(), onMenu())}
          >
            ☰
          </button>
        )}
        <span className="pane-title">📖 {path ? baseName(path) : 'markdown'}</span>
        <span className="md-path" title={path ?? ''}>
          {browsing ? (browseDir ?? 'roots') : (path ?? '')}
        </span>
        <span className="spacer" />
        <button
          className="pane-btn"
          title="Browse configured folders"
          data-testid="md-browse"
          onClick={() => {
            setBrowseDir(null);
            setBrowsing(true);
          }}
        >
          📂
        </button>
        {path !== undefined && !browsing && (
          <button
            className="pane-btn"
            title="Re-read the file"
            data-testid="md-refresh"
            onClick={() => setNonce((n) => n + 1)}
          >
            ⟳
          </button>
        )}
        {path !== undefined && browsing && (
          <button
            className="pane-btn"
            title="Back to the document"
            data-testid="md-back"
            onClick={() => setBrowsing(false)}
          >
            ↩
          </button>
        )}
      </div>

      {browsing ? (
        <div className="md-browser" data-testid="md-browser">
          <div className="md-crumbs">
            <button
              className="md-crumb"
              data-testid="md-crumb-roots"
              onClick={() => setBrowseDir(null)}
            >
              roots
            </button>
            {crumbs.map((c) => (
              <span key={c.path}>
                {' / '}
                <button className="md-crumb" onClick={() => setBrowseDir(c.path)}>
                  {c.label}
                </button>
              </span>
            ))}
          </div>
          {status === 'error' ? (
            <p className="pane-loading" data-testid="md-error">
              {error}
            </p>
          ) : status === 'loading' ? (
            <p className="pane-loading">Loading…</p>
          ) : (
            <ul className="md-entries" data-testid="md-entries">
              {listing?.dirs.map((d) => (
                <li key={d}>
                  <button className="md-entry dir" onClick={() => setBrowseDir(d)}>
                    📁 {listing.dir === null ? d : baseName(d)}
                  </button>
                </li>
              ))}
              {listing?.files.map((f) => (
                <li key={f}>
                  <button className="md-entry file" onClick={() => openFile(f)}>
                    📄 {baseName(f)}
                  </button>
                </li>
              ))}
              {listing && listing.dirs.length === 0 && listing.files.length === 0 && (
                <li className="pane-loading">nothing here</li>
              )}
            </ul>
          )}
        </div>
      ) : status === 'error' ? (
        <p className="pane-loading" data-testid="md-error">
          {error}
        </p>
      ) : status === 'loading' ? (
        <p className="pane-loading">Loading…</p>
      ) : (
        <div
          className="md-body"
          data-testid="md-body"
          style={{ fontSize: mdFontSize }}
          onClick={onBodyClick}
          // Rendered through marked → DOMPurify → link rewriting (markdown-render.ts).
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
    </div>
  );
};
