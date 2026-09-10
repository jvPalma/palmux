import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { initialVimState, vimKey, type VimState } from '../keybindings/vim-input';

export interface PaletteItem {
  key: string;
  label: string;
  /** Right-aligned hint, e.g. the action's current keybinding. */
  hint?: string;
  run: () => void;
}

export interface CommandPaletteProps {
  items: PaletteItem[];
  onClose: () => void;
  /** Modal (vim) editing of the query, per the `vimInputMode` setting. */
  vimMode?: boolean;
}

/** Subsequence fuzzy match: every query char appears in order within the text. */
export function fuzzyMatch(query: string, text: string): boolean {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let i = 0;
  for (const ch of t) {
    if (i < q.length && ch === q[i]) i++;
    if (i === q.length) return true;
  }
  return q.length === 0;
}

export function CommandPalette({ items, onClose, vimMode = false }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [vim, setVim] = useState<VimState>(() => initialVimState(''));
  const inputRef = useRef<HTMLInputElement>(null);
  // The reducer owns the caret while a key is handled; push it onto the DOM after
  // React has rendered the new text, or the browser would put it back at the end.
  const pendingCaret = useRef<number | null>(null);

  useLayoutEffect(() => {
    const at = pendingCaret.current;
    if (at === null) return;
    pendingCaret.current = null;
    inputRef.current?.setSelectionRange(at, at);
  });

  const filtered = useMemo(
    () => (query ? items.filter((it) => fuzzyMatch(query, it.label)) : items),
    [query, items],
  );
  const activeIdx = Math.min(active, Math.max(0, filtered.length - 1));

  const run = (item: PaletteItem | undefined) => {
    if (!item) return;
    onClose();
    item.run();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    // Escape in normal mode with nothing pending has no vim meaning, so it must
    // fall through and CLOSE the palette — otherwise vim users have no way out
    // except clicking outside.
    const vimClaimsEscape = e.key !== 'Escape' || vim.mode === 'insert' || vim.pending !== '';
    if (vimMode && vimClaimsEscape) {
      const { state, handled } = vimKey(vim, e.key);
      if (handled) {
        // Normal mode swallows bare letters, so they must not reach the input
        // (nor the app-wide keybinding layer above us).
        e.preventDefault();
        e.stopPropagation();
        setVim(state);
        pendingCaret.current = state.caret;
        if (state.text !== query) {
          setQuery(state.text);
          setActive(0);
        }
        return;
      }
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(filtered[activeIdx]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div className="panel-overlay" onPointerDown={onClose}>
      <div
        className="palette"
        onPointerDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Command palette"
      >
        <div className="palette-input-row">
          <input
            ref={inputRef}
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            className="palette-input"
            placeholder="Type a command…"
            value={query}
            onChange={(e) => {
              const text = e.target.value;
              setQuery(text);
              setActive(0);
              // Keep the reducer's view of the text in sync with insert-mode typing.
              setVim((s) => ({ ...s, text, caret: e.target.selectionStart ?? text.length }));
            }}
            onKeyDown={onKeyDown}
            data-testid="palette-input"
          />
          {vimMode && (
            <span className="palette-vim-mode" data-testid="palette-vim-mode">
              {vim.mode === 'normal' ? 'NORMAL' : 'INSERT'}
            </span>
          )}
        </div>
        <ul className="palette-list">
          {filtered.map((it, i) => (
            <li
              key={it.key}
              className={`palette-item${i === activeIdx ? ' active' : ''}`}
              data-testid={`palette-item-${it.key}`}
              onPointerEnter={() => setActive(i)}
              onPointerDown={(e) => {
                e.preventDefault();
                run(it);
              }}
            >
              <span>{it.label}</span>
              {it.hint && <span className="palette-hint">{it.hint}</span>}
            </li>
          ))}
          {filtered.length === 0 && (
            <li className="palette-item palette-empty" data-testid="palette-empty">
              No matches
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}
