// The history is AUDIO → TEXT → ACTIONS, and the text step is allowed to be
// missing. A dictation whose transcription failed used to leave nothing at all;
// now the clip is on disk and the entry offers to run the model again.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DictationHistory } from './DictationHistory';

interface Entry {
  name: string;
  time: number;
  text: string;
  audio: boolean;
}

const TRANSCRIBED: Entry = {
  name: '20260807-101500',
  time: new Date(2026, 7, 7, 10, 15, 0).getTime(),
  text: 'o ditado transcrito',
  audio: true,
};
const PENDING: Entry = {
  name: '20260807-102000',
  time: new Date(2026, 7, 7, 10, 20, 0).getTime(),
  text: '',
  audio: true,
};
const ORPHANED: Entry = { name: '20260807-090000', time: 0, text: '', audio: false };

/** Stub /transcripts, and optionally the POST /transcribe retry. */
const mockFetch = (entries: Entry[], transcribe?: () => Response) => {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).startsWith('/transcribe')) {
      if (!transcribe) throw new Error('unexpected transcribe call');
      expect(init?.method).toBe('POST');
      return transcribe();
    }
    return new Response(JSON.stringify({ entries }), {
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
};

const noop = () => {};

afterEach(() => vi.unstubAllGlobals());

describe('DictationHistory', () => {
  it('offers Copy/Insert for an entry that has text', async () => {
    mockFetch([TRANSCRIBED]);
    const onInsert = vi.fn();
    render(<DictationHistory onClose={noop} onCopy={noop} onInsert={onInsert} />);

    await screen.findByText('o ditado transcrito');
    fireEvent.click(screen.getByTestId(`dh-insert-${TRANSCRIBED.name}`));

    expect(onInsert).toHaveBeenCalledWith('o ditado transcrito');
    expect(screen.queryByTestId(`dh-transcribe-${TRANSCRIBED.name}`)).toBeNull();
  });

  it('plays back the stored clip for any entry that still has one', async () => {
    mockFetch([TRANSCRIBED]);
    render(<DictationHistory onClose={noop} onCopy={noop} onInsert={noop} />);

    const audio = await screen.findByTestId(`dh-audio-${TRANSCRIBED.name}`);
    expect(audio.getAttribute('src')).toBe(`/transcript-audio?name=${TRANSCRIBED.name}`);
    // preload="none" fetched nothing until play, so the browser never learned
    // the duration and every row rendered a dead `0:00 / 0:00` scrubber
    // (verified in Chromium: duration NaN, readyState 0, no loadedmetadata).
    // Affordable only because /transcript-audio answers Range requests.
    expect(audio.getAttribute('preload')).toBe('metadata');
  });

  it('offers Transcribe — not Insert — when the audio never became text', async () => {
    mockFetch([PENDING]);
    render(<DictationHistory onClose={noop} onCopy={noop} onInsert={noop} />);

    const btn = await screen.findByTestId(`dh-transcribe-${PENDING.name}`);
    expect(btn).not.toBeDisabled();
    expect(screen.queryByTestId(`dh-insert-${PENDING.name}`)).toBeNull();
  });

  it('a successful retry replaces the entry with its text in place', async () => {
    mockFetch(
      [PENDING],
      () =>
        new Response(JSON.stringify({ text: 'finalmente transcrito' }), {
          headers: { 'content-type': 'application/json' },
        }),
    );
    render(<DictationHistory onClose={noop} onCopy={noop} onInsert={noop} />);

    fireEvent.click(await screen.findByTestId(`dh-transcribe-${PENDING.name}`));

    await screen.findByText('finalmente transcrito');
    expect(screen.getByTestId(`dh-insert-${PENDING.name}`)).toBeTruthy();
  });

  it('keeps the entry retryable when the retry fails, and says why', async () => {
    mockFetch(
      [PENDING],
      () =>
        new Response(JSON.stringify({ error: 'speech service returned 502' }), {
          status: 502,
          headers: { 'content-type': 'application/json' },
        }),
    );
    render(<DictationHistory onClose={noop} onCopy={noop} onInsert={noop} />);

    fireEvent.click(await screen.findByTestId(`dh-transcribe-${PENDING.name}`));

    await screen.findByText('speech service returned 502');
    await waitFor(() =>
      expect(screen.getByTestId(`dh-transcribe-${PENDING.name}`)).not.toBeDisabled(),
    );
  });

  it('cannot retry an entry whose clip aged out of the byte budget', async () => {
    mockFetch([ORPHANED]);
    render(<DictationHistory onClose={noop} onCopy={noop} onInsert={noop} />);

    expect(await screen.findByTestId(`dh-transcribe-${ORPHANED.name}`)).toBeDisabled();
    expect(screen.queryByTestId(`dh-audio-${ORPHANED.name}`)).toBeNull();
  });
});
