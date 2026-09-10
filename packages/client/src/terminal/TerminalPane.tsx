// ── Terminal pane ─────────────────────────────────────────────────────────────
//
// A self-contained terminal instance: its own xterm (via useTerminal), its own
// per-session data WsClient (binary/snapshot/exit only — the app's control
// channel is a separate socket in App), its own replay-suppression and DA/DSR
// report-gating (per-document hasFocus, unchanged from the single-terminal app),
// its own fit/resize, exit overlay (per-pane reconnect, never a full reload),
// file upload, and mobile gestures. App renders one (single slot) or two (split)
// of these; the mobile input surfaces route to the focused one via the registry.

import { useCallback, useEffect, useRef, useState, type CSSProperties, type Ref } from 'react';
import type { ClientSettings } from '../settings/settings';
import { resolveMobileMode } from '../settings/settings';
import { useTerminal } from './useTerminal';
import { SearchBar } from './SearchBar';
import { useFileUpload } from './useFileUpload';
import { createMouseGate, type MouseGate } from './mouse-frames';
import { createTrzszBridge, type TrzszBridge } from './trzsz';
import { latin1Decode, writeMixed } from './byte-codec';
import { createLatencyRecorder } from '../diagnostics/latency';
import { LatencyOverlay } from '../diagnostics/LatencyOverlay';
import { copyText } from '../mobile/clipboard';
import { LinkMenu, type LinkMenuState } from './LinkMenu';
import { Button } from '../ui/Button';
import { cell0FromClient } from './touch';
import { openLink } from './useTerminal';
import { useMobileGestures } from '../mobile/useMobileGestures';
import { WsClient } from '../lib/ws';
import { wsUrlFor } from '../session/session-url';
import type { PaneApi, SlotId, SplitRegistry } from '../session/SplitFocusContext';

interface TerminalPaneProps {
  slot: SlotId;
  sessionId: string;
  registry: SplitRegistry;
  settings: ClientSettings;
  mobileActive: boolean;
  /** True when this slot is the focused one (drives the clipboard combo + focus). */
  focused: boolean;
  /** True when a split is active — renders the slot focus ring. */
  inSplit: boolean;
  /** True during a divider drag — fit visually but defer the PTY resize until
   *  settle, so a drag doesn't storm the shell with SIGWINCH/redraws. */
  resizePaused?: boolean | undefined;
  /** Absolute rect (position/size) applied to the pane wrapper. */
  style?: CSSProperties | undefined;
  maxUploadBytes: number;
  /** App-level block (a panel/chooser is up) — drop terminal input while set. */
  isBlocked: () => boolean;
  onAutoCopy: () => void;
  onUploadError: (msg: string) => void;
  /** Tap/click focuses this slot. */
  onFocusRequest: (slot: SlotId) => void;
  /** Read-and-clear the tmux session a freshly chosen terminal should open in.
   *  App owns the pending map; the pane consumes it as it opens the socket. */
  takeSpawnTmux?: ((id: string) => string | null | undefined) | undefined;
  /** Mobile gesture callbacks (owned by App; the soft keyboard lives there). */
  gestures: MobileGestures;
}

export interface MobileGestures {
  getFontSize: () => number;
  setFontSize: (px: number) => void;
  focusKeyboard: () => void;
}

