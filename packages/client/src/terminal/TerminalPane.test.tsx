// The pane's answer to the server's eviction notice. xterm, the upload hook and the gestures are
// mocked at their seams; the data socket is a fake that this test speaks for.
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliGoto, CliResultEntry, CliResultMessage, ServerMessage } from '@palmux/shared';
import { DEFAULTS } from '../settings/settings';
import { createSplitRegistry } from '../session/SplitFocusContext';
import { TerminalPane } from './TerminalPane';

const { sockets } = vi.hoisted(() => ({
  sockets: [] as Array<{
    url: string;
    message: (msg: ServerMessage) => void;
    open: () => void;
    stopped: boolean;
    results: CliResultMessage[];
  }>,
}));

vi.mock('../lib/ws', () => ({
  WsClient: class {
    url: string;
    stopped = false;
    results: CliResultMessage[] = [];
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
    sendCliResult(msg: CliResultMessage) {
      this.results.push(msg);
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
const { downloadFromServer } = vi.hoisted(() => ({
  downloadFromServer: vi.fn<(pattern: string) => Promise<string | null>>(),
}));
vi.mock('./download', () => ({ downloadFromServer }));

const pane = (
  sessionId: string,
  onTransferError: (msg: string) => void = () => {},
  cli: {
    onCliOpen?: (paths: string[], goto?: CliGoto[]) => CliResultEntry[];
    onCliGit?: (repo: string) => { results: CliResultEntry[]; note?: string };
    onCliWeb?: (url: string) => CliResultEntry;
  } = {},
) => (
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
    onTransferError={onTransferError}
    onCliOpen={cli.onCliOpen ?? (() => [])}
    onCliGit={cli.onCliGit ?? (() => ({ results: [] }))}
    onCliWeb={cli.onCliWeb ?? ((url) => ({ path: url, ok: true }))}
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

// `palmux download` in this terminal: the server sends the checked paths on this pane's socket.
describe('TerminalPane download', () => {
  beforeEach(() => {
    sockets.length = 0;
    downloadFromServer.mockReset();
  });

  it('downloads each path in order, one after the other, and toasts a failure', async () => {
    const order: string[] = [];
    let release: () => void = () => {};
    downloadFromServer.mockImplementation((p) => {
      order.push(p);
      if (p === '/a.mp4') return new Promise((r) => (release = () => r(null)));
      return Promise.resolve(p === '/b.mp4' ? 'not found' : null);
    });
    const errors: string[] = [];
    render(pane('3', (m) => errors.push(m)));
    await act(async () => {
      socketFor('3').message({ type: 'download', paths: ['/a.mp4', '/b.mp4', '/c'] });
    });
    // The second waits for the first, so the browser sees them in the order typed.
    expect(order).toEqual(['/a.mp4']);
    await act(async () => release());
    expect(order).toEqual(['/a.mp4', '/b.mp4', '/c']);
    expect(errors).toEqual(['not found: /b.mp4']);
  });
});

// `palmux open` / `palmux git` in this terminal: the window's answer goes back on this pane's socket.
describe('TerminalPane CLI requests', () => {
  beforeEach(() => {
    sockets.length = 0;
  });

  it('answers cliOpen with what App reports, on the socket the request came on', () => {
    const onCliOpen = vi.fn((paths: string[]) => paths.map((path) => ({ path, ok: true })));
    render(pane('3', () => {}, { onCliOpen }));
    act(() =>
      socketFor('3').message({ type: 'cliOpen', requestId: 'r1', paths: ['/a.ts', '/b.ts'] }),
    );
    expect(onCliOpen).toHaveBeenCalledWith(['/a.ts', '/b.ts']);
    expect(socketFor('3').results).toEqual([
      {
        type: 'cliResult',
        requestId: 'r1',
        results: [
          { path: '/a.ts', ok: true },
          { path: '/b.ts', ok: true },
        ],
      },
    ]);
  });

  it('hands App the positions of a cliOpen, and nothing extra when it carries none', () => {
    const onCliOpen = vi.fn((paths: string[]) => paths.map((path) => ({ path, ok: true })));
    render(pane('3', () => {}, { onCliOpen }));
    const goto = [{ path: '/a.ts', line: 4, column: 2 }];
    act(() => socketFor('3').message({ type: 'cliOpen', requestId: 'r1', paths: ['/a.ts'], goto }));
    expect(onCliOpen).toHaveBeenLastCalledWith(['/a.ts'], goto);
  });

  it('answers cliWeb with the entry App reports, on the same socket', () => {
    const onCliWeb = vi.fn((url: string) => ({
      path: url,
      ok: false,
      error: 'open in another window',
    }));
    render(pane('3', () => {}, { onCliWeb }));
    act(() =>
      socketFor('3').message({ type: 'cliWeb', requestId: 'w1', url: 'http://localhost:5173/' }),
    );
    expect(onCliWeb).toHaveBeenCalledWith('http://localhost:5173/');
    expect(socketFor('3').results).toEqual([
      {
        type: 'cliResult',
        requestId: 'w1',
        results: [{ path: 'http://localhost:5173/', ok: false, error: 'open in another window' }],
      },
    ]);
  });

  it('answers cliGit with its result and note, and leaves note out when there is none', () => {
    let note: string | undefined = 'this window has no Source Control panel';
    const onCliGit = (repo: string) => ({
      results: [{ path: repo, ok: true }],
      ...(note !== undefined ? { note } : {}),
    });
    render(pane('3', () => {}, { onCliGit }));
    act(() => socketFor('3').message({ type: 'cliGit', requestId: 'g1', repo: '/w/app' }));
    note = undefined;
    act(() => socketFor('3').message({ type: 'cliGit', requestId: 'g2', repo: '/w/app' }));
    expect(socketFor('3').results).toEqual([
      {
        type: 'cliResult',
        requestId: 'g1',
        results: [{ path: '/w/app', ok: true }],
        note: 'this window has no Source Control panel',
      },
      { type: 'cliResult', requestId: 'g2', results: [{ path: '/w/app', ok: true }] },
    ]);
  });
});
