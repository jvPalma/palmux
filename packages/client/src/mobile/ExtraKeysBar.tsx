// ── Extra-keys toolbar (Termux-style) ─────────────────────────────────────────
//
// Renders the configured rows of keys as a bottom bar. CTRL/ALT/SHIFT are sticky
// toggles exactly like Termux: a tap arms the modifier for the next key only
// (one-shot), a long-press LOCKS it so it applies to every following key until
// tapped off. Byte encoding is delegated to key-encoder.ts so a toolbar key and
// its hardware-keyboard twin always agree. The bar exposes `takeMods` so the
// soft keyboard can combine an armed modifier with the next typed character
// (this is how the tmux prefix, Ctrl+B, works from a touch keyboard).
//
// Pointer handling is gesture-aware: a key fires on RELEASE-in-place (not on
// press), so (a) a finger that slides becomes a swipe instead of a keystroke and
// (b) the OS bottom-edge navigation gesture — which lands on the bottom row and
// ends in pointercancel — never emits a phantom key. A horizontal swipe across
// the bar is reported by DIRECTION (onSwipe 'left'/'right'); holding a plain key
// auto-repeats it like a hardware keyboard.
//
// Two thresholds, deliberately different: 10px of travel cancels the KEY (the
// press became a swipe), but the long-press HOLD survives up to 24px. A thumb
// held for 350ms always drifts a little, and cancelling the hold on that drift
// is what made "long-press to lock CTRL" fail silently.

