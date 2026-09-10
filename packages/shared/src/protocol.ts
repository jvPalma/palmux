// ── palmux wire protocol ──────────────────────────────────────────────────
//
// The WebSocket carries two kinds of frames:
//   • Binary frames — raw PTY bytes, both directions, outside any envelope.
//   • Text frames   — a single JSON object, one of the discriminated unions below.
//
// `settings` and `extraKeys` payloads are intentionally opaque (`JsonObject`):
// the server persists and rebroadcasts them without understanding their shape,
// and the client owns the schema. Nothing is locked into a generated type.

import { isGroupId, isTabId } from './session-ids';
import type { ColorProfile } from './theme-colors';

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

/**
 * Default upload cap (50 MB) — used when config/ready omit an explicit value.
 *
 * Deliberately NOT raised alongside the download cap. The upload body is
 * accumulated in memory before it reaches the temp file, so this number is also
 * a per-request RSS budget; the operator raises it knowingly via
 * `maxUploadBytes: "1GB"` in config.json.
 */
export const DEFAULT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/**
 * One path's outcome from `POST /files/delete`. Per-path rather than a single
 * status because a bulk delete partially failing is normal, and the caller has
 * to be able to say which ones survived.
 */
export type DeleteResult =
  | { path: string; ok: true; kind: 'file' | 'directory'; entries?: number }
  | { path: string; ok: false; message: string };

/** Default cap on one /download response (1 GB). The zip is streamed. */
export const DEFAULT_MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024;

// ── Workspace tabs ────────────────────────────────────────────────────────────
//
// Every workspace slot (/0, /1, …) is a tab. Only `terminal` tabs own a PTY;
// the other kinds are metadata the server persists and rebroadcasts.

export type TabKind = 'terminal' | 'web' | 'dashboard' | 'editor' | 'markdown';

export const TAB_KINDS: readonly TabKind[] = ['terminal', 'web', 'dashboard', 'editor', 'markdown'];

export function isTabKind(v: unknown): v is TabKind {
  return typeof v === 'string' && (TAB_KINDS as readonly string[]).includes(v);
}

export interface TabMeta {
  /** Numeric-string workspace id — same id space as the URL path. */
  id: string;
  kind: TabKind;
  /** Custom user-given name; display precedence: name > title > kind default. */
  name?: string;
  /** Palette color name (client-defined palette); absent = no accent. */
  color?: string;
  /** Embedded page URL (web tabs only). */
  url?: string;
  /** Live OSC 0/2 window title (terminal tabs only). */
  title?: string;
  /** Tab-group membership (isGroupId); absent = ungrouped. Independent of the
   *  tab's own name/color — the group has its own (see TabGroup). */
  groupId?: string;
}

/**
 * A named, colored cluster of contiguous tabs. Server-authoritative; carried in
 * `sessions.groups`, strip-ordered (a group's position = its first member's).
 * `color`/`name` are independent of any member tab's own color/name.
 */
export interface TabGroup {
  /** isGroupId — server-minted, e.g. 'g3f9k2a1'. */
  id: string;
  /** Optional label; the chip shows a colored dot when absent. */
  name?: string;
  /** Palette color NAME (a TAB_COLORS name); always present after create. */
  color: string;
}

/** A deployment-configured web app (config.json `webApps`), e.g. SilverBullet. */
export interface WebAppLink {
  name: string;
  url: string;
  icon?: string;
}

// ── Server → client ───────────────────────────────────────────────────────────

/** Sent once after the PTY is attached and ready. */
export interface ReadyMessage {
  type: 'ready';
  cols: number;
  rows: number;
  /** Server-enforced upload cap (bytes) so the client can reject early. */
  maxUploadBytes: number;
  /** Deployment-configured web apps offered on the new-tab page. */
  webApps: WebAppLink[];
  /** Server build version (package version + optional short git sha); '' if unknown. */
  version: string;
}

/** Current server-persisted settings. Sent on connect and after any change. */
export interface SettingsMessage {
  type: 'settings';
  settings: JsonObject;
}

/** Current extra-keys (Termux-style mobile toolbar) config. */
export interface ExtraKeysMessage {
  type: 'extraKeys';
  extraKeys: JsonObject;
}

/** The PTY process exited; the client shows a "session ended" state. */
export interface ExitMessage {
  type: 'exit';
  code: number | null;
  signal: number | null;
}

