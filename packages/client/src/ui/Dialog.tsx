// ── Kit: Dialog ───────────────────────────────────────────────────────────────
//
// For BLOCKING confirms — killing a tab, closing a group — where the answer
// decides whether work is destroyed. App surfaces (settings, the new-tab
// chooser) belong in the dock or the drawer; a modal there just steals focus.
// The one exception is the New-tab chooser in a detached window, which has no
// dock to host it: there the dialog asks nothing, so it is given no
// `onConfirm` and its close is its only action.
//
// Radix supplies the parts that are easy to get wrong: focus is trapped inside
// the content and restored to the trigger on close, Escape and an overlay press
// both close, and the rest of the page is hidden from assistive tech.
//
// The confirm button is `danger` when the action destroys something, which is
// the only signal separating "close this tab" from "save".

import * as RadixDialog from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';
import { Button } from './Button';

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** One line of consequence — what the confirm actually does. */
  description?: string | undefined;
  /** Extra body content (a list of affected tabs, a warning). */
  children?: ReactNode;
  confirmLabel?: string | undefined;
  cancelLabel?: string | undefined;
  /** Absent for a dialog that asks nothing: the close is then its only action. */
  onConfirm?: (() => void) | undefined;
  /** Paints the confirm in the danger intent. */
  destructive?: boolean | undefined;
  'data-testid'?: string | undefined;
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  onConfirm,
  destructive = false,
  'data-testid': testId = 'ui-dialog',
}: DialogProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="ui-dialog-overlay" data-testid={`${testId}-overlay`} />
        <RadixDialog.Content
          className="ui-dialog-content"
          data-testid={testId}
          // Radix warns when neither a Description nor an explicit undefined is
          // given; a confirm often needs only its title.
          {...(description === undefined ? { 'aria-describedby': undefined } : {})}
        >
          <RadixDialog.Title className="ui-dialog-title">{title}</RadixDialog.Title>
          {description !== undefined && (
            <RadixDialog.Description className="ui-dialog-description">
              {description}
            </RadixDialog.Description>
          )}
          {children !== undefined && <div className="ui-dialog-body">{children}</div>}
          <div className="ui-dialog-actions">
            <RadixDialog.Close asChild>
              <Button variant="ghost" data-testid={`${testId}-cancel`}>
                {cancelLabel}
              </Button>
            </RadixDialog.Close>
            {onConfirm !== undefined && (
              <Button
                variant={destructive ? 'danger' : 'primary'}
                onClick={onConfirm}
                data-testid={`${testId}-confirm`}
              >
                {confirmLabel}
              </Button>
            )}
          </div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
