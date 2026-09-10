// One invariant, and it is the one the whole terminal pane is built on:
//
//   "the pane is keyed by SLOT, so a tab switch swaps sessionId in place"
//   (TerminalPane.tsx:286 — its socket effect takes `sessionId` as a dependency
//   for exactly that reason)
//
// It was broken by adding the tab id to the error boundary's React key, so that
// switching tabs would also clear a stuck boundary. The cost was invisible in
// every test and severe in use: every tab switch remounted the pane, threw away
// its xterm instance, and minted a fresh `clientKeyRef` uuid — which the server
// reads as a RIVAL client, evicts the pane, and shows "Opened somewhere else."
// Reported as "on mobile, switching sessions closes my terminal and I have to
// open it again", because a slow link is where the old socket is still attached
// when the new one arrives.
//
// Nothing else catches this. It is not a render error, not a type error, and
// the pane looks correct in a screenshot either way.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { useEffect, useState } from 'react';
import { cleanup, render } from '@testing-library/react';
import type { ComponentProps } from 'react';
import type { SplitState } from './useSplit';

const mounts: string[] = [];
const sessionIds: string[] = [];

vi.mock('../terminal/TerminalPane', () => ({
  TerminalPane: ({ slot, sessionId }: { slot: string; sessionId: string }) => {
    sessionIds.push(sessionId);
    // The useState INITIALISER runs once, at mount, so `mountedAs` is a stable
    // snapshot of what this pane was born as. That makes the effect's dependency
    // honest — one entry per MOUNT — without an exhaustive-deps escape hatch,
    // and an escape hatch in the one test that measures mounts would be the
    // wrong thing to normalise.
    const [mountedAs] = useState(`${slot}:${sessionId}`);
    useEffect(() => {
      mounts.push(mountedAs);
    }, [mountedAs]);
    return <div data-testid={`pane-${slot}`} data-session={sessionId} />;
  },
}));

vi.mock('../panes/PaneHost', () => ({ PaneHost: () => <div data-testid="pane-host" /> }));

const { SplitView } = await import('./SplitView');

type Props = ComponentProps<typeof SplitView>;

const noop = () => {};
const props = (sessionId: string): Props =>
  ({
    pairing: null as SplitState | null,
    sessionId,
    activeKind: 'terminal' as const,
    chooserPage: false,
    showEdgeZones: false,
    showSlotZones: false,
    containerRef: { current: null },
    registry: { register: noop, unregister: noop, focusedApi: () => null } as never,
    settings: {} as never,
    mobileActive: false,
    maxUploadBytes: 1,
    paneBlocked: () => false,
    onAutoCopy: noop,
    onUploadError: noop,
    onFocusRequest: noop,
    takeSpawnTmux: () => undefined,
    terminalGestures: {} as never,
    tabs: [],
    webApps: [],
    quickLinks: [],
    onCreate: noop,
    onUpdateQuickLinks: noop,
    onChangeUrl: noop,
    onPaneDirty: noop,
    onPaneFocus: noop,
    onRatioCommit: noop,
    onEject: noop,
    onDropSplit: noop,
    onDropSlot: noop,
  }) as unknown as Props;

afterEach(() => {
  cleanup();
  mounts.length = 0;
  sessionIds.length = 0;
});

describe('SplitView terminal identity', () => {
  it('swaps sessionId in place instead of remounting the pane', () => {
    const { rerender } = render(<SplitView {...props('0')} />);
    expect(mounts).toEqual(['a:0']);

    rerender(<SplitView {...props('1')} />);
    rerender(<SplitView {...props('2')} />);

    // ONE mount across three sessions. A second entry here means the pane was
    // torn down and rebuilt — a new xterm, a new clientKey, and an eviction.
    expect(mounts).toEqual(['a:0']);
    // …and it did see every session, so the swap really happened.
    expect(sessionIds.at(-1)).toBe('2');
  });

  it('survives switching back to a session it already showed', () => {
    const { rerender } = render(<SplitView {...props('0')} />);
    rerender(<SplitView {...props('1')} />);
    rerender(<SplitView {...props('0')} />);
    expect(mounts).toEqual(['a:0']);
  });
});
