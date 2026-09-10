// ── Kit: Collapsible ──────────────────────────────────────────────────────────
//
// A titled section that opens by animating `grid-template-rows: 0fr → 1fr`, not
// a pixel height: nothing in this file reads a layout box, so a section whose
// content grew while it was closed (a tmux session list, a file tree) still
// opens to exactly its current height instead of the height it had last time.
//
// The Radix content is `forceMount`ed so the row can stay in the grid while
// closed — that is what there is to animate. Closed content is hidden from the
// tab order by `visibility`, flipped only after the collapse finishes (ui.css).
//
// The animating box is `.ui-collapsible-track`, an extra wrapper INSIDE the
// Radix content rather than the content node itself. Radix's layout effect
// measures that node with `transition-duration: 0s` + `animation-name: none`
// pinned on it and restores them only after a getBoundingClientRect() — the
// recalc at which the browser would have started the transition — so a
// transition on the node it owns is swallowed every time. That treatment is
// deliberate (it re-triggers keyframe animations); a transition just needs to
// sit one level down, since neither property is inherited.
//
// Open/closed is per DEVICE, not per account: it is view state, so it lives in
// localStorage under `storageKey` and is never sent to the server. Storage can
// be unavailable (private mode) or hold anything at all, so both the read and
// the write are best-effort and a value that is not '1'/'0' falls back to
// `defaultOpen` rather than throwing on boot.

import * as RadixCollapsible from '@radix-ui/react-collapsible';
import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';

export interface CollapsibleProps {
  /** Section heading, rendered inside the trigger. */
  title: ReactNode;
  children: ReactNode;
  /** localStorage key for the per-device open state; omit to not persist. */
  storageKey?: string | undefined;
  defaultOpen?: boolean | undefined;
  className?: string | undefined;
  'data-testid'?: string | undefined;
}

function readStored(storageKey: string | undefined, fallback: boolean): boolean {
  if (!storageKey) return fallback;
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw === '1') return true;
    if (raw === '0') return false;
    return fallback;
  } catch {
    return fallback;
  }
}

function writeStored(storageKey: string | undefined, open: boolean): void {
  if (!storageKey) return;
  try {
    localStorage.setItem(storageKey, open ? '1' : '0');
  } catch {
    // View state is not worth surfacing an error for.
  }
}

export function Collapsible({
  title,
  children,
  storageKey,
  defaultOpen = true,
  className,
  'data-testid': testId = 'ui-collapsible',
}: CollapsibleProps) {
  const [open, setOpen] = useState(() => readStored(storageKey, defaultOpen));

  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      writeStored(storageKey, next);
    },
    [storageKey],
  );

  return (
    <RadixCollapsible.Root
      open={open}
      onOpenChange={handleOpenChange}
      className={['ui-collapsible', className].filter(Boolean).join(' ')}
      data-testid={testId}
    >
      <RadixCollapsible.Trigger
        className="ui-collapsible-trigger"
        data-testid={`${testId}-trigger`}
      >
        <span className="ui-collapsible-chevron" aria-hidden="true">
          ›
        </span>
        {title}
      </RadixCollapsible.Trigger>
      <RadixCollapsible.Content
        forceMount
        className="ui-collapsible-content"
        data-testid={`${testId}-content`}
      >
        <div className="ui-collapsible-track">
          <div className="ui-collapsible-inner">{children}</div>
        </div>
      </RadixCollapsible.Content>
    </RadixCollapsible.Root>
  );
}