/**
 * Another client attached to this session and took it over. A terminal session
 * has exactly ONE active client: the newest attach wins and every earlier one
 * gets this, then a close. Distinct from `exit` — the shell is alive and well,
 * this client just no longer owns it, so the UI offers to take it back rather
 * than reporting a dead session.
 */
export interface DetachedMessage {
  type: 'detached';
}

/** Outcome of an `importTheme`, reported back to the client that asked. */
export interface ThemeImportedMessage {
  type: 'themeImported';
  ok: boolean;
  /** Theme id to select on success (matches the discovered profile). */
  id?: string;
  /** Display name on success, human-readable reason on failure. */
  detail?: string;
}

/** One concrete font face discovered under the server's font directories. */
export interface FontInfo {
  /** CSS family name (faces of the same family share it). */
  family: string;
  /** OS/2 weight class (100–900). */
  weight: number;
  style: 'normal' | 'italic';
  /** Server URL that streams the font file. */
  url: string;
}

/** Fonts the client may register (@font-face) and offer in the picker. */
export interface FontsMessage {
  type: 'fonts';
  fonts: FontInfo[];
}

/** Externally-discovered color themes (user files / emulator configs) offered in
 *  the theme picker alongside the built-ins. */
export interface ThemesMessage {
  type: 'themes';
  themes: ColorProfile[];
}

/**
 * Sent immediately before the binary buffer-replay frame on (re)connect. Tells
 * the client the next binary frame is replayed history, so it must discard any
 * input the terminal generates while processing it (e.g. a Device Attributes
 * response to a replayed query — otherwise it lands as typed text like "?1;2c").
 */
export interface SnapshotMessage {
  type: 'snapshot';
}

/**
 * The live workspace tabs. Sent on connect and broadcast whenever a tab is
 * created, exits, is killed, retitles, or has its metadata updated, so
 * switcher UIs stay in sync. `ids`/`titles` are kept (derived from `tabs`)
 * so clients built before tab kinds existed keep working.
 */
export interface SessionsMessage {
  type: 'sessions';
  ids: string[];
  /** Session id → window title; ids with no title yet are absent. */
  titles: { [id: string]: string };
  /** Full per-tab metadata; parser synthesizes terminal tabs from ids/titles
      when talking to an older server that doesn't send it. */
  tabs: TabMeta[];
  /** Tab groups, strip-ordered. `[]` on an older server (parse default). */
  groups: TabGroup[];
}

/**
 * Sent only to the client that requested `createTab`, carrying the assigned id
 * so it can switch to the new tab deterministically (no guessing from the
 * broadcast — which would race with tabs created on other devices).
 */
export interface TabCreatedMessage {
  type: 'tabCreated';
  id: string;
}

/** Liveness reply to a client `ping` — lets the client detect a dead (zombie)
 *  socket that still reads OPEN after a mobile background/network switch. */
export interface PongMessage {
  type: 'pong';
}

/**
 * An opt-in self-update is in progress. Lets the client present the imminent
 * disconnect as an INTENTIONAL update ("updating / reconnecting") rather than a
 * lost connection. `restarting` is sent immediately before the handoff, so the
 * shells survive underneath.
 */
export interface UpdatingMessage {
  type: 'updating';
  stage: 'downloading' | 'staging' | 'restarting' | 'failed';
  /** The version being moved to, when known. */
  version?: string;
}

export type ServerMessage =
  | ReadyMessage
  | SettingsMessage
  | ExtraKeysMessage
  | ExitMessage
  | DetachedMessage
  | ThemeImportedMessage
  | FontsMessage
  | ThemesMessage
  | SnapshotMessage
  | SessionsMessage
  | TabCreatedMessage
  | PongMessage
  | UpdatingMessage;

// ── Client → server ───────────────────────────────────────────────────────────

/** Request a PTY resize. */
export interface ResizeMessage {
  type: 'resize';
  cols: number;
  rows: number;
}

/** Persist updated settings (server stores and rebroadcasts verbatim). */
export interface ClientSettingsMessage {
  type: 'settings';
  settings: JsonObject;
}

/** Persist updated extra-keys config. */
export interface ClientExtraKeysMessage {
  type: 'extraKeys';
  extraKeys: JsonObject;
}

/** Kill a workspace tab by id (a terminal's shell is terminated; any kind is removed). */
export interface KillMessage {
  type: 'kill';
  id: string;
}

