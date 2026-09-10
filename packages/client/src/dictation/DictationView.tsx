// ── Dictation view (dock) ─────────────────────────────────────────────────────
//
// The dock-panel sibling of DictationHistory's modal. Same server, same three
// endpoints — `/transcripts`, `POST /transcribe?name=`, `/transcript-audio?name=`
// — and the same entry model; what changes is the frame. A modal hides the
// terminal output you dictated ABOUT, which is the one thing you want to see
// while you check the transcript, so this is a view instead.
//
// Recording lives at the top and the history under it, because those are the
// same act: you record, it lands as the newest card, and if the model refused
// the card is where you retry.
//
// AN ENTRY WITH AUDIO BUT NO TEXT IS AN OFFER, NOT AN ERROR. The server writes
// the clip BEFORE it calls the model, so a 500 from the transcriber leaves a
// playable recording and no words. That state is drawn as a dashed card with a
// Transcribe button: nothing was lost, something is owed. Drawing it as a
// failure would be a lie about the data — the audio is right there.
//
// The record button drives its OWN useDictation. This view is self-contained by
// design (its props are just the two sinks, Copy and Insert); a host that owns
// the recorder should lift that state rather than run a second recorder.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, IconButton } from '../ui';
import { useDictation } from './useDictation';
import './dictation-view.css';

interface Entry {
  /** Stamp id; also the key for /transcript-audio and /transcribe. */
  name: string;
  time: number;
  /** '' when the clip was never turned into text. */
  text: string;
  /** Whether the recording is still on disk (it ages out on a byte budget). */
  audio: boolean;
}

export interface DictationViewProps {
  /** Copy to the OS clipboard; the caller owns the toast. */
  onCopy: (text: string) => void;
  /** Paste into the focused terminal; the caller owns failure feedback. */
  onInsert: (text: string) => void;
}

// Emoji rather than SVG here — but the rail next door already
// learned that the platform emoji fallback renders the microphone nearly
// invisible against a dark panel. Same glyph, same decision: inline SVG,
// currentColor, so the button's own state colours it.
const MicIcon = () => (
  <svg
    viewBox="0 0 16 16"
    width="14"
    height="14"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    aria-hidden="true"
  >
    <rect x="6" y="1.7" width="4" height="7.2" rx="2" />
    <path d="M3.6 7.4a4.4 4.4 0 0 0 8.8 0M8 11.8v2.5" strokeLinecap="round" />
  </svg>
);

const StopIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
    <rect x="4" y="4" width="8" height="8" rx="1.5" />
  </svg>
);

const timeLabel = (ms: number): string =>
  ms
    ? new Date(ms).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';

/** Seconds → "m:ss". Only rendered once the browser has read the container. */
const durationLabel = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

