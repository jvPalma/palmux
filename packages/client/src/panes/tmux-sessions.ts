// ── tmux session listing (client side) ────────────────────────────────────────
//
// Fetched when the picker opens, never cached: the list belongs to a tmux server
// palmux does not manage, so a session can appear or be attached between two
// opens of the same popover.

export interface TmuxSession {
  name: string;
  /** A client is already on it. Picking it DETACHES that client (tmux -D). */
  attached: boolean;
}

export interface TmuxListing {
  /** False when tmux is not installed on the host — hide the whole option. */
  available: boolean;
  sessions: TmuxSession[];
}

const EMPTY: TmuxListing = { available: false, sessions: [] };

function parse(raw: unknown): TmuxListing {
  if (typeof raw !== 'object' || raw === null) return EMPTY;
  const rec = raw as { available?: unknown; sessions?: unknown };
  if (rec.available !== true || !Array.isArray(rec.sessions)) return EMPTY;
  const sessions: TmuxSession[] = [];
  for (const s of rec.sessions) {
    if (typeof s !== 'object' || s === null) continue;
    const { name, attached } = s as { name?: unknown; attached?: unknown };
    if (typeof name === 'string' && name) sessions.push({ name, attached: attached === true });
  }
  return { available: true, sessions };
}

/** The host's tmux sessions. Never rejects — a failure reads as "no tmux". */
export async function fetchTmuxSessions(): Promise<TmuxListing> {
  try {
    const res = await fetch('/tmux-sessions', { credentials: 'same-origin' });
    if (!res.ok) return EMPTY;
    return parse(await res.json());
  } catch {
    return EMPTY;
  }
}

/** Case-insensitive substring filter; empty query keeps everything. */
export function filterSessions(sessions: TmuxSession[], query: string): TmuxSession[] {
  const q = query.trim().toLowerCase();
  if (!q) return sessions;
  return sessions.filter((s) => s.name.toLowerCase().includes(q));
}
