// ── Native touch text-selection over the canvas ───────────────────────────────
//
// The WebGL renderer paints glyphs into a canvas, so there is no DOM text under
// the finger: the browser's own long-press selection and the OS teardrop handles
// can never engage. This module recreates the pdf.js "text layer" trick — an
// absolutely-positioned, transparent DOM copy of the VISIBLE rows in the same
// monospace metrics, with `user-select: text`. A long press then lands on real
// text, so the platform supplies its own selection UI, its own handles, and its
// own Copy/Share callout, and the selected string is real terminal text.
//
// Three things make the difference between a demo and something usable:
//
//   • WRAPPED LINES. One element per VISUAL row would put a newline at every
//     soft wrap in whatever the OS copies — pasting a long command back into a
//     shell would execute it early. Consecutive wrapped rows are therefore ONE
//     element that re-wraps at the same columns, so its text has no break.
//   • METRIC REGISTRATION. xterm's cell width is device-pixel-rounded; the DOM
//     advances at the font's raw advance. Over a long line that drift exceeds a
//     cell and the invisible text stops covering the glyphs it stands for. The
//     layer measures its own advance once per font/size and corrects it with
//     `letter-spacing`, so a column in the layer is exactly a column on screen.
//   • EXPLICIT LINE BREAKS. The rows are absolutely positioned, and Blink's
//     plain-text serialiser emits NO newline between out-of-flow blocks — a
//     multi-line copy came out as one run-on line (verified in Chromium: the
//     same rows made `static` serialise with newlines, `absolute` without).
//     Each logical line therefore ends in a real `\n` character, which the OS
//     Copy then carries. Soft wraps stay break-free because a wrapped line is
//     still ONE element with ONE terminating newline.
//   • FREEZE ON SELECTION. Rewriting a row's textContent replaces its text node
//     and collapses any selection anchored in it — in a live pane that means the
//     selection dies the moment anything prints. Updates pause while a selection
//     is alive, and resume (dropping it) if the viewport scrolls out from under.
//
// Known limits: a wrapped line containing double-width glyphs (CJK/emoji) wraps
// by character where the terminal wraps by cell, so its columns drift; and the
// layer only holds the viewport, so a drag cannot extend into scrollback (the
// custom handles have the same limit).

/** The slice of xterm's Terminal this module needs (kept structural so it is unit-testable). */
export interface BufferLineLike {
  translateToString(trimRight?: boolean): string;
  /** True when this row is the continuation of the row above it. */
  readonly isWrapped?: boolean;
}

export interface TerminalLike {
  readonly rows: number;
  readonly cols: number;
  /** The authoritative font — the canvas renderer leaves no font in the DOM. */
  readonly options?: { readonly fontFamily?: string | undefined; readonly fontSize?: number };
  readonly buffer: {
    readonly active: {
      readonly viewportY: number;
      getLine(y: number): BufferLineLike | undefined;
    };
  };
}

export interface TextLayerGeometry {
  rows: number;
  cols: number;
  cellWidth: number;
  cellHeight: number;
  /** Grid origin relative to the host element (xterm pads, and mobile bottom-aligns). */
  left?: number;
  top?: number;
}

export interface NativeSelectionLayer {
  /** Re-render the layer from the current buffer (call on render/scroll/resize). */
  update(): void;
  setEnabled(on: boolean): void;
  isEnabled(): boolean;
  /** The text the user has natively selected inside the layer, or ''. */
  selectedText(): string;
  destroy(): void;
}

/**
 * True while the user holds a live text selection inside ANY mounted layer.
 * Exported because the app has to stand still around it: the IME closing is
 * what reflows the terminal, and reflowing underneath a selection destroys it.
 */
export function hasNativeSelection(): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return false;
  const { anchorNode, focusNode } = sel;
  if (!anchorNode || !focusNode) return false;
  for (const layer of document.querySelectorAll('.native-sel-layer')) {
    if (layer.contains(anchorNode) && layer.contains(focusNode)) return true;
  }
  return false;
}

/** The visible rows as plain strings, trailing blanks trimmed. */
export function visibleRows(term: TerminalLike): string[] {
  const top = term.buffer.active.viewportY;
  const out: string[] = [];
  for (let y = 0; y < term.rows; y++) {
    out.push(term.buffer.active.getLine(top + y)?.translateToString(true) ?? '');
  }
  return out;
}

/** One rendered element: a logical line, which may span several visual rows. */
interface LineGroup {
  /** Index of the first visual row (0-based within the viewport). */
  row: number;
  /** How many visual rows this logical line occupies. */
  span: number;
  text: string;
}

