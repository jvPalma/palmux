// Two invariants protect live state, and this file holds both:
//
//   1. "the pane is keyed by PANE, so a tab switch swaps sessionId in place"
//      (TerminalPane's socket effect takes `sessionId` as a dependency for exactly that reason).
//      A key that carried the tab id remounted the pane on every switch, which threw away its xterm
//      and minted a fresh `clientKeyRef` uuid: the server reads that as a RIVAL client, evicts the
//      pane, and shows "Opened somewhere else." It surfaces on a slow link, and nothing else catches
//      it: not a render error, not a type error, and the pane looks right in a screenshot.
//
//   2. No pane is ever reparented. The layout is a tree, but it is drawn flat: every strip, terminal,
//      the PaneHost, every overlay and every sash is a direct child of one root. An iframe reloads
//      when its DOM parent changes, so the test holds the iframe's own element across a split.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { useEffect, useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import type { TabKind, TabMeta } from '@palmux/shared';
import {
  activate,
  focusLeaf,
  layoutRects,
  moveTab,
  removeLeaf,
  singleLeaf,
  splitPane,
  type PaneLayout,
  type TabRef,
} from './pane-grid';

const mounts: string[] = [];
const sessionIds: string[] = [];
const seen = new Map<string, { focused: boolean; inSplit: boolean; resizePaused: boolean }>();

vi.mock('../terminal/TerminalPane', () => ({
  TerminalPane: ({
    slot,
    sessionId,
    focused,
    inSplit,
    resizePaused,
    style,
  }: {
    slot: string;
    sessionId: string;
    focused: boolean;
    inSplit: boolean;
    resizePaused?: boolean;
    style?: { top?: string; height?: string };
  }) => {
    sessionIds.push(sessionId);
    seen.set(slot, { focused, inSplit, resizePaused: !!resizePaused });
    // The useState INITIALISER runs once, at mount, so `mountedAs` is a stable snapshot of what this
    // pane was born as. That makes the effect's dependency honest (one entry per MOUNT) without an
    // exhaustive-deps escape hatch, and an escape hatch in the one test that measures mounts would
    // be the wrong thing to normalise.
    const [mountedAs] = useState(`${slot}:${sessionId}`);
    useEffect(() => {
      mounts.push(mountedAs);
    }, [mountedAs]);
    return (
      <div
        data-testid={`pane-${slot}`}
        data-session={sessionId}
        data-top={style?.top}
        data-height={style?.height}
      />
    );
  },
}));

// The iframe stand-in. PaneHost is real, so what the test holds is the node PaneHost keeps mounted.
vi.mock('../panes/WebPane', () => ({ WebPane: () => <div data-testid="web-node" /> }));

const { GroupsView } = await import('./GroupsView');

type Props = ComponentProps<typeof GroupsView>;

const noop = () => {};
const meta = (id: string, kind: TabKind = 'terminal'): TabMeta => ({ id, kind });
const ref = (id: string, kind: TabKind = 'terminal'): TabRef => ({ id, kind });
const ORDER = ['0', '1', '2', '3'];

const refit = vi.fn();
const registry = {
  register: noop,
  unregister: noop,
  focusedApi: () => null,
  forEachApi: (fn: (api: { refit: () => void }, slot: string) => void) => fn({ refit }, 'p0'),
};

const contentArea = document.createElement('div');
contentArea.getBoundingClientRect = () =>
  ({ left: 0, top: 0, width: 1000, height: 800 }) as DOMRect;

const props = (layout: PaneLayout | null, tabs: TabMeta[], over: Partial<Props> = {}): Props => {
  const geometry = layout ? layoutRects(layout) : { panes: new Map(), sashes: [] };
  return {
    layout,
    rects: geometry.panes,
    sashes: geometry.sashes,
    strips: true,
    chooserPage: false,
    dragTabId: null,
    renderStrip: (leaf) => <div data-testid={`strip-${leaf.id}`}>{leaf.tabs.length}</div>,
    onFocusLeaf: noop,
    onDropEdge: noop,
    onDropCentre: noop,
    onSashDrag: noop,
    onSashSettle: noop,
    containerRef: { current: contentArea },
    registry: registry as never,
    settings: {} as never,
    mobileActive: false,
    maxUploadBytes: 1,
    paneBlocked: () => false,
    onAutoCopy: noop,
    onTransferError: noop,
    onFocusRequest: noop,
    takeSpawnTmux: () => undefined,
    terminalGestures: {} as never,
    tabs,
    webApps: [],
    quickLinks: [],
    onCreate: noop,
    onUpdateQuickLinks: noop,
    onChangeUrl: noop,
    onPaneDirty: noop,
    onPaneFocus: noop,
    ...over,
  } as Props;
};

