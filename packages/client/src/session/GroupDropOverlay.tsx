// ── Pane drop overlay ─────────────────────────────────────────────────────────
//
// One per pane, laid over the pane's BODY while a tab drag is live, one of this window's own or one
// from another window (App mounts it only then).
// The pointer's place in the box picks a region, VS Code's rule (editorDropTarget
// `positionOverlay`, horizontal preferred): the left and right thirds are edges, then the top and
// bottom thirds, and what is left is the centre. An edge opens a new pane on that side, the
// centre moves the tab into this pane; a preview paints the half or the whole box the drop would
// claim. A region that would change nothing (a pane's only tab dropped on its own pane) previews
// and accepts nothing.
//
// A drop reports the id the drag carries (`getData`, readable on a drop and not before), because a
// drag from another window has no local id in App to name it. Only tab drags (they carry
// TAB_DND_TYPE) are answered. An OS file drag carries `Files`, and
// must reach the terminal's upload drop untouched, so it is never cancelled here. Nothing
// animates: the overlay floats over the terminal grid.

import { useState } from 'react';
import type { CSSProperties, DragEvent } from 'react';
import { TAB_DND_TYPE } from './SessionTabs';
import { rectCss, type Rect, type Side } from './pane-grid';

type Region = Side | 'centre';

interface GroupDropOverlayProps {
  /** The pane's rect; the overlay covers its body, below the strip. */
  rect: Rect;
  /** An edge drop is meaningful: the dragged tab is not this pane's only tab. */
  canSplit: boolean;
  /** A centre drop is meaningful: the dragged tab is not already in this pane. */
  canCentre: boolean;
  /** Every region is the centre: there is one pane and nothing to split (the New-tab page). */
  centreOnly?: boolean | undefined;
  /** `id` is the tab the drag carries, or null when the drag carries none. */
  onDropEdge: (side: Side, id: string | null) => void;
  onDropCentre: (id: string | null) => void;
}

const isTabDrag = (e: DragEvent): boolean =>
  Array.from(e.dataTransfer.types).includes(TAB_DND_TYPE);

function regionAt(e: DragEvent<HTMLElement>): Region {
  const box = e.currentTarget.getBoundingClientRect();
  const x = e.clientX - box.left;
  const y = e.clientY - box.top;
  if (x < box.width / 3) return 'left';
  if (x > (box.width * 2) / 3) return 'right';
  if (y < box.height / 3) return 'top';
  if (y > (box.height * 2) / 3) return 'bottom';
  return 'centre';
}

// The half (or whole) of the overlay each region claims. Inline because it is geometry, and the
// old per-side preview rules went with the old drop zones.
const PREVIEW: Record<Region, CSSProperties> = {
  left: { left: 0, top: 0, width: '50%', height: '100%' },
  right: { left: '50%', top: 0, width: '50%', height: '100%' },
  top: { left: 0, top: 0, width: '100%', height: '50%' },
  bottom: { left: 0, top: '50%', width: '100%', height: '50%' },
  centre: { left: 0, top: 0, width: '100%', height: '100%' },
};

export const GroupDropOverlay = ({
  rect,
  canSplit,
  canCentre,
  centreOnly,
  onDropEdge,
  onDropCentre,
}: GroupDropOverlayProps) => {
  const [region, setRegion] = useState<Region | null>(null);

  /** The region the pointer is in, or null when a drop there would do nothing. */
  const claim = (e: DragEvent<HTMLElement>): Region | null => {
    const at = centreOnly ? 'centre' : regionAt(e);
    return (at === 'centre' ? canCentre : canSplit) ? at : null;
  };

  // Run on `dragenter` as well as `dragover`. Chromium fires only `dragenter` on the element a drag
  // has just moved onto (the overlay mounting under a still pointer counts), and that answer is the
  // drop operation until the next `dragover`, which a still pointer gets ~352 ms later.
  const accept = (e: DragEvent<HTMLElement>) => {
    if (!isTabDrag(e)) return; // let file drags fall through to upload
    const next = claim(e);
    setRegion(next);
    if (!next) return; // not cancelled: the browser shows "no drop here"
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  return (
    <div
      className="group-drop-overlay"
      data-testid="group-drop-overlay"
      // `--group-strip-h` is 0px where there are no strips, so the body offset is right either way.
      // Inline because the rect is data; the stacking order is the stylesheet's.
      style={{ position: 'absolute', ...rectCss(rect, true) }}
      onDragEnter={accept}
      onDragOver={accept}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setRegion(null);
      }}
      onDrop={(e) => {
        setRegion(null);
        if (!isTabDrag(e)) return;
        const at = claim(e);
        if (!at) return;
        e.preventDefault();
        const id = e.dataTransfer.getData(TAB_DND_TYPE) || null;
        if (at === 'centre') onDropCentre(id);
        else onDropEdge(at, id);
      }}
    >
      {region && (
        <div
          className="group-drop-preview"
          data-testid="group-drop-preview"
          data-region={region}
          aria-hidden="true"
          // The preview must never take the drag from the overlay it paints over.
          style={{ position: 'absolute', pointerEvents: 'none', ...PREVIEW[region] }}
        />
      )}
    </div>
  );
};
