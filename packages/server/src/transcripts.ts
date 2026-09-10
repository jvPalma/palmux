// ── Dictation transcript history ──────────────────────────────────────────────
//
// A history entry is a STAMP id (`YYYYMMDD-HHMMSS[-n]`) with up to two files in
// ~/.config/palmux/transcripts/: the recorded clip (`<id>.<ext>`) and the text
// it transcribed to (`<id>.txt`). Both are optional, and which ones exist is
// the entry's whole state machine:
//
//   audio, no text  → transcription never landed; the panel offers a retry
//   audio + text    → the normal case
//   text only       → an old entry, or one whose audio aged out of the budget
//
// The audio is written FIRST, before the model is ever called. Transcription is
// a paid network round-trip that fails for reasons the speaker can do nothing
// about (quota, 502, a dropped link), and until it did the recording existed
// only in a request body — a failure threw away words that were actually said.
//
// Plain files on purpose: greppable, cat-able, playable from the shell palmux
// hosts, no index to corrupt. Text is pruned oldest-first past MAX_KEPT; audio
// has its own BYTE budget, because a clip is four orders of magnitude larger
// than the line it becomes.

import { createReadStream, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { ReadStream } from 'node:fs';
import { join } from 'node:path';
import { configDir } from './config';

const MAX_KEPT = 100;
/** Listing cap — the panel shows recent history, not an archive browser. */
const LIST_LIMIT = 50;
/** Total bytes of stored audio kept, oldest clips dropped first. */
const AUDIO_BUDGET_BYTES = 100 * 1024 * 1024;

/** The audio containers `dictate.ts` accepts, and the extension each is stored under. */
const AUDIO_EXT: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/aac': 'aac',
};
const EXT_MIME = new Map(Object.entries(AUDIO_EXT).map(([mime, ext]) => [ext, mime]));

export interface TranscriptEntry {
  /** The stamp id — `<id>.txt` / `<id>.<ext>` are its files. */
  name: string;
  /** Epoch ms parsed back out of the id (file mtime is less trustworthy
   *  across copies/restores). */
  time: number;
  /** The transcript, or '' when the audio was never turned into text. */
  text: string;
  /** True when the clip is still on disk and can be played or re-transcribed. */
  audio: boolean;
}

export function transcriptsDir(): string {
  return join(configDir(), 'transcripts');
}

const stamp = (d: Date): string =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}` +
  `-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;

/** `<id>` where id is `YYYYMMDD-HHMMSS` with an optional collision suffix. */
const ID_RE = /^\d{8}-\d{6}(?:-\d+)?$/;
const FILE_RE = /^(\d{8}-\d{6}(?:-\d+)?)\.([a-z0-9]+)$/;

/** True for a well-formed entry id. Guards every path built from a query param. */
export function isTranscriptId(id: string): boolean {
  return ID_RE.test(id);
}

/** Parse the timestamp back out of an entry id (local time). */
export function parseStamp(name: string): number | null {
  const id = name.replace(/\.[a-z0-9]+$/, '');
  if (!ID_RE.test(id)) return null;
  const [d, t] = id.split('-');
  const date = new Date(
    Number(d!.slice(0, 4)),
    Number(d!.slice(4, 6)) - 1,
    Number(d!.slice(6, 8)),
    Number(t!.slice(0, 2)),
    Number(t!.slice(2, 4)),
    Number(t!.slice(4, 6)),
  );
  const time = date.getTime();
  return Number.isFinite(time) ? time : null;
}

/** The extension a mime type is stored under, or null when it isn't audio we take. */
export function audioExt(mimeType: string): string | null {
  return AUDIO_EXT[mimeType.split(';')[0]!.trim().toLowerCase()] ?? null;
}

