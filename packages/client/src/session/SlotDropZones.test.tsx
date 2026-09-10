// Slot hover preview: a tab drag over a slot zone previews that whole slot,
// dragLeave/drop hides it, the other slot is never tinted, and file drags never
// light it (they keep hitting the upload path).

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SlotDropZones } from './SlotDropZones';
import { TAB_DND_TYPE } from './SessionTabs';
import type { Rect } from './useSplit';

const dt = (types: string[]) => {
  let data = '';
  return {
    types,
    setData: (_t: string, v: string) => {
      data = v;
    },
    getData: () => data,
    effectAllowed: '',
    dropEffect: '',
  };
};

const rects = {
  a: { left: 0, top: 0, width: 50, height: 100 } as Rect,
  b: { left: 50, top: 0, width: 50, height: 100 } as Rect,
};

describe('SlotDropZones hover preview', () => {
  it('shows no preview before any hover', () => {
    render(<SlotDropZones rects={rects} onDropSlot={vi.fn()} />);
    expect(screen.queryByTestId('slot-drop-preview')).toBeNull();
  });

  it('hovering slot B previews only slot B (slot A stays untinted)', () => {
    render(<SlotDropZones rects={rects} onDropSlot={vi.fn()} />);
    fireEvent.dragOver(screen.getByTestId('slot-dropzone-b'), { dataTransfer: dt([TAB_DND_TYPE]) });
    const preview = screen.getByTestId('slot-drop-preview');
    // Positioned over slot B's rect (left 50%), not slot A.
    expect(preview.style.left).toBe('50%');
    expect(preview.style.width).toBe('50%');
  });

  it('moving to the other slot moves the preview', () => {
    render(<SlotDropZones rects={rects} onDropSlot={vi.fn()} />);
    const t = dt([TAB_DND_TYPE]);
    fireEvent.dragOver(screen.getByTestId('slot-dropzone-b'), { dataTransfer: t });
    expect(screen.getByTestId('slot-drop-preview').style.left).toBe('50%');
    fireEvent.dragOver(screen.getByTestId('slot-dropzone-a'), { dataTransfer: t });
    expect(screen.getByTestId('slot-drop-preview').style.left).toBe('0%');
  });

  it('dragLeave hides the preview', () => {
    render(<SlotDropZones rects={rects} onDropSlot={vi.fn()} />);
    const zone = screen.getByTestId('slot-dropzone-a');
    fireEvent.dragOver(zone, { dataTransfer: dt([TAB_DND_TYPE]) });
    expect(screen.getByTestId('slot-drop-preview')).toBeTruthy();
    fireEvent.dragLeave(zone, { dataTransfer: dt([TAB_DND_TYPE]), relatedTarget: null });
    expect(screen.queryByTestId('slot-drop-preview')).toBeNull();
  });

  it('drop clears the preview and fires onDropSlot with the slot', () => {
    const onDropSlot = vi.fn();
    render(<SlotDropZones rects={rects} onDropSlot={onDropSlot} />);
    const t = dt([TAB_DND_TYPE]);
    t.setData(TAB_DND_TYPE, '3');
    fireEvent.dragOver(screen.getByTestId('slot-dropzone-b'), { dataTransfer: t });
    fireEvent.drop(screen.getByTestId('slot-dropzone-b'), { dataTransfer: t });
    expect(onDropSlot).toHaveBeenCalledWith('3', 'b');
    expect(screen.queryByTestId('slot-drop-preview')).toBeNull();
  });

  it('file drags never preview', () => {
    render(<SlotDropZones rects={rects} onDropSlot={vi.fn()} />);
    fireEvent.dragOver(screen.getByTestId('slot-dropzone-a'), { dataTransfer: dt(['Files']) });
    expect(screen.queryByTestId('slot-drop-preview')).toBeNull();
  });
});