const terminals = [meta('0'), meta('1'), meta('2'), meta('3')];
const fourTerminals = () =>
  singleLeaf(
    terminals.map((t) => ref(t.id)),
    '0',
  );

const root = (container: HTMLElement) => container.querySelector<HTMLElement>('.groups-view')!;
const mountsOf = (slot: string) => mounts.filter((m) => m.startsWith(`${slot}:`));

afterEach(() => {
  cleanup();
  mounts.length = 0;
  sessionIds.length = 0;
  seen.clear();
  refit.mockClear();
  vi.unstubAllGlobals();
});

describe('GroupsView terminal identity', () => {
  // Scenario: Switching tabs inside a pane
  it('swaps sessionId in place instead of remounting the pane', () => {
    let layout = fourTerminals();
    const { rerender } = render(<GroupsView {...props(layout, terminals)} />);
    expect(mounts).toEqual(['p0:0']);
    const node = screen.getByTestId('pane-p0');

    layout = activate(layout, 'p0', '1');
    rerender(<GroupsView {...props(layout, terminals)} />);
    layout = activate(layout, 'p0', '2');
    rerender(<GroupsView {...props(layout, terminals)} />);

    // ONE mount across three tabs. A second entry here means the pane was torn down and rebuilt: a
    // new xterm, a new clientKey, and an eviction.
    expect(mounts).toEqual(['p0:0']);
    // …it did see every session, so the swap really happened, on the same element.
    expect(sessionIds.at(-1)).toBe('2');
    expect(screen.getByTestId('pane-p0')).toBe(node);
  });

  it('survives switching back to a tab it already showed', () => {
    let layout = fourTerminals();
    const { rerender } = render(<GroupsView {...props(layout, terminals)} />);
    layout = activate(layout, 'p0', '1');
    rerender(<GroupsView {...props(layout, terminals)} />);
    layout = activate(layout, 'p0', '0');
    rerender(<GroupsView {...props(layout, terminals)} />);
    expect(mounts).toEqual(['p0:0']);
  });

  it('does not remount a pane when a split opens beside it, a merge closes it, or another tab moves', () => {
    let layout = fourTerminals();
    const { rerender } = render(<GroupsView {...props(layout, terminals)} />);
    const node = screen.getByTestId('pane-p0');

    // a split beside it: tab 1 opens pane p1 to the right
    layout = splitPane(layout, 'p0', 'right', ref('1'), ORDER);
    rerender(<GroupsView {...props(layout, terminals)} />);
    expect(mounts).toEqual(['p0:0', 'p1:1']);

    // a move of another tab: tab 2 goes to p1
    layout = moveTab(layout, '2', 'p1', ORDER);
    rerender(<GroupsView {...props(layout, terminals)} />);

    // a merge: p1's last tabs leave and the pane goes (p0 takes the space)
    layout = moveTab(layout, '2', 'p0', ORDER);
    layout = moveTab(layout, '1', 'p0', ORDER);
    rerender(<GroupsView {...props(layout, terminals)} />);
    expect(screen.queryByTestId('pane-p1')).toBeNull();

    // and a second split, then a removal of that pane outright
    layout = splitPane(layout, 'p0', 'bottom', ref('3'), ORDER);
    rerender(<GroupsView {...props(layout, terminals)} />);
    layout = removeLeaf(layout, 'p2');
    rerender(<GroupsView {...props(layout, terminals)} />);

    expect(mountsOf('p0')).toHaveLength(1);
    expect(screen.getByTestId('pane-p0')).toBe(node);
  });

  it('gives a pane that stays on screen the same element when it moves in the tree', () => {
    // p0 starts alone, then a split puts a NEW pane before it: p0 changes position in the root's
    // children, and must still be the same element (React moves it, it is not rebuilt).
    let layout = fourTerminals();
    const { rerender } = render(<GroupsView {...props(layout, terminals)} />);
    const node = screen.getByTestId('pane-p0');
    layout = splitPane(layout, 'p0', 'left', ref('1'), ORDER);
    rerender(<GroupsView {...props(layout, terminals)} />);
    expect(mountsOf('p0')).toHaveLength(1);
    expect(screen.getByTestId('pane-p0')).toBe(node);
  });
});

