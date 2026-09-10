// ── Dashboard body ────────────────────────────────────────────────────────────
//
// The shared body of the new-tab page, rendered inside both the transient chooser
// (`NewTabChooser`) and the pinned `dashboard` tab (`DashboardTab`); those own the
// surrounding frame + header, this owns the sections and their local input state.
//
// A dense list with collapsible sections: a 2×2 grid of create
// tiles (primary filled, the rest recessed), then one collapsible card per
// section with a count badge in its header. Styling lives in dashboard.css;
// controls come from the `../ui` kit so a theme switch repaints them.
//
// tmux is INLINE and always present — not a disclosure under a tile. The cost of
// a standing section is a listing of the host's sessions, so it is fetched once,
// when the section is first actually VISIBLE (it defaults open, so usually at
// mount; a user who collapsed it pays nothing until they open it), and cached for
// the life of the component. Nothing refetches per render.
//
// Listening ports come from `GET /ports`. That route may not exist on the server
// this client is talking to: a 404 (or any failure) renders NO section at all,
// which is both the honest thing to show and the correct behaviour until the
// route lands.

import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { TabKind, WebAppLink } from '@palmux/shared';
import { normalizeUrl } from './normalize-url';
import { pressKbdMove, pressMove } from './press';
import { fetchTmuxSessions, filterSessions, type TmuxListing } from './tmux-sessions';
import { Button, Collapsible, IconButton, Input } from '../ui';
import './dashboard.css';

export interface QuickLink {
  name: string;
  url: string;
}

export interface CreateSpec {
  kind: TabKind;
  url?: string;
  name?: string;
  /** Terminal only: attach to this tmux session on spawn. `null` = create a new
   *  unnamed one. Absent = a plain shell. */
  tmux?: string | null;
}

export interface DashboardBodyProps {
  webApps: WebAppLink[];
  quickLinks: QuickLink[];
  onCreate: (spec: CreateSpec) => void;
  onUpdateQuickLinks: (links: QuickLink[]) => void;
  /** Focus the primary "Terminal" tile on mount (chooser only). */
  autoFocusPrimary?: boolean | undefined;
}

/** One row of `GET /ports`. */
interface ListeningPort {
  port: number;
  pid: number;
  process: string;
}

interface PortListing {
  /** False when the route is absent or the host cannot enumerate — show nothing. */
  available: boolean;
  ports: ListeningPort[];
}

const NO_PORTS: PortListing = { available: false, ports: [] };

/** The host's listening ports. Never rejects — a failure reads as "no route". */
async function fetchPorts(): Promise<PortListing> {
  try {
    const res = await fetch('/ports', { credentials: 'same-origin' });
    if (!res.ok) return NO_PORTS;
    const raw: unknown = await res.json();
    if (typeof raw !== 'object' || raw === null) return NO_PORTS;
    const rec = raw as { available?: unknown; ports?: unknown };
    if (rec.available !== true || !Array.isArray(rec.ports)) return NO_PORTS;
    const ports: ListeningPort[] = [];
    for (const p of rec.ports) {
      if (typeof p !== 'object' || p === null) continue;
      const { port, pid, process: proc } = p as Record<string, unknown>;
      if (typeof port !== 'number') continue;
      ports.push({
        port,
        pid: typeof pid === 'number' ? pid : 0,
        process: typeof proc === 'string' ? proc : '',
      });
    }
    return { available: true, ports };
  } catch {
    return NO_PORTS;
  }
}

/** True once the collapsible section around `ref` has been open at least once.
 *
 *  The kit Collapsible force-mounts its content — that is what it animates — so
 *  mounting is not being seen, and it exposes no open callback. Radix's
 *  `data-state` on the content element is the one honest signal, and it is on an
 *  ancestor we can reach without owning the component. Outside a collapsible
 *  (no `[data-state]` ancestor) the content is visible by definition. */
