// ── Reconnecting WebSocket client ─────────────────────────────────────────────
//
// Binary frames carry raw PTY bytes; text frames carry the JSON protocol.
// Trimmed from the original client: full-jitter backoff, fast reconnect on
// network/visibility regain. No session/claude/workstation handling.

import {
  parseServerMessage,
  type ClientMessage,
  type ServerMessage,
  type JsonObject,
  type TabKind,
} from '@palmux/shared';

type BinaryHandler = (data: ArrayBuffer) => void;
type MessageHandler = (msg: ServerMessage) => void;
type VoidHandler = () => void;

const RECONNECT_BASE_MS = 150;
const RECONNECT_CAP_MS = 4000;
// Heartbeat: a zombie socket (mobile background / network switch) keeps
// readyState OPEN while being dead, so `send` silently voids and no `close`
// fires — the terminal freezes. We ping periodically and on foreground; if no
// frame comes back within the window, the socket is dead → close → reconnect.
const HEARTBEAT_MS = 15000;
const PONG_TIMEOUT_MS = 4000;

export class WsClient {
  private ws: WebSocket | null = null;
  private reconnectDelay = RECONNECT_BASE_MS;
  private destroyed = false;
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private pongTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly binaryHandlers: BinaryHandler[] = [];
  private readonly messageHandlers: MessageHandler[] = [];
  private readonly openHandlers: VoidHandler[] = [];
  private readonly closeHandlers: VoidHandler[] = [];

  private readonly onOnline = () => this.reconnectNow();
  private readonly onVisible = () => {
    if (document.visibilityState !== 'visible') return;
    // On return to foreground, a still-OPEN socket may be a zombie: probe it
    // (a healthy one pongs immediately and is untouched; a dead one is closed
    // by the watchdog → reconnect). A non-open socket reconnects right away.
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.probe();
    else this.reconnectNow();
  };

  constructor(private readonly url: string) {
    window.addEventListener('online', this.onOnline);
    document.addEventListener('visibilitychange', this.onVisible);
  }

