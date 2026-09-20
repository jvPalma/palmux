// ── Turning the server's JSON into lines a human reads ────────────────────────
//
// Pure string functions, no console: `index.ts` owns printing, so every rule here
// is a plain unit test rather than a captured stdout.

import { isTabId, isGroupId, type TabGroup, type TabMeta } from '@palmux/shared';

export interface TabsPayload {
  tabs: TabMeta[];
  groups: TabGroup[];
}

/**
 * Read the registry's own shape, without trusting it.
 *
 * The CLI and the server ship from the same repo, so this is not a hostile input
 * — it is a NEWER SERVER than the CLI. An `npm`-style mismatch is the realistic
 * case, and failing with "unknown response" beats `undefined.map` at a prompt.
 */
function asTabsPayload(body: unknown): TabsPayload | null {
  if (typeof body !== 'object' || body === null) return null;
  const { tabs, groups } = body as Record<string, unknown>;
  if (!Array.isArray(tabs) || !Array.isArray(groups)) return null;
  return { tabs: tabs as TabMeta[], groups: groups as TabGroup[] };
}

/**
 * What to call a tab in a listing: its own name, else its title, else NOTHING.
 *
 * Falling back to the kind made the common case print it twice — a fresh
 * terminal has neither a name nor an OSC title yet, so `palmux tabs` on a new
 * instance read `0  terminal  terminal` on every line. The kind has its own
 * column; a label that only repeats it is noise.
 */
function labelOf(t: TabMeta): string {
  return t.name ?? t.title ?? '';
}

/**
 * The tab list, in STRIP ORDER — which is the order the registry returns, and
 * NOT sorted by id: display order is decoupled from id (tab-reorder), so sorting
 * here would show an order no window has ever had.
 *
 * A group is rendered as an indented header followed by its members, because a
 * flat list with a group column cannot show that a group's members are
 * contiguous — which is the one thing the group model guarantees.
 */
export function renderTabs(body: unknown): string {
  const payload = asTabsPayload(body);
  if (!payload) return 'unexpected response from the server';
  if (payload.tabs.length === 0) return 'no tabs';

  const ordered = payload.tabs;
  const byId = new Map(payload.groups.map((g) => [g.id, g]));
  const lines: string[] = [];
  // A group whose chip has no name still needs something to print.
  const seen = new Set<string>();

  for (const t of ordered) {
    const gid = t.groupId;
    const group = gid !== undefined && isGroupId(gid) ? byId.get(gid) : undefined;
    if (group && !seen.has(group.id)) {
      seen.add(group.id);
      const name = group.name ?? '(unnamed group)';
      const n = ordered.filter((x) => x.groupId === group.id).length;
      lines.push(`${group.id}  ${name} — ${n} tab${n === 1 ? '' : 's'}`);
    }
    const indent = group ? '  ' : '';
    const label = labelOf(t);
    lines.push(`${indent}${t.id}  ${t.kind}${label ? `  ${label}` : ''}${urlSuffix(t)}`);
  }
  return lines.join('\n');
}

/** A tab that names a path is unreadable without it; a terminal's is noise. */
function urlSuffix(t: TabMeta): string {
  if (t.kind === 'terminal' || !t.url) return '';
  return `  ${t.url}`;
}

export function renderGroups(body: unknown): string {
  const payload = asTabsPayload(body);
  if (!payload) return 'unexpected response from the server';
  if (payload.groups.length === 0) return 'no groups';
  return payload.groups
    .map((g) => {
      const members = payload.tabs.filter((t) => t.groupId === g.id).map((t) => t.id);
      const name = g.name ?? '(unnamed)';
      const list = members.length > 0 ? members.join(', ') : 'no members';
      return `${g.id}  ${name}  ${g.color}  [${list}]`;
    })
    .join('\n');
}

/**
 * Settings are an opaque blob the SERVER merely persists (the client owns the
 * schema), so there is nothing here to lay out field by field — printing the JSON
 * is the honest rendering, and it stays correct as the client adds keys.
 */
export function renderSettings(body: unknown): string {
  return JSON.stringify(body, null, 2);
}

export interface StatusPayload {
  version: string;
  port: number;
  tabs: number;
  windows: number;
}

function asStatus(body: unknown): StatusPayload | null {
  if (typeof body !== 'object' || body === null) return null;
  const o = body as Record<string, unknown>;
  const { version, port, tabs, windows } = o;
  if (
    typeof version !== 'string' ||
    typeof port !== 'number' ||
    typeof tabs !== 'number' ||
    typeof windows !== 'number'
  ) {
    return null;
  }
  return { version, port, tabs, windows };
}

export function renderStatus(body: unknown): string {
  const s = asStatus(body);
  if (!s) return 'unexpected response from the server';
  return [
    `version  ${s.version}`,
    `port     ${s.port}`,
    `tabs     ${s.tabs}`,
    `windows  ${s.windows}`,
  ].join('\n');
}

/**
 * The `open` reply. `created: false` means an editor tab was already showing this
 * path and the command moved to it instead of opening a second buffer on the
 * same file — worth saying, because the alternative reads as a failed open.
 */
export function renderOpen(body: unknown, path: string): string {
  if (typeof body !== 'object' || body === null) return `opened ${path}`;
  const o = body as Record<string, unknown>;
  const id = o['id'];
  if (typeof id !== 'string' || !isTabId(id)) return `opened ${path}`;
  return o['created'] === false
    ? `showing tab ${id}: ${path}`
    : `opened tab ${id}: ${path}`;
}

export const HELP = `palmux — drive a running palmux from a shell

  palmux <path>          open a file in an editor tab
  palmux open <path>     the same, for a file whose name is a subcommand
  palmux tabs            list tabs, in strip order, grouped
  palmux groups          list tab groups
  palmux settings        print the server's settings
  palmux status          version, port, tab and window counts

  palmux serve [flags]   run the palmux server (--print-config, --new-token, …)

The file opens in the browser window the command ran from, or in the most
recently focused window when run from outside palmux (SSH, a desktop terminal).`;
