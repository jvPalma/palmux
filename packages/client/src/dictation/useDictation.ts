// ── Voice dictation hook ──────────────────────────────────────────────────────
//
// Push-to-talk, not live: one toggle starts the recording, the next stops it,
// and the whole snippet is POSTed to /dictate in one piece. Streaming was
// dropped on purpose — a ~4s round-trip on a short snippet is close enough to
// instant, and chunked streaming ASR cuts words at the chunk boundaries.
//
// getUserMedia only exists in a SECURE CONTEXT (https:// or localhost), so over
// plain http on a LAN address `navigator.mediaDevices` is undefined. That is
// reported as a normal error rather than crashing, because it is the single most
// likely reason this feature appears broken.

import { useCallback, useRef, useState } from 'react';

/** idle → recording (mic hot) → working (uploading + transcribing) → idle. */
export type DictationState = 'idle' | 'recording' | 'working';

interface UseDictationParams {
  /** Receives the cleaned line. Never called with an empty string. */
  onText: (text: string) => void;
  /**
   * `recoverable` means the words still exist server-side, so the host can offer
   * a route to them. It is a FLAG rather than wording baked into the message:
   * the host, not this hook, knows whether the history is a dock view or a
   * mobile panel.
   */
  onError: (message: string, recoverable?: boolean) => void;
  /** The time limit auto-stopped the recording (it still transcribes). */
  onAutoStop?: () => void;
  /** Server-enforced upload cap, mirrored client-side. */
  maxBytes: number;
}

export interface UseDictationResult {
  state: DictationState;
  /** Start recording, or stop and transcribe if already recording. */
  toggle: () => void;
  /** Epoch ms when the auto-stop fires; null outside 'recording'. */
  deadline: number | null;
  /**
   * Live level meter over the SAME MediaStream the recorder is using, so the
   * recording indicator shows what is actually being captured. Null outside
   * 'recording'. Without this the toast's waveform would have to be decorative,
   * and a decorative waveform on a dead microphone asserts that recording is
   * working — worse than showing nothing.
   */
  analyser: AnalyserNode | null;
}

// Containers a MediaRecorder may produce, in the order we prefer them. Chrome
// and Firefox take the first; Safari (iOS included) only does mp4/aac.
const PREFERRED_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];

// A forgotten recording must not grow until it trips the upload cap, so it is
// cut here. 5 min is roomy for a long dictated prompt (~5 MB of opus, well
// under both the upload cap and Gemini's inline-audio limit); the pill counts
// this down so hitting it is never a surprise.
export const MAX_RECORDING_MS = 300_000;

function pickMimeType(): string {
  for (const type of PREFERRED_TYPES) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return ''; // let the browser choose; the blob still reports its own type
}

export function useDictation({
  onText,
  onError,
  onAutoStop,
  maxBytes,
}: UseDictationParams): UseDictationResult {
  const [state, setState] = useState<DictationState>('idle');
  const [deadline, setDeadline] = useState<number | null>(null);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const audioCtx = useRef<AudioContext | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  /** Drop the level meter and its AudioContext. Called on every path that stops
   *  the stream — a node left wired to stopped tracks reads silence forever,
   *  which is indistinguishable from a broken microphone. */
  const releaseMeter = useCallback(() => {
    setAnalyser(null);
    void audioCtx.current?.close().catch(() => {});
    audioCtx.current = null;
  }, []);
  const autoStop = useRef<number | undefined>(undefined);

  const transcribe = useCallback(
    async (blob: Blob) => {
      if (blob.size === 0) {
        setState('idle');
        return;
      }
      // 0 means the upload limit was taken off in config.json — no pre-reject.
      if (maxBytes > 0 && blob.size > maxBytes) {
        setState('idle');
        onError('Recording too long');
        return;
      }
      let res: Response;
      try {
        res = await fetch(`/dictate?mime=${encodeURIComponent(blob.type)}`, {
          method: 'POST',
          headers: { 'Content-Type': blob.type || 'application/octet-stream' },
          body: blob,
        });
      } catch {
        setState('idle');
        onError('Dictation failed — server unreachable');
        return;
      }
      setState('idle');
      if (!res.ok) {
        const detail = (await res.json().catch(() => null)) as {
          error?: string;
          recoverable?: boolean;
        } | null;
        const why = detail?.error
          ? `Dictation: ${detail.error}`
          : `Dictation failed (${res.status})`;
        // The server stores the clip before it calls the model, so a failure
        // here has NOT lost the words — say so, or the user re-records for
        // nothing. The retry itself lives in the history panel, which the host
        // offers as the toast's action.
        onError(detail?.recoverable ? `${why} — recording kept` : why, detail?.recoverable);
        return;
      }
      let text: string;
      try {
        text = ((await res.json()) as { text: string }).text;
      } catch {
        onError('Dictation failed — bad server response');
        return;
      }
      if (!text) {
        onError('Nothing heard');
        return;
      }
      onText(text);
    },
    [maxBytes, onError, onText],
  );

  const start = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      onError('Dictation needs HTTPS (or localhost)');
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      onError('Microphone blocked — allow access for this site');
      return;
    }
    const mimeType = pickMimeType();
    // Tap the stream for a level meter. Best-effort: an engine without
    // AudioContext still records, the meter simply stays absent.
    try {
      const Ctx =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (Ctx) {
        const ctx = new Ctx();
        audioCtx.current = ctx;
        const node = ctx.createAnalyser();
        node.fftSize = 256;
        ctx.createMediaStreamSource(stream).connect(node);
        setAnalyser(node);
      }
    } catch {
      /* no meter; recording is unaffected */
    }
    const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    rec.onstop = () => {
      // Release the mic, or the browser keeps showing the recording indicator.
      for (const track of stream.getTracks()) track.stop();
      releaseMeter();
      window.clearTimeout(autoStop.current);
      recorder.current = null;
      void transcribe(new Blob(chunks, { type: rec.mimeType || mimeType }));
    };
    recorder.current = rec;
    try {
      rec.start();
    } catch {
      // start() can throw (codec/container edge cases). Without this cleanup a
      // dead recorder stays in the ref and the next toggle stop()s it — which
      // throws again and wedges the state machine at 'working' forever.
      for (const track of stream.getTracks()) track.stop();
      releaseMeter();
      recorder.current = null;
      onError('Recording failed to start');
      return;
    }
    setState('recording');
    setDeadline(Date.now() + MAX_RECORDING_MS);
    autoStop.current = window.setTimeout(() => {
      // The cut still transcribes, but silently swallowing the tail of what the
      // user was saying reads as data loss — announce it.
      setState('working');
      setDeadline(null);
      onAutoStop?.();
      rec.stop();
    }, MAX_RECORDING_MS);
  }, [onError, onAutoStop, transcribe, releaseMeter]);

  const toggle = useCallback(() => {
    const rec = recorder.current;
    if (rec) {
      setDeadline(null);
      if (rec.state === 'inactive') {
        // Defensive: an already-dead recorder must not wedge us in 'working'.
        recorder.current = null;
        setState('idle');
        return;
      }
      setState('working');
      rec.stop(); // onstop drives the rest
      return;
    }
    if (state === 'working') return; // a transcription is already in flight
    void start();
  }, [start, state]);

  return { state, toggle, deadline, analyser };
}
