// ── Tab metadata persistence ──────────────────────────────────────────────────
//
// <configDir>/tabs.json holds every tab's metadata so non-terminal tabs (and
// terminal names/colors) survive server restarts. PTY *processes* are never
// resurrected — a terminal entry only re-labels the slot when it respawns.
// The registry saves on every mutation (debounced); a corrupt or missing file
// restores nothing, matching the forgiving posture of extra-keys.json.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isGroupId, isTabId, isTabKind, type TabKind } from '@palmux/shared';
import { configDir } from './config';

export interface PersistedTab {
  id: string;
  kind: TabKind;
  name?: string;
  color?: string;
  url?: string;
  /** Tab-group membership (additive — an old server ignores it). */
  groupId?: string;
}

/** Group metadata, persisted in a SIDECAR (groups.json) so tabs.json keeps its
 *  bare-array shape and an old server loads it unchanged. */
export interface PersistedGroup {
  id: string;
  name?: string;
  color: string;
}

export interface TabsStore {
  load(): PersistedTab[];
  /** Debounced persist; the latest snapshot wins. */
  save(tabs: PersistedTab[]): void;
}

export interface GroupsStore {
  load(): PersistedGroup[];
  save(groups: PersistedGroup[]): void;
}

const SAVE_DEBOUNCE_MS = 150;

function parsePersistedTabs(raw: unknown): PersistedTab[] {
  if (!Array.isArray(raw)) return [];
  const out: PersistedTab[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const id = rec['id'];
    if (!isTabId(id) || seen.has(id)) continue;
    if (!isTabKind(rec['kind'])) continue;
    seen.add(id);
    out.push({
      id,
      kind: rec['kind'],
      ...(typeof rec['name'] === 'string' && rec['name'] ? { name: rec['name'] } : {}),
      ...(typeof rec['color'] === 'string' && rec['color'] ? { color: rec['color'] } : {}),
      ...(typeof rec['url'] === 'string' && rec['url'] ? { url: rec['url'] } : {}),
      ...(isGroupId(rec['groupId']) ? { groupId: rec['groupId'] } : {}),
    });
  }
  return out;
}

function parsePersistedGroups(raw: unknown): PersistedGroup[] {
  if (!Array.isArray(raw)) return [];
  const out: PersistedGroup[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    if (!isGroupId(rec['id']) || seen.has(rec['id'])) continue;
    if (typeof rec['color'] !== 'string' || !rec['color']) continue;
    seen.add(rec['id']);
    out.push({
      id: rec['id'],
      color: rec['color'],
      ...(typeof rec['name'] === 'string' && rec['name'] ? { name: rec['name'] } : {}),
    });
  }
  return out;
}

/** A debounced, atomically-written JSON array file (temp + rename). */
function fileStore<T>(
  path: string,
  parse: (raw: unknown) => T[],
): { load(): T[]; save(v: T[]): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: T[] | null = null;

  const flush = () => {
    if (pending === null) return;
    const data = pending;
    pending = null;
    try {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, path);
    } catch {
      /* unwritable dir — state simply won't survive a restart */
    }
  };

  // Best-effort flush on clean shutdown so a mutation right before exit lands.
  process.on('exit', flush);

  return {
    load(): T[] {
      try {
        if (!existsSync(path)) return [];
        return parse(JSON.parse(readFileSync(path, 'utf8')));
      } catch {
        return [];
      }
    },
    save(v: T[]): void {
      pending = v;
      clearTimeout(timer);
      timer = setTimeout(flush, SAVE_DEBOUNCE_MS);
      timer.unref?.();
    },
  };
}

/** File-backed store at <dir>/tabs.json (default: the palmux config dir). */
export function createTabsStore(dir?: string): TabsStore {
  return fileStore(join(dir ?? configDir(), 'tabs.json'), parsePersistedTabs);
}

/** Sidecar store at <dir>/groups.json — tab-group metadata. */
export function createGroupsStore(dir?: string): GroupsStore {
  return fileStore(join(dir ?? configDir(), 'groups.json'), parsePersistedGroups);
}

/** In-memory store for tests. */
export function memoryTabsStore(initial: PersistedTab[] = []): TabsStore & {
  snapshot(): PersistedTab[];
} {
  let data = initial;
  return {
    load: () => data,
    save: (tabs) => {
      data = tabs;
    },
    snapshot: () => data,
  };
}

/** In-memory groups store for tests. */
export function memoryGroupsStore(initial: PersistedGroup[] = []): GroupsStore & {
  snapshot(): PersistedGroup[];
} {
  let data = initial;
  return {
    load: () => data,
    save: (groups) => {
      data = groups;
    },
    snapshot: () => data,
  };
}
