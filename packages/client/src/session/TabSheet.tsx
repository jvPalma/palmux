// ── Tab sheet (mobile) ────────────────────────────────────────────────────────
//
// Bottom sheet opened by long-pressing a drawer row: rename field, the color
// palette, and Close. The rename input is a real text field (it may take focus
// from #mobile-kbd — fine, the sheet is modal); buttons act on pointerdown per
// the drawer convention.

import { useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { TabGroup, TabMeta } from '@palmux/shared';
import { displayTitle, kindIcon, resolveColorSlot, tabColorValue } from './tab-meta';
import { SwatchRows } from './SessionTabs';
import { pressMove } from '../panes/press';

interface TabSheetProps {
  tab: TabMeta;
  onRename: (id: string, name: string) => void;
  onRecolor: (id: string, color: string) => void;
  groups?: TabGroup[] | undefined;
  onNewGroup?: ((id: string) => void) | undefined;
  onAddToGroup?: ((id: string, gid: string) => void) | undefined;
  onRemoveFromGroup?: ((id: string) => void) | undefined;
  /** Close (kill) the tab; the App owns kind-specific confirmation. */
  onCloseTab: (id: string) => void;
  onDismiss: () => void;
}

const NO_GROUPS: TabGroup[] = [];

const press = (action: () => void) => (e: ReactPointerEvent) => {
  e.preventDefault();
  action();
};

export const TabSheet = ({
  tab,
  onRename,
  onRecolor,
  groups = NO_GROUPS,
  onNewGroup,
  onAddToGroup,
  onRemoveFromGroup,
  onCloseTab,
  onDismiss,
}: TabSheetProps) => {
  const [name, setName] = useState(tab.name ?? '');

  const commit = () => {
    const trimmed = name.trim();
    if (trimmed !== (tab.name ?? '')) onRename(tab.id, trimmed);
    onDismiss();
  };

  return (
    <>
      <div className="sheet-scrim" data-testid="sheet-scrim" onPointerDown={press(onDismiss)} />
      <div className="tab-sheet" data-testid="tab-sheet">
        <div className="sheet-title">
          {kindIcon(tab.kind)} {displayTitle(tab)}
        </div>
        <input
          className="sheet-input"
          data-testid="sheet-rename"
          placeholder="Tab name (empty = automatic)"
          value={name}
          autoCapitalize="off"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
          }}
        />
        {/* The group list is the only UNBOUNDED thing in this sheet — one row
            per group, on a phone, in fixed chrome with nowhere to grow. It is
            therefore a bounded SCROLLER, and that is why its rows use
            `pressMove` while the rest of the sheet uses the local `press`: a
            control inside a scroller cannot fire on pointerdown, because the
            finger that arrived to scroll has already picked whatever was under
            it, and preventDefault on a touch pointerdown cancels the pan
            outright. */}
        {(onNewGroup || onAddToGroup || (onRemoveFromGroup && tab.groupId)) && (
          <div className="sheet-groups">
            {onNewGroup && (
              <button
                className="tab-menu-item"
                data-testid="sheet-new-group"
                {...pressMove(() => {
                  onNewGroup(tab.id);
                  onDismiss();
                })}
              >
                New group from this tab
              </button>
            )}
            {onAddToGroup &&
              groups
                .filter((group) => group.id !== tab.groupId)
                .map((group) => (
                  <button
                    key={group.id}
                    className="tab-menu-item"
                    data-testid={`sheet-add-to-${group.id}`}
                    {...pressMove(() => {
                      onAddToGroup(tab.id, group.id);
                      onDismiss();
                    })}
                  >
                    <span
                      className="menu-group-dot"
                      style={{ background: tabColorValue(group.color) }}
                    />{' '}
                    Add to {group.name || 'group'}
                  </button>
                ))}
            {onRemoveFromGroup && tab.groupId && (
              <button
                className="tab-menu-item"
                data-testid="sheet-remove-from-group"
                {...pressMove(() => {
                  onRemoveFromGroup(tab.id);
                  onDismiss();
                })}
              >
                Remove from group
              </button>
            )}
          </div>
        )}
        <div className="sheet-colors">
          <SwatchRows
            testidPrefix="sheet-color"
            selectedSlot={resolveColorSlot(tab.color)}
            onPick={(color) => onRecolor(tab.id, color)}
          />
          <button
            className={`tab-swatch none${!tabColorValue(tab.color) ? ' selected' : ''}`}
            aria-label="No color"
            data-testid="sheet-color-none"
            onPointerDown={press(() => onRecolor(tab.id, ''))}
          >
            ∅
          </button>
        </div>
        <div className="sheet-actions">
          <button
            className="sheet-btn danger"
            data-testid="sheet-close-tab"
            onPointerDown={press(() => {
              onDismiss();
              onCloseTab(tab.id);
            })}
          >
            ✕ Close tab
          </button>
          <button className="sheet-btn" data-testid="sheet-done" onPointerDown={press(commit)}>
            Done
          </button>
        </div>
      </div>
    </>
  );
};
