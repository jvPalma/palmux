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
// A CARD IS A HEADER OVER A TRANSCRIPT. The header carries date · duration on the
// left and the actions on the right; the transcript sits under it at the card's
// full width, clamped to four lines. It used to sit BESIDE the actions, which
// left a long dictation a ~150px column that wrapped at every other word and ran
// the card to the height of the dock.
//
// The record button drives its OWN useDictation. This view is self-contained by
// design (its props are just the two sinks, Copy and Insert); a host that owns
// the recorder should lift that state rather than run a second recorder.

import {
  type SyntheticEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { Button, IconButton } from '../ui';
import { Icon } from '../ui/icons';
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

/** A transcript clamped to four lines, with a Show more / Show less toggle when
 *  there is more than that. Whether it overflows is MEASURED, not guessed from
 *  the length: the answer depends on the card's width (300px dock, phone drawer)
 *  and on the font that happens to be loaded. */
function Transcript({ name, text }: { name: string; text: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    // Expanded text has no clamp to overflow, so there is nothing to measure.
    // `overflows` keeps its last answer, which is what keeps "Show less" on screen.
    if (!el || expanded) return;
    const measure = (): void => setOverflows(el.scrollHeight > el.clientHeight);
    measure();
    // The dock can be resized and a webfont can land after the first paint; both
    // re-wrap the text without touching it.
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text, expanded]);

  const textId = `dictation-text-${name}`;
  return (
    <>
      <p
        className="dictation-card-text"
        id={textId}
        ref={ref}
        data-clamped={String(!expanded)}
        data-testid={`dv-text-${name}`}
      >
        {text}
      </p>
      {overflows && (
        <button
          type="button"
          className="dictation-card-toggle"
          aria-expanded={expanded}
          aria-controls={textId}
          data-testid={`dv-toggle-${name}`}
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </>
  );
}

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
  /** The entry whose scrubber is showing: from its first play until it ends. It
   *  outlives a pause, or the scrubber would vanish exactly when you want to seek. */
  const [scrubbing, setScrubbing] = useState('');
  /** Playback position (seconds) of the `scrubbing` entry. */
  const [position, setPosition] = useState(0);
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
    if (el.paused) {
      // One clip at a time: `playing` and the scrubber each name a single entry,
      // so a second clip left running would be audible and have no controls.
      for (const [other, player] of Object.entries(players.current)) {
        if (other !== name && player && !player.paused) player.pause();
      }
      void el.play().catch(() => setFailed((f) => ({ ...f, [name]: 'playback failed' })));
    } else el.pause();
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
        <Icon name={recording ? 'stop' : 'mic'} size={14} />
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
        const total = durations[entry.name] ?? 0;
        const scrubMax = Number.isFinite(total) && total > 0 ? total : 0;
        // Read the duration HERE, not inside the updater. React calls a
        // functional setState lazily, during the next render, and by then it has
        // nulled the synthetic event's currentTarget — so the deferred read threw
        // and took the whole app down with it (a render-phase throw, above every
        // handler's try/catch). Both events land here: a MediaRecorder clip says
        // Infinity at loadedmetadata and only learns its length later.
        const takeDuration = (e: SyntheticEvent<HTMLAudioElement>): void => {
          const seconds = e.currentTarget.duration;
          setDurations((d) => ({ ...d, [entry.name]: seconds }));
        };
        return (
          <div
            className={entry.text ? 'dictation-card' : 'dictation-card dictation-card-pending'}
            data-testid={`dv-card-${entry.name}`}
            key={entry.name}
          >
            <div className="dictation-card-head" data-testid={`dv-head-${entry.name}`}>
              <span className="dictation-card-when" data-testid={`dv-when-${entry.name}`}>
                {timeLabel(entry.time)}
                {duration && ` · ${duration}`}
              </span>

              <span className="dictation-card-actions">
                {entry.audio && (
                  <IconButton
                    label={playing === entry.name ? 'Pause' : 'Play recording'}
                    size="sm"
                    data-testid={`dv-play-${entry.name}`}
                    onClick={() => togglePlay(entry.name)}
                  >
                    <Icon name={playing === entry.name ? 'pause' : 'play'} size={14} />
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
                      <Icon name="copy" size={14} />
                    </IconButton>
                    <IconButton
                      label="Insert into terminal"
                      size="sm"
                      data-testid={`dv-insert-${entry.name}`}
                      onClick={() => onInsert(entry.text)}
                    >
                      <Icon name="newline" size={14} />
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

            {entry.text ? (
              <Transcript name={entry.name} text={entry.text} />
            ) : (
              <p className="dictation-card-sub dictation-card-warn">
                <i>audio only</i> ·{' '}
                {entry.audio ? 'the model failed · your words are kept' : 'the recording aged out'}
              </p>
            )}
            {failed[entry.name] && (
              <p className="dictation-card-sub dictation-card-warn">{failed[entry.name]}</p>
            )}

            {scrubbing === entry.name && (
              // A native range: keyboard-operable and announced as a slider for
              // free. It sits under the text, where the eye already is, rather
              // than in the header, which has no room for a track at 300px.
              <input
                type="range"
                className="dictation-card-scrub"
                aria-label="Seek recording"
                data-testid={`dv-scrub-${entry.name}`}
                min={0}
                max={scrubMax}
                step={0.1}
                // Until the length is known there is nowhere to seek TO: a 0..0
                // track that accepts input only pretends to work.
                disabled={scrubMax === 0}
                value={Math.min(position, scrubMax)}
                onChange={(e) => {
                  // Read the value HERE, not in a deferred updater (see takeDuration).
                  const seconds = Number(e.currentTarget.value);
                  const el = players.current[entry.name];
                  if (el) el.currentTime = seconds;
                  setPosition(seconds);
                }}
              />
            )}

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
                onLoadedMetadata={takeDuration}
                onDurationChange={takeDuration}
                onPlay={(e) => {
                  const seconds = e.currentTarget.currentTime;
                  setPlaying(entry.name);
                  setScrubbing(entry.name);
                  setPosition(seconds);
                }}
                onTimeUpdate={(e) => {
                  const seconds = e.currentTarget.currentTime;
                  if (scrubbing === entry.name) setPosition(seconds);
                }}
                onPause={() => setPlaying((p) => (p === entry.name ? '' : p))}
                onEnded={() => {
                  setPlaying((p) => (p === entry.name ? '' : p));
                  setScrubbing((s) => (s === entry.name ? '' : s));
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