describe('GroupsView next to an iframe', () => {
  const tabs = [meta('0'), meta('1', 'web'), meta('2')];

  // Scenario: Splitting next to an iframe
  it('keeps the web pane element across a split beside it, a move and a merge', () => {
    let layout = singleLeaf(
      tabs.map((t) => ref(t.id, t.kind)),
      '1',
    );
    const { rerender } = render(<GroupsView {...props(layout, tabs)} />);
    const web = screen.getByTestId('web-node');
    const host = web.closest('.pane-host');

    layout = splitPane(layout, 'p0', 'right', ref('2'), ['0', '1', '2']);
    rerender(<GroupsView {...props(layout, tabs)} />);
    expect(screen.getByTestId('web-node')).toBe(web);
    expect(web.closest('.pane-host')).toBe(host);

    layout = moveTab(layout, '0', 'p1', ['0', '1', '2']);
    rerender(<GroupsView {...props(layout, tabs)} />);
    expect(screen.getByTestId('web-node')).toBe(web);

    layout = moveTab(layout, '0', 'p0', ['0', '1', '2']);
    layout = moveTab(layout, '2', 'p0', ['0', '1', '2']);
    rerender(<GroupsView {...props(layout, tabs)} />);
    expect(screen.getByTestId('web-node')).toBe(web);
  });

  it('hands PaneHost the whole pane rect of the leaf showing the web tab', () => {
    const layout = splitPane(
      singleLeaf(
        tabs.map((t) => ref(t.id, t.kind)),
        '1',
      ),
      'p0',
      'right',
      ref('2'),
      ['0', '1', '2'],
    );
    render(<GroupsView {...props(layout, tabs)} />);
    // p0 holds 0 and 1 and shows the web tab, in the left half; p1 holds terminal 2.
    const pane = screen.getByTestId('web-node').closest<HTMLElement>('.pane')!;
    expect(pane.className).not.toContain('hidden');
    expect(pane.style.left).toBe('0%');
    expect(pane.style.width).toBe('50%');
    expect(screen.getByTestId('pane-p1')).toBeTruthy();
  });

  it('draws no terminal for a pane showing a web tab, and hides a web tab no pane shows', () => {
    const layout = singleLeaf(
      tabs.map((t) => ref(t.id, t.kind)),
      '0',
    );
    render(<GroupsView {...props(layout, tabs)} />);
    expect(screen.getByTestId('pane-p0')).toBeTruthy();
    expect(screen.getByTestId('web-node').closest('.pane')!.className).toContain('hidden');
  });
});

