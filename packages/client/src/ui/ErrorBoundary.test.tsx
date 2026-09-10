// The boundary exists because of one measured incident: a lazy setState updater
// read `e.currentTarget.duration` after React had nulled it, and the render-phase
// throw unmounted the ENTIRE app — every terminal, every editor buffer — from a
// bug in one dictation card.

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';

const Boom = ({ throws }: { throws: boolean }) => {
  if (throws) throw new Error('duration of null');
  return <div data-testid="ok">fine</div>;
};

beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

describe('ErrorBoundary', () => {
  it('passes children straight through when nothing throws', () => {
    render(
      <ErrorBoundary label="Dictation">
        <Boom throws={false} />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('ok')).toBeTruthy();
    expect(screen.queryByTestId('error-boundary')).toBeNull();
  });

  it('contains a throw, naming the panel and the reason', () => {
    render(
      <ErrorBoundary label="Dictation">
        <Boom throws />
      </ErrorBoundary>,
    );
    const box = screen.getByTestId('error-boundary');
    expect(box.textContent).toContain('Dictation failed');
    expect(box.textContent).toContain('duration of null');
    expect(box.getAttribute('role')).toBe('alert'); // the panel, not the app, is gone
  });

  it('Try again re-renders the subtree', () => {
    const view = render(
      <ErrorBoundary label="Dictation">
        <Boom throws />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('error-boundary')).toBeTruthy();

    view.rerender(
      <ErrorBoundary label="Dictation">
        <Boom throws={false} />
      </ErrorBoundary>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByTestId('ok')).toBeTruthy();
  });

  // Switching view and back is the retry a user actually performs. The hosts
  // give the boundary a React key per view, so a new subject REMOUNTS it rather
  // than inheriting the previous one's error.
  it('a new key remounts it clean, without pressing anything', () => {
    const view = render(
      <ErrorBoundary key="dictation" label="Dictation">
        <Boom throws />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('error-boundary')).toBeTruthy();

    view.rerender(
      <ErrorBoundary key="files" label="Files">
        <Boom throws={false} />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('ok')).toBeTruthy();
    expect(screen.queryByTestId('error-boundary')).toBeNull();
  });
});

// ── The fallback's own positioning ────────────────────────────────────────────
//
// Panes are placed by ABSOLUTE rect. A boundary that rendered its fallback in
// normal flow would drop it at 0,0 on top of the surviving pane, so the style
// is applied to the fallback and — importantly — never to the children: putting
// a wrapper around a live pane is the reparenting the split layout exists to
// avoid, because an iframe or a Monaco editor reloads when its parent changes.
describe('ErrorBoundary style', () => {
  const Boom = (): never => {
    throw new Error('pane exploded');
  };

  it('applies the style to the fallback', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <ErrorBoundary label="Terminal 3" style={{ left: '50%', width: '50%' }}>
        <Boom />
      </ErrorBoundary>,
    );
    const el = screen.getByTestId('error-boundary');
    expect(el).toHaveTextContent('Terminal 3 failed');
    expect(el.style.left).toBe('50%');
    expect(el.style.width).toBe('50%');
    spy.mockRestore();
  });

  it('adds no element and no style around healthy children', () => {
    const { container } = render(
      <ErrorBoundary label="Terminal 3" style={{ left: '50%' }}>
        <p data-testid="child">alive</p>
      </ErrorBoundary>,
    );
    // The child is the boundary's only output — no wrapper div was introduced.
    expect(container.firstChild).toBe(screen.getByTestId('child'));
    expect(screen.queryByTestId('error-boundary')).toBeNull();
  });

  it('isolates one throwing sibling from the other', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <>
        <ErrorBoundary label="Terminal a">
          <Boom />
        </ErrorBoundary>
        <ErrorBoundary label="Terminal b">
          <p data-testid="survivor">still here</p>
        </ErrorBoundary>
      </>,
    );
    expect(screen.getByTestId('survivor')).toBeTruthy();
    expect(screen.getAllByTestId('error-boundary')).toHaveLength(1);
    spy.mockRestore();
  });
});