  connect(): void {
    if (this.destroyed) return;
    // Cut the previous socket loose FIRST. A socket we gave up on (the pong
    // watchdog fired) may still be alive and slow rather than truly dead, and
    // anything it delivers now speaks for a connection we have already replaced
    // — including the server's takeover notice, which would otherwise surface as
    // "opened somewhere else" for a session this client never lost.
    this.abandon();
    try {
      this.ws = new WebSocket(this.url);
      this.ws.binaryType = 'arraybuffer';

      this.ws.onopen = () => {
        this.reconnectDelay = RECONNECT_BASE_MS;
        this.startHeartbeat();
        this.openHandlers.forEach((h) => h());
      };

      this.ws.onmessage = (ev) => {
        this.markAlive(); // any inbound frame proves the socket is alive
        if (ev.data instanceof ArrayBuffer) {
          this.binaryHandlers.forEach((h) => h(ev.data as ArrayBuffer));
        } else if (typeof ev.data === 'string') {
          const msg = parseServerMessage(ev.data);
          if (!msg || msg.type === 'pong') return; // pong is an internal liveness reply
          this.messageHandlers.forEach((h) => h(msg));
        }
      };

      this.ws.onclose = () => {
        this.stopHeartbeat();
        this.closeHandlers.forEach((h) => h());
        if (!this.destroyed && !this.stopped) {
          const wait = Math.random() * this.reconnectDelay;
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = setTimeout(() => this.connect(), wait);
          this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_CAP_MS);
        }
      };

      this.ws.onerror = () => this.ws?.close();
    } catch {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelay);
    }
  }

  /**
   * Detach and close the current socket so nothing it emits from here on can
   * reach the app. Silencing `onclose` too is deliberate: the caller is already
   * making the replacement, so the abandoned socket must not also schedule one.
   */
  private abandon(): void {
    const ws = this.ws;
    if (!ws) return;
    this.ws = null;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    try {
      ws.close();
    } catch {
      /* already closing */
    }
  }

  /** Halt auto-reconnect (e.g. after the PTY exits). A full reload restarts it. */
  stopReconnect(): void {
    this.stopped = true;
    this.stopHeartbeat();
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => this.probe(), HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    this.markAlive();
  }

  /** A frame arrived → cancel the pending pong watchdog (the socket is alive). */
  private markAlive(): void {
    clearTimeout(this.pongTimer);
    this.pongTimer = undefined;
  }

  /** Ping and arm a watchdog; no reply within the window ⇒ zombie ⇒ close it. */
  private probe(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    if (this.pongTimer) return; // already awaiting a pong
    if (!this.sendMessage({ type: 'ping' })) return;
    this.pongTimer = setTimeout(() => {
      this.pongTimer = undefined;
      // Dead connection masquerading as OPEN — force it closed so onclose
      // schedules a reconnect (the server keeps the PTY alive and replays).
      // Deafen it first: we have judged it dead, so nothing it says from now on
      // should reach the app. `onclose` stays wired — it is what reconnects.
      try {
        if (this.ws) this.ws.onmessage = null;
        this.ws?.close();
      } catch {
        /* already closing */
      }
    }, PONG_TIMEOUT_MS);
  }

  private reconnectNow(): void {
    if (this.destroyed || this.stopped) return;
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.reconnectDelay = RECONNECT_BASE_MS;
    this.connect();
  }

  onBinary(h: BinaryHandler): void {
    this.binaryHandlers.push(h);
  }
  onMessage(h: MessageHandler): void {
    this.messageHandlers.push(h);
  }
  onOpen(h: VoidHandler): void {
    this.openHandlers.push(h);
  }
  onClose(h: VoidHandler): void {
    this.closeHandlers.push(h);
  }

  /** Send a UTF-8 string as raw PTY input (binary frame). False = dropped. */
  sendInput(text: string): boolean {
    return this.sendBinary(new TextEncoder().encode(text).buffer);
  }

  /** Returns false when the socket isn't open and the frame was dropped. */
  sendBinary(data: ArrayBuffer): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(data);
    return true;
  }

  /** Returns false when the socket isn't open and the frame was dropped. */
  private sendMessage(msg: ClientMessage): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  sendResize(cols: number, rows: number): void {
    this.sendMessage({ type: 'resize', cols, rows });
  }
  sendSettings(settings: JsonObject): void {
    this.sendMessage({ type: 'settings', settings });
  }
  sendExtraKeys(extraKeys: JsonObject): void {
    this.sendMessage({ type: 'extraKeys', extraKeys });
  }
  sendKill(id: string): boolean {
    return this.sendMessage({ type: 'kill', id });
  }
  sendImportTheme(source: string): boolean {
    return this.sendMessage({ type: 'importTheme', source });
  }
  sendCreateTab(spec: { kind: TabKind; url?: string; name?: string; color?: string }): boolean {
    return this.sendMessage({ type: 'createTab', ...spec });
  }
  sendUpdateTab(patch: { id: string; name?: string; color?: string; url?: string }): boolean {
    return this.sendMessage({ type: 'updateTab', ...patch });
  }
  /** Full desired tab order; the server rebroadcasts the applied order. */
  sendReorderTabs(ids: string[]): boolean {
    return this.sendMessage({ type: 'reorderTabs', ids });
  }
  /** Create a tab group from `ids` (server assigns the id + a default color). */
  sendGroupCreate(ids: string[], meta: { name?: string; color?: string } = {}): boolean {
    return this.sendMessage({ type: 'groupCreate', ids, ...meta });
  }
  /** Mutate a group: rename/recolor/add/remove/dissolve and/or set strip order. */
  sendGroupUpdate(patch: {
    id: string;
    name?: string;
    color?: string;
    addIds?: string[];
    removeIds?: string[];
    dissolve?: boolean;
    order?: string[];
  }): boolean {
    return this.sendMessage({ type: 'groupUpdate', ...patch });
  }

  destroy(): void {
    this.destroyed = true;
    this.stopHeartbeat();
    clearTimeout(this.reconnectTimer);
    window.removeEventListener('online', this.onOnline);
    document.removeEventListener('visibilitychange', this.onVisible);
    // Detach before closing: a frame arriving after the owner unmounted would
    // otherwise still run its handlers.
    this.abandon();
  }
}
