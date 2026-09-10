// Measure what one wheel notch COSTS inside tmux versus outside it.
//
// Outside tmux a notch is free: xterm scrolls its own buffer and nothing
// crosses the wire. Inside tmux the notch is an SGR mouse report to the PTY,
// tmux repaints its region with absolute addressing, and those bytes travel
// back over the WebSocket. This measures the second number.
//
//   node scripts/measure-tmux-scroll.mjs
//
// Run from the repo root — node-pty is hoisted there.
//
// **It rebinds WheelUpPane, and tmux key tables are per-SERVER, not
// per-session.** There is no session-scoped form of `bind-key`, so this
// necessarily reaches every session on the same tmux server, including live
// ones. It therefore re-sources `~/.tmux.conf` on the way out — including on a
// throw or a Ctrl-C — which is the only way to put the user's own bindings back
// exactly as they were. Do not remove that restore.

import { spawn } from 'node-pty';
import { execFileSync } from 'node:child_process';

const SESSION = 'palmux-scroll-probe';
const COLS = 120;
const ROWS = 40;
let NOTCHES = 12; // one flick at WHEEL_CELLS_PER_NOTCH = 1

const tmux = (...args) => execFileSync('tmux', args, { encoding: 'utf8' }).trim();

/** Put the user's own key bindings back. Registered before anything is changed. */
function restoreUserBindings() {
  try {
    tmux('source-file', `${process.env.HOME}/.tmux.conf`);
  } catch {
    console.error('WARNING: could not re-source ~/.tmux.conf — run it yourself.');
  }
}
for (const sig of ['exit', 'SIGINT', 'SIGTERM', 'uncaughtException']) {
  process.on(sig, () => {
    restoreUserBindings();
    if (sig !== 'exit') process.exit(1);
  });
}

/** One SGR wheel-up report at (col,row), exactly what touch.ts emits. */
const wheelUp = (col, row) => `\x1b[<64;${col};${row}M`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function measure(label, command, prime) {
  const pty = spawn('/bin/bash', ['-lc', command], {
    name: 'xterm-256color',
    cols: COLS,
    rows: ROWS,
    env: { ...process.env, TERM: 'xterm-256color' },
  });

  let bytes = 0;
  let chunks = 0;
  let counting = false;
  pty.onData((d) => {
    if (!counting) return;
    bytes += Buffer.byteLength(d, 'utf8');
    chunks++;
  });

  await sleep(1500);
  if (prime) {
    pty.write(prime);
    await sleep(1500);
  }

  counting = true;
  const t0 = Date.now();
  for (let i = 0; i < NOTCHES; i++) {
    pty.write(wheelUp(60, 20));
    await sleep(16); // ~one frame apart, like a real swipe
  }
  await sleep(800);
  const ms = Date.now() - t0;
  counting = false;
  pty.kill();

  return { label, bytes, chunks, ms, perNotch: Math.round(bytes / 12) };
}

try {
  tmux('kill-session', '-t', SESSION);
} catch {
  /* not running */
}

// A session with real scrollback to move through, mouse on, 1 line per tick —
// the owner's own tmux.conf settings.
tmux('new-session', '-d', '-s', SESSION, '-x', String(COLS), '-y', String(ROWS));
tmux('send-keys', '-t', SESSION, 'seq 1 4000', 'Enter');
await sleep(1500);
tmux('set-option', '-t', SESSION, '-g', 'mouse', 'on');

const results = [];

// 1. A bare shell with NO mouse reporting: the wheel report is typed as text,
//    which is what the shell echoes back. This is the floor, not a real case —
//    outside tmux the client never sends the report at all.
results.push(await measure('bare shell (no mouse mode)', 'cat > /dev/null', null));

// 2. tmux, mouse on, the owner's `-N 1` binding: one repaint per notch.
// 2/3. The decisive comparison. If the cost is per NOTCH, coarser notches (the
//       owner's tmux -N 5 default plus a bigger WHEEL_CELLS_PER_NOTCH) buy a 5x
//       saving. If it is per LINE SCROLLED, they buy nothing and only cost
//       precision — which is the question this whole item turns on.
// SAME DISTANCE, different granularity: 12 lines of travel either way.
for (const [n, notches] of [
  [1, 12],
  [2, 6],
  [3, 4],
  [6, 2],
]) {
  NOTCHES = notches;
  tmux('bind-key', '-T', 'copy-mode', 'WheelUpPane', 'send-keys', '-N', String(n), '-X', 'scroll-up');
  tmux('bind-key', '-T', 'copy-mode-vi', 'WheelUpPane', 'send-keys', '-N', String(n), '-X', 'scroll-up');
  tmux(
    'bind-key', '-T', 'root', 'WheelUpPane',
    `if-shell -F "#{mouse_any_flag}" "send-keys -M" "if-shell -F \\"#{pane_in_mode}\\" \\"send-keys -N ${n} -X scroll-up\\" \\"copy-mode -e ; send-keys -N ${n} -X scroll-up\\""`,
  );
  results.push(
    await measure(
      `tmux, ${notches} notch x ${n} line = 12 lines`,
      `tmux attach-session -t ${SESSION}`,
      null,
    ),
  );
}
NOTCHES = 12;

try {
  tmux('kill-session', '-t', SESSION);
} catch {
  /* already gone */
}

const pad = (s, n) => String(s).padEnd(n);
console.log('');
console.log(`12 lines of scroll travel, ${COLS}x${ROWS} pane, ~16ms apart`);
console.log('');
console.log(`${pad('case', 30)}${pad('bytes back', 12)}${pad('per line', 12)}${pad('chunks', 9)}ms`);
for (const r of results) {
  console.log(
    `${pad(r.label, 30)}${pad(r.bytes, 12)}${pad(r.perNotch, 12)}${pad(r.chunks, 9)}${r.ms}`,
  );
}
console.log('');
console.log('Outside tmux the client sends NO report at all — xterm scrolls its own');
console.log('buffer locally, so the true cost there is 0 bytes and 0 round trips.');
