// ── Split drop zones ──────────────────────────────────────────────────────────
//
// Shown over the content area while a strip tab is being dragged (desktop).
// Dropping a tab on an edge opens a split with that tab in that position. Only
// tab drags light up (they carry TAB_DND_TYPE) — OS file drags carry `Files`
// and must keep hitting the terminal's upload path, never these zones. While a
// zone is hovered, a single overlay previews the claimed half of the content
// area (replaces the old per-zone :hover tint — the zones themselves stay
// invisible hit areas).

import { useState } from 'react';
import { TAB_DND_TYPE } from './SessionTabs';
import type { Orientation } from './useSplit';

type Side = 'left' | 'right' | 'top' | 'bottom';

interface SplitDropZonesProps {
  /** Drop `tabId` on an edge → open a split; side gives position + orientation. */
  onDropSplit: (tabId: string, side: Side) => void;
}

const isTabDrag = (e: React.DragEvent): boolean =>
  Array.from(e.dataTransfer.types).includes(TAB_DND_TYPE);

const SIDES: { side: Side; orientation: Orientation }[] = [
  { side: 'left', orientation: 'row' },
  { side: 'right', orientation: 'row' },
  { side: 'top', orientation: 'column' },
  { side: 'bottom', orientation: 'column' },
];

export const SplitDropZones = ({ onDropSplit }: SplitDropZonesProps) => {
  const [hot, setHot] = useState<Side | null>(null);

  return (
    <div className="split-dropzones" data-testid="split-dropzones">
      {SIDES.map(({ side }) => (
        <div
          key={side}
          className={`split-dropzone ${side}`}
          data-testid={`dropzone-${side}`}
          onDragOver={(e) => {
            if (!isTabDrag(e)) return; // let file drags fall through to upload
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            setHot(side);
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) {
              setHot((h) => (h === side ? null : h));
            }
          }}
          onDrop={(e) => {
            setHot(null);
            if (!isTabDrag(e)) return;
            e.preventDefault();
            const id = e.dataTransfer.getData(TAB_DND_TYPE);
            if (id) onDropSplit(id, side);
          }}
        />
      ))}
      {hot && (
        <div
          className={`split-drop-preview ${hot}`}
          data-testid="split-drop-preview"
          aria-hidden="true"
        />
      )}
    </div>
  );
};