function ensureDir(): string {
  const dir = transcriptsDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Every file in the history dir that belongs to an entry, as [id, ext] pairs. */
function entryFiles(dir: string): { id: string; ext: string; file: string }[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((file) => {
    const m = FILE_RE.exec(file);
    return m ? [{ id: m[1]!, ext: m[2]!, file }] : [];
  });
}

/** Mint an id that no file in the dir is using yet. */
function freshId(dir: string, now: Date): string {
  const taken = new Set(entryFiles(dir).map((f) => f.id));
  const base = stamp(now);
  if (!taken.has(base)) return base;
  for (let n = 1; ; n++) {
    const id = `${base}-${n}`;
    if (!taken.has(id)) return id;
  }
}

/**
 * Persist a recorded clip and return its entry id. Called BEFORE transcription,
 * so a model failure still leaves something the user can play back and retry.
 * Returns null for an audio type we don't store.
 */
export function saveAudio(audio: Buffer, mimeType: string, now = new Date()): string | null {
  const ext = audioExt(mimeType);
  if (!ext) return null;
  const dir = ensureDir();
  const id = freshId(dir, now);
  writeFileSync(join(dir, `${id}.${ext}`), audio, { mode: 0o600 });
  pruneAudio(dir);
  return id;
}

/**
 * Persist a transcript; returns its entry id. Pass the id `saveAudio` returned
 * to attach the text to that clip — omit it and the entry is text-only.
 * Failures are the caller's to swallow: history must never make dictation fail.
 */
export function saveTranscript(text: string, now = new Date(), id?: string): string {
  const dir = ensureDir();
  const entryId = id && isTranscriptId(id) ? id : freshId(dir, now);
  writeFileSync(join(dir, `${entryId}.txt`), text, { mode: 0o600 });
  pruneText(dir);
  return entryId;
}

/** Drop the oldest ENTRIES (both files) once the text history is over MAX_KEPT. */
function pruneText(dir: string): void {
  const ids = [...new Set(entryFiles(dir).map((f) => f.id))].sort();
  for (const id of ids.slice(0, Math.max(0, ids.length - MAX_KEPT))) {
    for (const f of entryFiles(dir).filter((f) => f.id === id)) remove(dir, f.file);
  }
}

/**
 * Drop the oldest CLIPS past the byte budget, leaving their transcripts behind.
 * Text costs nothing to keep; audio is what would grow without bound.
 */
function pruneAudio(dir: string): void {
  const clips = entryFiles(dir)
    .filter((f) => f.ext !== 'txt')
    .sort((a, b) => (a.id < b.id ? 1 : -1)); // newest first
  let budget = AUDIO_BUDGET_BYTES;
  for (const clip of clips) {
    let size = 0;
    try {
      size = statSync(join(dir, clip.file)).size;
    } catch {
      continue; // vanished — nothing to account for
    }
    budget -= size;
    if (budget < 0) remove(dir, clip.file);
  }
}

function remove(dir: string, file: string): void {
  try {
    rmSync(join(dir, file));
  } catch {
    /* a vanished file is already pruned */
  }
}

/** The stored clip for an entry, or null when it has none. */
export function findAudio(id: string): { path: string; mime: string; size: number } | null {
  if (!isTranscriptId(id)) return null;
  const dir = transcriptsDir();
  const clip = entryFiles(dir).find((f) => f.id === id && f.ext !== 'txt');
  if (!clip) return null;
  const path = join(dir, clip.file);
  try {
    return { path, mime: EXT_MIME.get(clip.ext) ?? 'application/octet-stream', size: statSync(path).size };
  } catch {
    return null;
  }
}

/** Open the stored clip for streaming. Caller must have checked `findAudio`. */
export function audioStream(path: string, range?: ByteRange): ReadStream {
  return range ? createReadStream(path, { start: range.start, end: range.end }) : createReadStream(path);
}

/** Inclusive byte offsets, as HTTP counts them. */
export interface ByteRange {
  start: number;
  end: number;
}

/**
 * Parse a single-range `Range: bytes=…` header against a known size.
 *
 * Range support is what makes the history panel's `preload="metadata"` cheap:
 * the browser asks for a few KB to read the container's duration instead of
 * pulling whole clips for every entry (audio has its own 100 MB budget, so a
 * panel of them is not a small download). Without it the player cannot seek
 * either — and a `<audio>` that cannot seek renders a dead scrubber.
 *
 * Returns `null` for "ignore this header and send the whole thing" (absent,
 * malformed, or a multi-range request we do not implement) and `'unsatisfiable'`
 * for a syntactically fine range that falls outside the file, which is a 416.
 */
export function parseRange(header: string | undefined, size: number): ByteRange | 'unsatisfiable' | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null; // multi-range or junk → full body, which is always legal
  const [, rawStart, rawEnd] = m;
  if (rawStart === '' && rawEnd === '') return null;
  if (size <= 0) return 'unsatisfiable';
  let start: number;
  let end: number;
  if (rawStart === '') {
    // `bytes=-N` is the LAST n bytes, not "up to n".
    const n = Number(rawEnd);
    if (n <= 0) return 'unsatisfiable';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    return 'unsatisfiable';
  }
  return { start, end };
}

/** The stored clip in full, for handing back to the transcriber on a retry. */
export function readAudioFile(id: string): { audio: Buffer; mime: string } | null {
  const clip = findAudio(id);
  if (!clip) return null;
  try {
    return { audio: readFileSync(clip.path), mime: clip.mime };
  } catch {
    return null;
  }
}

/** Newest-first recent history, full text included (transcripts are small). */
export function listTranscripts(): TranscriptEntry[] {
  const dir = transcriptsDir();
  const files = entryFiles(dir);
  const ids = [...new Set(files.map((f) => f.id))].sort().reverse().slice(0, LIST_LIMIT);
  return ids.map((id) => {
    const own = files.filter((f) => f.id === id);
    let text = '';
    if (own.some((f) => f.ext === 'txt')) {
      try {
        text = readFileSync(join(dir, `${id}.txt`), 'utf8');
      } catch {
        /* raced with prune — report it as untranscribed */
      }
    }
    return { name: id, time: parseStamp(id) ?? 0, text, audio: own.some((f) => f.ext !== 'txt') };
  });
}