describe('GroupsView structure', () => {
  const tabs = [meta('0'), meta('1', 'web'), meta('2')];
  const twoPanes = () =>
    splitPane(
      singleLeaf(
        tabs.map((t) => ref(t.id, t.kind)),
        '0',
      ),
      'p0',
      'right',
      ref('1', 'web'),
      ['0', '1', '2'],
    );

  it('renders nothing for a null layout (nothing mounts before the first broadcast)', () => {
    const { container } = render(<GroupsView {...props(null, tabs)} />);
    expect(container.firstChild).toBeNull();
    expect(mounts).toEqual([]);
  });

  it('draws every strip, body, overlay and sash as a direct child of the one root', () => {
    const layout = twoPanes();
    const { container } = render(<GroupsView {...props(layout, tabs, { dragTabId: '2' })} />);
    const view = root(container);
    expect(container.querySelectorAll('.groups-view')).toHaveLength(1);
    const direct = (el: Element | null) => expect(el?.parentElement).toBe(view);

    const strips = view.querySelectorAll('.group-strip');
    expect(strips).toHaveLength(2);
    strips.forEach(direct);
    direct(screen.getByTestId('pane-p0')); // the terminal pane
    direct(view.querySelector('.pane-host')); // every non-terminal pane lives in this one host
    view.querySelectorAll('.group-drop-overlay').forEach(direct);
    expect(view.querySelectorAll('.group-drop-overlay')).toHaveLength(2);
    view.querySelectorAll('.group-sash').forEach(direct);
    expect(view.querySelectorAll('.group-sash')).toHaveLength(1);
    // and the web pane sits in the host, not in a per-pane wrapper
    expect(screen.getByTestId('web-node').closest('.pane')!.parentElement).toBe(
      view.querySelector('.pane-host'),
    );
  });

  it('tags each strip with its pane id', () => {
    const { container } = render(<GroupsView {...props(twoPanes(), tabs)} />);
    expect(
      [...container.querySelectorAll('.group-strip')].map((s) => s.getAttribute('data-pane-id')),
    ).toEqual(['p0', 'p1']);
  });

  it('puts group-strip-focused on the focused pane strip only, and moves it with focus', () => {
    let layout = twoPanes(); // splitPane focuses the new pane
    const { container, rerender } = render(<GroupsView {...props(layout, tabs)} />);
    const focused = () =>
      [...container.querySelectorAll('.group-strip-focused')].map((s) =>
        s.getAttribute('data-pane-id'),
      );
    expect(focused()).toEqual(['p1']);
    layout = focusLeaf(layout, 'p0');
    rerender(<GroupsView {...props(layout, tabs)} />);
    expect(focused()).toEqual(['p0']);
    expect(container.querySelectorAll('.group-strip')).toHaveLength(2);
  });

  it('hands each strip its pane and rect, inside the strip box', () => {
    const renderStrip = vi.fn((leaf: { id: string }) => <i data-testid={`s-${leaf.id}`} />);
    render(<GroupsView {...props(twoPanes(), tabs, { renderStrip })} />);
    expect(renderStrip).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'p1' }),
      expect.objectContaining({ left: 50, width: 50 }),
    );
    expect(screen.getByTestId('s-p1').parentElement).toBe(screen.getByTestId('group-strip-p1'));
  });

  it('focuses a pane on a pointerdown anywhere in its strip, before the strip acts on it', () => {
    const onFocusLeaf = vi.fn();
    render(<GroupsView {...props(twoPanes(), tabs, { onFocusLeaf })} />);
    fireEvent.pointerDown(screen.getByTestId('strip-p0'));
    expect(onFocusLeaf).toHaveBeenCalledWith('p0');
  });

  it('does not focus a pane on a middle or right press in its strip', () => {
    const onFocusLeaf = vi.fn();
    render(<GroupsView {...props(twoPanes(), tabs, { onFocusLeaf })} />);
    const strip = screen.getByTestId('strip-p0');
    fireEvent.pointerDown(strip, { button: 1 }); // middle: closes a tab
    fireEvent.pointerDown(strip, { button: 2 }); // right: opens the tab menu
    expect(onFocusLeaf).not.toHaveBeenCalled();
    fireEvent.pointerDown(strip, { button: 0 });
    expect(onFocusLeaf.mock.calls).toEqual([['p0']]);
  });

  it('tells each terminal whether it is focused and whether a split is on screen', () => {
    const layout = splitPane(fourTerminals(), 'p0', 'right', ref('1'), ORDER);
    render(<GroupsView {...props(layout, terminals)} />);
    expect(seen.get('p0')).toMatchObject({ focused: false, inSplit: true });
    expect(seen.get('p1')).toMatchObject({ focused: true, inSplit: true });
    cleanup();
    seen.clear();
    render(<GroupsView {...props(fourTerminals(), terminals)} />);
    expect(seen.get('p0')).toMatchObject({ focused: true, inSplit: false });
  });

  it('offsets a terminal body by the strip height token', () => {
    const { container } = render(<GroupsView {...props(fourTerminals(), terminals)} />);
    const pane = screen.getByTestId('pane-p0');
    expect(pane.getAttribute('data-top')).toBe('calc(0% + var(--group-strip-h))');
    expect(pane.getAttribute('data-height')).toBe('calc(100% - var(--group-strip-h))');
    // the token is the content area's, not set here
    expect(root(container).style.getPropertyValue('--group-strip-h')).toBe('');
  });
});

