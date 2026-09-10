// ── Right-click link menu ─────────────────────────────────────────────────────
//
// Shown only when the right-click actually lands on a link cell (OSC-8 or a
// regex match); anywhere else the browser's own context menu is left alone, so
// this never steals a gesture the user wanted for something else.

import { useEffect, useRef } from 'react';

export interface LinkMenuState {
  url: string;
  x: number;
  y: number;
}

export interface LinkMenuProps {
  state: LinkMenuState;
  onCopy: (url: string) => void;
  onOpen: (url: string) => void;
  onClose: () => void;
}

export const LinkMenu = ({ state, onCopy, onOpen, onClose }: LinkMenuProps) => {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    // Capture phase: the terminal swallows plenty of events beneath us.
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="link-menu"
      style={{ left: state.x, top: state.y }}
      role="menu"
      data-testid="link-menu"
    >
      <div className="link-menu-url" title={state.url}>
        {state.url}
      </div>
      <button
        type="button"
        role="menuitem"
        className="link-menu-item"
        data-testid="link-menu-open"
        onClick={() => {
          onOpen(state.url);
          onClose();
        }}
      >
        Open link
      </button>
      <button
        type="button"
        role="menuitem"
        className="link-menu-item"
        data-testid="link-menu-copy"
        onClick={() => {
          onCopy(state.url);
          onClose();
        }}
      >
        Copy link
      </button>
    </div>
  );
};
