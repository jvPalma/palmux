// The registry is how App's shared input surfaces (soft keyboard, extra keys, upload, paste)
// reach "the focused pane" without a prop path. A slot used to be 'a' | 'b'; it is a pane's id
// now, so any number can register and none is focused until App says which.

import { describe, expect, it, vi } from 'vitest';
import { createSplitRegistry, type PaneApi } from './SplitFocusContext';

// Only identity matters to the registry; a pane's methods are never called here except `term`.
const fakeApi = (name: string): PaneApi => ({ name, term: () => null }) as unknown as PaneApi;

describe('createSplitRegistry', () => {
  it('starts with no focused slot, so there is no focused api until App sets one', () => {
    const registry = createSplitRegistry();
    expect(registry.focusedSlot()).toBeNull();
    expect(registry.focusedApi()).toBeNull();
    // a pane registering does not focus itself: the registry never guesses
    registry.register('p0', fakeApi('p0'));
    expect(registry.focusedSlot()).toBeNull();
    expect(registry.focusedApi()).toBeNull();
  });

  it('answers the focused pane once App sets the slot, whichever order they happen in', () => {
    const registry = createSplitRegistry();
    const first = fakeApi('first');
    registry.setFocusedSlot('p1');
    expect(registry.focusedApi()).toBeNull(); // focused slot with no terminal pane
    registry.register('p1', first);
    expect(registry.focusedSlot()).toBe('p1');
    expect(registry.focusedApi()).toBe(first);
  });

  it('keys by any string, not just a and b', () => {
    const registry = createSplitRegistry();
    const apis = ['p0', 'p1', 'pz', 'p10'].map((slot) => [slot, fakeApi(slot)] as const);
    for (const [slot, api] of apis) registry.register(slot, api);
    for (const [slot, api] of apis) expect(registry.apiFor(slot)).toBe(api);
    expect(registry.apiFor('a')).toBeNull();
  });

  it('unregisters only its own registration', () => {
    const registry = createSplitRegistry();
    const old = fakeApi('old');
    const fresh = fakeApi('fresh');
    const unregisterOld = registry.register('p0', old);
    registry.register('p0', fresh); // the same slot re-registered before the old cleanup ran
    unregisterOld();
    expect(registry.apiFor('p0')).toBe(fresh);
  });

  it('drops the pane when its own cleanup runs, and the focused api with it', () => {
    const registry = createSplitRegistry();
    const unregister = registry.register('p0', fakeApi('p0'));
    registry.setFocusedSlot('p0');
    unregister();
    expect(registry.apiFor('p0')).toBeNull();
    expect(registry.focusedApi()).toBeNull();
    expect(registry.focusedSlot()).toBe('p0');
  });

  describe('forEachApi', () => {
    it('visits every registered pane with its slot, in registration order', () => {
      const registry = createSplitRegistry();
      const a = fakeApi('a');
      const b = fakeApi('b');
      const c = fakeApi('c');
      registry.register('p0', a);
      registry.register('p1', b);
      registry.register('p2', c);
      const seen: Array<[PaneApi, string]> = [];
      registry.forEachApi((api, slot) => seen.push([api, slot]));
      expect(seen).toEqual([
        [a, 'p0'],
        [b, 'p1'],
        [c, 'p2'],
      ]);
    });

    it('visits nothing for an empty registry, and skips an unregistered pane', () => {
      const registry = createSplitRegistry();
      const visit = vi.fn();
      registry.forEachApi(visit);
      expect(visit).not.toHaveBeenCalled();
      const unregister = registry.register('p0', fakeApi('p0'));
      unregister();
      registry.forEachApi(visit);
      expect(visit).not.toHaveBeenCalled();
    });

    it('is not disturbed by a visitor that unregisters or registers a pane', () => {
      const registry = createSplitRegistry();
      const unregisterFirst = registry.register('p0', fakeApi('p0'));
      registry.register('p1', fakeApi('p1'));
      const seen: string[] = [];
      registry.forEachApi((_api, slot) => {
        seen.push(slot);
        unregisterFirst();
        registry.register('p2', fakeApi('p2'));
      });
      expect(seen).toEqual(['p0', 'p1']);
      expect(registry.apiFor('p2')).not.toBeNull();
    });
  });
});
