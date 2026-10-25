import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSystemPrefersDark } from './useSystemPrefersDark';

/** A `matchMedia` the test can flip: `matches` is read live, `change` is dispatched. */
const stubScheme = (initialDark: boolean) => {
  let dark = initialDark;
  const listeners = new Set<() => void>();
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        media: query,
        get matches() {
          return query.includes('prefers-color-scheme: dark') ? dark : false;
        },
        addEventListener: (_: string, cb: () => void) => listeners.add(cb),
        removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
      }) as unknown as MediaQueryList,
  );
  return {
    set: (next: boolean) => {
      dark = next;
      listeners.forEach((cb) => cb());
    },
    listeners,
  };
};

afterEach(() => vi.restoreAllMocks());

describe('useSystemPrefersDark', () => {
  it('starts from what the system says on the first render', () => {
    stubScheme(true);
    expect(renderHook(() => useSystemPrefersDark()).result.current).toBe(true);
  });

  it('follows a scheme change live', () => {
    const scheme = stubScheme(true);
    const { result } = renderHook(() => useSystemPrefersDark());
    act(() => scheme.set(false));
    expect(result.current).toBe(false);
    act(() => scheme.set(true));
    expect(result.current).toBe(true);
  });

  it('stops listening on unmount', () => {
    const scheme = stubScheme(false);
    const { unmount } = renderHook(() => useSystemPrefersDark());
    expect(scheme.listeners.size).toBe(1);
    unmount();
    expect(scheme.listeners.size).toBe(0);
  });
});