export const TerminalPane = ({
  slot,
  sessionId,
  registry,
  settings,
  mobileActive,
  focused,
  inSplit,
  resizePaused,
  style,
  maxUploadBytes,
  isBlocked,
  onAutoCopy,
  onUploadError,
  onFocusRequest,
  takeSpawnTmux,
  gestures,
}: TerminalPaneProps) => {
  const wsRef = useRef<WsClient | null>(null);
  const wsGenRef = useRef(0);
  const suppressInputRef = useRef(false);
  // Held in a ref so a new callback identity from App cannot re-open the socket.
  const takeSpawnTmuxRef = useRef(takeSpawnTmux);
  takeSpawnTmuxRef.current = takeSpawnTmux;
  const replayPendingRef = useRef(false);
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  const isBlockedRef = useRef(isBlocked);
  isBlockedRef.current = isBlocked;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const [exited, setExited] = useState(false);
  const [detached, setDetached] = useState(false);
  const [reconnectNonce, setReconnectNonce] = useState(0);
  // Focus target for the exit overlay. xterm keeps DOM focus when the socket
  // dies, so without this the only actionable control in the app is behind an
  // unknown number of Tab presses.
  const exitButtonRef = useRef<HTMLButtonElement | null>(null);
  // Stable identity for THIS pane, for the server's one-active-client rule. Held
  // in a ref so it survives reconnects AND an explicit Take-back (which builds a
  // fresh socket): both are the same logical client reclaiming its own session.
  const clientKeyRef = useRef<string>(
    globalThis.crypto?.randomUUID?.() ?? `c${Math.random().toString(36).slice(2)}`,
  );

  // Move focus onto the overlay's action as it appears — and only then, so a
  // healthy pane never has focus stolen from the terminal.
  useEffect(() => {
    if (exited || detached) exitButtonRef.current?.focus();
  }, [exited, detached]);

  const sendInput = useCallback((t: string) => wsRef.current?.sendInput(t) ?? false, []);
  // During a divider drag, fit locally but defer the PTY resize to settle.
  const resizePausedRef = useRef(resizePaused);
  resizePausedRef.current = resizePaused;
  const pendingSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const onResize = useCallback((cols: number, rows: number) => {
    if (resizePausedRef.current) {
      pendingSizeRef.current = { cols, rows };
      return;
    }
    wsRef.current?.sendResize(cols, rows);
  }, []);
  // Flush the deferred size when the drag settles.
  useEffect(() => {
    if (resizePaused) return;
    const p = pendingSizeRef.current;
    if (p) {
      pendingSizeRef.current = null;
      wsRef.current?.sendResize(p.cols, p.rows);
    }
  }, [resizePaused]);

  // SGR mouse frames get their own gate: motion is dropped while unfocused and
  // throttled while focused (see mouse-frames.ts); clicks/wheel pass through.
  const mouseGateRef = useRef<MouseGate | null>(null);
  if (mouseGateRef.current === null) {
    mouseGateRef.current = createMouseGate({ send: (b) => void wsRef.current?.sendInput(b) });
  }
  useEffect(() => () => mouseGateRef.current?.dispose(), []);

  // In-band trzsz. Inert (pure pass-through, library never downloaded) until a
  // handshake appears in the PTY output.
  const trzszRef = useRef<TrzszBridge | null>(null);
  const latencyRef = useRef(createLatencyRecorder());

  // DA/DSR REPORTS ARE NO LONGER GATED ON FOCUS. They used to be dropped while
  // the document was unfocused and for a second after it regained focus, as a
  // proxy for "these are answers to REPLAYED queries, not live ones". That proxy
  // is obsolete — `suppressInputRef` above covers the replay exactly: the server
  // sends the ring as ONE binary frame after the `snapshot` marker, and the flag
  // is held across that whole `write()` until its completion callback fires.
  //
  // Keeping the proxy actively broke capability negotiation, which is the ONE
  // thing that must survive an attach. tmux queries DA1 the moment its client
  // attaches — for an auto-attached or session-restored shell that is a few
  // hundred ms after mount, i.e. inside the old grace window — so the reply was
  // swallowed and tmux concluded the terminal had no `sixel` feature, drawing its
  // "SIXEL IMAGE (WxH)" placeholder instead of passing images through. Verified
  // both ways: DA1 `?62;4;9;22c` → tmux `client_termfeatures` gains `sixel`;
  // `?1;2c` → it does not. An unfocused pane answering its own app's query is
  // correct anyway — nothing else can consume that reply.
  const onData = useCallback((d: string) => {
    if (suppressInputRef.current) return;
    if (isBlockedRef.current()) return; // a panel/chooser is up — no terminal to type into
    if (mouseGateRef.current?.feed(d)) return; // motion frame: dropped or queued
    // A live trzsz transfer owns the input stream (its own control protocol).
    if (trzszRef.current?.processInput(d)) return;
    if (settingsRef.current.latencyOverlay) latencyRef.current.markInput(performance.now());
    wsRef.current?.sendInput(d);
  }, []);

  const getFocused = useCallback(() => focusedRef.current, []);

  // File upload: paste / drop / picker → POST /upload → inject the temp path.
  const uploadPasteRef = useRef<(file: File) => void>(() => {});
  const onPasteImage = useCallback((file: File) => uploadPasteRef.current(file), []);

  const [searchOpen, setSearchOpen] = useState(false);
  const [linkMenu, setLinkMenu] = useState<LinkMenuState | null>(null);
  const {
    ref,
    instance,
    fit,
    refreshFont,
    refreshTheme,
    syncCursor,
    serialize,
    copyLastOutput,
    search,
    linkAt,
    outputZone,
    clearLinks,
  } = useTerminal({
    settings,
    onData,
    onResize,
    onAutoCopy,
    onPasteImage,
    getFocused,
    onSearch: () => setSearchOpen(true),
  });

  // A block cursor fills only while this slot is the focused one — re-evaluate
  // whenever slot focus changes (window focus/visibility is handled internally).
  useEffect(() => {
    syncCursor();
  }, [focused, syncCursor]);

  const instanceRef = useRef(instance);
  instanceRef.current = instance;
  const wrapRef = useRef<HTMLDivElement>(null);

  const onUploaded = useCallback(() => {
    if (!resolveMobileMode(settingsRef.current.mobileMode)) instanceRef.current?.focus();
  }, []);
  const { dragActive, openPicker, openImagePicker, uploadFile } = useFileUpload({
    sendToPty: sendInput,
    sessionId,
    maxBytes: maxUploadBytes,
    wrapRef,
    isBlocked,
    getFocused,
    onUploaded,
    onError: onUploadError,
  });
  uploadPasteRef.current = (file) => void uploadFile(file);

  // Mobile gestures bind to THIS pane's host + term (per-pane, coordinate-local).
  useMobileGestures({
    host: ref.current,
    term: instance,
    active: mobileActive,
    sendInput,
    ...gestures,
    isBlocked,
    linkAt,
    outputZone,
    nativeSelection: settings.nativeTouchSelection,
  });

  // Right-click on a link cell → our menu; anywhere else the browser's own menu
  // is left alone, so this never steals a gesture meant for something else.
  useEffect(() => {
    const host = ref.current;
    if (!instance || !host || mobileActive) return;
    const onContextMenu = (e: MouseEvent) => {
      const { col, row } = cell0FromClient(instance, host, e.clientX, e.clientY);
      const url = linkAt(col, instance.buffer.active.viewportY + row);
      if (!url) return;
      e.preventDefault();
      setLinkMenu({ url, x: e.clientX, y: e.clientY });
    };
    host.addEventListener('contextmenu', onContextMenu);
    return () => host.removeEventListener('contextmenu', onContextMenu);
  }, [instance, mobileActive, linkAt, ref]);

  // Re-fit preserving the active selection (keyboard toggle / divider resize
  // clears it otherwise). getSelectionPosition is 1-based; select() is 0-based.
  const refit = useCallback(() => {
    const inst = instanceRef.current;
    const sel = inst?.hasSelection() ? inst.getSelectionPosition() : undefined;
    // Capture the column count BEFORE the fit — the selection length is in the
    // pre-fit grid; reading inst.cols after fit() would use the new width.
    const preCols = inst?.cols ?? 0;
    fit();
    if (inst && sel) {
      const length = (sel.end.y - sel.start.y) * preCols + (sel.end.x - sel.start.x);
      if (length > 0) inst.select(sel.start.x - 1, sel.start.y - 1, length);
    }
  }, [fit]);

  // Per-session data socket: binary/snapshot/exit only. App owns the control
  // channel (tab list / settings / fonts) on a separate socket.
  useEffect(() => {
    if (!instance) return;
    const gen = ++wsGenRef.current;
    replayPendingRef.current = false;
    suppressInputRef.current = false;
    // The pane is keyed by SLOT, so a tab switch swaps sessionId in place: a
    // motion frame queued for the old session must never fire into the new
    // session's PTY (dispose clears pending + timer; the gate stays usable).
    mouseGateRef.current?.dispose();
    setExited(false);
    instance.reset();
    // A reset restarts absolute buffer coordinates, and the OSC 8 ranges are
    // keyed by them — without this a link from the previous tab survives and
    // attaches to whatever the new session draws in the same cells.
    clearLinks();

    // Consumed HERE, not at mount: the pane is keyed by slot, so one instance
    // serves many tabs. Baking it into the socket URL (rather than sending it
    // after connect) is what makes it race-free — this attach is what spawns the
    // shell, so there is no window in which the shell exists without it.
    const tmux = takeSpawnTmuxRef.current?.(sessionId);
    const ws = new WsClient(wsUrlFor(sessionId, 'terminal', clientKeyRef.current, tmux));
    wsRef.current = ws;
    let exitTimer: ReturnType<typeof setTimeout> | undefined;

    // Server bytes pass through the trzsz bridge, which is a no-op memcpy until a
    // handshake shows up. Latin-1 keeps the round-trip byte-identical.
    const bridge = createTrzszBridge({
      writeToTerminal: (data) => {
        writeMixed((d) => instance.write(d as string), data);
        if (settingsRef.current.latencyOverlay) {
          requestAnimationFrame(() => latencyRef.current.markPaint(performance.now()));
        }
      },
      sendToServer: (data) => void wsRef.current?.sendInput(data),
      getColumns: () => instance.cols,
    });
    trzszRef.current = bridge;

    ws.onBinary((buf) => {
      try {
        if (replayPendingRef.current) {
          replayPendingRef.current = false;
          suppressInputRef.current = true;
          // Replay must clear the suppression flag on completion, so it bypasses
          // the bridge — a handshake can't be mid-replay anyway (it is history).
          //
          // It also bypasses the DECODE. This branch writes the bytes directly,
          // so the latin1Decode that used to run before the `if` was building a
          // string of up to 512 KB, character by character, purely to discard
          // it — once per tab switch, on the path the user is waiting on.
          instance.write(new Uint8Array(buf), () => {
            if (wsGenRef.current === gen) suppressInputRef.current = false;
          });
        } else {
          bridge.processOutput(latin1Decode(new Uint8Array(buf)));
        }
      } catch {
        /* terminal disposed */
      }
    });
    ws.onMessage((msg) => {
      if (msg.type === 'snapshot') replayPendingRef.current = true;
      else if (msg.type === 'exit') {
        ws.stopReconnect();
        // A closed ACTIVE tab navigates to its strip neighbor within a frame or
        // two (App's sessions handler) and unmounts this pane — delaying the
        // overlay means the user never sees a Reconnect flash mid-navigation.
        // A pane that STAYS (popout, no-neighbor races) still gets it.
        exitTimer = setTimeout(() => setExited(true), 250);
      } else if (msg.type === 'detached') {
        // Another client took the session over. The shell is fine — we just
        // don't own it. Suppress the auto-reconnect (it would fight the new
        // owner forever) and offer to take it back on purpose. No 250ms delay:
        // this is never a navigation race, and the screen is stale immediately.
        ws.stopReconnect();
        setDetached(true);
      }
      // sessions / settings / extraKeys / fonts / ready / tabCreated arrive here
      // too (broadcasts go to every socket) but are the control socket's job.
    });
    ws.onOpen(() => {
      setExited(false);
      setDetached(false);
      ws.sendResize(instance.cols, instance.rows);
    });
    ws.connect();

    return () => {
      clearTimeout(exitTimer);
      if (wsRef.current === ws) wsRef.current = null;
      bridge.dispose();
      if (trzszRef.current === bridge) trzszRef.current = null;
      ws.destroy();
    };
  }, [instance, sessionId, reconnectNonce, clearLinks]);

  // Neutralize xterm's own textarea on mobile so all input flows through App's
  // #mobile-kbd (incremental IME). Intact on desktop.
  useEffect(() => {
    if (!instance) return;
    instance.options.disableStdin = mobileActive;
    const xta = instance.textarea;
    if (!xta) return;
    if (mobileActive) {
      xta.setAttribute('inputmode', 'none');
      xta.readOnly = true;
      xta.tabIndex = -1;
      xta.blur();
    } else {
      xta.removeAttribute('inputmode');
      xta.readOnly = false;
      xta.tabIndex = 0;
    }
  }, [instance, mobileActive]);

  // Register this pane's API for the shared input surfaces; keep it live.
  useEffect(() => {
    if (!instance) return;
    const api: PaneApi = {
      sendInput,
      // NOT instance.paste(): xterm silently drops ALL input (triggerDataEvent)
      // while options.disableStdin is set — which the mobile layer does above.
      // A programmatic paste (dictation) must reach the PTY on both layouts, so
      // mirror xterm's paste transform (\n → \r, bracket while the app has
      // bracketed paste on) over sendInput directly.
      paste: (t) => {
        const text = t.replace(/\r?\n/g, '\r');
        return sendInput(instance.modes.bracketedPasteMode ? `\x1b[200~${text}\x1b[201~` : text);
      },
      pasteImage: (file) => void uploadFile(file),
      openPicker,
      openImagePicker,
      focus: () => instance.focus(),
      blur: () => instance.blur(),
      refit,
      refreshFont,
      refreshTheme,
      exportScrollback: () => serialize(),
      copyLastOutput: () => copyLastOutput(),
      openSearch: () => setSearchOpen(true),
      term: () => instanceRef.current,
      container: () => wrapRef.current,
    };
    return registry.register(slot, api);
  }, [
    instance,
    slot,
    registry,
    sendInput,
    openPicker,
    openImagePicker,
    uploadFile,
    refit,
    refreshFont,
    refreshTheme,
    serialize,
    copyLastOutput,
  ]);

  // Desktop focus follows a click on the pane; mobile focus is single-slot.
  const focusThisSlot = useCallback(() => onFocusRequest(slot), [onFocusRequest, slot]);

  const cls =
    `term-wrap${dragActive ? ' drag-active' : ''}` +
    (inSplit ? ' slot' : '') +
    (inSplit && focused ? ' focused' : '');

  return (
    <div
      className={cls}
      style={style}
      ref={wrapRef}
      onMouseDown={focusThisSlot}
      data-testid={`term-pane-${slot}`}
    >
      <div className="term-host" ref={ref as Ref<HTMLDivElement>} />
      {searchOpen && <SearchBar search={search} onClose={() => setSearchOpen(false)} />}
      {linkMenu && (
        <LinkMenu
          state={linkMenu}
          onOpen={openLink}
          onCopy={(url) => void copyText(url)}
          onClose={() => setLinkMenu(null)}
        />
      )}
      {settings.latencyOverlay && <LatencyOverlay recorder={latencyRef.current} />}
      {(exited || detached) && (
        // A real dialog, not a decorated div. The pane behind it is a frozen
        // last frame and this button is the only way out, so a keyboard user
        // must not have to discover it by tabbing past a terminal that still
        // holds focus — `alertdialog` announces it, and the ref below moves
        // focus onto the action as it mounts.
        <div className="exit-overlay">
          <div
            className="exit-card"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={`exit-msg-${sessionId}`}
            aria-describedby={`exit-hint-${sessionId}`}
          >
            <p className="exit-card-msg" id={`exit-msg-${sessionId}`}>
              {detached ? 'Opened somewhere else.' : 'Session ended.'}
            </p>
            <p className="exit-card-hint" id={`exit-hint-${sessionId}`}>
              {detached
                ? 'Another view attached to this terminal and took it over.'
                : 'The shell exited. Reconnecting starts a new one.'}
            </p>
            <Button
              ref={exitButtonRef}
              variant="primary"
              data-testid="exit-reconnect"
              onClick={() => setReconnectNonce((n) => n + 1)}
            >
              {detached ? 'Take back' : 'Reconnect'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};
