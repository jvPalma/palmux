// ── Transient toast ───────────────────────────────────────────────────────────
//
// Owns its own message state and exposes an imperative `show(msg)` handle, so
// firing a toast (copy-on-select, upload errors, refusals) re-renders ONLY this
// leaf — not the whole App tree. React 18: `forwardRef` is the right tool here
// (there is no `ref`-as-prop yet).
//
// A toast may carry ONE action, and that changes how long it lives. 1.4s is a
// confirmation ("Copied") — long enough to register, short enough to ignore. A
// message the user is meant to ACT on cannot use it: nobody reads a sentence and
// reaches a button in 1.4 seconds, so an action holds the toast for 6s. The
// dictation failure is the case this exists for — the recording survives, but
// only if the user is told where it went before the message disappears.

import { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { Button } from './ui';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastHandle {
  show: (message: string, action?: ToastAction) => void;
}

const TOAST_MS = 1400;
const TOAST_ACTION_MS = 6000;

export const Toast = forwardRef<ToastHandle>(function Toast(_props, ref) {
  const [message, setMessage] = useState('');
  const [action, setAction] = useState<ToastAction | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const dismiss = () => {
    setMessage('');
    setAction(null);
  };

  useImperativeHandle(
    ref,
    () => ({
      show: (msg: string, next?: ToastAction) => {
        setMessage(msg);
        setAction(next ?? null);
        clearTimeout(timer.current);
        timer.current = window.setTimeout(dismiss, next ? TOAST_ACTION_MS : TOAST_MS);
      },
    }),
    [],
  );

  return (
    <div className={`toast${message ? ' show' : ''}`}>
      {message}
      {action && (
        <Button
          size="sm"
          variant="ghost"
          className="toast-action"
          data-testid="toast-action"
          onClick={() => {
            // Dismiss first: the action navigates, and a toast left hanging over
            // the thing it just opened is the same obstruction it was avoiding.
            clearTimeout(timer.current);
            dismiss();
            action.onClick();
          }}
        >
          {action.label}
        </Button>
      )}
    </div>
  );
});
