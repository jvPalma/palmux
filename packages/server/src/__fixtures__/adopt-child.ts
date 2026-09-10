// Test fixture: acts as a handoff SUCCESSOR process. It inherits a PTY master fd
// at 3 and adopts it exactly the way the real handoff does, round-trips a command
// through the still-running shell, then writes the outcome to argv[2] as JSON.
//
// Run cross-process (not in the vitest process) because two libuv handles on one
// fd conflict — the whole point of the handoff is that the ORIGINAL owner is gone.

import { writeFileSync } from 'node:fs';
import { adoptTransport } from '../pty-transport';

const outPath = process.argv[2]!;
const transport = adoptTransport(3, Number(process.env['ADOPT_PID'] ?? '0'));

let got = '';
transport.onData((d) => {
  got += d;
});

setTimeout(() => transport.write('echo SURVIVED=$MARK\n'), 400);

// Poll for the answer instead of guessing a settle time — a fixed timeout makes
// this flaky on a loaded machine.
const deadline = Date.now() + 8000;
const tick = setInterval(() => {
  const sameShell = got.includes('SURVIVED=handoff-ok');
  if (!sameShell && Date.now() < deadline) return;
  clearInterval(tick);
  let resized = true;
  try {
    transport.resize(100, 30);
  } catch {
    resized = false;
  }
  writeFileSync(outPath, JSON.stringify({ sameShell, resized }));
  process.exit(0);
}, 100);
