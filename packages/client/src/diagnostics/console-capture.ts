// ── Console capture ring ──────────────────────────────────────────────────────
//
// Shadow console.warn / console.error into a bounded FIFO ring from app start so
// the diagnostics report can include recent warnings/errors. Normal console
// output is preserved (the original method is always still called).

export interface CapturedLog {
  level: 'warn' | 'error';
  message: string;
  at: number;
}

const RING_MAX = 50;
const ring: CapturedLog[] = [];
let installed = false;

function format(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return arg.stack ?? arg.message;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

/** Install the capture once. Idempotent. */
export function installConsoleCapture(): void {
  if (installed) return;
  installed = true;
  (['warn', 'error'] as const).forEach((level) => {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]): void => {
      try {
        ring.push({ level, message: args.map(format).join(' '), at: Date.now() });
        if (ring.length > RING_MAX) ring.shift();
      } catch {
        /* never let capture break logging */
      }
      original(...args);
    };
  });
}

export function capturedLogs(): CapturedLog[] {
  return [...ring];
}

export function clearCapturedLogs(): void {
  ring.length = 0;
}
