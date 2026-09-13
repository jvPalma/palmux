// Measured on a 390px phone: Monaco gave the text 319px and spent the other 71px
// on gutter chrome. These pin the decision that follows from that, and the two
// traps in making it — a hidden pane measuring 0, and firing on every resize.

import { describe, expect, it, vi } from 'vitest';
import { editorLayoutOptions, NARROW_EDITOR_PX, observeEditorWidth } from './editor-layout';

describe('editorLayoutOptions', () => {
  it('drops the gutter chrome on a narrow pane', () => {
    const o = editorLayoutOptions(390);
    expect(o.lineNumbers).toBe('off');
    expect(o.folding).toBe(false);
    expect(o.lineDecorationsWidth).toBe(0);
    expect(o.overviewRulerLanes).toBe(0);
  });

  it('keeps it on a pane wide enough to afford it', () => {
    const o = editorLayoutOptions(1200);
    expect(o.lineNumbers).toBe('on');
    expect(o.folding).toBe(true);
    expect(o.overviewRulerLanes).toBeGreaterThan(0);
  });

  // The dock is 300px on a DESKTOP too. Keying this off `mobileMode` would have
  // fixed the phone and left the dock's editor just as cramped.
  it('treats a 300px dock exactly like a phone', () => {
    expect(editorLayoutOptions(300)).toEqual(editorLayoutOptions(390));
  });

  it('wraps at every width — a narrow column beats horizontal scrolling', () => {
    expect(editorLayoutOptions(320).wordWrap).toBe('on');
    expect(editorLayoutOptions(1600).wordWrap).toBe('on');
  });

  it('gives touch a bigger scrollbar than a mouse needs', () => {
    expect(editorLayoutOptions(390).scrollbar.verticalScrollbarSize).toBeLessThan(
      editorLayoutOptions(1200).scrollbar.verticalScrollbarSize,
    );
  });

  // Panes stay mounted while their tab exists, so a hidden one measures 0. That
  // must not read as "extremely narrow" and strip the chrome off a desktop pane
  // that is merely in the background.
  it('does not treat a hidden (zero-width) pane as narrow', () => {
    expect(editorLayoutOptions(0).lineNumbers).toBe('on');
  });

  it('switches at the documented threshold', () => {
    expect(editorLayoutOptions(NARROW_EDITOR_PX - 1).lineNumbers).toBe('off');
    expect(editorLayoutOptions(NARROW_EDITOR_PX).lineNumbers).toBe('on');
  });
});

describe('observeEditorWidth', () => {
  const hostOf = (width: number) =>
    ({ getBoundingClientRect: () => ({ width }) }) as unknown as HTMLElement;

  it('reports the initial width immediately', () => {
    const seen = vi.fn();
    observeEditorWidth(hostOf(390), seen);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen.mock.calls[0]?.[0].lineNumbers).toBe('off');
  });

  // `updateOptions` re-lays out the editor. Firing it on every frame of a dock
  // animation is exactly the resize storm the layout rules forbid, so only a
  // CROSSING of the threshold counts.
  it('reports only when the pane crosses the threshold', () => {
    const seen = vi.fn();
    // A holder, not a `let`: assigning only inside the constructor leaves TS
    // narrowing the variable to `never` at every call site.
    const hold: { cb: ((e: { contentRect: { width: number } }[]) => void) | null } = { cb: null };
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(fn: (e: { contentRect: { width: number } }[]) => void) {
          hold.cb = fn;
        }
        observe() {}
        disconnect() {}
      },
    );
    const stop = observeEditorWidth(hostOf(1200), seen);
    expect(seen).toHaveBeenCalledTimes(1); // initial

    hold.cb?.([{ contentRect: { width: 1100 } }]); // still wide
    hold.cb?.([{ contentRect: { width: 900 } }]); // still wide
    expect(seen).toHaveBeenCalledTimes(1);

    hold.cb?.([{ contentRect: { width: 390 } }]); // crossed
    expect(seen).toHaveBeenCalledTimes(2);

    hold.cb?.([{ contentRect: { width: 320 } }]); // still narrow
    expect(seen).toHaveBeenCalledTimes(2);

    hold.cb?.([{ contentRect: { width: 1200 } }]); // crossed back
    expect(seen).toHaveBeenCalledTimes(3);
    stop();
    vi.unstubAllGlobals();
  });

  it('ignores a pane hidden by a tab switch rather than restyling it', () => {
    const seen = vi.fn();
    // A holder, not a `let`: assigning only inside the constructor leaves TS
    // narrowing the variable to `never` at every call site.
    const hold: { cb: ((e: { contentRect: { width: number } }[]) => void) | null } = { cb: null };
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(fn: (e: { contentRect: { width: number } }[]) => void) {
          hold.cb = fn;
        }
        observe() {}
        disconnect() {}
      },
    );
    observeEditorWidth(hostOf(1200), seen);
    hold.cb?.([{ contentRect: { width: 0 } }]);
    expect(seen).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});
