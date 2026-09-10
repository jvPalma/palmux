// ── Dictation history panel ───────────────────────────────────────────────────
//
// Recent dictations, newest first, from the server's persisted history
// (~/.config/palmux/transcripts/). Each entry is AUDIO → TEXT → ACTIONS, and
// the middle step is allowed to be missing: the clip is written to disk before
// the transcriber is ever called, so a model/network failure still leaves a
// playable recording here. An entry with no text offers "Transcribe" (re-runs
// the model server-side on the stored clip); one with text offers the usual
// Copy / Insert. That makes this the recovery path for BOTH halves of the
// pipeline — a transcription that never happened, and an injection that landed
// nowhere.
//
// Modal on both layouts — same precedent as the keybindings editor: the list
// needs the room.

import { useEffect, useState } from 'react';

interface Entry {
  /** Stamp id; also the key for /transcript-audio and /transcribe. */
  name: string;
  time: number;
  /** '' when the clip was never turned into text. */
  text: string;
  /** Whether the recording is still on disk (it ages out on a byte budget). */
  audio: boolean;
}

export interface DictationHistoryProps {
  onClose: () => void;
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

export function DictationHistory({ onClose, onCopy, onInsert }: DictationHistoryProps) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState('');
  /** Entry id currently being transcribed — at most one at a time (it is paid). */
  const [busy, setBusy] = useState('');
  /** Per-entry failure text, cleared when that entry is retried. */
  const [failed, setFailed] = useState<Record<string, string>>({});

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let alive = true;
    fetch('/transcripts')
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const json = (await res.json()) as { entries: Entry[] };
        if (alive) setEntries(json.entries);
      })
      .catch(() => {
        if (alive) setError('Could not load history');
      });
    return () => {
      alive = false;
    };
  }, []);

  const transcribe = async (name: string): Promise<void> => {
    setBusy(name);
    setFailed((f) => ({ ...f, [name]: '' }));
    try {
      const res = await fetch(`/transcribe?name=${encodeURIComponent(name)}`, { method: 'POST' });
      const json = (await res.json().catch(() => null)) as {
        text?: string;
        error?: string;
      } | null;
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

  return (
    <div className="panel-overlay" onPointerDown={onClose}>
      <div
        className="panel dictation-history"
        onPointerDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Dictation history"
      >
        <h2>Dictation history</h2>
        {error && <p className="dh-empty">{error}</p>}
        {entries?.length === 0 && <p className="dh-empty">No dictations yet.</p>}
        {entries?.map((entry) => (
          <div className="dh-entry" key={entry.name}>
            <div className="dh-head">
              <span className="dh-time">{timeLabel(entry.time)}</span>
              {entry.text ? (
                <>
                  <button
                    type="button"
                    data-testid={`dh-copy-${entry.name}`}
                    onClick={() => onCopy(entry.text)}
                  >
                    Copy
                  </button>
                  <button
                    type="button"
                    data-testid={`dh-insert-${entry.name}`}
                    onClick={() => onInsert(entry.text)}
                  >
                    Insert
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="dh-transcribe"
                  data-testid={`dh-transcribe-${entry.name}`}
                  disabled={!entry.audio || !!busy}
                  onClick={() => void transcribe(entry.name)}
                >
                  {busy === entry.name ? 'Transcribing…' : 'Transcribe'}
                </button>
              )}
            </div>

            {entry.audio && (
              // `preload="none"` fetched nothing until play, so the browser
              // never learned the duration and every row rendered a dead
              // `0:00 / 0:00` scrubber. `metadata` is only affordable because
              // /transcript-audio now answers Range requests — the browser
              // reads the container header instead of pulling whole clips for
              // every entry in the panel.
              <audio
                className="dh-audio"
                controls
                preload="metadata"
                src={`/transcript-audio?name=${encodeURIComponent(entry.name)}`}
                data-testid={`dh-audio-${entry.name}`}
              />
            )}

            {entry.text ? (
              <div className="dh-text">{entry.text}</div>
            ) : (
              <div className="dh-text dh-untranscribed">
                {entry.audio
                  ? 'Not transcribed — the recording is still here.'
                  : 'No transcript, and the recording has aged out.'}
              </div>
            )}
            {failed[entry.name] && <div className="dh-error">{failed[entry.name]}</div>}
          </div>
        ))}
        <div style={{ marginTop: 18, textAlign: 'right' }}>
          <button
            className="icon-btn"
            onClick={onClose}
            style={{ width: 'auto', padding: '0 16px' }}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
