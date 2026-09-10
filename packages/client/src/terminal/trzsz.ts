// ── trzsz in-band file transfer (lazy) ────────────────────────────────────────
//
// `trz`/`tsz` announce themselves with a magic marker in the PTY output; from
// that point the byte stream is a transfer protocol, not terminal output, and
// must be routed through the trzsz filter instead of xterm.
//
// The library is ~3.6 MB unpacked, so a terminal-only user must download none
// of it: the bridge does its own (cheap) magic detection and only then
// `import('trzsz')`. That import is async, so the detecting chunk and every
// chunk behind it are buffered (bounded) and replayed into the filter in order
// once it exists. Every failure mode — import rejection, buffer overflow, a
// throwing filter — degrades to plain pass-through: a broken optional feature
// must never take the terminal down with it.

/** The handshake marker, verbatim from the trzsz protocol. */
export const TRZSZ_MAGIC_RE = /::TRZSZ:TRANSFER:([SRD]):(\d+\.\d+\.\d+)(:\d+)?/;

/** Cap on buffered output while the import is in flight. */
const MAX_BUFFERED_CHARS = 2 * 1024 * 1024;

/**
 * Idle time after which an installed filter is torn down and the bridge returns
 * to plain detection.
 *
 * The filter is installed by a MAGIC STRING IN THE OUTPUT, which any program can
 * print — `cat` a log containing one and the terminal is behind a file-transfer
 * filter with no transfer to end it. Before this, that state had no exit: every
 * byte, in both directions, went through trzsz until the pane was closed.
 *
 * Twenty seconds of silence with no transfer running is not a transfer. Standing
 * down is cheap — the module is already in the bundle cache, so a real transfer
 * that starts later re-installs it without another download.
 */
const IDLE_STAND_DOWN_MS = 20_000;

/** The slice of `TrzszFilter` the bridge uses. */
export interface TrzszFilterLike {
  processServerOutput(data: string): void;
  processTerminalInput(input: string): void;
  setTerminalColumns(cols: number): void;
  isTransferringFiles(): boolean;
  stopTransferringFiles(): void;
}

export interface TrzszBridgeOptions {
  writeToTerminal(data: string): void;
  sendToServer(data: string): void;
  getColumns(): number;
  /** Injectable for tests; defaults to the real lazy `import('trzsz')`. */
  loadFilter?: (opts: {
    writeToTerminal: (d: string) => void;
    sendToServer: (d: string) => void;
    terminalColumns: number;
  }) => Promise<TrzszFilterLike>;
}

export interface TrzszBridge {
  /** Server -> terminal bytes. Pass-through until a handshake is seen. */
  processOutput(data: string): void;
  /** Terminal -> server bytes. Returns true when trzsz consumed the input. */
  processInput(data: string): boolean;
  isTransferring(): boolean;
  setColumns(cols: number): void;
  dispose(): void;
}

// We only ever feed strings in, so only strings come back out; the binary arms
// exist solely to satisfy the library's (webshell-oriented) wider callback type.
const asText = (data: string | ArrayBuffer | Uint8Array | Blob): string =>
  typeof data === 'string' ? data : data instanceof Blob ? '' : new TextDecoder().decode(data);

const defaultLoadFilter = async (opts: {
  writeToTerminal: (d: string) => void;
  sendToServer: (d: string) => void;
  terminalColumns: number;
}): Promise<TrzszFilterLike> => {
  const { TrzszFilter } = await import('trzsz');
  return new TrzszFilter({
    writeToTerminal: (out) => opts.writeToTerminal(asText(out)),
    sendToServer: (input) => opts.sendToServer(asText(input)),
    terminalColumns: opts.terminalColumns,
  });
};

