// ── xterm host hook ───────────────────────────────────────────────────────────
//
// Owns one `Terminal`: creates it, opens it on the returned ref, disposes it.
// Nothing else — every addon, listener and imperative tweak lives in
// `useTerminal`, which is the only caller.
//
// This replaces react-xtermjs, which did exactly this and peer-depended on
// `@xterm/xterm@^5.5.0`. That pin was the only thing standing between palmux and
// xterm 6, for a wrapper it used for a single import.
//
// The Terminal is recreated whenever `options` changes identity, so the caller
// must pass a STABLE object and apply later setting changes imperatively.

import { useEffect, useRef, useState, type RefObject } from 'react';
import { Terminal, type ITerminalInitOnlyOptions, type ITerminalOptions } from '@xterm/xterm';

export interface UseXTermResult {
  ref: RefObject<HTMLDivElement | null>;
  instance: Terminal | null;
}

export function useXTerm(options: ITerminalOptions & ITerminalInitOnlyOptions): UseXTermResult {
  const ref = useRef<HTMLDivElement | null>(null);
  const [instance, setInstance] = useState<Terminal | null>(null);

  useEffect(() => {
    const term = new Terminal(options);
    if (ref.current) {
      term.open(ref.current);
      term.focus();
    }
    setInstance(term);
    return () => {
      term.dispose();
      setInstance(null);
    };
  }, [options]);

  return { ref, instance };
}
