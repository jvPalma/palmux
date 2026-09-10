import { describe, expect, it } from 'vitest';
import { dictate, DictationError, rejectsThinkingLevel, toSingleLine } from './dictate';

const CFG = { apiKey: 'test-key', modelAudio: 'test-audio', modelText: 'test-text' };

describe('toSingleLine', () => {
  // The whole point: a newline reaching a shell RUNS the line.
  it('turns newlines into spaces', () => {
    expect(toSingleLine('git status\nrm -rf /')).toBe('git status rm -rf /');
    expect(toSingleLine('a\r\nb')).toBe('a b');
  });

  it('strips other control characters', () => {
    expect(toSingleLine('esc\x1b[31mred\x07')).toBe('esc [31mred');
    expect(toSingleLine('nul\x00byte')).toBe('nul byte');
  });

  it('collapses whitespace runs and trims', () => {
    expect(toSingleLine('  ls   -la  \n\n')).toBe('ls -la');
  });

  it('leaves an ordinary line untouched', () => {
    expect(toSingleLine('faz deploy da branch de staging')).toBe('faz deploy da branch de staging');
  });
});

describe('dictate', () => {
  it('refuses to call out when no key is configured', async () => {
    await expect(dictate(Buffer.from('x'), 'audio/webm', { ...CFG, apiKey: '' })).rejects.toThrow(
      DictationError,
    );
  });

  it('rejects a container we did not ask the browser for', async () => {
    await expect(dictate(Buffer.from('x'), 'video/mp4', CFG)).rejects.toMatchObject({
      status: 415,
    });
    await expect(dictate(Buffer.from('x'), '', CFG)).rejects.toMatchObject({ status: 415 });
  });

  it('accepts the codecs parameter MediaRecorder appends', async () => {
    // Reaches the network (and fails there), which is proof the mime passed.
    await expect(
      dictate(Buffer.from('x'), 'audio/webm;codecs=opus', { ...CFG, modelAudio: '' }),
    ).rejects.toMatchObject({ status: 502 });
  });
});

describe('rejectsThinkingLevel', () => {
  // Swapping `model` is the remedy when a model regresses upstream, so that
  // swap must not walk into a different failure: the 2.5 family 400s over the
  // `thinkingLevel` field that the 3.x request always carries.
  it('spots the 2.5-family rejection so the call can be retried without it', () => {
    expect(
      rejectsThinkingLevel(400, '{"error":{"message":"Thinking level is not supported for this model."}}'),
    ).toBe(true);
  });

  it('leaves every other failure alone (a 500 must stay a 500)', () => {
    // The measured gemini-3.6/3.7-flash audio regression — retrying without
    // thinkingConfig would not have helped and would only hide the real status.
    expect(rejectsThinkingLevel(500, '{"error":{"message":"Internal error encountered."}}')).toBe(
      false,
    );
    expect(rejectsThinkingLevel(400, '{"error":{"message":"API key not valid"}}')).toBe(false);
    expect(rejectsThinkingLevel(429, 'Thinking level is not supported for this model.')).toBe(false);
  });
});