/** Create a tab; the server assigns the lowest free numeric id. */
export interface CreateTabMessage {
  type: 'createTab';
  kind: TabKind;
  /** Required for `web` tabs (the server drops a web create without it). */
  url?: string;
  name?: string;
  color?: string;
}

/** Update tab metadata. Empty-string `name`/`color` clears the field. */
export interface UpdateTabMessage {
  type: 'updateTab';
  id: string;
  name?: string;
  color?: string;
  /** Applied to `web` tabs only; ignored on other kinds. */
  url?: string;
}

/**
 * Reorder the tab strip: the full desired id order. The server applies it as a
 * forgiving permutation (unknown ids ignored, omitted known ids appended in
 * their prior relative order) — a stale client can never lose or duplicate a
 * tab. The result arrives via the next `sessions` broadcast, whose `tabs`
 * array order is the authoritative display order.
 */
export interface ReorderTabsMessage {
  type: 'reorderTabs';
  ids: string[];
}

/** Create a tab group from `ids` (server assigns the group id, and a palette
 *  default color when `color` is omitted). Empty/all-unknown ids = no-op. */
export interface GroupCreateMessage {
  type: 'groupCreate';
  ids: string[];
  name?: string;
  color?: string;
}

/**
 * Mutate a group: rename/recolor, add/remove members, dissolve, and/or set the
 * full strip `order`. A join/leave drop sends `addIds`/`removeIds` WITH `order`
 * so membership + position change atomically (a plain reorder can't move
 * membership — the server would normalize the tab back). `dissolve` ungroups
 * all members (they keep their own colors).
 */
export interface GroupUpdateMessage {
  type: 'groupUpdate';
  id: string;
  name?: string;
  color?: string;
  addIds?: string[];
  removeIds?: string[];
  dissolve?: boolean;
  order?: string[];
}

/** Liveness probe; the server replies with `pong`. Used to detect a zombie
 *  socket (readyState OPEN but the connection is dead — common on mobile). */
export interface PingMessage {
  type: 'ping';
}

/** Import a colour theme from a URL (or a bare Gogh theme name). */
export interface ImportThemeMessage {
  type: 'importTheme';
  /** Whatever the user pasted — the server resolves it to a fetchable URL. */
  source: string;
}

export type ClientMessage =
  | ResizeMessage
  | ClientSettingsMessage
  | ClientExtraKeysMessage
  | KillMessage
  | CreateTabMessage
  | UpdateTabMessage
  | ReorderTabsMessage
  | GroupCreateMessage
  | GroupUpdateMessage
  | ImportThemeMessage
  | PingMessage;

// ── Encode / decode helpers ───────────────────────────────────────────────────

export function encodeServerMessage(msg: ServerMessage): string {
  return JSON.stringify(msg);
}

