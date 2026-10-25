// MarkdownPane wiring: document load/refresh/error, the roots browser (list →
// descend → open a file), internal-link navigation, and path-less → browse.
// The renderer is mocked (its own real-DOM contract lives in
// markdown-render.test.ts); here we verify OUR fetch/navigation glue.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TabMeta } from '@palmux/shared';
import { MarkdownPane } from './MarkdownPane';
import { Icon } from '../ui/icons';

vi.mock('./markdown-render', () => ({
  renderMarkdown: (text: string) => Promise.resolve(`<p data-src>${text}</p>`),
}));

let fetchMock: ReturnType<typeof vi.fn>;
const jsonRes = (body: unknown) => ({ ok: true, json: async () => body, text: async () => '' });
const textRes = (body: string) => ({ ok: true, text: async () => body, json: async () => ({}) });
const errRes = (status: number, msg: string) => ({
  ok: false,
  status,
  text: async () => msg,
  json: async () => ({ error: msg }),
});

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

/** The drawn shapes of a registered icon, to compare against what a control
 *  rendered. Rendered into a detached node so `screen` never sees it. */
const iconPaths = (name: string): string | undefined => {
  const host = document.createElement('div');
  render(<Icon name={name} />, { container: host });
  return host.querySelector('svg')?.innerHTML;
};

const mdTab = (url?: string): TabMeta => ({ id: '0', kind: 'markdown', ...(url ? { url } : {}) });

describe('document view', () => {
  it('fetches the path and renders it', async () => {
    fetchMock.mockResolvedValueOnce(textRes('# hello'));
    render(<MarkdownPane tab={mdTab('/docs/a.md')} onChangePath={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('md-body')).toHaveTextContent('# hello'));
    expect(fetchMock).toHaveBeenCalledWith(`/md-file?path=${encodeURIComponent('/docs/a.md')}`);
  });

  it('refresh re-fetches the same path', async () => {
    fetchMock.mockResolvedValue(textRes('v1'));
    render(<MarkdownPane tab={mdTab('/docs/a.md')} onChangePath={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('md-body')).toHaveTextContent('v1'));
    fetchMock.mockResolvedValue(textRes('v2'));
    fireEvent.click(screen.getByTestId('md-refresh'));
    await waitFor(() => expect(screen.getByTestId('md-body')).toHaveTextContent('v2'));
  });

  it('surfaces a server error as a message', async () => {
    fetchMock.mockResolvedValueOnce(errRes(413, 'file exceeds 2 MB'));
    render(<MarkdownPane tab={mdTab('/docs/big.md')} onChangePath={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByTestId('md-error')).toHaveTextContent('file exceeds 2 MB'),
    );
  });

  it('an internal .md link click navigates the tab (onChangePath)', async () => {
    fetchMock.mockResolvedValueOnce(textRes('body'));
    const onChangePath = vi.fn();
    render(<MarkdownPane tab={mdTab('/docs/a.md')} onChangePath={onChangePath} />);
    await waitFor(() => screen.getByTestId('md-body'));
    const body = screen.getByTestId('md-body');
    body.innerHTML = '<a data-md-path="/docs/b.md" href="#">b</a>';
    fireEvent.click(body.querySelector('a')!);
    expect(onChangePath).toHaveBeenCalledWith('/docs/b.md');
  });
});

describe('browser view', () => {
  it('a path-less tab opens straight into the roots list', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ dir: null, root: null, dirs: ['/docs'], files: [] }));
    render(<MarkdownPane tab={mdTab()} onChangePath={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('md-entries')).toHaveTextContent('/docs'));
    expect(fetchMock).toHaveBeenCalledWith('/md-list');
  });

  it('descends into a dir then opens a file (onChangePath + leaves browse)', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ dir: null, root: null, dirs: ['/docs'], files: [] }));
    const onChangePath = vi.fn();
    render(<MarkdownPane tab={mdTab()} onChangePath={onChangePath} />);
    await waitFor(() => screen.getByTestId('md-entries'));

    fetchMock.mockResolvedValueOnce(
      jsonRes({ dir: '/docs', root: '/docs', dirs: [], files: ['/docs/readme.md'] }),
    );
    // A row is an icon plus its name: the folder and the file draw different
    // shapes, and the name is the button's own text.
    const dirRow = screen.getByText('/docs');
    expect(dirRow.querySelector('svg')?.innerHTML).toBe(iconPaths('folder'));
    fireEvent.click(dirRow);
    await waitFor(() => screen.getByText('readme.md'));
    expect(fetchMock).toHaveBeenLastCalledWith(`/md-list?dir=${encodeURIComponent('/docs')}`);

    fetchMock.mockResolvedValueOnce(textRes('# readme'));
    const fileRow = screen.getByText('readme.md');
    expect(fileRow.querySelector('svg')?.innerHTML).toBe(iconPaths('file'));
    fireEvent.click(fileRow);
    expect(onChangePath).toHaveBeenCalledWith('/docs/readme.md');
  });

  it('shows the no-roots error from the server', async () => {
    fetchMock.mockResolvedValueOnce(errRes(404, 'no markdownRoots configured (config.json)'));
    render(<MarkdownPane tab={mdTab()} onChangePath={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByTestId('md-error')).toHaveTextContent('no markdownRoots configured'),
    );
  });

  it('the browse button from a document switches to the browser view', async () => {
    fetchMock.mockResolvedValueOnce(textRes('doc'));
    render(<MarkdownPane tab={mdTab('/docs/a.md')} onChangePath={vi.fn()} />);
    await waitFor(() => screen.getByTestId('md-body'));
    fetchMock.mockResolvedValueOnce(jsonRes({ dir: null, root: null, dirs: ['/docs'], files: [] }));
    // Icon-only: the icon is aria-hidden, so the title is its accessible name.
    const browse = screen.getByTestId('md-browse');
    expect(browse.textContent).toBe('');
    expect(browse.querySelector('svg')?.innerHTML).toBe(iconPaths('folder-open'));
    expect(browse).toHaveAttribute('title', 'Browse configured folders');
    fireEvent.click(browse);
    await waitFor(() => screen.getByTestId('md-browser'));
  });
});

