// Heartbeat / zombie-socket detection: a mobile socket that dies on background
// keeps readyState OPEN, so `send` voids silently and no `close` fires (the
// terminal freezes). The client pings; a missed pong within the window must
// force the socket closed so the existing reconnect fires.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WsClient } from './ws';

const PING = JSON.stringify({ type: 'ping' });
const PONG = JSON.stringify({ type: 'pong' });

class MockWS {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static last: MockWS | null = null;
  static count = 0;

  readyState = MockWS.CONNECTING;
  binaryType = '';
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: unknown[] = [];

  constructor(public url: string) {
    MockWS.last = this;
    MockWS.count += 1;
  }
  send(data: unknown): void {
    this.sent.push(data);
  }
  close(): void {
    if (this.readyState === MockWS.CLOSED) return;
    this.readyState = MockWS.CLOSED;
    this.onclose?.();
  }
  // test helpers
  accept(): void {
    this.readyState = MockWS.OPEN;
    this.onopen?.();
  }
  deliver(data: unknown): void {
    this.onmessage?.({ data });
  }
}

const openClient = () => {
  const c = new WsClient('ws://x/ws');
  c.connect();
  MockWS.last!.accept();
  return c;
};

describe('WsClient heartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockWS.last = null;
    MockWS.count = 0;
    vi.stubGlobal('WebSocket', MockWS);
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('pings after the heartbeat interval', () => {
    const c = openClient();
    const ws = MockWS.last!;
    expect(ws.sent).not.toContain(PING);
    vi.advanceTimersByTime(15000);
    expect(ws.sent).toContain(PING);
    c.destroy();
  });

  it('closes a zombie (no pong within the window) so reconnect fires', () => {
    const c = openClient();
    const ws = MockWS.last!;
    vi.advanceTimersByTime(15000); // ping sent
    vi.advanceTimersByTime(4000); // pong watchdog elapses with no reply
    expect(ws.readyState).toBe(MockWS.CLOSED);
    // onclose scheduled a reconnect → a new socket is created.
    vi.advanceTimersByTime(5000);
    expect(MockWS.count).toBeGreaterThan(1);
    c.destroy();
  });

  it('a pong keeps the socket alive (no close)', () => {
    const c = openClient();
    const ws = MockWS.last!;
    vi.advanceTimersByTime(15000); // ping
    ws.deliver(PONG); // liveness reply clears the watchdog
    vi.advanceTimersByTime(4000);
    expect(ws.readyState).toBe(MockWS.OPEN);
    c.destroy();
  });

  it('any inbound frame counts as liveness (not just pong)', () => {
    const c = openClient();
    const ws = MockWS.last!;
    vi.advanceTimersByTime(15000); // ping
    ws.deliver(new ArrayBuffer(4)); // a PTY data frame proves the socket is live
    vi.advanceTimersByTime(4000);
    expect(ws.readyState).toBe(MockWS.OPEN);
    c.destroy();
  });

  it('probes an OPEN socket when returning to the foreground', () => {
    const c = openClient();
    const ws = MockWS.last!;
    document.dispatchEvent(new Event('visibilitychange'));
    expect(ws.sent).toContain(PING);
    c.destroy();
  });
});