export function encodeClientMessage(msg: ClientMessage): string {
  return JSON.stringify(msg);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Copy optional string fields, skipping non-strings (exactOptionalPropertyTypes-safe). */
function copyStrings<K extends string>(
  raw: Record<string, unknown>,
  keys: readonly K[],
): { [P in K]?: string } {
  const out: { [P in K]?: string } = {};
  for (const k of keys) {
    if (typeof raw[k] === 'string') out[k] = raw[k] as string;
  }
  return out;
}

function parseTabMeta(v: unknown): TabMeta | null {
  if (!isRecord(v) || typeof v['id'] !== 'string' || !isTabKind(v['kind'])) return null;
  return {
    id: v['id'],
    kind: v['kind'],
    ...copyStrings(v, ['name', 'color', 'url', 'title']),
    // groupId is validated (else dropped) — an invalid membership never survives.
    ...(isGroupId(v['groupId']) ? { groupId: v['groupId'] } : {}),
  };
}

function parseTabGroups(v: unknown): TabGroup[] {
  if (!Array.isArray(v)) return [];
  const out: TabGroup[] = [];
  const seen = new Set<string>();
  for (const item of v) {
    if (!isRecord(item) || !isGroupId(item['id']) || seen.has(item['id'])) continue;
    if (typeof item['color'] !== 'string' || !item['color']) continue;
    seen.add(item['id']);
    out.push({ id: item['id'], color: item['color'], ...copyStrings(item, ['name']) });
  }
  return out;
}

/** Validate an array of tab ids (each isTabId, capped) for a group op. */
function parseTabIdList(v: unknown): string[] | null {
  if (v === undefined) return null;
  if (!Array.isArray(v) || v.length > 1000 || !v.every(isTabId)) return null;
  return v as string[];
}

/** Validate one wire ColorProfile (id/name/fg/bg + 16 numeric ansi colors). */
function parseColorProfile(item: unknown): ColorProfile | null {
  if (!isRecord(item)) return null;
  const id = item['id'];
  const name = item['name'];
  const fg = item['fg'];
  const bg = item['bg'];
  const ansi16 = item['ansi16'];
  if (typeof id !== 'string' || typeof name !== 'string') return null;
  if (typeof fg !== 'number' || typeof bg !== 'number') return null;
  if (!Array.isArray(ansi16) || ansi16.length !== 16) return null;
  if (!ansi16.every((c) => typeof c === 'number')) return null;
  const p: ColorProfile = { id, name, fg, bg, ansi16: ansi16 as number[] };
  const cursor = item['cursor'];
  if (typeof cursor === 'number') p.cursor = cursor;
  return p;
}

function parseWebApps(v: unknown): WebAppLink[] {
  if (!Array.isArray(v)) return [];
  const out: WebAppLink[] = [];
  for (const item of v) {
    if (!isRecord(item)) continue;
    if (typeof item['name'] !== 'string' || typeof item['url'] !== 'string') continue;
    out.push({ name: item['name'], url: item['url'], ...copyStrings(item, ['icon']) });
  }
  return out;
}

/** Parse a text frame into a ServerMessage, or null if it isn't one we know. */
export function parseServerMessage(data: string): ServerMessage | null {
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isRecord(raw) || typeof raw['type'] !== 'string') return null;
  switch (raw['type']) {
    case 'ready':
      if (typeof raw['cols'] === 'number' && typeof raw['rows'] === 'number') {
        return {
          type: 'ready',
          cols: raw['cols'],
          rows: raw['rows'],
          maxUploadBytes:
            typeof raw['maxUploadBytes'] === 'number' && raw['maxUploadBytes'] > 0
              ? raw['maxUploadBytes']
              : DEFAULT_MAX_UPLOAD_BYTES,
          webApps: parseWebApps(raw['webApps']),
          version: typeof raw['version'] === 'string' ? raw['version'] : '',
        };
      }
      return null;
    case 'settings':
      return isRecord(raw['settings'])
        ? { type: 'settings', settings: raw['settings'] as JsonObject }
        : null;
    case 'extraKeys':
      return isRecord(raw['extraKeys'])
        ? { type: 'extraKeys', extraKeys: raw['extraKeys'] as JsonObject }
        : null;
    case 'exit':
      return {
        type: 'exit',
        code: typeof raw['code'] === 'number' ? raw['code'] : null,
        signal: typeof raw['signal'] === 'number' ? raw['signal'] : null,
      };
    case 'detached':
      return { type: 'detached' };
    case 'themeImported': {
      const out: ThemeImportedMessage = { type: 'themeImported', ok: raw['ok'] === true };
      if (typeof raw['id'] === 'string') out.id = raw['id'];
      if (typeof raw['detail'] === 'string') out.detail = raw['detail'];
      return out;
    }
    case 'snapshot':
      return { type: 'snapshot' };
    case 'pong':
      return { type: 'pong' };
    case 'tabCreated':
      return typeof raw['id'] === 'string' ? { type: 'tabCreated', id: raw['id'] } : null;
    case 'updating': {
      const stage = raw['stage'];
      if (
        stage !== 'downloading' &&
        stage !== 'staging' &&
        stage !== 'restarting' &&
        stage !== 'failed'
      ) {
        return null;
      }
      const version = raw['version'];
      return {
        type: 'updating',
        stage,
        ...(typeof version === 'string' ? { version } : {}),
      };
    }
    case 'sessions': {
      if (!Array.isArray(raw['ids'])) return null;
      const ids = raw['ids'].filter((id): id is string => typeof id === 'string');
      const titles: { [id: string]: string } = {};
      if (isRecord(raw['titles'])) {
        for (const [id, t] of Object.entries(raw['titles'])) {
          if (typeof t === 'string') titles[id] = t;
        }
      }
      // Older servers don't send `tabs` — synthesize terminal tabs from
      // ids/titles so tab-aware clients degrade gracefully.
      const tabs = Array.isArray(raw['tabs'])
        ? raw['tabs'].map(parseTabMeta).filter((t): t is TabMeta => t !== null)
        : ids.map<TabMeta>((id) => {
            const title = titles[id];
            return { id, kind: 'terminal', ...(title !== undefined ? { title } : {}) };
          });
      return { type: 'sessions', ids, titles, tabs, groups: parseTabGroups(raw['groups']) };
    }
    case 'fonts': {
      if (!Array.isArray(raw['fonts'])) return null;
      const fonts: FontInfo[] = [];
      for (const item of raw['fonts']) {
        if (!isRecord(item)) continue;
        const family = item['family'];
        const url = item['url'];
        if (typeof family !== 'string' || typeof url !== 'string') continue;
        const weight = typeof item['weight'] === 'number' ? item['weight'] : 400;
        const style = item['style'] === 'italic' ? 'italic' : 'normal';
        fonts.push({ family, weight, style, url });
      }
      return { type: 'fonts', fonts };
    }
    case 'themes': {
      if (!Array.isArray(raw['themes'])) return null;
      const themes: ColorProfile[] = [];
      for (const item of raw['themes']) {
        const p = parseColorProfile(item);
        if (p) themes.push(p);
      }
      return { type: 'themes', themes };
    }
    default:
      return null;
  }
}