/**
 * Split the viewport into logical lines. A row whose `isWrapped` is true is a
 * continuation of the one above and joins its group; interior rows are taken
 * UNTRIMMED and padded to the full column count, because a short interior row
 * would move the CSS wrap point of everything after it.
 */
export function lineGroups(term: TerminalLike, cols: number): LineGroup[] {
  const top = term.buffer.active.viewportY;
  const line = (y: number) => term.buffer.active.getLine(top + y);
  const groups: LineGroup[] = [];

  for (let y = 0; y < term.rows;) {
    let end = y + 1;
    while (end < term.rows && line(end)?.isWrapped) end++;

    let text = '';
    for (let r = y; r < end; r++) {
      const last = r === end - 1;
      const raw = line(r)?.translateToString(last) ?? '';
      text += last ? raw : raw.padEnd(cols, ' ').slice(0, cols);
    }
    groups.push({ row: y, span: end - y, text });
    y = end;
  }
  return groups;
}

export function createNativeSelectionLayer(
  term: TerminalLike,
  host: HTMLElement,
  geom: () => TextLayerGeometry,
): NativeSelectionLayer {
  const root = document.createElement('div');
  root.className = 'native-sel-layer';
  root.dataset['nativeSel'] = 'layer';
  root.style.position = 'absolute';
  root.style.overflow = 'hidden';
  // Invisible but SELECTABLE: visibility/opacity/display would all make the text
  // unselectable, which is the whole point of the layer.
  root.style.color = 'transparent';
  root.style.background = 'transparent';
  root.style.whiteSpace = 'pre';
  root.style.userSelect = 'text';
  root.style.webkitUserSelect = 'text';
  // Uniform advances are what keep columns registered: no ligature substitution
  // (JetBrains Mono NF has plenty, and the canvas renderer applies none).
  root.style.fontVariantLigatures = 'none';
  root.style.fontKerning = 'none';

  const rowEls: HTMLDivElement[] = [];
  let enabled = false;
  let cellW = 0;
  let cellH = 0;
  let cols = 0;
  let rows = 0;
  let originX = 0;
  let originY = 0;
  let fontKey = '';
  // The groups the rows currently hold — needed to re-place them while frozen.
  let lastGroups: LineGroup[] = [];

  // Take the font from the terminal's OPTIONS, never from its DOM: under the
  // WebGL renderer there is no `.xterm-rows`, and `.xterm` carries no font of
  // its own — it just inherits the page's system-ui, which is what a DOM read
  // silently picked up (columns then bore no relation to the canvas at all).
  const syncFont = (fallbackPx: number) => {
    root.style.fontFamily = term.options?.fontFamily || 'monospace';
    root.style.fontSize = `${term.options?.fontSize || fallbackPx}px`;
  };

  // Measure the layer's own per-character advance and cancel the difference from
  // xterm's (rounded) cell width. Monospace + letter-spacing is exactly additive,
  // so after this one column of DOM text is one column of canvas.
  const syncMetrics = () => {
    const key = `${root.style.fontFamily}|${root.style.fontSize}|${cellW}`;
    if (key === fontKey) return;
    fontKey = key;
    root.style.letterSpacing = '0px';
    const probe = document.createElement('span');
    probe.style.position = 'absolute';
    probe.style.whiteSpace = 'pre';
    probe.style.visibility = 'hidden';
    probe.textContent = 'M'.repeat(100);
    root.appendChild(probe);
    const advance = probe.getBoundingClientRect().width / 100;
    probe.remove();
    // No layout (headless, or the layer is detached) → leave it uncorrected.
    if (advance > 0) root.style.letterSpacing = `${cellW - advance}px`;
  };

  const place = (el: HTMLDivElement, g: LineGroup) => {
    el.style.top = `${g.row * cellH}px`;
    el.style.height = `${g.span * cellH}px`;
    el.style.lineHeight = `${cellH}px`;
    // A single-row line never wraps; a multi-row one must re-wrap at exactly the
    // column the terminal wrapped at, which is what break-all buys us.
    el.style.whiteSpace = g.span > 1 ? 'pre-wrap' : 'pre';
    el.style.wordBreak = g.span > 1 ? 'break-all' : 'normal';
  };

  // The text a row element carries: the logical line plus the newline that makes
  // the copy break there. The LAST row is left bare — the terminal's own copy
  // never appends a trailing newline, and one pasted into a shell RUNS the line.
  const rowText = (g: LineGroup, isLast: boolean) => (isLast ? g.text : `${g.text}\n`);

  const addRow = (): HTMLDivElement => {
    const el = document.createElement('div');
    el.className = 'native-sel-row';
    el.style.position = 'absolute';
    el.style.left = '0';
    el.style.width = '100%';
    root.appendChild(el);
    return el;
  };

  /** A live selection with both ends inside the layer, or null. */
  const layerSelection = (): Selection | null => {
    const sel = typeof window === 'undefined' ? null : window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const { anchorNode, focusNode } = sel;
    if (!anchorNode || !focusNode) return null;
    // While disabled the root is detached, so this is false — a page selection
    // elsewhere never leaks out as terminal text.
    if (!root.contains(anchorNode) || !root.contains(focusNode)) return null;
    return sel;
  };

  /** Push geometry to the root. Safe mid-selection: it writes no text nodes. */
  const applyGeometry = (g: TextLayerGeometry) => {
    cellW = g.cellWidth;
    cellH = g.cellHeight;
    cols = g.cols;
    rows = g.rows;
    originX = g.left ?? 0;
    originY = g.top ?? 0;
    root.style.width = `${cols * cellW}px`;
    root.style.height = `${rows * cellH}px`;
    root.style.left = `${originX}px`;
    root.style.top = `${originY}px`;
  };

  const update = () => {
    if (!enabled) return;
    const g = geom();
    // EVERY value applyGeometry consumes has to be compared here. Leaving rows
    // and the origin out meant a soft-keyboard toggle — which changes the row
    // count and the grid's top offset but not the cell size — never re-applied,
    // so the layer kept the old height and sat 6px off the glyphs it covers.
    const metricsChanged =
      g.cellWidth !== cellW ||
      g.cellHeight !== cellH ||
      g.cols !== cols ||
      g.rows !== rows ||
      (g.left ?? 0) !== originX ||
      (g.top ?? 0) !== originY;

    // A live selection freezes the TEXT. Rewriting a row's textContent replaces
    // its text node and collapses the selection — the instant output prints, or
    // the moment the closing IME reflows the terminal. Geometry may still
    // follow (moving an element keeps its text node intact), but we NEVER drop
    // the user's selection ourselves: an earlier version did exactly that on a
    // metrics change, which is precisely the keyboard-close case.
    if (layerSelection()) {
      if (metricsChanged) {
        applyGeometry(g);
        syncFont(cellH);
        syncMetrics();
        rowEls.forEach((el, i) => {
          const group = lastGroups[i];
          if (group) place(el, group);
        });
      }
      return;
    }

    if (metricsChanged) applyGeometry(g);
    // Outside the metrics branch: a font-family change can leave rows/cols/cell
    // size untouched while completely changing the advance. Both calls are
    // cheap and syncMetrics re-measures only when its key actually moved.
    syncFont(cellH);
    syncMetrics();

    const groups = lineGroups(term, g.cols);
    while (rowEls.length < groups.length) rowEls.push(addRow());
    while (rowEls.length > groups.length) rowEls.pop()?.remove();

    // Reuse the row elements: only the text (and, on a resize, the geometry) is
    // rewritten, so a re-render never invalidates an in-progress selection.
    rowEls.forEach((el, i) => {
      const group = groups[i]!;
      place(el, group);
      const text = rowText(group, i === groups.length - 1);
      if (el.textContent !== text) el.textContent = text;
    });
    lastGroups = groups;
  };

  // A webfont that finishes loading AFTER the first measurement silently
  // invalidates it: the family string never changes, so the cached key would
  // keep a correction computed against fallback metrics (measured live: a
  // 31-column row rendering 96px short of its grid). Re-measure on every font
  // load, and once more if they were already done before we attached.
  const onFontsDone = () => {
    fontKey = '';
    update();
  };
  const fontSet: FontFaceSet | undefined =
    typeof document === 'undefined' ? undefined : document.fonts;
  fontSet?.addEventListener?.('loadingdone', onFontsDone);
  void fontSet?.ready?.then?.(onFontsDone).catch(() => {});

  const setEnabled = (on: boolean) => {
    if (on === enabled) return;
    enabled = on;
    if (!on) {
      root.remove();
      return;
    }
    host.appendChild(root);
    fontKey = ''; // force a re-measure: metrics need the layer to be laid out
    update();
  };

  return {
    update,
    setEnabled,
    isEnabled: () => enabled,
    selectedText: () => layerSelection()?.toString() ?? '',
    destroy: () => {
      enabled = false;
      fontSet?.removeEventListener?.('loadingdone', onFontsDone);
      root.remove();
      rowEls.length = 0;
      root.textContent = '';
    },
  };
}