describe('GroupsView without strips', () => {
  it('draws no strip, zeroes the strip token, and puts the body at the pane rect', () => {
    const { container } = render(
      <GroupsView {...props(fourTerminals(), terminals, { strips: false })} />,
    );
    expect(container.querySelector('.group-strip')).toBeNull();
    expect(root(container).style.getPropertyValue('--group-strip-h')).toBe('0px');
    const pane = screen.getByTestId('pane-p0');
    expect(pane.getAttribute('data-top')).toBe('0%');
    expect(pane.getAttribute('data-height')).toBe('100%');
    // the terminal is still drawn
    expect(mounts).toEqual(['p0:0']);
  });
});

describe('GroupsView chooser page', () => {
  it('renders the one strip and no body', () => {
    const layout = singleLeaf([], null);
    const { container } = render(
      <GroupsView {...props(layout, [], { chooserPage: true, dragTabId: '9' })} />,
    );
    expect(container.querySelectorAll('.group-strip')).toHaveLength(1);
    expect(screen.getByTestId('strip-p0')).toBeTruthy();
    expect(container.querySelector('.pane-host')).toBeNull();
    expect(container.querySelector('[data-testid^="pane-"]')).toBeNull();
    expect(container.querySelector('.group-drop-overlay')).toBeNull();
    expect(container.querySelector('.group-sash')).toBeNull();
    expect(mounts).toEqual([]);
  });

  it('mounts no terminal even when the layout still names one (a pane would respawn the id)', () => {
    render(<GroupsView {...props(fourTerminals(), terminals, { chooserPage: true })} />);
    expect(screen.queryByTestId('pane-p0')).toBeNull();
    expect(mounts).toEqual([]);
    // and without strips there is nothing at all
    cleanup();
    const { container } = render(
      <GroupsView {...props(fourTerminals(), terminals, { chooserPage: true, strips: false })} />,
    );
    expect(root(container).children).toHaveLength(0);
  });

  it('draws only the focused strip when several panes are still in the layout', () => {
    const layout = splitPane(fourTerminals(), 'p0', 'right', ref('1'), ORDER);
    const { container } = render(
      <GroupsView {...props(layout, terminals, { chooserPage: true })} />,
    );
    expect(
      [...container.querySelectorAll('.group-strip')].map((s) => s.getAttribute('data-pane-id')),
    ).toEqual(['p1']);
  });
});

const dragOver = (el: HTMLElement, x: number, y: number) => {
  const ev = new Event('dragover', { bubbles: true, cancelable: true });
  Object.defineProperties(ev, {
    clientX: { value: x },
    clientY: { value: y },
    dataTransfer: { value: { types: ['application/x-palmux-tab'], dropEffect: '' } },
  });
  fireEvent(el, ev);
};

