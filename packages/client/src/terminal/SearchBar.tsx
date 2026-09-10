import { useEffect, useRef, useState } from 'react';
import type { SearchAddon } from '@xterm/addon-search';

export interface SearchBarProps {
  search: () => SearchAddon | null;
  onClose: () => void;
}

/** A small in-terminal find bar over the loaded @xterm/addon-search. */
export function SearchBar({ search, onClose }: SearchBarProps) {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const find = (dir: 'next' | 'prev') => {
    const addon = search();
    if (!addon || !query) return;
    // Bright mustard highlight (VS Code-like) — clearly above terminal colours.
    const opts = {
      decorations: {
        matchBackground: '#8a6d00',
        matchOverviewRuler: '#8a6d00',
        activeMatchBackground: '#e6b800',
        activeMatchColorOverviewRuler: '#e6b800',
      },
    };
    if (dir === 'next') addon.findNext(query, opts);
    else addon.findPrevious(query, opts);
  };

  return (
    <div className="term-search" onPointerDown={(e) => e.stopPropagation()}>
      <input
        ref={inputRef}
        className="term-search-input"
        placeholder="Search…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            find(e.shiftKey ? 'prev' : 'next');
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          }
        }}
        data-testid="term-search-input"
      />
      <button type="button" onClick={() => find('prev')} title="Previous (Shift+Enter)">
        ↑
      </button>
      <button type="button" onClick={() => find('next')} title="Next (Enter)">
        ↓
      </button>
      <button type="button" onClick={onClose} title="Close (Esc)">
        ✕
      </button>
    </div>
  );
}
