// Web pane: sandboxed iframe, URL edit → normalized updateTab, reload remount,
// open-externally fallback.

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TabMeta } from '@palmux/shared';
import { WebPane } from './WebPane';

const TAB: TabMeta = { id: '4', kind: 'web', url: 'https://sb.local' };

afterEach(() => vi.restoreAllMocks());

const renderPane = () => {
  const onChangeUrl = vi.fn();
  const onMenu = vi.fn();
  render(<WebPane tab={TAB} onChangeUrl={onChangeUrl} onMenu={onMenu} />);
  return { onChangeUrl, onMenu };
};

describe('WebPane', () => {
  it('renders a sandboxed iframe pointed at the tab url (cross-origin keeps allow-same-origin)', () => {
    renderPane();
    const iframe = screen.getByTestId('pane-iframe-4') as HTMLIFrameElement;
    expect(iframe.getAttribute('src')).toBe('https://sb.local');
    expect(iframe.getAttribute('sandbox')).toBe(
      'allow-scripts allow-same-origin allow-forms allow-popups allow-downloads',
    );
  });

  it('drops allow-same-origin for a SAME-ORIGIN artifact (no sandbox escape)', () => {
    render(
      <WebPane
        tab={{ id: '5', kind: 'web', url: '/artifacts/report.html' }}
        onChangeUrl={vi.fn()}
        onMenu={undefined}
      />,
    );
    const iframe = screen.getByTestId('pane-iframe-5') as HTMLIFrameElement;
    expect(iframe.getAttribute('sandbox')).toBe(
      'allow-scripts allow-forms allow-popups allow-downloads',
    );
    expect(iframe.getAttribute('sandbox')).not.toContain('allow-same-origin');
  });

  it('never puts a non-embeddable url in src (renders about:blank instead)', () => {
    // A hostile value that slipped past the server would still not execute.
    render(
      <WebPane
        tab={{ id: '6', kind: 'web', url: 'javascript:alert(1)' }}
        onChangeUrl={vi.fn()}
        onMenu={undefined}
      />,
    );
    const iframe = screen.getByTestId('pane-iframe-6') as HTMLIFrameElement;
    expect(iframe.getAttribute('src')).toBe('about:blank');
  });

  it('commits a normalized URL on Enter', () => {
    const p = renderPane();
    const input = screen.getByTestId('pane-url');
    fireEvent.change(input, { target: { value: 'grafana.local/d/1' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(p.onChangeUrl).toHaveBeenCalledWith('https://grafana.local/d/1');
  });

  it('does not commit on Escape or an unchanged/invalid URL', () => {
    const p = renderPane();
    const input = screen.getByTestId('pane-url');
    fireEvent.change(input, { target: { value: 'javascript:alert(1)' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.change(input, { target: { value: 'somewhere.new' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(p.onChangeUrl).not.toHaveBeenCalled();
    expect((input as HTMLInputElement).value).toBe('https://sb.local'); // draft reset
  });

  it('open-externally uses a real browser tab (frame-refusal fallback)', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    renderPane();
    fireEvent.click(screen.getByTestId('pane-external'));
    expect(open).toHaveBeenCalledWith('https://sb.local', '_blank', 'noopener');
  });

  it('☰ opens the drawer on mobile', () => {
    const p = renderPane();
    fireEvent.pointerDown(screen.getByTestId('pane-menu'));
    expect(p.onMenu).toHaveBeenCalled();
  });

  it('routes a loopback url through the proxy and KEEPS allow-same-origin', () => {
    // Without it the framed app's ESM assets are fetched uncredentialed (CORS
    // mode + opaque origin) and the cookie gate / workstation ingress bounces
    // them — measured as a 302 to _workstation/forwardAuthCookie. The proxy is
    // useless without this, unlike /artifacts/* which must stay opaque.
    render(
      <WebPane
        tab={{ id: '7', kind: 'web', url: 'http://localhost:5173' }}
        onChangeUrl={vi.fn()}
        onMenu={undefined}
      />,
    );
    const iframe = screen.getByTestId('pane-iframe-7') as HTMLIFrameElement;
    expect(iframe.getAttribute('src')).toBe('/webproxy/5173/');
    expect(iframe.getAttribute('sandbox')).toContain('allow-same-origin');
  });

  it('a same-origin ARTIFACT still gets the opaque origin (proxy is the exception)', () => {
    render(
      <WebPane
        tab={{ id: '8', kind: 'web', url: '/artifacts/x.html' }}
        onChangeUrl={vi.fn()}
        onMenu={undefined}
      />,
    );
    expect(screen.getByTestId('pane-iframe-8').getAttribute('sandbox')).not.toContain(
      'allow-same-origin',
    );
  });

  it('← / → walk the top-level joint history (the framed page is unreachable)', () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
    const forward = vi.spyOn(window.history, 'forward').mockImplementation(() => {});
    renderPane();
    fireEvent.click(screen.getByTestId('pane-back'));
    fireEvent.click(screen.getByTestId('pane-forward'));
    expect(back).toHaveBeenCalledTimes(1);
    expect(forward).toHaveBeenCalledTimes(1);
  });

  it('a url change navigates the SAME frame element (history survives)', () => {
    // Keying the iframe on the url tore down the browsing context on every
    // url-bar commit, which pruned its session-history entries and left ←
    // nothing to walk back to. Same sandbox class ⇒ same element.
    const { rerender } = render(<WebPane tab={TAB} onChangeUrl={vi.fn()} onMenu={undefined} />);
    const before = screen.getByTestId('pane-iframe-4');
    rerender(
      <WebPane tab={{ ...TAB, url: 'https://sb.local/next' }} onChangeUrl={vi.fn()} onMenu={undefined} />,
    );
    const after = screen.getByTestId('pane-iframe-4');
    expect(after).toBe(before);
    expect(after.getAttribute('src')).toBe('https://sb.local/next');
  });

  it('REMOUNTS when the sandbox class flips (the attribute applies at navigation time)', () => {
    // cross-origin → same-origin must not reuse a frame carrying
    // allow-same-origin, or the artifact would inherit our authenticated origin.
    const { rerender } = render(<WebPane tab={TAB} onChangeUrl={vi.fn()} onMenu={undefined} />);
    const before = screen.getByTestId('pane-iframe-4');
    rerender(
      <WebPane
        tab={{ ...TAB, url: '/artifacts/report.html' }}
        onChangeUrl={vi.fn()}
        onMenu={undefined}
      />,
    );
    const after = screen.getByTestId('pane-iframe-4');
    expect(after).not.toBe(before);
    expect(after.getAttribute('sandbox')).not.toContain('allow-same-origin');
  });

  it('reload remounts the frame', () => {
    renderPane();
    const before = screen.getByTestId('pane-iframe-4');
    fireEvent.click(screen.getByTestId('pane-reload'));
    expect(screen.getByTestId('pane-iframe-4')).not.toBe(before);
  });
});
