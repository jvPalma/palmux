// ── Terminal hook ─────────────────────────────────────────────────────────────
//
// Wraps the local useXTerm host. The hook recreates the Terminal whenever the
// `options` identity changes, so we pass a STABLE options object (captured from
// the first render) and apply later setting changes imperatively. All addons —
// including WebGL, which must load after open() — are loaded in our own effect.

import { useCallback, useEffect, useMemo, useRef, type RefObject } from 'react';
import { useXTerm } from './useXTerm';
import type { ITerminalInitOnlyOptions, ITerminalOptions, Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { SerializeAddon } from '@xterm/addon-serialize';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { createOsc8Tracker, findRegexLinkInRow, isSafeUrl, normalizeUrl } from './links';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import { ImageAddon } from '@xterm/addon-image';
import { imageAddonOptions } from './image-support';
import { resolveMobileMode, type ClientSettings } from '../settings/settings';
import { getProfile, toXtermTheme } from '../settings/themes';
import { ensureColorEmojiFont, withSymbolFallback } from '../settings/fonts';
import { copyText } from '../mobile/clipboard';
import { stripTrailingSpaces } from './copy-text';

export interface UseTerminalParams {
  settings: ClientSettings;
  onData: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
  /** Called after copy-on-select lands text in the clipboard (e.g. show a toast). */
  onAutoCopy?: () => void;
  /** Handle an image-only clipboard on Ctrl+Shift+V (upload-and-inject flow). */
  onPasteImage?: (file: File) => void;
  /** Whether this instance is the focused slot. The window-level Ctrl+Shift+C/V
   *  listener is per-instance, so with two split panes it must only act for the
   *  focused one — else a paste would land in both shells. Defaults to focused. */
  getFocused?: () => boolean;
  /** Open this pane's search bar (used by the ctrlFSearch interception toggle). */
  onSearch?: () => void;
}

// Ctrl+Shift+V paste: text when the clipboard has any, otherwise hand an image
// over to the upload flow. Falls back to plain readText when the clipboard-read
// permission (or the API itself) is unavailable.
async function pasteClipboard(term: Terminal, onImage?: (file: File) => void): Promise<void> {
  try {
    if (navigator.clipboard?.read && onImage) {
      const items = await navigator.clipboard.read();
      const hasText = items.some((i) => i.types.includes('text/plain'));
      if (!hasText) {
        for (const item of items) {
          const type = item.types.find((t) => t.startsWith('image/'));
          if (type) {
            const blob = await item.getType(type);
            onImage(new File([blob], `clipboard.${type.split('/')[1] ?? 'png'}`, { type }));
            return;
          }
        }
      }
    }
  } catch {
    /* clipboard.read denied — text fallback below */
  }
  try {
    const text = await navigator.clipboard?.readText();
    if (text) term.paste(text);
  } catch {
    /* clipboard unavailable */
  }
}

/** Open a terminal link, but only for schemes we are willing to hand the OS.
 *  Terminal output is untrusted — a `javascript:` "link" must never be opened. */
export function openLink(url: string): void {
  const target = normalizeUrl(url);
  if (!isSafeUrl(target)) return;
  window.open(target, '_blank', 'noopener,noreferrer');
}

export interface UseTerminalResult {
  ref: RefObject<HTMLDivElement | null>;
  instance: Terminal | null;
  fit: () => void;
  search: () => SearchAddon | null;
  /** Serialize the current buffer+scrollback to text (null before the addon loads). */
  serialize: () => string | null;
  /** The last command's output text via OSC-133 zones (null if unavailable). */
  copyLastOutput: () => string | null;
  /** The link (OSC-8 or a regex match) at an absolute buffer cell, or null. */
  linkAt: (col: number, absRow: number) => string | null;
  /** The active OSC-133 output zone in absolute rows, or null. */
  outputZone: () => { start: number; end: number } | null;
  /** Re-measure + re-rasterize after a late-loading web font becomes available. */
  refreshFont: () => void;
  /** Re-read the canvas palette after the theme registry changes (user themes). */
  refreshTheme: () => void;
  /** Re-evaluate the focus-aware cursor (call when the pane's focus changes). */
  syncCursor: () => void;
  /** Forget every tracked OSC 8 range — call alongside `Terminal.reset()`. */
  clearLinks: () => void;
}

export function useTerminal(params: UseTerminalParams): UseTerminalResult {
  const initial = useRef(params.settings).current;

  const options = useMemo<ITerminalOptions & ITerminalInitOnlyOptions>(
    () => ({
      fontSize: initial.fontSize,
      fontFamily: withSymbolFallback(initial.fontFamily),
      theme: toXtermTheme(getProfile(initial.themeId)),
      scrollback: initial.scrollback,
      cursorBlink: initial.cursorBlink,
      cursorStyle: initial.cursorStyle,
      allowProposedApi: true,
      macOptionIsMeta: true,
      // macOS: xterm.js ignores Shift for the mouse-report bypass; Option+drag is the only supported gesture.
      macOptionClickForcesSelection: true,
      fontWeightBold: '700',
    }),
    [initial],
  );

  const { ref, instance } = useXTerm(options);

  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const serializeRef = useRef<SerializeAddon | null>(null);
  const instRef = useRef<Terminal | null>(null);
  const cwdRef = useRef<string | null>(null);
  const outStartRef = useRef<number | null>(null);
  const outEndRef = useRef<number | null>(null);
  const osc8Ref = useRef(createOsc8Tracker());
  const settingsRef = useRef(params.settings);
  settingsRef.current = params.settings;
  const onSearchRef = useRef(params.onSearch);
  onSearchRef.current = params.onSearch;
  const instanceRef = useRef<Terminal | null>(null);
  instanceRef.current = instance;
  const onDataRef = useRef(params.onData);
  const onResizeRef = useRef(params.onResize);
  const onAutoCopyRef = useRef(params.onAutoCopy);
  const onPasteImageRef = useRef(params.onPasteImage);
  const getFocusedRef = useRef(params.getFocused);
  useEffect(() => {
    onDataRef.current = params.onData;
    onResizeRef.current = params.onResize;
    onAutoCopyRef.current = params.onAutoCopy;
    onPasteImageRef.current = params.onPasteImage;
    getFocusedRef.current = params.getFocused;
  });

  // xterm 5 measured its own scrollBarWidth and FitAddon fell back to a phantom
  // 15px when we hid the scrollbar, so doFit used to zero that internal first.
  // addon-fit 0.11 dropped the field: it reserves a flat
  // `overviewRuler.width || 14` and there is no way to ask for zero (a 0 hits
  // the fallback). The mobile CSS takes that gutter back by overhanging the
  // host — see `.app.mobile .term-host` in index.css.
  const doFit = useCallback(() => {
    const fit = fitRef.current;
    if (!fit) return;
    try {
      fit.fit();
    } catch {
      /* not laid out yet */
    }
    // Measure the sub-row remainder for the mobile bottom-align (see
    // `.app.mobile .term-host .xterm` in index.css). Zeroed FIRST because the
    // transform it feeds would otherwise be included in the very measurement
    // that produces it, and the value would collapse to 0 on the second fit.
    const host = ref.current;
    const screen = host?.querySelector('.xterm-screen');
    if (host && screen) {
      host.style.setProperty('--fit-rem', '0px');
      const gap = host.getBoundingClientRect().bottom - screen.getBoundingClientRect().bottom;
      host.style.setProperty('--fit-rem', `${Math.max(0, Math.round(gap))}px`);
    }
  }, [ref]);

  // Focus-aware cursor. On mobile the keystrokes go through a SEPARATE hidden
  // textarea, so xterm's own helper textarea is never focused — xterm would draw
  // the blurred (hollow) cursor forever. We instead drive `cursorInactiveStyle`
  // from real app focus: a FILLED block while the window is focused/visible and
  // this pane is the active slot, a hollow outline when backgrounded or the pane
  // is unfocused (matching desktop's focused=filled / away=hollow behaviour).
  const applyCursor = useCallback(() => {
    const term = instanceRef.current;
    if (!term) return;
    const docActive =
      typeof document === 'undefined' ||
      (document.visibilityState !== 'hidden' && document.hasFocus());
    const paneFocused = getFocusedRef.current ? getFocusedRef.current() : true;
    const active = docActive && paneFocused;
    term.options.cursorInactiveStyle = active ? (term.options.cursorStyle ?? 'block') : 'outline';
  }, []);

  // Load addons + wire I/O once the instance exists (post-open).
  useEffect(() => {
    if (!instance) return;

    const fit = new FitAddon();
    instance.loadAddon(fit);
    fitRef.current = fit;

    const search = new SearchAddon();
    instance.loadAddon(search);
    searchRef.current = search;
    const serialize = new SerializeAddon();
    instance.loadAddon(serialize);
    serializeRef.current = serialize;

    // Regex link pass. Route activation through our own scheme allowlist rather
    // than the addon's default window.open.
    instance.loadAddon(new WebLinksAddon((_e, uri) => openLink(uri)));
    // OSC-8 hyperlinks: xterm renders + clicks them, we only need the URL for the
    // right-click menu and the mobile tap resolver, so the handler RETURNS FALSE
    // and lets xterm's own OSC-8 handling run underneath.
    instance.options.linkHandler = {
      activate: (_e, text) => openLink(text),
      allowNonHttpProtocols: false,
    };
    instance.loadAddon(new ClipboardAddon());
    instance.loadAddon(new Unicode11Addon());
    instance.unicode.activeVersion = '11';
    instRef.current = instance;

    // Shell integration: OSC 7 (cwd) + OSC 133 (command zones). Additive — a
    // shell emitting none of these is unaffected.
    const absY = (): number => instance.buffer.active.baseY + instance.buffer.active.cursorY;
    instance.parser.registerOscHandler(7, (data) => {
      const path = /^file:\/\/[^/]*(\/.*)$/.exec(data)?.[1];
      if (path) {
        try {
          cwdRef.current = decodeURIComponent(path);
        } catch {
          cwdRef.current = path;
        }
      }
      return true;
    });
    instance.parser.registerOscHandler(8, (data) => {
      // `params;URI` — an empty URI closes the open link.
      const semi = data.indexOf(';');
      const uri = semi >= 0 ? data.slice(semi + 1) : '';
      const x = instance.buffer.active.cursorX;
      if (uri) osc8Ref.current.begin(uri, x, absY());
      else osc8Ref.current.end(x, absY());
      return false; // fall through to xterm's built-in OSC-8 handling
    });
    instance.parser.registerOscHandler(133, (data) => {
      const kind = data.charAt(0);
      if (kind === 'C') {
        outStartRef.current = absY();
        outEndRef.current = null;
      } else if (kind === 'D') {
        outEndRef.current = absY();
      }
      return true;
    });

    const forceRepaint = () => {
      try {
        instance.refresh(0, instance.rows - 1);
      } catch {
        /* renderer not ready */
      }
    };

    // WebGL is the GPU fast path; fall back to the default renderer if the
    // context can't be created (no WebGL2, lost context).
    // NOTE: programming-ligature shaping is NOT supported on the WebGL renderer
    // (xterm's ligatures addon only works with the DOM renderer, which would
    // give up GPU acceleration) — a documented limitation, not a regression.
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        // Mobile browsers drop the GL context when the tab is backgrounded /
        // the phone is locked. Dispose → DOM renderer, then force a repaint or
        // the screen (and the cursor) stay blank on return.
        webgl.dispose();
        requestAnimationFrame(forceRepaint);
      });
      instance.loadAddon(webgl);
    } catch {
      /* canvas/DOM renderer remains */
    }

    // Returning to the foreground (app switch / unlock): re-fit, repaint so the
    // cursor and content aren't left blank, and re-evaluate the focus cursor.
    const onFocusVisibility = () => {
      applyCursor();
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      doFit();
      forceRepaint();
    };
    window.addEventListener('focus', onFocusVisibility);
    window.addEventListener('blur', applyCursor);
    document.addEventListener('visibilitychange', onFocusVisibility);
    applyCursor();

    const dataDisp = instance.onData((d) => onDataRef.current(d));
    const resizeDisp = instance.onResize(({ cols, rows }) => onResizeRef.current?.(cols, rows));

    // Ctrl+Shift+C / Ctrl+Shift+V — the standard Linux-terminal clipboard combo.
    // ALWAYS swallowed, app-wide and even with an empty selection: muscle memory
    // fires it constantly, and any miss opens the browser's devtools inspector.
    // (DevTools stays reachable via F12 / Ctrl+Shift+I.) A window-level capture
    // listener covers the case where focus isn't inside xterm; the xterm-level
    // handler keeps Ctrl+C itself flowing to the shell as SIGINT.
    const isClipboardCombo = (e: KeyboardEvent): boolean =>
      e.ctrlKey &&
      e.shiftKey &&
      !e.altKey &&
      !e.metaKey &&
      (e.code === 'KeyC' || e.code === 'KeyV');
    // The capture listener runs first and performs the action exactly once;
    // xterm's handler only opts out so the combo never reaches the shell.
    const winCombo = (e: KeyboardEvent) => {
      if (!isClipboardCombo(e)) return;
      // With two split panes each installs this listener; only the focused one
      // acts (else a paste lands in both shells). Default (no getFocused) = act.
      if (getFocusedRef.current && !getFocusedRef.current()) return;
      e.preventDefault();
      if (e.code === 'KeyC') {
        const sel = instance.getSelection();
        if (sel) void navigator.clipboard?.writeText(stripTrailingSpaces(sel)).catch(() => {});
      } else {
        // Text wins when present (the normal terminal paste); an image-only
        // clipboard (fresh screenshot) routes to the upload-and-inject flow —
        // preventDefault above suppressed the native paste event, so the
        // document-level image-paste listener can never see this combo.
        void pasteClipboard(instance, onPasteImageRef.current);
      }
    };
    window.addEventListener('keydown', winCombo, { capture: true });
    instance.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      if (isClipboardCombo(e)) return false; // handled by the window listener above
      const s = settingsRef.current;
      const plainCtrl = e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey;
      // Opt-in interception (default OFF) of plain Ctrl+V / Ctrl+F so vim/readline
      // users keep the literal control bytes unless they enable these.
      if (plainCtrl && s.ctrlVPaste && e.code === 'KeyV') {
        // preventDefault stops the browser's own paste event from ALSO firing
        // (which would double-paste); stopPropagation keeps it off other handlers.
        e.preventDefault();
        e.stopPropagation();
        void pasteClipboard(instance, onPasteImageRef.current);
        return false;
      }
      if (plainCtrl && s.ctrlFSearch && e.code === 'KeyF') {
        // preventDefault stops the browser's Ctrl+F find-in-page from opening too.
        e.preventDefault();
        e.stopPropagation();
        onSearchRef.current?.();
        return false;
      }
      return true;
    });

    // Copy-on-select: under mouse reporting (tmux mouse on) xterm drops the
    // shift-selection the instant the button is released, so the text must be
    // captured AT EVENT TIME — by the time a debounce fires, getSelection() is
    // already empty. copyText (not navigator.clipboard directly) so the
    // execCommand fallback covers non-secure origins like http://<lan-ip>.
    let selTimer: ReturnType<typeof setTimeout> | undefined;
    let pendingSel = '';
    const selDisp = instance.onSelectionChange(() => {
      const sel = instance.getSelection();
      if (sel) pendingSel = sel; // remember the latest non-empty selection
      clearTimeout(selTimer);
      selTimer = setTimeout(() => {
        if (!pendingSel) return;
        const text = pendingSel;
        pendingSel = '';
        void copyText(stripTrailingSpaces(text)).then((ok) => {
          if (ok) onAutoCopyRef.current?.();
        });
      }, 120);
    });

    doFit();
    onResizeRef.current?.(instance.cols, instance.rows);

    const host = ref.current;
    const ro = new ResizeObserver(() => doFit());
    if (host) ro.observe(host);

    return () => {
      dataDisp.dispose();
      resizeDisp.dispose();
      selDisp.dispose();
      clearTimeout(selTimer);
      window.removeEventListener('keydown', winCombo, { capture: true });
      window.removeEventListener('focus', onFocusVisibility);
      window.removeEventListener('blur', applyCursor);
      document.removeEventListener('visibilitychange', onFocusVisibility);
      ro.disconnect();
      fitRef.current = null;
      searchRef.current = null;
      serializeRef.current = null;
      instRef.current = null;
    };
  }, [instance, ref, doFit, applyCursor]);

  // ── Inline images (SIXEL + iTerm2 IIP) ──────────────────────────────────────
  //
  // Its own effect rather than a line in the addon block above, because this one
  // is a LIVE TOGGLE and loading it is not a private decision: besides claiming
  // `DCS q` and `OSC 1337`, the addon answers DA1 as a sixel-capable terminal
  // (`CSI ?62;4;9;22c`) and switches on the pixel-geometry window reports
  // (CSI 14t/16t/18t). That handshake is the whole point — it is what makes timg,
  // chafa, yazi and friends emit actual pixels instead of unicode half-blocks —
  // but it also means turning the setting off has to genuinely unregister them
  // again, which only `dispose()` does. Hence create-and-dispose, not a flag.
  //
  // Two things follow from that handshake being answered over our own wire:
  //   • The DA1/`t` replies travel back through TerminalPane's REPORT_RE gate,
  //     which drops reports while the document is unfocused or within a second
  //     of regaining focus. A probe fired in that window sees no sixel support
  //     and the app falls back to blocks — the gate exists to keep replayed
  //     history from answering, and that trade stays as it is.
  //   • Image storage is not cleaned up here. Each image is anchored to a buffer
  //     marker, and `Terminal.reset()` (what a tab switch does) rebuilds the
  //     buffers, so the markers dispose and the addon evicts on its own.
  //
  // Kitty's graphics protocol is deliberately absent: it exists only in this
  // addon's 0.10 beta line, which requires xterm 6.1-beta — two majors ahead —
  // and IIP already covers the same clients.
  useEffect(() => {
    if (!instance || !params.settings.inlineImages) return;
    const addon = new ImageAddon(imageAddonOptions(resolveMobileMode(params.settings.mobileMode)));
    try {
      instance.loadAddon(addon);
    } catch {
      return; // terminal already disposed
    }
    return () => {
      try {
        addon.dispose();
      } catch {
        /* terminal disposed first — its own disposables already ran */
      }
    };
  }, [instance, params.settings.inlineImages, params.settings.mobileMode]);

  // Force a glyph re-measure/re-rasterize. Needed when a discovered web font
  // (settings/fonts.ts) finishes loading AFTER the terminal already measured
  // with the fallback — assigning the same fontFamily is a no-op, so bounce it.
  // Re-derive the canvas palette from the CURRENT theme registry. Needed because
  // a `user:` / emulator theme only exists after the server's `themes` broadcast
  // registers it: until then getProfile falls back to the DEFAULT profile, and
  // the settings effect below won't re-run on its own (themeId never changed —
  // only what that id resolves to did). App calls this when themes arrive.
  const refreshTheme = useCallback(() => {
    const term = instanceRef.current;
    if (!term) return;
    term.options.theme = toXtermTheme(getProfile(settingsRef.current.themeId));
  }, []);

  const refreshFont = useCallback(() => {
    const term = instanceRef.current;
    if (!term) return;
    const fam = term.options.fontFamily ?? 'monospace';
    term.options.fontFamily = fam === 'monospace' ? 'ui-monospace' : 'monospace';
    term.options.fontFamily = fam;
    try {
      term.clearTextureAtlas();
    } catch {
      /* renderer without an atlas */
    }
    doFit();
  }, [doFit]);

  // Mobile: load the bundled color-emoji font (the platform one isn't resolved
  // for the glyph atlas → gray monochrome circles) and re-rasterize once it's in.
  useEffect(() => {
    if (!instance || !resolveMobileMode(params.settings.mobileMode)) return;
    let cancelled = false;
    void ensureColorEmojiFont().then(() => {
      if (!cancelled) refreshFont();
    });
    return () => {
      cancelled = true;
    };
  }, [instance, params.settings.mobileMode, refreshFont]);

  // Apply live setting changes without recreating the terminal.
  useEffect(() => {
    if (!instance) return;
    const s = params.settings;
    instance.options.fontSize = s.fontSize;
    instance.options.fontFamily = withSymbolFallback(s.fontFamily);
    instance.options.theme = toXtermTheme(getProfile(s.themeId));
    instance.options.scrollback = s.scrollback;
    instance.options.cursorBlink = s.cursorBlink;
    instance.options.cursorStyle = s.cursorStyle;
    applyCursor(); // keep the focus-aware inactive style mirroring the new style
    // UI-token application lives in App (themes a panes-only workspace too, and
    // runs pre-paint at boot); useTerminal only owns the xterm canvas theme.
    doFit();
    // A newly-selected web font may still be loading; remeasure once it's ready.
    if (typeof document !== 'undefined' && document.fonts?.ready) {
      void document.fonts.ready.then(() => doFit());
    }
  }, [instance, params.settings, doFit, applyCursor]);

  // The serialize addon reconstructs the buffer WITH escape sequences (colors,
  // cursor moves) — useless in a downloaded .txt — so strip them to plain text.
  // eslint-disable-next-line no-control-regex
  const ANSI = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|\x1b\[[0-9;?]*[ -/]*[@-~]/g;
  const serializeBuffer = useCallback(() => {
    const raw = serializeRef.current?.serialize();
    return raw == null ? null : raw.replace(ANSI, '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const copyLastOutput = useCallback((): string | null => {
    const inst = instRef.current;
    const start = outStartRef.current;
    if (!inst || start == null) return null;
    const buf = inst.buffer.active;
    const end = outEndRef.current ?? buf.baseY + buf.cursorY;
    const lines: string[] = [];
    for (let y = start; y < end; y++) {
      const line = buf.getLine(y);
      if (line) lines.push(line.translateToString(true));
    }
    return lines.join('\n').replace(/\s+$/, '') || null;
  }, []);

  // OSC-8 wins over the regex pass: an OSC-8 link's visible text is often a
  // label, not the URL, so the regex would find nothing (or the wrong thing).
  const linkAt = useCallback((col: number, absRow: number): string | null => {
    const inst = instRef.current;
    if (!inst) return null;
    const tagged = osc8Ref.current.at(col, absRow);
    if (tagged) return tagged;
    const text = inst.buffer.active.getLine(absRow)?.translateToString(true) ?? '';
    return findRegexLinkInRow(text, col);
  }, []);

  const outputZone = useCallback((): { start: number; end: number } | null => {
    const inst = instRef.current;
    const start = outStartRef.current;
    if (!inst || start == null) return null;
    const buf = inst.buffer.active;
    return { start, end: outEndRef.current ?? buf.baseY + buf.cursorY };
  }, []);

  // Stable: the socket effect in TerminalPane lists this as a dependency, and a
  // fresh arrow per render would reopen the WebSocket on every render.
  const clearLinks = useCallback(() => osc8Ref.current.clear(), []);

  return {
    ref,
    instance,
    fit: doFit,
    search: () => searchRef.current,
    serialize: serializeBuffer,
    copyLastOutput,
    linkAt,
    outputZone,
    refreshFont,
    refreshTheme,
    /**
     * Forget every tracked OSC 8 range. MUST be called with `Terminal.reset()`:
     * ranges are keyed by ABSOLUTE buffer cell, and a reset restarts those
     * coordinates at zero, so a surviving range points at whatever the next
     * session happens to draw there — a link from the previous tab attached to
     * unrelated text, with no way for the user to tell.
     *
     * Known limit, not covered here: once the scrollback is FULL, xterm evicts
     * the oldest line on every new one and every absolute index shifts down by
     * one, so long-lived ranges drift. Fixing that properly needs an xterm
     * marker per range rather than a number; this only closes the reset case.
     */
    clearLinks,
    /** Re-evaluate the focus-aware cursor (call when the pane's focus changes). */
    syncCursor: applyCursor,
  };
}
