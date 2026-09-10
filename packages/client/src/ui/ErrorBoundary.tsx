// ── Kit: ErrorBoundary ────────────────────────────────────────────────────────
//
// A render-phase throw anywhere in the tree unmounts the WHOLE React root:
// React has no other safe option, because it cannot know which state is
// corrupt. In a page that is mostly text, that is a blank screen you reload
// past. In palmux it costs every attached terminal, every unsaved editor buffer
// and every pane's scroll position, and the only way back is closing the tab.
//
// That is far too much to lose over one panel, so each swappable view gets a
// boundary: the panel shows what broke, the terminals keep running, and the
// user chooses when to retry. Measured: `e.currentTarget.duration` read inside a
// lazy setState updater (React nulls it before it runs the updater) took the
// entire app down from the dictation view.
//
// Retrying needs no state of its own to clear: the host gives the boundary a
// React `key` of whatever is being shown (the view name), so switching away and
// back REMOUNTS it with a clean slate. Clearing the error from a lifecycle hook
// instead would mean a setState in componentDidUpdate — a second render pass on
// every update, for a case a key already handles.

import { Component } from 'react';
import type { CSSProperties, ErrorInfo, ReactNode } from 'react';
import { Button } from './Button';

export interface ErrorBoundaryProps {
  children: ReactNode;
  /** Shown as "<label> failed" — name the panel, not the component. */
  label: string;
  /**
   * Applied to the FALLBACK only, never to the children. A pane is positioned
   * by absolute rect, so without this its fallback would render at 0,0 over the
   * other pane; and applying it to the happy path would mean wrapping every
   * pane in a div, which is exactly the reparenting the split layout avoids
   * (an iframe or an editor reloads when its DOM parent changes).
   */
  style?: CSSProperties | undefined;
}

interface ErrorBoundaryState {
  message: string;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { message: '' };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // The console is the only place a stack survives; the panel shows the
    // message alone, because a component stack is not the user's problem.
    console.error(`[${this.props.label}]`, error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.message) return this.props.children;
    return (
      <div
        className="ui-error-boundary"
        role="alert"
        data-testid="error-boundary"
        style={this.props.style}
      >
        <p className="ui-error-boundary-title">{this.props.label} failed</p>
        <p className="ui-error-boundary-msg">{this.state.message}</p>
        <Button size="sm" onClick={() => this.setState({ message: '' })}>
          Try again
        </Button>
      </div>
    );
  }
}
