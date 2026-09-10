// ── Context-aware tap resolver ─────────────────────────────────────────────
//
// A tap on the terminal means different things depending on what's under it:
// forward it as a mouse click to an app that owns mouse reporting (tmux pane
// focus), open a link, walk the caret on a readline prompt row, or walk a
// single-row highlight inside an OSC-133 output zone (a "menu row" tap —
// this NEVER sends '\r'/'\n', so it can never auto-submit). Pure decision
// logic only; touch.ts / the caller resolves cells, links and zones and
// forwards the returned bytes.

export type TapAction =
  | { kind: 'mouse' }
  | { kind: 'link'; url: string }
  | { kind: 'menuRow'; rows: number } // positive = move DOWN
  | { kind: 'caret'; cols: number } // positive = move RIGHT
  | { kind: 'keyboard' };

export interface TapContext {
  mouseReporting: boolean;
  /** A link under the tapped cell, already resolved by the caller. */
  linkUrl: string | null;
  /** Tapped cell, absolute buffer coordinates. */
  tapped: { col: number; row: number };
  /** Current cursor cell, absolute buffer coordinates. */
  cursor: { col: number; row: number };
  /** Active OSC-133 output zone in absolute rows, inclusive, or null. */
  outputZone: { start: number; end: number } | null;
  /** Absolute row of the active readline prompt row, or null when unknown. */
  promptRow: number | null;
  /** Safety clamp on how many arrow keys one tap may emit. Default 200. */
  maxDelta?: number;
}

const DEFAULT_MAX_DELTA = 200;

function clamp(value: number, maxDelta: number): number {
  return Math.max(-maxDelta, Math.min(maxDelta, value));
}

export function resolveTap(ctx: TapContext): TapAction {
  if (ctx.mouseReporting) return { kind: 'mouse' };
  if (ctx.linkUrl !== null) return { kind: 'link', url: ctx.linkUrl };

  const maxDelta = ctx.maxDelta ?? DEFAULT_MAX_DELTA;

  if (ctx.promptRow !== null && ctx.tapped.row === ctx.promptRow) {
    const cols = clamp(ctx.tapped.col - ctx.cursor.col, maxDelta);
    return cols === 0 ? { kind: 'keyboard' } : { kind: 'caret', cols };
  }

  if (
    ctx.outputZone !== null &&
    ctx.tapped.row >= ctx.outputZone.start &&
    ctx.tapped.row <= ctx.outputZone.end
  ) {
    const rows = clamp(ctx.tapped.row - ctx.cursor.row, maxDelta);
    return rows === 0 ? { kind: 'keyboard' } : { kind: 'menuRow', rows };
  }

  return { kind: 'keyboard' };
}

/** Arrow bytes for a caret/menuRow action; '' for the others. */
export function tapActionBytes(action: TapAction): string {
  if (action.kind === 'caret') {
    return action.cols > 0 ? '\x1b[C'.repeat(action.cols) : '\x1b[D'.repeat(-action.cols);
  }
  if (action.kind === 'menuRow') {
    return action.rows > 0 ? '\x1b[B'.repeat(action.rows) : '\x1b[A'.repeat(-action.rows);
  }
  return '';
}
