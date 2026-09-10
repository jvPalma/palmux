import { useEffect, useRef, useState } from 'react';
import {
  ACTION_LABELS,
  ACTIONS,
  type Action,
  type Chord,
  chordFromEvent,
  findConflict,
  formatChord,
  loadBindings,
  resetBindings,
  saveBindings,
} from '../keybindings/keybindings';

export interface KeybindingsPanelProps {
  onClose: () => void;
}

const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta']);

export function KeybindingsPanel({ onClose }: KeybindingsPanelProps) {
  const [bindings, setBindings] = useState<Record<Action, Chord>>(loadBindings);
  const [capturing, setCapturing] = useState<Action | null>(null);
  const [conflict, setConflict] = useState<{ action: Action; withAction: Action } | null>(null);
  const capturingRef = useRef<Action | null>(null);
  capturingRef.current = capturing;

  // While capturing, the NEXT non-modifier keydown becomes the chord (Escape
  // cancels). A conflict with another action is reported instead of applied.
  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setCapturing(null);
        return;
      }
      if (MODIFIER_KEYS.has(e.key)) return; // wait for a real key
      const action = capturingRef.current;
      if (!action) return;
      const chord = chordFromEvent(e);
      const clash = findConflict(bindings, action, chord);
      if (clash) {
        setConflict({ action, withAction: clash });
        return;
      }
      const next = { ...bindings, [action]: chord };
      setBindings(next);
      saveBindings(next);
      setCapturing(null);
      setConflict(null);
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [capturing, bindings]);

  const reset = () => {
    setBindings(resetBindings());
    setConflict(null);
    setCapturing(null);
  };

  return (
    <div className="panel-overlay" onPointerDown={onClose}>
      <div
        className="panel"
        onPointerDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Keybindings"
      >
        <h2>Keybindings</h2>

        {ACTIONS.map((a) => (
          <div className="field" key={a} data-testid={`kb-row-${a}`}>
            <label>{ACTION_LABELS[a]}</label>
            <button
              type="button"
              className="kb-chord"
              data-testid={`kb-rebind-${a}`}
              onClick={() => {
                setCapturing(a);
                setConflict(null);
              }}
            >
              {capturing === a ? 'press keys…' : formatChord(bindings[a])}
            </button>
          </div>
        ))}

        {conflict && (
          <p className="kb-conflict" role="alert" data-testid="kb-conflict">
            That chord is already bound to “{ACTION_LABELS[conflict.withAction]}”. Pick another.
          </p>
        )}

        <div className="field">
          <button type="button" onClick={reset}>
            Reset to defaults
          </button>
          <button type="button" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