// The header was ☰ 📖 📂 ⟳ ↩ characters. Each is an icon now, and each icon-only
// control keeps its title as its accessible name (the icon is aria-hidden).
describe('header icons', () => {
  const paneHeader = () => screen.getByTestId('markdown-pane').querySelector('.pane-header');

  it('names the document header controls and draws the book beside the file name', async () => {
    fetchMock.mockResolvedValueOnce(textRes('doc'));
    const onMenu = vi.fn();
    render(<MarkdownPane tab={mdTab('/docs/a.md')} onChangePath={vi.fn()} onMenu={onMenu} />);
    await waitFor(() => screen.getByTestId('md-body'));

    const menu = screen.getByRole('button', { name: 'Menu' });
    expect(menu.textContent).toBe('');
    expect(menu.querySelector('svg')?.innerHTML).toBe(iconPaths('menu'));
    fireEvent.pointerDown(menu);
    expect(onMenu).toHaveBeenCalledTimes(1);

    const title = paneHeader()?.querySelector('.pane-title');
    expect(title).toHaveTextContent(/^a\.md$/);
    expect(title?.querySelector('svg')?.innerHTML).toBe(iconPaths('book'));

    const refresh = screen.getByTestId('md-refresh');
    expect(refresh).toHaveAttribute('title', 'Re-read the file');
    expect(refresh.textContent).toBe('');
    expect(refresh.querySelector('svg')?.innerHTML).toBe(iconPaths('reload'));
  });

  it('swaps reload for the back arrow while browsing, and back returns to the document', async () => {
    fetchMock.mockResolvedValueOnce(textRes('doc'));
    render(<MarkdownPane tab={mdTab('/docs/a.md')} onChangePath={vi.fn()} />);
    await waitFor(() => screen.getByTestId('md-body'));
    fetchMock.mockResolvedValueOnce(jsonRes({ dir: null, root: null, dirs: ['/docs'], files: [] }));
    fireEvent.click(screen.getByTestId('md-browse'));
    await waitFor(() => screen.getByTestId('md-browser'));

    expect(screen.queryByTestId('md-refresh')).toBeNull();
    const back = screen.getByTestId('md-back');
    expect(back).toHaveAttribute('title', 'Back to the document');
    expect(back.textContent).toBe('');
    expect(back.querySelector('svg')?.innerHTML).toBe(iconPaths('back'));
    fetchMock.mockResolvedValueOnce(textRes('doc'));
    fireEvent.click(back);
    await waitFor(() => screen.getByTestId('md-body'));
  });
});

describe('internal-link modifier clicks', () => {
  it('a plain click navigates in-pane; a ctrl/cmd/middle click is left to the browser', async () => {
    fetchMock.mockResolvedValueOnce(textRes('doc'));
    const onChangePath = vi.fn();
    render(<MarkdownPane tab={mdTab('/docs/a.md')} onChangePath={onChangePath} />);
    await waitFor(() => screen.getByTestId('md-body'));
    const body = screen.getByTestId('md-body');
    body.innerHTML = '<a data-md-path="/docs/b.md" href="/md-file?path=%2Fdocs%2Fb.md">b</a>';
    const link = body.querySelector('a')!;

    fireEvent.click(link, { ctrlKey: true }); // modified → browser handles the fallback href
    expect(onChangePath).not.toHaveBeenCalled();
    fireEvent.click(link, { metaKey: true });
    expect(onChangePath).not.toHaveBeenCalled();

    fireEvent.click(link); // plain → in-pane nav
    expect(onChangePath).toHaveBeenCalledWith('/docs/b.md');
  });
});