/** Parse a text frame into a ClientMessage, or null if invalid. */
export function parseClientMessage(data: string): ClientMessage | null {
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isRecord(raw) || typeof raw['type'] !== 'string') return null;
  switch (raw['type']) {
    case 'resize':
      if (typeof raw['cols'] === 'number' && typeof raw['rows'] === 'number') {
        return { type: 'resize', cols: raw['cols'], rows: raw['rows'] };
      }
      return null;
    case 'settings':
      return isRecord(raw['settings'])
        ? { type: 'settings', settings: raw['settings'] as JsonObject }
        : null;
    case 'extraKeys':
      return isRecord(raw['extraKeys'])
        ? { type: 'extraKeys', extraKeys: raw['extraKeys'] as JsonObject }
        : null;
    case 'ping':
      return { type: 'ping' };
    case 'kill':
      return typeof raw['id'] === 'string' ? { type: 'kill', id: raw['id'] } : null;
    case 'importTheme':
      return typeof raw['source'] === 'string' ? { type: 'importTheme', source: raw['source'] } : null;
    case 'createTab':
      if (!isTabKind(raw['kind'])) return null;
      return {
        type: 'createTab',
        kind: raw['kind'],
        ...copyStrings(raw, ['url', 'name', 'color']),
      };
    case 'updateTab':
      if (typeof raw['id'] !== 'string') return null;
      return { type: 'updateTab', id: raw['id'], ...copyStrings(raw, ['name', 'color', 'url']) };
    case 'reorderTabs': {
      const ids = raw['ids'];
      // isTabId bounds each id; the length cap bounds the frame (the registry
      // holds nowhere near this many tabs).
      if (!Array.isArray(ids) || ids.length > 1000 || !ids.every(isTabId)) return null;
      return { type: 'reorderTabs', ids: ids as string[] };
    }
    case 'groupCreate': {
      const ids = parseTabIdList(raw['ids']); // member ids are tab ids
      if (ids === null) return null;
      return { type: 'groupCreate', ids, ...copyStrings(raw, ['name', 'color']) };
    }
    case 'groupUpdate': {
      if (!isGroupId(raw['id'])) return null;
      const addIds = raw['addIds'] === undefined ? undefined : parseTabIdList(raw['addIds']);
      const removeIds =
        raw['removeIds'] === undefined ? undefined : parseTabIdList(raw['removeIds']);
      const order = raw['order'] === undefined ? undefined : parseTabIdList(raw['order']);
      // A present-but-invalid list is a malformed frame → reject the whole op.
      if (addIds === null || removeIds === null || order === null) return null;
      return {
        type: 'groupUpdate',
        id: raw['id'],
        ...copyStrings(raw, ['name', 'color']),
        ...(addIds !== undefined ? { addIds } : {}),
        ...(removeIds !== undefined ? { removeIds } : {}),
        ...(order !== undefined ? { order } : {}),
        ...(typeof raw['dissolve'] === 'boolean' ? { dissolve: raw['dissolve'] } : {}),
      };
    }
    default:
      return null;
  }
}