function useSeenOpen(ref: RefObject<HTMLElement | null>): boolean {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (seen) return;
    const host = ref.current?.closest('[data-state]');
    if (!host) {
      setSeen(true);
      return;
    }
    if (host.getAttribute('data-state') === 'open') {
      setSeen(true);
      return;
    }
    const obs = new MutationObserver(() => {
      if (host.getAttribute('data-state') === 'open') setSeen(true);
    });
    obs.observe(host, { attributes: true, attributeFilter: ['data-state'] });
    return () => obs.disconnect();
  }, [ref, seen]);
  return seen;
}

const SectionTitle = ({ label, count }: { label: string; count?: number | undefined }) => (
  <span className="dash-sec-title">
    <span className="dash-sec-label">{label}</span>
    {count !== undefined && <span className="dash-sec-count">{count}</span>}
  </span>
);

export const DashboardBody = ({
  webApps,
  quickLinks,
  onCreate,
  onUpdateQuickLinks,
  autoFocusPrimary = false,
}: DashboardBodyProps) => {
  const [urlOpen, setUrlOpen] = useState(false);
  const [urlDraft, setUrlDraft] = useState('');
  const [mdOpen, setMdOpen] = useState(false);
  const [mdDraft, setMdDraft] = useState('');
  const [tmuxList, setTmuxList] = useState<TmuxListing | null>(null);
  const [tmuxFilter, setTmuxFilter] = useState('');
  const [ports, setPorts] = useState<PortListing>(NO_PORTS);
  const [adding, setAdding] = useState(false);
  const [linkName, setLinkName] = useState('');
  const [linkUrl, setLinkUrl] = useState('');

  const tmuxRef = useRef<HTMLDivElement>(null);
  const tmuxSeen = useSeenOpen(tmuxRef);

  // `tmuxSeen` only ever goes false → true, so this runs at most once per mount.
  useEffect(() => {
    if (!tmuxSeen) return;
    let live = true;
    void fetchTmuxSessions().then((l) => {
      if (live) setTmuxList(l);
    });
    return () => {
      live = false;
    };
  }, [tmuxSeen]);

  // Ports are fetched even while the section is collapsed: whether the section
  // exists at all is the answer to this request.
  useEffect(() => {
    let live = true;
    void fetchPorts().then((p) => {
      if (live) setPorts(p);
    });
    return () => {
      live = false;
    };
  }, []);

  const openTmux = (target: string | null) => {
    setTmuxFilter('');
    onCreate({ kind: 'terminal', tmux: target });
  };

  const openMarkdown = () => {
    const path = mdDraft.trim();
    // A non-empty path MUST be absolute (the server rejects the rest, matching
    // the shell-trust model) — keep the row open on a bad path instead of
    // silently dropping it. Empty = a path-less tab that opens the browser view.
    if (path && !path.startsWith('/')) return;
    onCreate({ kind: 'markdown', ...(path ? { url: path } : {}) });
    setMdDraft('');
    setMdOpen(false);
  };

  const openUrl = () => {
    const url = normalizeUrl(urlDraft);
    if (!url) return;
    setUrlDraft('');
    setUrlOpen(false);
    onCreate({ kind: 'web', url });
  };

  const addLink = () => {
    const url = normalizeUrl(linkUrl);
    const name = linkName.trim();
    if (!url || !name) return;
    onUpdateQuickLinks([...quickLinks, { name, url }]);
    setLinkName('');
    setLinkUrl('');
    setAdding(false);
  };

  const removeLink = (i: number) => {
    onUpdateQuickLinks(quickLinks.filter((_, idx) => idx !== i));
  };

  return (
    <div className="dash-body dash-dock">
      <Collapsible
        title={<SectionTitle label="Create" />}
        storageKey="palmux-dash-create"
        defaultOpen
        className="dash-section"
        data-testid="dash-primary"
      >
        <div className="dash-grid">
          <Button
            variant="primary"
            data-testid="dash-new-terminal"
            autoFocus={autoFocusPrimary}
            {...pressKbdMove(() => onCreate({ kind: 'terminal' }))}
          >
            ❯ Terminal
          </Button>
          <Button
            className="dash-tile-recessed"
            data-testid="dash-new-editor"
            {...pressKbdMove(() => onCreate({ kind: 'editor' }))}
          >
            ✎ Editor
          </Button>
          <Button
            className="dash-tile-recessed"
            data-testid="dash-open-url"
            {...pressKbdMove(() => setUrlOpen((v) => !v))}
          >
            🌐 URL…
          </Button>
          <Button
            className="dash-tile-recessed"
            data-testid="dash-open-markdown"
            {...pressKbdMove(() => setMdOpen((v) => !v))}
          >
            📖 Markdown…
          </Button>
        </div>

        {urlOpen && (
          <div className="dash-row">
            <Input
              data-testid="dash-url-input"
              placeholder="example.com or /artifacts/page.html"
              value={urlDraft}
              autoFocus
              spellCheck={false}
              autoCapitalize="off"
              onChange={(e) => setUrlDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') openUrl();
              }}
            />
            <Button data-testid="dash-url-go" {...pressMove(openUrl)}>
              Open
            </Button>
          </div>
        )}

        {mdOpen && (
          <div className="dash-row">
            <Input
              data-testid="dash-md-input"
              placeholder="/absolute/path/to/file.md — empty = browse folders"
              value={mdDraft}
              autoFocus
              spellCheck={false}
              autoCapitalize="off"
              onChange={(e) => setMdDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') openMarkdown();
              }}
            />
            <Button data-testid="dash-md-go" {...pressMove(openMarkdown)}>
              Open
            </Button>
          </div>
        )}
      </Collapsible>

      <Collapsible
        title={
          <SectionTitle
            label="tmux"
            {...(tmuxList?.available ? { count: tmuxList.sessions.length } : {})}
          />
        }
        storageKey="palmux-dash-tmux"
        defaultOpen
        className="dash-section"
        data-testid="dash-tmux"
      >
        <div className="dash-list dash-list-scroll" ref={tmuxRef} data-testid="dash-tmux-list">
          {tmuxSeen && tmuxList === null && (
            <div className="dash-note">Looking for tmux sessions…</div>
          )}
          {tmuxList?.available === false && (
            <div className="dash-note" data-testid="dash-tmux-missing">
              tmux is not installed on this host.
            </div>
          )}
          {tmuxList?.available && (
            <>
              <Input
                data-testid="dash-tmux-filter"
                placeholder="filter…"
                value={tmuxFilter}
                spellCheck={false}
                autoCapitalize="off"
                onChange={(e) => setTmuxFilter(e.target.value)}
              />
              {/* Always first, always available: with no tmux server running at
                  all this row is the only thing here, and it starts one. */}
              <Button
                className="dash-srow dash-srow-new"
                data-testid="dash-tmux-new"
                {...pressKbdMove(() => openTmux(null))}
              >
                <span className="dash-srow-icon" aria-hidden="true">
                  ＋
                </span>
                <span className="dash-srow-label">New tmux session</span>
              </Button>
              {filterSessions(tmuxList.sessions, tmuxFilter).map((s) => (
                <Button
                  key={s.name}
                  className="dash-srow"
                  data-testid={`dash-tmux-${s.name}`}
                  // Say what the click COSTS. Picking an attached session detaches
                  // whoever is on it — tmux sizes a window to its smallest client,
                  // so mirroring a desktop session onto a phone would shrink it.
                  {...(s.attached
                    ? { title: 'Attached elsewhere — opening here detaches it' }
                    : {})}
                  {...pressKbdMove(() => openTmux(s.name))}
                >
                  <span
                    className={s.attached ? 'dash-srow-dot on' : 'dash-srow-dot'}
                    aria-hidden="true"
                  />
                  <span className="dash-srow-label">{s.name}</span>
                  {s.attached && <span className="dash-srow-state">attached</span>}
                </Button>
              ))}
              {tmuxList.sessions.length === 0 && (
                <div className="dash-note">No tmux sessions running.</div>
              )}
            </>
          )}
        </div>
      </Collapsible>

      {ports.available && (
        <Collapsible
          title={<SectionTitle label="Listening ports" count={ports.ports.length} />}
          storageKey="palmux-dash-ports"
          defaultOpen={false}
          className="dash-section"
          data-testid="dash-ports"
        >
          <div className="dash-list">
            {ports.ports.map((p) => (
              <Button
                key={`${p.port}-${p.pid}`}
                className="dash-srow"
                data-testid={`dash-port-${p.port}`}
                title={`pid ${p.pid}`}
                // A loopback URL is exactly what the /webproxy route re-serves
                // same-origin, so the port a dev server is on is one press away.
                {...pressKbdMove(() =>
                  onCreate({ kind: 'web', url: `http://localhost:${p.port}` }),
                )}
              >
                <span className="dash-srow-icon dash-srow-icon-live" aria-hidden="true">
                  ◉
                </span>
                <span className="dash-srow-label">
                  {p.port}
                  {p.process && <span className="dash-srow-sub">{p.process}</span>}
                </span>
              </Button>
            ))}
            {ports.ports.length === 0 && <div className="dash-note">Nothing is listening.</div>}
          </div>
        </Collapsible>
      )}

      {webApps.length > 0 && (
        <Collapsible
          title={<SectionTitle label="Apps" count={webApps.length} />}
          storageKey="palmux-dash-apps"
          defaultOpen
          className="dash-section"
          data-testid="dash-webapps"
        >
          <div className="dash-list">
            {webApps.map((app) => (
              <Button
                key={app.url}
                className="dash-srow"
                data-testid={`dash-webapp-${app.name}`}
                {...pressKbdMove(() => onCreate({ kind: 'web', url: app.url, name: app.name }))}
              >
                <span className="dash-srow-icon" aria-hidden="true">
                  {app.icon ?? '🔗'}
                </span>
                <span className="dash-srow-label">{app.name}</span>
              </Button>
            ))}
          </div>
        </Collapsible>
      )}

      <Collapsible
        title={<SectionTitle label="Quick links" count={quickLinks.length} />}
        storageKey="palmux-dash-links"
        defaultOpen
        className="dash-section"
        data-testid="dash-links"
      >
        <div className="dash-list">
          {quickLinks.map((link, i) => (
            <div key={`${link.url}-${i}`} className="dash-row">
              <Button
                className="dash-srow"
                data-testid={`dash-link-${link.name}`}
                {...pressKbdMove(() => onCreate({ kind: 'web', url: link.url, name: link.name }))}
              >
                <span className="dash-srow-icon" aria-hidden="true">
                  🔗
                </span>
                <span className="dash-srow-label">{link.name}</span>
              </Button>
              <IconButton
                label={`Remove ${link.name}`}
                size="sm"
                data-testid={`dash-link-remove-${link.name}`}
                {...pressMove(() => removeLink(i))}
              >
                ✕
              </IconButton>
            </div>
          ))}
        </div>

        {adding ? (
          <div className="dash-row">
            <Input
              data-testid="dash-add-name"
              placeholder="Name"
              value={linkName}
              autoFocus
              onChange={(e) => setLinkName(e.target.value)}
            />
            <Input
              data-testid="dash-add-url"
              placeholder="URL"
              value={linkUrl}
              spellCheck={false}
              autoCapitalize="off"
              onChange={(e) => setLinkUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addLink();
              }}
            />
            <Button data-testid="dash-add-save" {...pressMove(addLink)}>
              Add
            </Button>
          </div>
        ) : (
          <Button
            className="dash-dashed"
            data-testid="dash-add-link"
            {...pressKbdMove(() => setAdding(true))}
          >
            + Add link
          </Button>
        )}
      </Collapsible>
    </div>
  );
};
