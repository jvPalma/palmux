// ── Kit: ContextMenu ──────────────────────────────────────────────────────────
//
// Right-click on a pointer device, LONG-PRESS on a touch one — Radix handles
// both from the same trigger, which is the whole reason for taking the
// dependency rather than reusing the tab strip's hand-positioned menu. That one
// listens for `contextmenu` alone, and a phone never fires it.
//
// Styled from the eight `--t-*` tokens only, like every other kit component, and
// animated on the surface tier. Radix keeps the item semantics (`role="menu"`,
// `role="menuitem"`, roving focus, type-ahead, Escape, focus restoration on
// close) — the exact set the strip's menu does NOT have.

import * as Radix from '@radix-ui/react-context-menu';
import type { ReactNode } from 'react';

export interface ContextMenuItemSpec {
  /** Stable id, used as the key and the `data-testid` suffix. */
  id: string;
  label: string;
  /** Leading glyph or icon. Optional — a menu of bare labels is fine. */
  icon?: ReactNode;
  onSelect: () => void;
  /** Destructive items are tinted and sit behind a separator. */
  danger?: boolean | undefined;
  disabled?: boolean | undefined;
  /** Draw a separator ABOVE this item. */
  separatorBefore?: boolean | undefined;
}

export interface ContextMenuProps {
  items: ContextMenuItemSpec[];
  children: ReactNode;
  /** Prefix for each item's `data-testid` (`<prefix>-<item id>`). */
  testidPrefix?: string | undefined;
  /** Called when the menu opens — hosts use it to select the row under it. */
  onOpen?: (() => void) | undefined;
}

export function ContextMenu({ items, children, testidPrefix, onOpen }: ContextMenuProps) {
  if (items.length === 0) return <>{children}</>;
  return (
    <Radix.Root
      onOpenChange={(open) => {
        if (open) onOpen?.();
      }}
    >
      {/* asChild: the trigger must BE the row, not a wrapper around it — a
          wrapper would break the tree's absolute-free flow layout and add a box
          the row's own indentation does not account for. */}
      <Radix.Trigger asChild>{children}</Radix.Trigger>
      <Radix.Portal>
        <Radix.Content className="ui-menu" collisionPadding={8} data-testid={testidPrefix}>
          {items.map((item) => (
            <div key={item.id}>
              {item.separatorBefore && <Radix.Separator className="ui-menu-sep" />}
              <Radix.Item
                className={`ui-menu-item${item.danger ? ' danger' : ''}`}
                disabled={item.disabled ?? false}
                data-testid={testidPrefix ? `${testidPrefix}-${item.id}` : undefined}
                onSelect={item.onSelect}
              >
                {item.icon !== undefined && (
                  <span className="ui-menu-icon" aria-hidden="true">
                    {item.icon}
                  </span>
                )}
                <span className="ui-menu-label">{item.label}</span>
              </Radix.Item>
            </div>
          ))}
        </Radix.Content>
      </Radix.Portal>
    </Radix.Root>
  );
}
