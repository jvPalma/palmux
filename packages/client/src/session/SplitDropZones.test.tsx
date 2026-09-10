// Claimed-half hover preview: a tab drag over an edge zone shows the preview
// on the correct half, dragLeave hides it, and file drags never light it.

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SplitDropZones } from './SplitDropZones';
import { TAB_DND_TYPE } from './SessionTabs';

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

describe('SplitDropZones drop preview', () => {
  it('shows no preview before any hover', () => {
    render(<SplitDropZones onDropSplit={vi.fn()} />);
    expect(screen.queryByTestId('split-drop-preview')).toBeNull();
  });

  it('dragOver a tab drag shows the preview on the correct half', () => {
    render(<SplitDropZones onDropSplit={vi.fn()} />);
    const t = dt([TAB_DND_TYPE]);
    fireEvent.dragOver(screen.getByTestId('dropzone-right'), { dataTransfer: t });
    const preview = screen.getByTestId('split-drop-preview');
    expect(preview.className).toContain('right');
  });

  it('dragOver a different zone moves the preview', () => {
    render(<SplitDropZones onDropSplit={vi.fn()} />);
    const t = dt([TAB_DND_TYPE]);
    fireEvent.dragOver(screen.getByTestId('dropzone-top'), { dataTransfer: t });
    expect(screen.getByTestId('split-drop-preview').className).toContain('top');
    fireEvent.dragOver(screen.getByTestId('dropzone-bottom'), { dataTransfer: t });
    expect(screen.getByTestId('split-drop-preview').className).toContain('bottom');
  });

  it('dragLeave hides the preview', () => {
    render(<SplitDropZones onDropSplit={vi.fn()} />);
    const t = dt([TAB_DND_TYPE]);
    const zone = screen.getByTestId('dropzone-left');
    fireEvent.dragOver(zone, { dataTransfer: t });
    expect(screen.getByTestId('split-drop-preview')).toBeTruthy();
    fireEvent.dragLeave(zone, { dataTransfer: t, relatedTarget: null });
    expect(screen.queryByTestId('split-drop-preview')).toBeNull();
  });

  it('drop clears the preview and fires onDropSplit with the side', () => {
    const onDropSplit = vi.fn();
    render(<SplitDropZones onDropSplit={onDropSplit} />);
    const t = dt([TAB_DND_TYPE]);
    t.setData(TAB_DND_TYPE, '3');
    fireEvent.dragOver(screen.getByTestId('dropzone-left'), { dataTransfer: t });
    fireEvent.drop(screen.getByTestId('dropzone-left'), { dataTransfer: t });
    expect(onDropSplit).toHaveBeenCalledWith('3', 'left');
    expect(screen.queryByTestId('split-drop-preview')).toBeNull();
  });

  it('a Files drag never shows the preview', () => {
    render(<SplitDropZones onDropSplit={vi.fn()} />);
    const t = dt(['Files']);
    fireEvent.dragOver(screen.getByTestId('dropzone-right'), { dataTransfer: t });
    expect(screen.queryByTestId('split-drop-preview')).toBeNull();
  });
});