import {
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { encodeExtraKey, encodeMacro, type KeyMods } from './key-encoder';
import {
  type ExtraKeysConfig,
  type ExtraKeySpec,
  isModifierKey,
  keyLabel,
  toExtraKey,
} from './extra-keys';
import { keyFace } from './key-icons';

// Hold a key this long to fire its long-press popup/action, or LOCK a modifier.
const LONG_PRESS_MS = 350;
// A held plain key starts auto-repeating after this delay, then every interval.
const REPEAT_DELAY_MS = 400;
const REPEAT_INTERVAL_MS = 60;
// Finger travel past this (px) turns a press into a swipe — the key is cancelled.
const MOVE_CANCEL_PX = 10;
// …but a long-press tolerates this much drift before its hold timer is killed.
const HOLD_CANCEL_PX = 24;
// Horizontal swipe distance that counts as a bar swipe.
const DRAWER_SWIPE_PX = 60;

// Sticky-modifier state. 'armed' is one-shot (cleared after the next key);
// 'locked' persists until the modifier is tapped off.
type ModLevel = 'off' | 'armed' | 'locked';
type ModName = 'ctrl' | 'alt' | 'shift';
type ModsState = Record<ModName, ModLevel>;

const NO_MODS_STATE: ModsState = { ctrl: 'off', alt: 'off', shift: 'off' };
const MOD_NAMES: ModName[] = ['ctrl', 'alt', 'shift'];

const toKeyMods = (s: ModsState): KeyMods => ({
  ctrl: s.ctrl !== 'off',
  alt: s.alt !== 'off',
  shift: s.shift !== 'off',
});

/**
 * How long one physical key's input events count as the SAME press.
 *
 * A single backspace does not produce a single event: GBoard composes almost
 * every word, so it arrives as a one-character composition shrink, while other
 * IMEs send `deleteContentBackward` — and useSoftKeyboard reads the modifiers on
 * both paths. Consuming the armed modifier on the first read left the rest of
 * the burst unmodified, so CTRL+BKSP sent ^H and then a bare DEL: a word killed
 * and one more character with it, which reads as "the modifier did nothing".
 *
 * A frame and a half. No human presses two keys inside it, and no auto-repeat
 * interval comes close, so a real second press is never swallowed.
 */
const BURST_MS = 24;

/** Clear one-shot ('armed') modifiers, keep locked ones. */
const consumeOneShot = (s: ModsState): ModsState => ({
  ctrl: s.ctrl === 'armed' ? 'off' : s.ctrl,
  alt: s.alt === 'armed' ? 'off' : s.alt,
  shift: s.shift === 'armed' ? 'off' : s.shift,
});

export interface ExtraKeysBarHandle {
  takeMods: (consume?: boolean) => KeyMods;
}

export interface ExtraKeysBarProps {
  config: ExtraKeysConfig;
  visible: boolean;
  send: (text: string) => void;
  isBlocked?: () => boolean;
  /** Reports the rendered height (0 when hidden) so the terminal can reserve space. */
  onHeightChange: (px: number) => void;
  /** Run a named UI action from a key's long-press (e.g. 'keyboard'). */
  onAction?: (action: string) => void;
  /**
   * Horizontal swipe across the bar, by GESTURE DIRECTION ('right' = left→right).
   * The bar has no opinion on what each direction does — App maps them.
   */
  onSwipe?: (dir: 'left' | 'right') => void;
  /**
   * Re-raise the soft keyboard. Android can dismiss the IME during a long press
   * without blurring the hidden textarea, which made locking a modifier look
   * like it "closed the keyboard"; the bar restores it on release. Never called
   * for a key whose own action toggles the keyboard (long-press ESC).
   */
  onRaiseKeyboard?: () => void;
}

/** Corner glyph hinting a key's long-press action, or '' if none. */
const ACTION_HINTS: Record<string, string> = { keyboard: '⌨', dictate: '🔉' };
const actionHint = (action: string | undefined): string =>
  (action ? ACTION_HINTS[action] : '') ?? '';

/** A plain key that fires bytes (repeatable on hold): not a modifier, no popup/action. */
const isRepeatable = (spec: ExtraKeySpec): boolean => {
  if (isModifierKey(spec)) return false;
  const k = toExtraKey(spec);
  if (k.action || k.popup !== undefined) return false;
  return !!(k.key || k.macro);
};

interface Gesture {
  pointerId: number;
  spec: ExtraKeySpec;
  startX: number;
  startY: number;
  moved: boolean; // past MOVE_CANCEL_PX — no key on release
  holdFired: boolean; // popup/action/lock already fired via the hold timer
  repeating: boolean; // auto-repeat has begun (release must not re-emit)
  holdTimer: number;
  repeatTimer: number;
  kbdWasUp: boolean; // IME was up when the press began
  viewportH: number; // visualViewport height at press (shrinks while the IME is up)
}

/** The soft keyboard is up iff the hidden textarea holds focus. */
const kbdFocused = (): boolean =>
  typeof document !== 'undefined' && document.activeElement?.id === 'mobile-kbd';

const viewportHeight = (): number =>
  (typeof window !== 'undefined' ? window.visualViewport?.height : 0) ?? 0;

// The IME went away during the press if the textarea lost focus OR the visual
// viewport grew back by a keyboard's worth of pixels (Android dismisses without
// blurring, so focus alone is not a reliable signal).
const keyboardVanished = (g: Gesture): boolean =>
  g.kbdWasUp && (!kbdFocused() || viewportHeight() > g.viewportH + 100);

export const ExtraKeysBar = forwardRef<ExtraKeysBarHandle, ExtraKeysBarProps>(
  function ExtraKeysBar(props, ref) {
    const { config, visible, send, isBlocked, onHeightChange, onAction, onSwipe, onRaiseKeyboard } =
      props;
    // `mods` drives the render; `modsRef` is the SYNCHRONOUS source of truth so a
    // key read immediately after arming a modifier (armed alt → arrow) sees it
    // without waiting for a re-render — the tap path used to lose that race.
    const [mods, setModsState] = useState<ModsState>({ ...NO_MODS_STATE });
    const modsRef = useRef(mods);
    const setMods = (next: ModsState) => {
      modsRef.current = next;
      setModsState(next);
    };
    const el = useRef<HTMLDivElement | null>(null);
    // Gestures BY POINTER, not one slot. A modifier held down while another key
    // is tapped is the natural keyboard gesture — hold CTRL, press ←  — and a
    // single slot dropped that second key in silence: the guard below saw a live
    // gesture and returned. Only NON-modifier keys are still one-at-a-time, so
    // two ordinary keys cannot interleave.
    const gestures = useRef<Map<number, Gesture>>(new Map());

    // The last consumed snapshot, replayed for the rest of that key's event
    // burst — see BURST_MS.
    const burst = useRef<{ mods: KeyMods; at: number } | null>(null);

    useImperativeHandle(ref, () => ({
      takeMods(consume = true): KeyMods {
        const now = Date.now();
        if (burst.current && now - burst.current.at < BURST_MS) return burst.current.mods;
        const snapshot = toKeyMods(modsRef.current);
        if (consume && MOD_NAMES.some((m) => modsRef.current[m] === 'armed')) {
          burst.current = { mods: snapshot, at: now };
          setMods(consumeOneShot(modsRef.current));
        }
        return snapshot;
      },
    }));

    // Report height so the terminal area reserves space above the bar.
    useLayoutEffect(() => {
      onHeightChange(visible && el.current ? el.current.offsetHeight : 0);
    }, [visible, config, onHeightChange]);

    /** The modifier a spec toggles, or null (FN is Termux parity; no web encoding). */
    const modOf = (spec: ExtraKeySpec): ModName | null => {
      if (!isModifierKey(spec)) return null;
      const name = toExtraKey(spec).key!.toUpperCase();
      return name === 'FN' ? null : (name.toLowerCase() as ModName);
    };

    /** Encode + send a key's bytes, consuming any one-shot (armed) modifier. */
    const emitKey = (spec: ExtraKeySpec) => {
      if (isBlocked?.()) return;
      const key = toExtraKey(spec);
      let out = '';
      if (key.macro) out = encodeMacro(key.macro);
      else if (key.key) out = encodeExtraKey(key.key, toKeyMods(modsRef.current));
      if (MOD_NAMES.some((m) => modsRef.current[m] === 'armed')) {
        setMods(consumeOneShot(modsRef.current));
      }
      if (out) send(out);
    };

    const clearTimers = (g: Gesture) => {
      clearTimeout(g.holdTimer);
      clearTimeout(g.repeatTimer);
    };

    // Press begins the gesture but fires NOTHING yet — a plain key emits on
    // release (so a slide/edge-gesture can cancel it). The hold timer arms the
    // type-specific long-press: lock a modifier, fire a popup's bytes, arm an
    // action (run on release, where the user-gesture can open the keyboard), or
    // begin auto-repeat for a plain key.
    const startPress = (e: ReactPointerEvent, spec: ExtraKeySpec) => {
      e.preventDefault(); // never steal focus from the hidden keyboard textarea
      // One ordinary key at a time; a held modifier never blocks anything.
      if (!modOf(spec) && [...gestures.current.values()].some((g) => !modOf(g.spec))) return;
      const g: Gesture = {
        pointerId: e.pointerId,
        spec,
        startX: e.clientX,
        startY: e.clientY,
        moved: false,
        holdFired: false,
        repeating: false,
        holdTimer: 0,
        repeatTimer: 0,
        kbdWasUp: kbdFocused(),
        viewportH: viewportHeight(),
      };
      gestures.current.set(e.pointerId, g);
      // Capture on the BAR (a non-focusable div), never the <button>: capturing
      // to a focusable element dismisses the mobile virtual keyboard even with
      // preventDefault. The bar-level move/up handlers still see the gesture.
      // AFTER the gesture is recorded, and guarded: setPointerCapture throws if
      // the pointer is already gone, and a throw here used to abort the whole
      // press — losing the keystroke entirely rather than just the capture.
      try {
        el.current?.setPointerCapture?.(e.pointerId);
      } catch {
        // No capture: move/up still bubble to the bar, so the gesture survives.
      }

      const mod = modOf(spec);
      if (mod) {
        g.holdTimer = window.setTimeout(() => {
          if (isBlocked?.()) return;
          g.holdFired = true;
          navigator.vibrate?.(8);
          setMods({ ...modsRef.current, [mod]: 'locked' });
        }, LONG_PRESS_MS);
        return;
      }
      const key = toExtraKey(spec);
      if (key.action || key.popup !== undefined) {
        g.holdTimer = window.setTimeout(() => {
          if (isBlocked?.()) return; // stays a normal tap on release
          g.holdFired = true;
          navigator.vibrate?.(8);
          if (key.popup !== undefined) emitKey(key.popup); // popup bytes fire on hold
          // an action runs in endPress (needs the release user-gesture)
        }, LONG_PRESS_MS);
        return;
      }
      if (isRepeatable(spec)) {
        const repeat = () => {
          if (gestures.current.get(g.pointerId) !== g || g.moved) return;
          g.repeating = true;
          emitKey(spec);
          navigator.vibrate?.(3);
          g.repeatTimer = window.setTimeout(repeat, REPEAT_INTERVAL_MS);
        };
        g.repeatTimer = window.setTimeout(repeat, REPEAT_DELAY_MS);
      }
    };

    const movePress = (e: ReactPointerEvent) => {
      const g = gestures.current.get(e.pointerId);
      if (!g) return;
      const travel = Math.hypot(e.clientX - g.startX, e.clientY - g.startY);
      // Past the key threshold: no keystroke on release, but the hold timer
      // lives on — a thumb resting for 350ms drifts, and killing the lock over
      // a few px of wobble is what made long-press-to-lock unreliable.
      if (!g.moved && travel > MOVE_CANCEL_PX) g.moved = true;
      if (travel > HOLD_CANCEL_PX) clearTimers(g); // a real swipe: no hold, no repeat
    };

    const endPress = (e: ReactPointerEvent) => {
      const g = gestures.current.get(e.pointerId);
      if (!g) return;
      clearTimers(g);
      gestures.current.delete(e.pointerId);

      const spec = g.spec;
      const key = toExtraKey(spec);
      const mod = modOf(spec);

      // A long press can leave Android's IME dismissed even though the hidden
      // textarea never blurred. Restore it here — pointerup is a user gesture,
      // which a re-focus needs. Skipped for a key whose own action toggles the
      // keyboard (long-press ESC), or the toggle could never close it.
      const restoreKeyboard = () => {
        if (g.holdFired && !key.action && keyboardVanished(g)) onRaiseKeyboard?.();
      };

      if (g.moved) {
        // A swipe: a dominant horizontal drag is reported by direction; never a
        // key. A press whose hold already fired is NOT also a swipe.
        const dx = e.clientX - g.startX;
        const dy = e.clientY - g.startY;
        if (!g.holdFired && Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > DRAWER_SWIPE_PX) {
          onSwipe?.(dx > 0 ? 'right' : 'left');
          return;
        }
        restoreKeyboard();
        return;
      }
      if (g.repeating) return; // auto-repeat already emitted; nothing more on release

      if (mod) {
        if (isBlocked?.()) return;
        if (!g.holdFired) {
          // Toggle off↔armed; a locked modifier is turned off by a tap.
          const cur = modsRef.current[mod];
          setMods({ ...modsRef.current, [mod]: cur === 'off' ? 'armed' : 'off' });
        }
        restoreKeyboard();
        return;
      }
      if (key.action || key.popup !== undefined) {
        if (g.holdFired) {
          if (key.action) onAction?.(key.action); // deferred action, in this release gesture
          restoreKeyboard(); // no-op for action keys, restores after a popup
          return; // popup already fired on hold
        }
        emitKey(spec); // quick tap → the main key
        return;
      }
      emitKey(spec); // plain key tap
    };

    const cancelPress = (e: ReactPointerEvent) => {
      const g = gestures.current.get(e.pointerId);
      if (!g) return;
      clearTimers(g);
      gestures.current.delete(e.pointerId); // OS gesture / interruption: emit nothing
    };

    return (
      <div
        ref={el}
        id="extra-keys-bar"
        className={`extra-keys-bar${visible ? '' : ' hidden'}`}
        role="toolbar"
        aria-label="Terminal extra keys"
        onPointerMove={movePress}
        onPointerUp={endPress}
        onPointerCancel={cancelPress}
        // Android raises a context menu ~500ms into a hold; its default handling
        // steals focus from the hidden keyboard textarea. Nothing on this bar
        // has a useful context menu, so suppress it outright.
        onContextMenu={(e) => e.preventDefault()}
      >
        {config.layout.map((row, ri) => (
          <div className="ek-row" key={ri}>
            {row.map((spec, ci) => {
              const key = toExtraKey(spec);
              const mod = isModifierKey(spec);
              const modName = modOf(spec);
              const level: ModLevel = modName ? mods[modName] : 'off';
              const id = (key.key ?? key.macro ?? '').trim();
              const face = keyFace(id);
              return (
                <button
                  key={ci}
                  type="button"
                  className={`ek-key${mod ? ' ek-mod' : ''}${face ? ' ek-icon' : ''}${
                    level === 'armed' ? ' armed' : level === 'locked' ? ' locked' : ''
                  }`}
                  data-testid={id ? `extra-key-${id}` : undefined}
                  onPointerDown={(e) => startPress(e, spec)}
                >
                  {face ?? keyLabel(spec)}
                  {key.popup !== undefined ? (
                    <span className="ek-popup-hint">{keyLabel(key.popup)}</span>
                  ) : actionHint(key.action) ? (
                    <span className="ek-popup-hint">{actionHint(key.action)}</span>
                  ) : null}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    );
  },
);
