// ── Slot drop zones ───────────────────────────────────────────────────────────
//
// Shown over the content area while a strip tab is dragged AND a split is on
// screen: one zone per slot; dropping a tab replaces that slot's content (the
// split always keeps exactly two slots — a drop never adds a third). Opening a
// split from an edge is SplitDropZones' job when no split is shown. Only tab
// drags light up (TAB_DND_TYPE) — OS file drags keep hitting the upload path.
// While a slot is hovered, a single overlay previews the whole claimed slot
// (same treatment as SplitDropZones' claimed-half preview — the zones themselves
// stay invisible hit areas).

import { useState, type CSSProperties } from 'react';
import { TAB_DND_TYPE } from './SessionTabs';
import type { Rect, SlotId } from './useSplit';

interface SlotDropZonesProps {
  rects: { a: Rect; b: Rect };
  /** Drop `tabId` on a slot → replace that slot's content. */
  onDropSlot: (tabId: string, slot: SlotId) => void;
}

const isTabDrag = (e: React.DragEvent): boolean =>
  Array.from(e.dataTransfer.types).includes(TAB_DND_TYPE);

const rectCss = (r: Rect): CSSProperties => ({
  position: 'absolute',
  left: `${r.left}%`,
  top: `${r.top}%`,
  width: `${r.width}%`,
  height: `${r.height}%`,
});

export const SlotDropZones = ({ rects, onDropSlot }: SlotDropZonesProps) => {
  const [hot, setHot] = useState<SlotId | null>(null);

  return (
    <div className="slot-dropzones" data-testid="slot-dropzones">
      {(['a', 'b'] as const).map((slot) => (
        <div
          key={slot}
          className="slot-dropzone"
          style={rectCss(rects[slot])}
          data-testid={`slot-dropzone-${slot}`}
          onDragOver={(e) => {
            if (!isTabDrag(e)) return; // let file drags fall through to upload
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            setHot(slot);
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) {
              setHot((h) => (h === slot ? null : h));
            }
          }}
          onDrop={(e) => {
            setHot(null);
            if (!isTabDrag(e)) return;
            e.preventDefault();
            const id = e.dataTransfer.getData(TAB_DND_TYPE);
            if (id) onDropSlot(id, slot);
          }}
        />
      ))}
      {hot && (
        <div
          className="split-drop-preview"
          data-testid="slot-drop-preview"
          style={rectCss(rects[hot])}
          aria-hidden="true"
        />
      )}
    </div>
  );
};
