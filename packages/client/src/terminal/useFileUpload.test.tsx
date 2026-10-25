// A multi-file pick has to reach the PTY as ONE ordered line of paths.
// Uploading in parallel would let a small file overtake a large one, and typing
// the paths back-to-back would fuse them into a single unusable token.

import { createRef } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFileUpload } from './useFileUpload';

const file = (name: string, size = 4) =>
  new File([new Uint8Array(size)], name, { type: 'image/png' });

/** Resolve /upload with a path derived from the request's filename. */
const mockUpload = (delays: Record<string, number> = {}) =>
  vi.fn(async (input: string) => {
    const name = new URL(input, 'http://x').searchParams.get('filename') ?? '';
    const wait = delays[name] ?? 0;
    if (wait) await new Promise((r) => setTimeout(r, wait));
    return {
      ok: true,
      status: 200,
      json: async () => ({ path: `/tmp/${name}` }),
    } as Response;
  });

const setup = (sendToPty = vi.fn((_text: string) => true)) => {
  const view = renderHook(() =>
    useFileUpload({
      sendToPty,
      sessionId: '0',
      maxBytes: 1024,
      wrapRef: createRef<HTMLElement>(),
      onError: vi.fn(),
    }),
  );
  return { view, sendToPty };
};

const input = (testId: string) =>
  document.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`)!;

/** Put files on a hidden input and fire the change the picker would. */
const pick = (testId: string, files: File[]) => {
  const el = input(testId);
  Object.defineProperty(el, 'files', { value: files, configurable: true });
  act(() => {
    el.dispatchEvent(new Event('change'));
  });
};

describe('useFileUpload', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockUpload());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('types multi-picked paths in pick order, space-separated', async () => {
    // The slowest file is picked FIRST: a parallel upload would type it last.
    vi.stubGlobal('fetch', mockUpload({ 'a.png': 20 }));
    const { sendToPty } = setup();

    pick('upload-input', [file('a.png'), file('b.png'), file('c.png')]);

    await waitFor(() => expect(sendToPty).toHaveBeenCalledTimes(3));
    expect(sendToPty.mock.calls.map((c) => c[0])).toEqual([
      '/tmp/a.png',
      ' /tmp/b.png',
      ' /tmp/c.png',
    ]);
  });

  it('does not lead with a separator when the first file is rejected', async () => {
    const { sendToPty } = setup();

    // 2 KB against a 1 KB cap — rejected before any round trip.
    pick('upload-input', [file('big.png', 2048), file('ok.png')]);

    await waitFor(() => expect(sendToPty).toHaveBeenCalledTimes(1));
    expect(sendToPty).toHaveBeenCalledWith('/tmp/ok.png');
  });

  it('gives the image picker an image-only accept — that is what skips Android’s chooser', () => {
    setup();

    // An EMPTY accept makes Chrome offer "take a photo / record a video / file"
    // every time; image-only routes it straight to the system photo picker.
    expect(input('upload-image-input').accept).toBe('image/*');
    expect(input('upload-image-input').multiple).toBe(true);
    // The any-file picker keeps no accept (any type) but gains multi-select.
    expect(input('upload-input').accept).toBe('');
    expect(input('upload-input').multiple).toBe(true);
  });

  it('opens the picker the caller asked for', () => {
    const { view } = setup();
    const anyClick = vi.spyOn(input('upload-input'), 'click');
    const imageClick = vi.spyOn(input('upload-image-input'), 'click');

    view.result.current.openImagePicker();
    expect(imageClick).toHaveBeenCalled();
    expect(anyClick).not.toHaveBeenCalled();

    view.result.current.openPicker();
    expect(anyClick).toHaveBeenCalled();
  });

  // The drawer holds the layout still for a picker, and must hold it only for one
  // that is actually up. So a launch says whether it launched.
  it('says whether a picker was launched', () => {
    const { view } = setup();
    const { openPicker, openImagePicker } = view.result.current;

    expect(openPicker()).toBe(true);
    expect(openImagePicker()).toBe(true);

    // Unmounted, the hidden inputs are gone: the click goes nowhere.
    view.unmount();
    expect(openPicker()).toBe(false);
    expect(openImagePicker()).toBe(false);
  });
});

// A caller that holds its layout for the picker needs to hear when the picker is
// over, and the page gets no word of it from the OS dialog. `change` and `cancel`
// are the real signals; a focus back on a VISIBLE page is the fallback, after a
// grace for a late `change`. Nothing is time-based: a photo takes as long as it takes.
const setVisibility = (state: 'visible' | 'hidden') =>
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
const focusWindow = () => act(() => void window.dispatchEvent(new Event('focus')));
const advance = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

describe('useFileUpload picker return', () => {
  const GRACE_MS = 300;
  const fire = (testId: string, type: 'change' | 'cancel') =>
    act(() => void input(testId).dispatchEvent(new Event(type)));

  beforeEach(() => {
    vi.stubGlobal('fetch', mockUpload());
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    setVisibility('visible');
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(document, 'visibilityState');
  });

  it('reports a pick once', () => {
    const { view } = setup();
    const onReturn = vi.fn();
    view.result.current.openPicker(onReturn);
    expect(onReturn).not.toHaveBeenCalled();

    fire('upload-input', 'change');
    fire('upload-input', 'change'); // a second pick is a second launch's business
    expect(onReturn).toHaveBeenCalledTimes(1);
  });

  it('reports a cancel once, and listens on the input that was opened', () => {
    const { view } = setup();
    const onReturn = vi.fn();
    view.result.current.openImagePicker(onReturn);

    fire('upload-input', 'cancel'); // the OTHER input
    expect(onReturn).not.toHaveBeenCalled();
    fire('upload-image-input', 'cancel');
    fire('upload-image-input', 'cancel');
    expect(onReturn).toHaveBeenCalledTimes(1);
  });

  it('never lets go on elapsed time alone', () => {
    const { view } = setup();
    const onReturn = vi.fn();
    view.result.current.openPicker(onReturn);

    advance(10 * 60 * 1000);
    expect(onReturn).not.toHaveBeenCalled();
    fire('upload-input', 'change');
    expect(onReturn).toHaveBeenCalledTimes(1);
  });

  it('does not count a focus while the page is hidden as a return', () => {
    const { view } = setup();
    const onReturn = vi.fn();
    view.result.current.openPicker(onReturn);

    setVisibility('hidden');
    focusWindow();
    advance(60 * 1000);
    expect(onReturn).not.toHaveBeenCalled();
  });

  it('treats a confirmed return with no change as a cancel, after the grace', () => {
    const { view } = setup();
    const onReturn = vi.fn();
    view.result.current.openPicker(onReturn);

    focusWindow();
    expect(onReturn).not.toHaveBeenCalled();
    advance(0); // the tick; the grace is still running
    advance(GRACE_MS - 1);
    expect(onReturn).not.toHaveBeenCalled();
    advance(1);
    expect(onReturn).toHaveBeenCalledTimes(1);

    // Settled: neither another focus nor another clock reports it again.
    focusWindow();
    advance(60 * 1000);
    expect(onReturn).toHaveBeenCalledTimes(1);
  });

  it('does not restart the grace on a second focus, nor report twice', () => {
    const { view } = setup();
    const onReturn = vi.fn();
    view.result.current.openPicker(onReturn);

    focusWindow();
    advance(100);
    focusWindow(); // a flicker of focus inside the grace
    advance(60 * 1000);
    expect(onReturn).toHaveBeenCalledTimes(1);
  });

  it('lets a late change win the grace, and reports once', () => {
    const { view } = setup();
    const onReturn = vi.fn();
    view.result.current.openPicker(onReturn);

    focusWindow();
    advance(GRACE_MS / 2);
    fire('upload-input', 'change');
    expect(onReturn).toHaveBeenCalledTimes(1);
    advance(60 * 1000);
    expect(onReturn).toHaveBeenCalledTimes(1);
  });

  // The return listeners ride on the SAME input as the upload's own `change`: a pick
  // has to do both, and the order they were added in must not matter to either.
  it('uploads a pick and reports the return, both once', async () => {
    const { view, sendToPty } = setup();
    const onReturn = vi.fn();
    view.result.current.openPicker(onReturn);

    pick('upload-input', [file('a.png')]);
    expect(onReturn).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(sendToPty).toHaveBeenCalledWith('/tmp/a.png'));
    expect(sendToPty).toHaveBeenCalledTimes(1);
    expect(onReturn).toHaveBeenCalledTimes(1);
  });

  // On a desktop browser the window's `focus` commonly arrives AFTER the `change`. A
  // listener that survived the settle would count it as a second, confirmed return.
  it('does not report again when the window refocuses after a pick or a cancel', () => {
    const { view } = setup();
    const onReturn = vi.fn();
    view.result.current.openPicker(onReturn);
    fire('upload-input', 'change');
    focusWindow();
    advance(60 * 1000);
    expect(onReturn).toHaveBeenCalledTimes(1);

    const onCancelReturn = vi.fn();
    view.result.current.openImagePicker(onCancelReturn);
    fire('upload-image-input', 'cancel');
    focusWindow();
    advance(60 * 1000);
    expect(onCancelReturn).toHaveBeenCalledTimes(1);
  });

  // A focus on a hidden page is ignored, not spent: the picker is still up, and the real
  // return still has to be heard when the page is visible again.
  it('still hears the return after a focus it ignored while the page was hidden', () => {
    const { view } = setup();
    const onReturn = vi.fn();
    view.result.current.openPicker(onReturn);

    setVisibility('hidden');
    focusWindow();
    advance(60 * 1000);
    expect(onReturn).not.toHaveBeenCalled();

    setVisibility('visible');
    focusWindow();
    advance(GRACE_MS - 1);
    expect(onReturn).not.toHaveBeenCalled();
    advance(1);
    expect(onReturn).toHaveBeenCalledTimes(1);
  });

  it('gives the image picker the same confirmed return', () => {
    const { view } = setup();
    const onReturn = vi.fn();
    view.result.current.openImagePicker(onReturn);

    focusWindow();
    advance(GRACE_MS - 1);
    expect(onReturn).not.toHaveBeenCalled();
    advance(1);
    expect(onReturn).toHaveBeenCalledTimes(1);
  });

  // A launch that went nowhere is not a picker: nothing is up to come back from, so a
  // caller must never be told it returned.
  it('never reports the return of a picker that did not launch', () => {
    const { view } = setup();
    const { openPicker } = view.result.current;
    view.unmount();

    const onReturn = vi.fn();
    expect(openPicker(onReturn)).toBe(false);
    focusWindow();
    advance(60 * 1000);
    expect(onReturn).not.toHaveBeenCalled();
  });

  it('settles the previous picker when a new one launches', () => {
    const { view } = setup();
    const first = vi.fn();
    const second = vi.fn();
    view.result.current.openPicker(first);
    view.result.current.openImagePicker(second);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();

    fire('upload-image-input', 'cancel');
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledTimes(1);
  });

  it('does not strand a caller when the pane unmounts mid-picker', () => {
    const { view } = setup();
    const onReturn = vi.fn();
    view.result.current.openPicker(onReturn);

    view.unmount();
    expect(onReturn).toHaveBeenCalledTimes(1);
  });

  it('launches without a return callback', () => {
    const { view } = setup();
    expect(view.result.current.openPicker()).toBe(true);
    focusWindow();
    advance(60 * 1000); // nothing to report to, and nothing throws
  });
});
