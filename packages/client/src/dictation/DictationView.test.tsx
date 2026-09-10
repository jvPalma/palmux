// The dictation view, and above all the failure that took the whole app down:
// `loadedmetadata` fired, the handler read `e.currentTarget.duration` inside a
// functional setState, React ran that updater during the NEXT render — by which
// time it had nulled currentTarget — and the throw happened in the render phase,
// where no handler's try/catch can reach it. Every terminal went with it.

import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DictationView } from './DictationView';

vi.mock('./useDictation', () => ({
  useDictation: () => ({ state: 'idle', toggle: vi.fn(), deadline: null, analyser: null }),
}));

const ENTRIES = [
  { name: '20260901-2140', time: 1_756_000_000_000, text: 'hello there', audio: true },
  { name: '20260901-2130', time: 1_755_000_000_000, text: '', audio: true },
];

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ entries: ENTRIES }),
  }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const renderView = async () => {
  render(<DictationView onCopy={vi.fn()} onInsert={vi.fn()} />);
  await screen.findByTestId(`dv-card-${ENTRIES[0]!.name}`);
};

describe('DictationView', () => {
  it('lists an entry with text and one that is audio-only', async () => {
    await renderView();
    expect(screen.getByTestId('dv-card-20260901-2140').textContent).toContain('hello there');
    // Audio with no text is an OFFER, not an error: it gets a Transcribe button.
    expect(screen.getByTestId('dv-transcribe-20260901-2130')).toBeTruthy();
    expect(screen.queryByTestId('dv-transcribe-20260901-2140')).toBeNull();
  });

  // The crash, reproduced at its source. React invokes a functional updater
  // lazily; anything the updater reads off the synthetic event is gone by then.
  it('survives loadedmetadata — the duration is read in the handler, not the updater', async () => {
    await renderView();
    const audio = screen.getByTestId('dv-audio-20260901-2140') as HTMLAudioElement;
    Object.defineProperty(audio, 'duration', { value: 12.4, configurable: true });

    // Fire it the way the browser does, then force the re-render the updater
    // runs in. Before the fix this threw inside render and unmounted the tree.
    audio.dispatchEvent(new Event('loadedmetadata'));

    await waitFor(() => {
      expect(screen.getByTestId('dv-card-20260901-2140').textContent).toContain('0:12');
    });
    // Still mounted — which is the entire claim.
    expect(screen.getByTestId('dictation-view')).toBeTruthy();
  });

  it('reports a history that will not load instead of rendering an empty list', async () => {
    fetchMock.mockImplementation(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    render(<DictationView onCopy={vi.fn()} onInsert={vi.fn()} />);
    expect(await screen.findByTestId('dictation-error')).toHaveTextContent(
      'Could not load history',
    );
  });
});
