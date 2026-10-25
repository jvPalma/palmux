// ── Kit: DropdownMenu ─────────────────────────────────────────────────────────
//
// A menu opened by a BUTTON, as ContextMenu is a menu opened by a right-click or
// a long press. The app menu in the topbar is the first caller. Radix keeps what
// a popover of buttons would lose: `role="menu"`, roving focus, type-ahead,
// Escape, and focus returning to the trigger on close.
//
// It reuses ContextMenu's item shape and its `.ui-menu` / `.ui-menu-item`
// classes, so the two menus cannot drift apart. The only difference is the
// transform origin: a dropdown grows out of its trigger, and Radix publishes
// that as its own variable (see `.ui-dropdown` in ui.css).

import * as Radix from '@radix-ui/react-dropdown-menu';
import type { ReactNode } from 'react';
import type { ContextMenuItemSpec } from './ContextMenu';

export type DropdownMenuItemSpec = ContextMenuItemSpec;

export interface DropdownMenuProps {
  items: DropdownMenuItemSpec[];
  /** The trigger. Rendered as-is (`asChild`), so it must be a single button. */
  children: ReactNode;
  /** Prefix for each item's `data-testid` (`<prefix>-<item id>`); the menu itself carries the bare prefix. */
  testidPrefix?: string | undefined;
  /** Which edge of the trigger the menu lines up with. */
  align?: 'start' | 'center' | 'end' | undefined;
}

export function DropdownMenu({
  items,
  children,
  testidPrefix,
  align = 'start',
}: DropdownMenuProps) {
  if (items.length === 0) return <>{children}</>;
  return (
    <Radix.Root>
      {/* asChild: the trigger must BE the caller's button, not a wrapper around
          it — a wrapper would add a box the topbar's flex row does not account for. */}
      <Radix.Trigger asChild className="ui-menu-trigger">
        {children}
      </Radix.Trigger>
      <Radix.Portal>
        <Radix.Content
          className="ui-menu ui-dropdown"
          align={align}
          sideOffset={4}
          collisionPadding={8}
          data-testid={testidPrefix}
        >
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