describe('GroupsView drag overlays', () => {
  it('mounts an overlay per pane only while a tab is dragged', () => {
    const layout = splitPane(fourTerminals(), 'p0', 'right', ref('1'), ORDER);
    const { container, rerender } = render(<GroupsView {...props(layout, terminals)} />);
    expect(container.querySelector('.group-drop-overlay')).toBeNull();
    rerender(<GroupsView {...props(layout, terminals, { dragTabId: '2' })} />);
    expect(container.querySelectorAll('.group-drop-overlay')).toHaveLength(2);
    rerender(<GroupsView {...props(layout, terminals, { dragTabId: null })} />);
    expect(container.querySelector('.group-drop-overlay')).toBeNull();
  });

  it('refuses the centre where the tab already is, and the edges for a lone tab', () => {
    // p0 holds 0, 2, 3 and p1 holds only 1.
    const layout = splitPane(fourTerminals(), 'p0', 'right', ref('1'), ORDER);
    const onDropEdge = vi.fn();
    const onDropCentre = vi.fn();
    const { container } = render(
      <GroupsView {...props(layout, terminals, { dragTabId: '1', onDropEdge, onDropCentre })} />,
    );
    const [first, second] = [...container.querySelectorAll<HTMLElement>('.group-drop-overlay')];
    for (const el of [first!, second!]) {
      el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 300 }) as DOMRect;
    }
    // p0 does not hold the dragged tab: edge and centre both live
    dragOver(first!, 250, 150);
    expect(first!.querySelector('[data-region="right"]')).not.toBeNull();
    dragOver(first!, 150, 150);
    expect(first!.querySelector('[data-region="centre"]')).not.toBeNull();
    // p1 holds only the dragged tab: nothing at all
    dragOver(second!, 250, 150);
    dragOver(second!, 150, 150);
    expect(second!.querySelector('.group-drop-preview')).toBeNull();
  });

  it('reports a drop with the pane it landed on', () => {
    const layout = splitPane(fourTerminals(), 'p0', 'right', ref('1'), ORDER);
    const onDropEdge = vi.fn();
    const onDropCentre = vi.fn();
    const { container } = render(
      <GroupsView {...props(layout, terminals, { dragTabId: '2', onDropEdge, onDropCentre })} />,
    );
    const second = container.querySelectorAll<HTMLElement>('.group-drop-overlay')[1]!;
    second.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 300 }) as DOMRect;
    const drop = (x: number, y: number) => {
      const ev = new Event('drop', { bubbles: true, cancelable: true });
      Object.defineProperties(ev, {
        clientX: { value: x },
        clientY: { value: y },
        dataTransfer: {
          value: { types: ['application/x-palmux-tab'], getData: () => '2' },
        },
      });
      fireEvent(second, ev);
    };
    drop(250, 150);
    drop(150, 150);
    // The id the drag carries rides along: a drag from another window has no local one.
    expect(onDropEdge).toHaveBeenCalledWith('p1', 'right', '2');
    expect(onDropCentre).toHaveBeenCalledWith('p1', '2');
  });
});

// A tab dragged in from ANOTHER window: App has no local drag to report (`dragTabId` is null) and
// says so with `externalDrag`. The tab is in none of this window's panes, so a drop can never be a
// no-op and every pane takes the centre and every edge.
describe('GroupsView drag overlays for a tab from another window', () => {
  const twoPanes = () => splitPane(fourTerminals(), 'p0', 'right', ref('1'), ORDER);

  it('mounts an overlay per pane while externalDrag is set, and none otherwise', () => {
    const layout = twoPanes();
    const { container, rerender } = render(<GroupsView {...props(layout, terminals)} />);
    expect(container.querySelector('.group-drop-overlay')).toBeNull();
    rerender(<GroupsView {...props(layout, terminals, { externalDrag: true })} />);
    expect(container.querySelectorAll('.group-drop-overlay')).toHaveLength(2);
    rerender(<GroupsView {...props(layout, terminals, { externalDrag: false })} />);
    expect(container.querySelector('.group-drop-overlay')).toBeNull();
  });

  it('takes the centre and the edges on every pane, a pane holding one tab included', () => {
    // p0 holds 0, 2, 3 and p1 holds only 1: a LOCAL drag of 1 would be refused on p1 entirely.
    const { container } = render(
      <GroupsView {...props(twoPanes(), terminals, { externalDrag: true })} />,
    );
    const overlays = container.querySelectorAll<HTMLElement>('.group-drop-overlay');
    expect(overlays).toHaveLength(2);
    for (const el of overlays) {
      el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 300 }) as DOMRect;
      dragOver(el, 250, 150);
      expect(el.querySelector('[data-region="right"]')).not.toBeNull();
      dragOver(el, 150, 150);
      expect(el.querySelector('[data-region="centre"]')).not.toBeNull();
    }
  });

  it('reports the id it carries with the pane and the side', () => {
    const onDropEdge = vi.fn();
    const onDropCentre = vi.fn();
    const { container } = render(
      <GroupsView
        {...props(twoPanes(), terminals, { externalDrag: true, onDropEdge, onDropCentre })}
      />,
    );
    const first = container.querySelectorAll<HTMLElement>('.group-drop-overlay')[0]!;
    first.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 300 }) as DOMRect;
    const drop = (x: number, y: number) => {
      const ev = new Event('drop', { bubbles: true, cancelable: true });
      Object.defineProperties(ev, {
        clientX: { value: x },
        clientY: { value: y },
        dataTransfer: { value: { types: ['application/x-palmux-tab'], getData: () => '9' } },
      });
      fireEvent(first, ev);
    };
    drop(150, 280);
    drop(150, 150);
    expect(onDropEdge).toHaveBeenCalledWith('p0', 'bottom', '9');
    expect(onDropCentre).toHaveBeenCalledWith('p0', '9');
  });

  it('mounts none on the New-tab page', () => {
    const { container } = render(
      <GroupsView {...props(twoPanes(), terminals, { chooserPage: true, externalDrag: true })} />,
    );
    expect(container.querySelector('.group-drop-overlay')).toBeNull();
  });
});

