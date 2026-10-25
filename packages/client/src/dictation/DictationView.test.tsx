// The dictation view, and above all the failure that took the whole app down:
// `loadedmetadata` fired, the handler read `e.currentTarget.duration` inside a
// functional setState, React ran that updater during the NEXT render — by which
// time it had nulled currentTarget — and the throw happened in the render phase,
// where no handler's try/catch can reach it. Every terminal went with it.

import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DictationView } from './DictationView';
import { Icon } from '../ui/icons';

// The recorder's state is the test's to set: the record button swaps its icon on it.
const recorder = vi.hoisted(() => ({ state: 'idle' as 'idle' | 'recording' | 'working' }));
vi.mock('./useDictation', () => ({
  useDictation: () => ({ state: recorder.state, toggle: vi.fn(), deadline: null, analyser: null }),
}));

/** The drawn shapes of a registered icon, to compare against what a control
 *  rendered. Rendered into a detached node so `screen` never sees it. */
const iconPaths = (name: string): string | undefined => {
  const host = document.createElement('div');
  render(<Icon name={name} />, { container: host });
  return host.querySelector('svg')?.innerHTML;
};

const ENTRIES = [
  { name: '20260901-2140', time: 1_756_000_000_000, text: 'hello there', audio: true },
  { name: '20260901-2130', time: 1_755_000_000_000, text: '', audio: true },
];

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  recorder.state = 'idle';
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

  // The record button, and the card actions, are drawn with the shared icons —
  // the view carried its own mic/stop SVGs and used ✕-style glyphs for the rest.
  // Every action is icon-only, so its label is its whole accessible name.
  it('draws its controls as icons and keeps their accessible names', async () => {
    await renderView();
    const record = screen.getByTestId('dictation-record');
    expect(record.querySelectorAll('svg')).toHaveLength(1);
    expect(record.querySelector('svg')?.innerHTML).toBe(iconPaths('mic'));
    expect(record).toHaveTextContent('Record');

    const name = '20260901-2140';
    for (const [id, label, icon] of [
      [`dv-play-${name}`, 'Play recording', 'play'],
      [`dv-copy-${name}`, 'Copy transcript', 'copy'],
      [`dv-insert-${name}`, 'Insert into terminal', 'newline'],
    ] as const) {
      const button = screen.getByTestId(id);
      expect(button.querySelectorAll('svg')).toHaveLength(1);
      expect(button.querySelector('svg')?.innerHTML, id).toBe(iconPaths(icon));
      expect(button).toHaveAttribute('aria-label', label);
      expect(button.textContent).toBe('');
    }
  });

  // Stop is a square, not a second mic, and the label says which it is.
  it('swaps the record button to the stop icon while recording', async () => {
    recorder.state = 'recording';
    await renderView();
    const record = screen.getByTestId('dictation-record');
    expect(record).toHaveTextContent('Stop');
    expect(record.querySelector('svg')?.innerHTML).toBe(iconPaths('stop'));
  });

  it('keeps the mic, disabled, while a clip is being transcribed', async () => {
    recorder.state = 'working';
    await renderView();
    const record = screen.getByTestId('dictation-record');
    expect(record).toBeDisabled();
    expect(record).toHaveTextContent('Transcribing…');
    expect(record.querySelector('svg')?.innerHTML).toBe(iconPaths('mic'));
  });

  // ❚❚ / ▶ were one glyph swapped on state; the icon and the label both follow
  // what the audio element reports.
  it('shows pause and its label while a clip plays, and play again when it stops', async () => {
    await renderView();
    const name = '20260901-2140';
    const button = () => screen.getByTestId(`dv-play-${name}`);
    const audio = screen.getByTestId(`dv-audio-${name}`);

    act(() => void audio.dispatchEvent(new Event('play')));
    expect(button().querySelector('svg')?.innerHTML).toBe(iconPaths('pause'));
    expect(button()).toHaveAttribute('aria-label', 'Pause');

    act(() => void audio.dispatchEvent(new Event('pause')));
    expect(button().querySelector('svg')?.innerHTML).toBe(iconPaths('play'));
    expect(button()).toHaveAttribute('aria-label', 'Play recording');
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