export function DictationView({ onCopy, onInsert }: DictationViewProps) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState('');
  /** Entry id currently being transcribed — at most one at a time (it is paid). */
  const [busy, setBusy] = useState('');
  /** Per-entry failure text, cleared when that entry is retried. */
  const [failed, setFailed] = useState<Record<string, string>>({});
  /** Read off each <audio> once its metadata lands; absent until then. */
  const [durations, setDurations] = useState<Record<string, number>>({});
  /** The one entry currently playing back, if any. */
  const [playing, setPlaying] = useState('');
  const players = useRef<Record<string, HTMLAudioElement | null>>({});

  const load = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch('/transcripts');
      if (!res.ok) throw new Error(String(res.status));
      const json = (await res.json()) as { entries: Entry[] };
      setEntries(json.entries);
    } catch {
      setError('Could not load history');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const dictation = useDictation({
    onText: (text) => {
      onInsert(text);
      // The clip is now on disk, so the list is stale the moment this returns.
      void load();
    },
    onError: (message) => setError(message),
    onAutoStop: () => setError('Recording hit the 5 minute limit — transcribing what there is'),
    // 0 = no client-side pre-reject; the server owns the cap and answers 413.
    // The recorder is already time-capped, which is the limit that actually bites.
    maxBytes: 0,
  });

  const recording = dictation.state === 'recording';
  const working = dictation.state === 'working';

  const transcribe = async (name: string): Promise<void> => {
    setBusy(name);
    setFailed((f) => ({ ...f, [name]: '' }));
    try {
      const res = await fetch(`/transcribe?name=${encodeURIComponent(name)}`, { method: 'POST' });
      const json = (await res.json().catch(() => null)) as { text?: string; error?: string } | null;
      if (!res.ok) throw new Error(json?.error || `failed (${res.status})`);
      const text = json?.text ?? '';
      if (!text) throw new Error('nothing heard in that recording');
      setEntries((list) => list?.map((e) => (e.name === name ? { ...e, text } : e)) ?? list);
    } catch (err) {
      setFailed((f) => ({ ...f, [name]: err instanceof Error ? err.message : 'failed' }));
    } finally {
      setBusy('');
    }
  };

  const togglePlay = (name: string): void => {
    const el = players.current[name];
    if (!el) return;
    if (el.paused)
      void el.play().catch(() => setFailed((f) => ({ ...f, [name]: 'playback failed' })));
    else el.pause();
  };

  const count = entries?.length ?? 0;

  return (
    <div className="dictation-view" data-testid="dictation-view">
      <Button
        variant={recording ? 'danger' : 'primary'}
        className="dictation-record"
        data-testid="dictation-record"
        disabled={working}
        onClick={dictation.toggle}
      >
        {recording ? <StopIcon /> : <MicIcon />}
        {recording ? 'Stop' : working ? 'Transcribing…' : 'Record'}
      </Button>

      {error && (
        <p className="dictation-error" data-testid="dictation-error">
          {error}
        </p>
      )}

      <div className="dictation-group">
        History{entries ? ` · ${count} ${count === 1 ? 'entry' : 'entries'}` : ''}
      </div>

      {entries?.length === 0 && (
        <p className="dictation-empty" data-testid="dictation-empty">
          No dictations yet.
        </p>
      )}

      {entries?.map((entry) => {
        const duration = durationLabel(durations[entry.name] ?? 0);
        return (
          <div
            className={entry.text ? 'dictation-card' : 'dictation-card dictation-card-pending'}
            data-testid={`dv-card-${entry.name}`}
            key={entry.name}
          >
            <span className="dictation-card-body">
              {entry.text ? (
                <span className="dictation-card-text">{`“${entry.text}”`}</span>
              ) : (
                <span className="dictation-card-text dictation-card-muted">
                  <i>audio only</i> · {timeLabel(entry.time)}
                </span>
              )}
              {entry.text ? (
                <span className="dictation-card-sub">
                  {timeLabel(entry.time)}
                  {duration && ` · ${duration}`}
                </span>
              ) : (
                <span className="dictation-card-sub dictation-card-warn">
                  {entry.audio
                    ? 'the model failed · your words are kept'
                    : 'the recording aged out'}
                </span>
              )}
              {failed[entry.name] && (
                <span className="dictation-card-sub dictation-card-warn">{failed[entry.name]}</span>
              )}
            </span>

            {entry.audio && (
              // preload="metadata" is what gives the card its duration, and it
              // is only affordable because /transcript-audio answers Range
              // requests — otherwise every card would pull a whole clip.
              <audio
                preload="metadata"
                src={`/transcript-audio?name=${encodeURIComponent(entry.name)}`}
                data-testid={`dv-audio-${entry.name}`}
                ref={(el) => {
                  players.current[entry.name] = el;
                }}
                onLoadedMetadata={(e) => {
                  // Read the duration HERE, not inside the updater. React calls
                  // a functional setState lazily, during the next render, and by
                  // then it has nulled the synthetic event's currentTarget — so
                  // the deferred read threw and took the whole app down with it
                  // (a render-phase throw, above every handler's try/catch).
                  const seconds = e.currentTarget.duration;
                  setDurations((d) => ({ ...d, [entry.name]: seconds }));
                }}
                onPlay={() => setPlaying(entry.name)}
                onPause={() => setPlaying((p) => (p === entry.name ? '' : p))}
                onEnded={() => setPlaying((p) => (p === entry.name ? '' : p))}
              />
            )}

            <span className="dictation-card-actions">
              {entry.audio && (
                <IconButton
                  label={playing === entry.name ? 'Pause' : 'Play recording'}
                  size="sm"
                  data-testid={`dv-play-${entry.name}`}
                  onClick={() => togglePlay(entry.name)}
                >
                  {playing === entry.name ? '❚❚' : '▶'}
                </IconButton>
              )}
              {entry.text ? (
                <>
                  <IconButton
                    label="Copy transcript"
                    size="sm"
                    data-testid={`dv-copy-${entry.name}`}
                    onClick={() => onCopy(entry.text)}
                  >
                    ⧉
                  </IconButton>
                  <IconButton
                    label="Insert into terminal"
                    size="sm"
                    data-testid={`dv-insert-${entry.name}`}
                    onClick={() => onInsert(entry.text)}
                  >
                    ↵
                  </IconButton>
                </>
              ) : (
                <Button
                  variant="primary"
                  size="sm"
                  data-testid={`dv-transcribe-${entry.name}`}
                  disabled={!entry.audio || !!busy}
                  onClick={() => void transcribe(entry.name)}
                >
                  {busy === entry.name ? 'Transcribing…' : 'Transcribe'}
                </Button>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}
