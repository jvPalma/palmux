import { useEffect, useRef } from 'react';
import { type Action, type Chord, loadBindings, matchAction } from './keybindings';

// Install a capture-phase keydown handler that runs an app action for a bound
// chord and lets every unbound key fall through to xterm untouched. Only claims
// (preventDefault) a chord that BOTH matches a binding AND has a wired handler —
// so an action with no target yet (e.g. the palette before it exists) still
// passes through rather than swallowing the key.
export function useKeybindings(handlers: Partial<Record<Action, () => void>>): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const bindingsRef = useRef<Record<Action, Chord>>(loadBindings());

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = matchAction(bindingsRef.current, e);
      if (!action) return; // unbound → xterm / default handling
      const handler = handlersRef.current[action];
      if (!handler) return; // bound but not wired → let it pass
      e.preventDefault();
      e.stopPropagation();
      handler();
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, []);
}
