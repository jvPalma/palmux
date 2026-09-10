// ── Bulk tab close ────────────────────────────────────────────────────────────
//
// One confirmation shape for every close that takes more than one tab: the
// group's "Close all" and the strip's "Close others" / "Close to the right".
//
// It is kind-aware on purpose. A bulk close is the only action in the app that
// can destroy work the user cannot get back, and the two kinds that can are not
// interchangeable: a terminal is a running process, an editor is unsaved text.
// A generic "close 7 tabs?" tells the user the count and hides the cost.
//
// Pure, so the wording is testable without a DOM or a socket.

import type { TabMeta } from '@palmux/shared';

export interface DirtyMap {
  [id: string]: boolean;
}

/**
 * The confirm text for closing `tabs`, or null when there is nothing to close.
 * `headline` is the caller's first line — the rest is what it costs.
 */
export function closeManyMessage(
  tabs: TabMeta[],
  dirty: DirtyMap,
  headline: string,
): string | null {
  if (tabs.length === 0) return null;
  const terms = tabs.filter((t) => t.kind === 'terminal').length;
  const dirtyEditors = tabs.filter((t) => t.kind === 'editor' && dirty[t.id]).length;
  const lines = [headline];
  if (terms > 0) lines.push(`${terms} terminal${terms > 1 ? 's' : ''} will be killed.`);
  if (dirtyEditors > 0) {
    lines.push(
      `${dirtyEditors} editor tab${dirtyEditors > 1 ? 's' : ''} with unsaved changes will be discarded.`,
    );
  }
  return lines.join('\n');
}

/**
 * Every tab except `keepId`, in strip order.
 *
 * Order matters to the caller: closing left-to-right means each close navigates
 * to a neighbour that is itself about to close, so App kills them all in one
 * pass rather than one at a time.
 */
export function tabsExcept(tabs: TabMeta[], keepId: string): TabMeta[] {
  return tabs.filter((t) => t.id !== keepId);
}

/**
 * Every tab AFTER `fromId` in strip order. Empty when `fromId` is last or is not
 * in the list — an unknown id closes nothing, rather than closing everything.
 */
export function tabsToTheRight(tabs: TabMeta[], fromId: string): TabMeta[] {
  const i = tabs.findIndex((t) => t.id === fromId);
  return i === -1 ? [] : tabs.slice(i + 1);
}
