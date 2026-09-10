import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { LinkMenu } from './LinkMenu';

afterEach(() => {
  cleanup();
});

const state = { url: 'https://example.com', x: 12, y: 34 };

describe('LinkMenu', () => {
  it('renders the url and both menu items, positioned at the given coordinates', () => {
    render(<LinkMenu state={state} onCopy={() => {}} onOpen={() => {}} onClose={() => {}} />);

    expect(screen.getByText(state.url)).toBeTruthy();
    expect(screen.getByTestId('link-menu-open')).toBeTruthy();
    expect(screen.getByTestId('link-menu-copy')).toBeTruthy();

    const menu = screen.getByTestId('link-menu');
    expect(menu.style.left).toBe('12px');
    expect(menu.style.top).toBe('34px');
  });

  it('clicking "Open link" calls onOpen with the url and then onClose', () => {
    const calls: string[] = [];
    const onOpen = vi.fn((url: string) => calls.push(`open:${url}`));
    const onClose = vi.fn(() => calls.push('close'));
    render(<LinkMenu state={state} onCopy={() => {}} onOpen={onOpen} onClose={onClose} />);

    fireEvent.click(screen.getByTestId('link-menu-open'));

    expect(onOpen).toHaveBeenCalledWith(state.url);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([`open:${state.url}`, 'close']);
  });

  it('clicking "Copy link" calls onCopy with the url and then onClose', () => {
    const calls: string[] = [];
    const onCopy = vi.fn((url: string) => calls.push(`copy:${url}`));
    const onClose = vi.fn(() => calls.push('close'));
    render(<LinkMenu state={state} onCopy={onCopy} onOpen={() => {}} onClose={onClose} />);

    fireEvent.click(screen.getByTestId('link-menu-copy'));

    expect(onCopy).toHaveBeenCalledWith(state.url);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([`copy:${state.url}`, 'close']);
  });

  it('pressing Escape calls onClose', () => {
    const onClose = vi.fn();
    render(<LinkMenu state={state} onCopy={() => {}} onOpen={() => {}} onClose={onClose} />);

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a pointerdown outside the menu calls onClose', () => {
    const onClose = vi.fn();
    render(<LinkMenu state={state} onCopy={() => {}} onOpen={() => {}} onClose={onClose} />);

    fireEvent.pointerDown(document.body);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a pointerdown inside the menu does not call onClose', () => {
    const onClose = vi.fn();
    render(<LinkMenu state={state} onCopy={() => {}} onOpen={() => {}} onClose={onClose} />);

    fireEvent.pointerDown(screen.getByTestId('link-menu-open'));

    expect(onClose).not.toHaveBeenCalled();
  });

  it('removes its listeners on unmount', () => {
    const onClose = vi.fn();
    const { unmount } = render(
      <LinkMenu state={state} onCopy={() => {}} onOpen={() => {}} onClose={onClose} />,
    );

    unmount();
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.pointerDown(document.body);

    expect(onClose).not.toHaveBeenCalled();
  });
});
