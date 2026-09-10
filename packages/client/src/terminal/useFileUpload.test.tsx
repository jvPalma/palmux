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
});