export function createTrzszBridge(options: TrzszBridgeOptions): TrzszBridge {
  const { writeToTerminal, sendToServer, getColumns, loadFilter = defaultLoadFilter } = options;

  let filter: TrzszFilterLike | null = null;
  let loading = false;
  let abandoned = false; // import failed / buffer overflowed — pass-through forever
  let disposed = false;
  let columns: number | null = null;
  let buffered: string[] = [];
  let bufferedChars = 0;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const guard = (run: () => void): boolean => {
    try {
      run();
      return true;
    } catch (err) {
      console.error('[trzsz] filter threw; falling back to the terminal', err);
      return false;
    }
  };

  const flushBufferToTerminal = () => {
    const pending = buffered;
    buffered = [];
    bufferedChars = 0;
    for (const chunk of pending) writeToTerminal(chunk);
  };

  const abandon = () => {
    abandoned = true;
    clearIdle();
    flushBufferToTerminal();
  };

  function clearIdle(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  }

  /**
   * Drop the filter and go back to DETECTING — unlike `abandon`, which is
   * permanent. Nothing is lost: the filter holds no terminal state of its own,
   * and a later handshake re-installs it.
   */
  const standDown = (): void => {
    clearIdle();
    const target = filter;
    filter = null;
    if (!target) return;
    guard(() => {
      if (target.isTransferringFiles()) target.stopTransferringFiles();
    });
  };

  /** Restart the idle countdown; called on every byte while a filter is live. */
  const touch = (): void => {
    clearIdle();
    if (!filter || disposed) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      // A long transfer can be quiet between chunks — never interrupt one.
      if (isTransferring()) {
        touch();
        return;
      }
      standDown();
    }, IDLE_STAND_DOWN_MS);
  };

  const feedFilter = (target: TrzszFilterLike, chunk: string) => {
    if (!guard(() => target.processServerOutput(chunk))) writeToTerminal(chunk);
  };

  const startLoading = () => {
    loading = true;
    const cols = columns ?? getColumns();
    loadFilter({ writeToTerminal, sendToServer, terminalColumns: cols })
      .then((created) => {
        loading = false;
        if (disposed || abandoned) return;
        filter = created;
        const latest = columns; // a resize may have landed while the import was in flight
        if (latest !== null && latest !== cols) guard(() => created.setTerminalColumns(latest));
        const pending = buffered;
        buffered = [];
        bufferedChars = 0;
        for (const chunk of pending) feedFilter(created, chunk);
        touch();
      })
      .catch((err: unknown) => {
        loading = false;
        console.error('[trzsz] failed to load the file-transfer filter', err);
        if (!disposed) abandon();
      });
  };

  const buffer = (chunk: string) => {
    buffered.push(chunk);
    bufferedChars += chunk.length;
    if (bufferedChars <= MAX_BUFFERED_CHARS) return;
    console.warn('[trzsz] buffered output exceeded the cap; falling back to pass-through');
    abandon();
  };

  const processOutput = (data: string): void => {
    if (disposed) return;
    if (filter) {
      feedFilter(filter, data);
      touch();
      return;
    }
    if (loading) {
      buffer(data);
      return;
    }
    if (!abandoned && TRZSZ_MAGIC_RE.test(data)) {
      startLoading();
      buffer(data);
      return;
    }
    clearIdle();
    writeToTerminal(data);
  };

  /**
   * Divert a keystroke into the filter — ONLY while a transfer is actually
   * running, which is the only thing `processTerminalInput` is for (it is how
   * Ctrl-C aborts one).
   *
   * It used to divert whenever a filter existed, so a filter installed by a
   * magic string that led to no transfer swallowed every keystroke from then on:
   * the shell simply stopped responding, with nothing on screen to say why.
   */
  const processInput = (data: string): boolean => {
    if (disposed || !filter || !isTransferring()) return false;
    const target = filter;
    return guard(() => target.processTerminalInput(data));
  };

  const isTransferring = (): boolean => {
    if (disposed || !filter) return false;
    try {
      return filter.isTransferringFiles();
    } catch {
      return false;
    }
  };

  const setColumns = (cols: number): void => {
    if (disposed) return;
    columns = cols;
    if (!filter) return;
    const target = filter;
    guard(() => target.setTerminalColumns(cols));
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    clearIdle();
    buffered = [];
    bufferedChars = 0;
    const target = filter;
    filter = null;
    if (!target) return;
    guard(() => {
      if (target.isTransferringFiles()) target.stopTransferringFiles();
    });
  };

  return { processOutput, processInput, isTransferring, setColumns, dispose };
}
