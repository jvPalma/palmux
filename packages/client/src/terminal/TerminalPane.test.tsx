// The pane's answer to the server's eviction notice. xterm, the upload hook and the gestures are
// mocked at their seams; the data socket is a fake that this test speaks for.
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerMessage } from '@palmux/shared';
import { DEFAULTS } from '../settings/settings';
import { createSplitRegistry } from '../session/SplitFocusContext';
import { TerminalPane } from './TerminalPane';

const { sockets } = vi.hoisted(() => ({
  sockets: [] as Array<{
    url: string;
    message: (msg: ServerMessage) => void;
    open: () => void;
    stopped: boolean;
  }>,
}));

vi.mock('../lib/ws', () => ({
  WsClient: class {
    url: string;
    stopped = false;
    private readonly messageHandlers: Array<(msg: ServerMessage) => void> = [];
    private readonly openHandlers: Array<() => void> = [];
    constructor(url: string) {
      this.url = url;
      sockets.push(this as never);
    }
    message(msg: ServerMessage) {
      for (const h of this.messageHandlers) h(msg);
    }
    open() {
      for (const h of this.openHandlers) h();
    }
    onBinary() {}
    onMessage(h: (msg: ServerMessage) => void) {
      this.messageHandlers.push(h);
    }
    onOpen(h: () => void) {
      this.openHandlers.push(h);
    }
    connect() {}
    stopReconnect() {
      this.stopped = true;
    }
    destroy() {}
    sendResize() {}
    sendInput() {
      return true;
    }
  },
}));

const instance = {
  cols: 80,
  rows: 24,
  options: {},
  textarea: null,
  modes: { bracketedPasteMode: false },
  buffer: { active: { viewportY: 0 } },
  reset: () => {},
  write: () => {},
  focus: () => {},
  blur: () => {},
  hasSelection: () => false,
};
// One object, so the pane's effects see stable identities and open one socket per session.
const terminal = {
  ref: { current: null },
  instance,
  fit: () => {},
  refreshFont: () => {},
  refreshTheme: () => {},
  syncCursor: () => {},
  serialize: () => '',
  copyLastOutput: () => {},
  search: {},
  linkAt: () => null,
  outputZone: () => null,
  clearLinks: () => {},
};
vi.mock('./useTerminal', () => ({ openLink: () => {}, useTerminal: () => terminal }));
vi.mock('./useFileUpload', () => ({
  useFileUpload: () => ({
    dragActive: false,
    openPicker: () => false,
    openImagePicker: () => false,
    uploadFile: () => Promise.resolve(),
  }),
}));
vi.mock('../mobile/useMobileGestures', () => ({ useMobileGestures: () => {} }));

const pane = (sessionId: string) => (
  <TerminalPane
    slot="p0"
    sessionId={sessionId}
    registry={createSplitRegistry()}
    settings={DEFAULTS}
    mobileActive={false}
    focused
    inSplit={false}
    maxUploadBytes={1024}
    isBlocked={() => false}
    onAutoCopy={() => {}}
    onUploadError={() => {}}
    onFocusRequest={() => {}}
    gestures={{ getFontSize: () => 14, setFontSize: () => {}, focusKeyboard: () => {} }}
  />
);
const overlay = () => screen.queryByRole('alertdialog');
const socketFor = (id: string) => sockets.filter((s) => s.url.includes(`session=${id}&`)).at(-1)!;

describe('TerminalPane eviction', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sockets.length = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a rival takeover shows "Opened somewhere else." with Take back at once', () => {
    render(pane('3'));
    act(() => socketFor('3').message({ type: 'detached' }));
    expect(overlay()).toHaveTextContent('Opened somewhere else.');
    expect(screen.getByTestId('exit-reconnect')).toHaveTextContent('Take back');
    expect(socketFor('3').stopped).toBe(true);
  });

  // A tab moved to another window, whose attach reached this pane before the broadcast that
  // moved it did: the broadcast takes the pane to another tab, and nothing is shown meanwhile.
  it('a move to another window shows nothing, stops reconnecting, and leaves with the tab', () => {
    const { rerender } = render(pane('3'));
    act(() => socketFor('3').message({ type: 'detached', moved: true }));
    expect(overlay()).toBeNull();
    expect(socketFor('3').stopped).toBe(true);
    act(() => vi.advanceTimersByTime(1000));
    expect(overlay()).toBeNull();
    rerender(pane('4'));
    act(() => vi.advanceTimersByTime(5000));
    expect(overlay()).toBeNull();
  });

  // The broadcast never takes it away (this window's control socket missed it, and a reclaim gave
  // the tab back): the pane would sit frozen with no way out, so the takeover shows after all.
  it('a move whose tab never leaves shows the takeover after the hold', () => {
    render(pane('3'));
    act(() => socketFor('3').message({ type: 'detached', moved: true }));
    act(() => vi.advanceTimersByTime(1999));
    expect(overlay()).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(overlay()).toHaveTextContent('Opened somewhere else.');
  });

  // The pane is keyed by pane, so a tab switch swaps the session in place: the old tab's takeover
  // must not sit over the new one for the connect round trip.
  it('drops the takeover the moment the pane switches to another tab', () => {
    const { rerender } = render(pane('3'));
    act(() => socketFor('3').message({ type: 'detached' }));
    expect(overlay()).not.toBeNull();
    rerender(pane('4'));
    expect(overlay()).toBeNull();
  });
});
