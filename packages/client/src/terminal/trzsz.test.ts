// The trzsz bridge: bytes pass through untouched (and the library is never
// imported) until the handshake magic appears; the detecting chunk and its
// successors are replayed into the filter in order once the lazy import lands;
// every failure path degrades to plain pass-through.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTrzszBridge, TRZSZ_MAGIC_RE, type TrzszFilterLike } from './trzsz';

const MAGIC = '::TRZSZ:TRANSFER:S:1.1.6:1234';

interface FakeFilter extends TrzszFilterLike {
  outputs: string[];
  inputs: string[];
  columns: number[];
  stops: number;
  transferring: boolean;
}

const createFake = (): FakeFilter => {
  const fake: FakeFilter = {
    outputs: [],
    inputs: [],
    columns: [],
    stops: 0,
    transferring: false,
    processServerOutput: (data) => void fake.outputs.push(data),
    processTerminalInput: (input) => void fake.inputs.push(input),
    setTerminalColumns: (cols) => void fake.columns.push(cols),
    isTransferringFiles: () => fake.transferring,
    stopTransferringFiles: () => void (fake.stops += 1),
  };
  return fake;
};

/** A loader whose promise the test resolves by hand, so ordering is observable. */
const createLoader = () => {
  const calls: { terminalColumns: number }[] = [];
  let settle!: (filter: TrzszFilterLike) => void;
  let fail!: (err: unknown) => void;
  const promise = new Promise<TrzszFilterLike>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  const loadFilter = (opts: { terminalColumns: number }) => {
    calls.push(opts);
    return promise;
  };
  return { calls, loadFilter, settle, fail };
};

