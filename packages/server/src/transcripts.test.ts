import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const created: string[] = [];

/** Isolated config dir per test; ./transcripts resolves configDir() live. */
async function fresh(label: string) {
  const dir = join(tmpdir(), `palmux-tr-${label}-${Math.random().toString(36).slice(2)}`);
  process.env['PALMUX_CONFIG_DIR'] = dir;
  created.push(dir);
  return import('./transcripts');
}

afterEach(() => {
  delete process.env['PALMUX_CONFIG_DIR'];
  for (const dir of created.splice(0)) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

describe('saveTranscript / listTranscripts', () => {
  it('round-trips a transcript, newest first', async () => {
    const t = await fresh('roundtrip');
    t.saveTranscript('primeiro ditado', new Date(2026, 6, 25, 10, 0, 0));
    t.saveTranscript('segundo ditado', new Date(2026, 6, 25, 11, 30, 5));
    const entries = t.listTranscripts();
    expect(entries.map((e) => e.text)).toEqual(['segundo ditado', 'primeiro ditado']);
    expect(entries[0]!.name).toBe('20260725-113005');
    expect(new Date(entries[0]!.time).getHours()).toBe(11);
    expect(entries[0]!.audio).toBe(false);
  });

  it('suffixes same-second collisions instead of overwriting', async () => {
    const t = await fresh('collide');
    const when = new Date(2026, 6, 25, 12, 0, 0);
    t.saveTranscript('um', when);
    t.saveTranscript('dois', when);
    const entries = t.listTranscripts();
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.text).sort()).toEqual(['dois', 'um']);
  });

  it('lists empty without a directory', async () => {
    const t = await fresh('empty');
    expect(t.listTranscripts()).toEqual([]);
  });

  it('prunes oldest past the retention cap', async () => {
    const t = await fresh('prune');
    for (let i = 0; i < 105; i++) {
      t.saveTranscript(`ditado ${i}`, new Date(2026, 0, 1, 8, 0, (i % 60) + (i >= 60 ? 100 : 0)));
    }
    const kept = readdirSync(t.transcriptsDir());
    expect(kept.length).toBeLessThanOrEqual(100);
  });

  it('parseStamp rejects foreign names', async () => {
    const t = await fresh('parse');
    expect(t.parseStamp('notes.txt')).toBe(null);
    expect(t.parseStamp('20260725-113005.txt')).not.toBe(null);
    expect(t.parseStamp('20260725-113005')).not.toBe(null);
  });
});

describe('audio-first history', () => {
  const when = new Date(2026, 6, 25, 9, 15, 0);

  it('a saved clip alone is already a history entry', async () => {
    // The whole point: transcription is a paid network call that fails, and
    // before this the audio only existed in the request body.
    const t = await fresh('audio-only');
    const id = t.saveAudio(Buffer.from('fake-webm'), 'audio/webm;codecs=opus', when);
    expect(id).toBe('20260725-091500');
    const entries = t.listTranscripts();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ name: id, text: '', audio: true });
  });

  it('attaches the transcript to the clip it came from', async () => {
    const t = await fresh('attach');
    const id = t.saveAudio(Buffer.from('fake'), 'audio/webm', when)!;
    t.saveTranscript('o ditado', when, id);
    const entries = t.listTranscripts();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ name: id, text: 'o ditado', audio: true });
  });

  it('never lets a clip reuse a live id', async () => {
    const t = await fresh('collide-audio');
    const a = t.saveAudio(Buffer.from('one'), 'audio/webm', when);
    const b = t.saveAudio(Buffer.from('two'), 'audio/webm', when);
    expect(a).not.toBe(b);
    expect(t.listTranscripts()).toHaveLength(2);
  });

  it('refuses an audio type it cannot store', async () => {
    const t = await fresh('badmime');
    expect(t.saveAudio(Buffer.from('x'), 'application/pdf')).toBe(null);
    expect(t.listTranscripts()).toEqual([]);
  });

  it('findAudio resolves the clip and rejects a forged id', async () => {
    const t = await fresh('find');
    const id = t.saveAudio(Buffer.from('fake'), 'audio/ogg', when)!;
    expect(t.findAudio(id)).toMatchObject({ mime: 'audio/ogg' });
    expect(t.findAudio('../../etc/passwd')).toBe(null);
    expect(t.findAudio('20260725-091501')).toBe(null); // no such entry
  });
});

describe('parseRange', () => {
  // Range support is what lets the history panel preload metadata per entry
  // without downloading every clip, and what makes the scrubber work at all.
  it('parses a closed range', async () => {
    const t = await fresh('range-closed');
    expect(t.parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 });
  });

  it('an open end means "to the last byte"', async () => {
    const t = await fresh('range-open');
    expect(t.parseRange('bytes=500-', 1000)).toEqual({ start: 500, end: 999 });
  });

  it('a suffix range is the LAST n bytes, not the first n', async () => {
    const t = await fresh('range-suffix');
    expect(t.parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 });
  });

  it('clamps an end past EOF instead of over-reading', async () => {
    const t = await fresh('range-clamp');
    expect(t.parseRange('bytes=900-99999', 1000)).toEqual({ start: 900, end: 999 });
  });

  it('falls back to the whole body for an absent or unsupported header', async () => {
    const t = await fresh('range-null');
    // null means "send it all", which is always a legal answer to a Range.
    expect(t.parseRange(undefined, 1000)).toBe(null);
    expect(t.parseRange('bytes=0-10,20-30', 1000)).toBe(null); // multi-range
    expect(t.parseRange('items=0-10', 1000)).toBe(null);
    expect(t.parseRange('bytes=-', 1000)).toBe(null);
  });

  it('reports a genuinely unsatisfiable range (a 416, not a silent full body)', async () => {
    const t = await fresh('range-416');
    expect(t.parseRange('bytes=1000-', 1000)).toBe('unsatisfiable');
    expect(t.parseRange('bytes=5000-6000', 1000)).toBe('unsatisfiable');
    expect(t.parseRange('bytes=-0', 1000)).toBe('unsatisfiable');
    expect(t.parseRange('bytes=0-0', 0)).toBe('unsatisfiable'); // empty file
  });
});