describe('GroupsView sashes', () => {
  let frames: Array<() => void> = [];
  const runFrames = () => {
    const queued = frames;
    frames = [];
    queued.forEach((run) => run());
  };
  const stubFrames = () => {
    frames = [];
    vi.stubGlobal('requestAnimationFrame', (run: () => void) => frames.push(run));
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      frames[id - 1] = () => {};
    });
    Element.prototype.setPointerCapture = vi.fn();
    Element.prototype.releasePointerCapture = vi.fn();
  };
  const twoColumns = () => splitPane(fourTerminals(), 'p0', 'right', ref('1'), ORDER);

  it('draws one sash per boundary and keys it by its place in the tree', () => {
    const layout = splitPane(twoColumns(), 'p1', 'right', ref('2'), ORDER);
    const { container } = render(<GroupsView {...props(layout, terminals)} />);
    expect(container.querySelectorAll('.group-sash')).toHaveLength(2);
  });

  it('reports a drag against its own sash and branch, then settles once and refits every pane', () => {
    stubFrames();
    const onSashDrag = vi.fn();
    const onSashSettle = vi.fn();
    const layout = twoColumns();
    const { container } = render(
      <GroupsView {...props(layout, terminals, { onSashDrag, onSashSettle })} />,
    );
    const sash = screen.getByTestId('group-sash');
    fireEvent.pointerDown(sash, { pointerId: 1, clientX: 500, clientY: 100 });
    expect(contentArea.getAttribute('data-sash-drag')).toBe('true');
    fireEvent.pointerMove(sash, { pointerId: 1, clientX: 600, clientY: 100 });
    act(runFrames);
    // 100px of a 1000px-wide branch that spans the whole content area
    expect(onSashDrag).toHaveBeenLastCalledWith(layoutRects(layout).sashes[0], 0.1);
    fireEvent.pointerUp(sash, { pointerId: 1, clientX: 600, clientY: 100 });
    expect(onSashSettle).toHaveBeenCalledTimes(1);
    expect(contentArea.hasAttribute('data-sash-drag')).toBe(false);
    // the refit waits a frame, so the new rects are laid out first
    expect(refit).not.toHaveBeenCalled();
    act(runFrames);
    expect(refit).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.group-sash')).toBeTruthy();
  });

  it('holds every terminal resize while a sash is dragged and releases it after', () => {
    stubFrames();
    render(<GroupsView {...props(twoColumns(), terminals)} />);
    expect(seen.get('p0')?.resizePaused).toBe(false);
    const sash = screen.getByTestId('group-sash');
    fireEvent.pointerDown(sash, { pointerId: 1, clientX: 500, clientY: 100 });
    expect(seen.get('p0')?.resizePaused).toBe(true);
    expect(seen.get('p1')?.resizePaused).toBe(true);
    fireEvent.pointerMove(sash, { pointerId: 1, clientX: 560, clientY: 100 });
    fireEvent.pointerUp(sash, { pointerId: 1, clientX: 560, clientY: 100 });
    expect(seen.get('p0')?.resizePaused).toBe(false);
    expect(seen.get('p1')?.resizePaused).toBe(false);
  });

  it('reports the drag state to its caller, true on pointerdown and false on release', () => {
    stubFrames();
    const onSashDragging = vi.fn();
    render(<GroupsView {...props(twoColumns(), terminals, { onSashDragging })} />);
    const sash = screen.getByTestId('group-sash');
    fireEvent.pointerDown(sash, { pointerId: 1, clientX: 500, clientY: 100 });
    expect(onSashDragging.mock.calls).toEqual([[true]]);
    fireEvent.pointerMove(sash, { pointerId: 1, clientX: 560, clientY: 100 });
    fireEvent.pointerUp(sash, { pointerId: 1, clientX: 560, clientY: 100 });
    expect(onSashDragging.mock.calls).toEqual([[true], [false]]);
  });

  it('reports the drag over, settles it and releases the resize when its sash unmounts mid-drag', () => {
    stubFrames();
    const onSashDragging = vi.fn();
    const onSashSettle = vi.fn();
    const { container, rerender } = render(
      <GroupsView {...props(twoColumns(), terminals, { onSashDragging, onSashSettle })} />,
    );
    const sash = screen.getByTestId('group-sash');
    fireEvent.pointerDown(sash, { pointerId: 1, clientX: 500, clientY: 100 });
    fireEvent.pointerMove(sash, { pointerId: 1, clientX: 560, clientY: 100 });
    expect(seen.get('p0')?.resizePaused).toBe(true);
    // another window's broadcast merges the panes: the sash being dragged is gone
    rerender(
      <GroupsView {...props(fourTerminals(), terminals, { onSashDragging, onSashSettle })} />,
    );
    expect(container.querySelector('.group-sash')).toBeNull();
    expect(onSashDragging.mock.calls).toEqual([[true], [false]]);
    expect(onSashSettle).toHaveBeenCalledTimes(1);
    expect(seen.get('p0')?.resizePaused).toBe(false);
    expect(contentArea.hasAttribute('data-sash-drag')).toBe(false);
  });

  it('ends a drag whose sash the same commit removed through the callbacks of THAT render', () => {
    stubFrames();
    const oldSettle = vi.fn();
    const oldDragging = vi.fn();
    const newSettle = vi.fn();
    const newDragging = vi.fn();
    const newRefit = vi.fn();
    const newRegistry = {
      ...registry,
      forEachApi: (fn: (api: { refit: () => void }, slot: string) => void) =>
        fn({ refit: newRefit }, 'p0'),
    };
    const { rerender } = render(
      <GroupsView
        {...props(twoColumns(), terminals, {
          onSashSettle: oldSettle,
          onSashDragging: oldDragging,
        })}
      />,
    );
    const sash = screen.getByTestId('group-sash');
    fireEvent.pointerDown(sash, { pointerId: 1, clientX: 500, clientY: 100 });
    fireEvent.pointerMove(sash, { pointerId: 1, clientX: 560, clientY: 100 });
    // ONE rerender hands over new callbacks (the caller re-rendered with the broadcast's state) AND
    // drops the dragged sash (that broadcast merged the panes).
    rerender(
      <GroupsView
        {...props(fourTerminals(), terminals, {
          onSashSettle: newSettle,
          onSashDragging: newDragging,
          registry: newRegistry as never,
        })}
      />,
    );
    expect(newSettle).toHaveBeenCalledTimes(1);
    expect(newDragging.mock.calls).toEqual([[false]]);
    // the closures of the render before would commit a layout the caller has already replaced
    expect(oldSettle).not.toHaveBeenCalled();
    expect(oldDragging.mock.calls).toEqual([[true]]);
    act(runFrames);
    expect(newRefit).toHaveBeenCalledTimes(1);
    expect(refit).not.toHaveBeenCalled();
  });

  it('holds the resize while the dock is busy, with no sash involved', () => {
    render(<GroupsView {...props(fourTerminals(), terminals, { resizeBusy: true })} />);
    expect(seen.get('p0')?.resizePaused).toBe(true);
  });
});