/** Let the bridge's own `.then`/`.catch` chain run to completion. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const setup = () => {
  const written: string[] = [];
  const sent: string[] = [];
  const loader = createLoader();
  const bridge = createTrzszBridge({
    writeToTerminal: (d) => void written.push(d),
    sendToServer: (d) => void sent.push(d),
    getColumns: () => 80,
    loadFilter: loader.loadFilter,
  });
  return { bridge, written, sent, loader };
};

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TRZSZ_MAGIC_RE', () => {
  it('matches the handshake and nothing else', () => {
    expect(TRZSZ_MAGIC_RE.test(MAGIC)).toBe(true);
    expect(TRZSZ_MAGIC_RE.test('::TRZSZ:TRANSFER:R:1.0.0')).toBe(true);
    expect(TRZSZ_MAGIC_RE.test('trz -d')).toBe(false);
  });
});

describe('createTrzszBridge', () => {
  it('passes output through byte-identically without loading the library', () => {
    const { bridge, written, loader } = setup();
    const chunks = ['ls -la\r\n', '\x1b[0m\x1b[32mfile\x1b[0m', 'not ::TRZSZ: really'];
    for (const chunk of chunks) bridge.processOutput(chunk);
    expect(written).toEqual(chunks);
    expect(loader.calls).toHaveLength(0);
  });

  it('loads the filter exactly once, however many magic chunks arrive', async () => {
    const { bridge, loader } = setup();
    bridge.processOutput(MAGIC);
    bridge.processOutput(MAGIC);
    expect(loader.calls).toHaveLength(1);

    loader.settle(createFake());
    await flush();
    bridge.processOutput(MAGIC);
    expect(loader.calls).toHaveLength(1);
  });

  it('replays chunks buffered during the import, detecting chunk first', async () => {
    const { bridge, written, loader } = setup();
    bridge.processOutput('before\r\n');
    bridge.processOutput(`prompt$ ${MAGIC}`);
    bridge.processOutput('mid-transfer-1');
    bridge.processOutput('mid-transfer-2');
    expect(written).toEqual(['before\r\n']);

    const fake = createFake();
    loader.settle(fake);
    await flush();
    expect(fake.outputs).toEqual([`prompt$ ${MAGIC}`, 'mid-transfer-1', 'mid-transfer-2']);

    bridge.processOutput('after');
    expect(fake.outputs).toHaveLength(4);
    expect(written).toEqual(['before\r\n']);
  });

  it('flushes the buffer to the terminal and stays pass-through when the import fails', async () => {
    const { bridge, written, loader } = setup();
    bridge.processOutput(MAGIC);
    bridge.processOutput('tail');
    loader.fail(new Error('chunk load failed'));
    await flush();

    expect(written).toEqual([MAGIC, 'tail']);
    expect(console.error).toHaveBeenCalledTimes(1);

    bridge.processOutput(MAGIC);
    bridge.processOutput('more');
    expect(written).toEqual([MAGIC, 'tail', MAGIC, 'more']);
    expect(loader.calls).toHaveLength(1);
    expect(bridge.processInput('x')).toBe(false);
  });

  it('falls back to pass-through when the buffer exceeds its cap', async () => {
    const { bridge, written, loader } = setup();
    bridge.processOutput(MAGIC);
    const huge = 'x'.repeat(2 * 1024 * 1024 + 1);
    bridge.processOutput(huge);

    expect(written).toEqual([MAGIC, huge]);
    expect(console.warn).toHaveBeenCalledTimes(1);

    const fake = createFake();
    loader.settle(fake);
    await flush();
    bridge.processOutput('after');
    expect(fake.outputs).toEqual([]);
    expect(written).toEqual([MAGIC, huge, 'after']);
  });

  // Behaviour CHANGED deliberately. This used to claim input the moment a filter
  // existed, which meant a magic string that led to NO transfer — anything can
  // print one; `cat` a log — swallowed every keystroke from then on, and the
  // shell just stopped responding. `processTerminalInput` exists to let Ctrl-C
  // abort a transfer, so it is gated on there being one.
  it('claims terminal input only while a transfer is actually running', async () => {
    const { bridge, loader } = setup();
    expect(bridge.processInput('a')).toBe(false);

    bridge.processOutput(MAGIC);
    expect(bridge.processInput('b')).toBe(false);

    const fake = createFake();
    loader.settle(fake);
    await flush();
    // Filter installed, nothing transferring: the keystroke belongs to the shell.
    expect(bridge.processInput('c')).toBe(false);
    expect(fake.inputs).toEqual([]);

    fake.transferring = true;
    expect(bridge.processInput('d')).toBe(true);
    expect(fake.inputs).toEqual(['d']);

    // And it hands input back the moment the transfer ends.
    fake.transferring = false;
    expect(bridge.processInput('e')).toBe(false);
    expect(fake.inputs).toEqual(['d']);
  });

  it('applies a pre-load column change to the filter it later creates', async () => {
    const { bridge, loader } = setup();
    bridge.setColumns(120);
    bridge.processOutput(MAGIC);
    expect(loader.calls[0]?.terminalColumns).toBe(120);

    const fake = createFake();
    loader.settle(fake);
    await flush();
    bridge.setColumns(100);
    expect(fake.columns).toEqual([100]);
  });

  it('stops an in-flight transfer on dispose and then goes inert', async () => {
    const { bridge, written, loader } = setup();
    bridge.processOutput(MAGIC);
    const fake = createFake();
    fake.transferring = true;
    loader.settle(fake);
    await flush();

    bridge.dispose();
    expect(fake.stops).toBe(1);
    expect(bridge.isTransferring()).toBe(false);

    bridge.processOutput('ignored');
    expect(bridge.processInput('x')).toBe(false);
    bridge.setColumns(10);
    bridge.dispose();
    expect(fake.stops).toBe(1);
    expect(fake.outputs).toEqual([MAGIC]);
    expect(written).toEqual([]);
  });

  it('survives a filter that throws, writing the chunk to the terminal instead', async () => {
    const { bridge, written, loader } = setup();
    bridge.processOutput(MAGIC);
    const fake = createFake();
    fake.processServerOutput = () => {
      throw new Error('boom');
    };
    loader.settle(fake);
    await flush();

    expect(() => bridge.processOutput('after')).not.toThrow();
    expect(written).toEqual([MAGIC, 'after']);
  });
});

// ── The idle stand-down ───────────────────────────────────────────────────────
//
// The filter is installed by a magic string in the OUTPUT, which any program can
// print. Without a way back, a false handshake left the terminal behind a
// file-transfer filter permanently. Twenty seconds of silence with no transfer
// running is not a transfer.
describe('trzsz idle stand-down', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const install = async () => {
    const { bridge, loader, written } = setup();
    bridge.processOutput(MAGIC);
    const fake = createFake();
    loader.settle(fake);
    await vi.advanceTimersByTimeAsync(0);
    return { bridge, fake, written };
  };

  it('drops the filter after 20 idle seconds and writes straight to the terminal', async () => {
    const { bridge, fake, written } = await install();
    fake.outputs.length = 0;
    written.length = 0;

    await vi.advanceTimersByTimeAsync(20_000);

    bridge.processOutput('hello');
    expect(fake.outputs).toEqual([]);
    expect(written).toEqual(['hello']);
  });

  it('never interrupts a live transfer, however quiet', async () => {
    const { bridge, fake } = await install();
    fake.transferring = true;
    fake.outputs.length = 0;

    await vi.advanceTimersByTimeAsync(120_000);

    bridge.processOutput('chunk');
    expect(fake.outputs).toEqual(['chunk']);
  });

  it('keeps the countdown alive while bytes are flowing', async () => {
    const { bridge, fake } = await install();
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
      bridge.processOutput(`tick${i}`);
    }
    fake.outputs.length = 0;
    bridge.processOutput('still filtered');
    expect(fake.outputs).toEqual(['still filtered']);
  });

  // Standing down is not abandoning: a real transfer later must still work.
  it('re-arms detection, so a later handshake installs a filter again', async () => {
    const { bridge } = await install();
    await vi.advanceTimersByTimeAsync(20_000);
    bridge.processOutput(MAGIC);
    // Buffered pending a fresh import rather than written straight through —
    // which is exactly what the detecting state does.
    expect(bridge.isTransferring()).toBe(false);
  });

  it('stops a transfer it is tearing down, and leaves no timer after dispose', async () => {
    const { bridge, fake } = await install();
    bridge.dispose();
    expect(fake.stops).toBe(0); // nothing was transferring
    await vi.advanceTimersByTimeAsync(60_000);
    expect(vi.getTimerCount()).toBe(0);
  });
});
