// FilePane branches: markdown files get a Read/Edit toggle, everything else
// edits, and images render as an <img> with no editor at all — the tab that
// used to open a PNG as binary garbage in Monaco.
//
// The child panes are mocked: their own wiring is tested in EditorPane.test
// and MarkdownPane.test; this file verifies FilePane's branching around them.

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FilePane } from './FilePane';

vi.mock('./EditorPane', () => ({
  EditorPane: ({ active }: { active: boolean }) =>
    active ? <div data-testid="mock-editor" /> : null,
}));
vi.mock('./MarkdownPane', () => ({
  MarkdownPane: () => <div data-testid="mock-markdown" />,
}));

const renderPane = (path: string) =>
  render(<FilePane path={path} mode="read" onMode={() => {}} />);

describe('image files', () => {
  it('renders an <img> pointed at /file-image, and nothing else', () => {
    renderPane('/home/user/shot.png');
    const img = screen.getByTestId('file-pane-image').querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toBe('/file-image?path=%2Fhome%2Fuser%2Fshot.png');
    expect(img?.getAttribute('alt')).toBe('shot.png');
    expect(screen.queryByTestId('file-pane-mode')).toBeNull();
    expect(screen.queryByTestId('file-pane-save-state')).toBeNull();
    expect(screen.queryByTestId('mock-editor')).toBeNull();
    expect(screen.queryByTestId('mock-markdown')).toBeNull();
  });

  it('applies to every image extension', () => {
    renderPane('/tmp/diagram.svg');
    expect(screen.getByTestId('file-pane-image')).toBeTruthy();
    expect(screen.queryByTestId('mock-editor')).toBeNull();
  });

  it('names a failed load instead of leaving an empty box', () => {
    renderPane('/home/user/shot.png');
    fireEvent.error(screen.getByTestId('file-pane-image').querySelector('img') as HTMLElement);
    expect(screen.getByTestId('file-pane-image-error')).toBeTruthy();
  });
});

describe('markdown files', () => {
  it('keeps the Read/Edit toggle with the Read view mounted', () => {
    renderPane('/home/user/notes.md');
    expect(screen.getByTestId('file-pane-mode')).toBeTruthy();
    expect(screen.getByTestId('mock-markdown')).toBeTruthy();
  });
});

describe('other files', () => {
  it('edits without a Read view', () => {
    renderPane('/home/user/app.ts');
    expect(screen.getByTestId('file-pane-mode')).toBeTruthy();
    expect(screen.getByTestId('mock-editor')).toBeTruthy();
    expect(screen.queryByTestId('mock-markdown')).toBeNull();
  });
});
