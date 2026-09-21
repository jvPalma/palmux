import { afterEach, describe, expect, it, vi } from 'vitest';
import { dictate, DictationError, rejectsThinkingLevel, toSingleLine, type DictationConfig } from './dictate';

const CFG: DictationConfig = {
  apiKey: 'test-key',
  provider: 'gemini',
  providerAudio: 'gemini',
  providerText: 'gemini',
  baseUrl: '',
  modelAudio: 'test-audio',
  modelText: 'test-text',
};

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

describe('rejectsThinkingLevel', () => {  // Swapping `model` is the remedy when a model regresses upstream, so that
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

const jsonRes = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

describe('dictate — openai provider', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('posts the OpenAI chat-completions shape and parses the reply', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => jsonRes({ choices: [{ message: { content: ' transcrito ' } }] }));
    vi.stubGlobal('fetch', fetchMock);
    const cfg = {
      ...CFG,
      provider: 'openai',
      providerAudio: 'openai',
      providerText: 'openai',
      baseUrl: 'https://openrouter.ai/api/v1',
      modelAudio: 'openai/gpt-4o-mini',
      modelText: 'openai/gpt-4o-mini',
    } as const;
    expect(await dictate(Buffer.from([1, 2, 3]), 'audio/webm', cfg)).toBe('transcrito');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(init!.headers).toMatchObject({ authorization: 'Bearer test-key' });
    const req = JSON.parse(init!.body as string);
    expect(req.messages[0].content[1]).toMatchObject({
      type: 'input_audio',
      input_audio: { data: 'AQID', format: 'webm' },
    });
  });

  it('falls back to api.openai.com when no base-url is set', async () => {
    const fetchMock = vi.fn().mockImplementation(() => jsonRes({ choices: [{ message: { content: 'x' } }] }));
    vi.stubGlobal('fetch', fetchMock);
    const cfg = { ...CFG, providerAudio: 'openai', providerText: 'openai' } as const;
    await dictate(Buffer.from([1]), 'audio/wav', cfg);
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.openai.com/v1/chat/completions');
  });

  it('names the provider, model and status on failure', async () => {
    const fetchMock = vi.fn().mockImplementation(() => new Response('upstream exploded', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    const cfg = { ...CFG, providerAudio: 'openai', providerText: 'openai', modelAudio: 'm' } as const;
    await expect(dictate(Buffer.from([1]), 'audio/webm', cfg)).rejects.toThrow(
      /openai\/m.*500.*upstream exploded/,
    );
  });
});

describe('dictate — anthropic provider', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('refuses the audio pass with a named remedy', async () => {
    const cfg = {
      ...CFG,
      provider: 'anthropic',
      providerAudio: 'anthropic',
      providerText: 'anthropic',
    } as const;
    await expect(dictate(Buffer.from([1]), 'audio/webm', cfg)).rejects.toMatchObject({ status: 501 });
  });

  it('cleans text through the messages API as the text pass', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ choices: [{ message: { content: ' transcrito ' } }] }))
      .mockResolvedValueOnce(jsonRes({ content: [{ type: 'text', text: ' limpo ' }] }));
    vi.stubGlobal('fetch', fetchMock);
    const cfg = { ...CFG, providerAudio: 'openai', providerText: 'anthropic', modelText: 'claude-x' } as const;
    expect(await dictate(Buffer.from([1]), 'audio/webm', cfg)).toBe('limpo');
    const [, init] = fetchMock.mock.calls[1]!;
    expect(init!.headers).toMatchObject({ 'x-api-key': 'test-key', 'anthropic-version': '2023-06-01' });
    const req = JSON.parse(init!.body as string);
    expect(req.model).toBe('claude-x');
    expect(req.max_tokens).toBe(1024);
  });
});

describe('dictate — openai transcription models', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('falls back to /audio/transcriptions when the model refuses chat/completions', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              error: {
                message: 'nvidia/parakeet-tdt-0.6b-v3 is a transcription model and cannot be used with the chat/completions endpoint',
              },
            }),
            { status: 400 },
          ),
        ),
      )
      .mockImplementationOnce(() => Promise.resolve(jsonRes({ text: ' transcrito ' })))
      .mockImplementationOnce(() => Promise.resolve(jsonRes({ choices: [{ message: { content: ' limpo ' } }] })));
    vi.stubGlobal('fetch', fetchMock);
    const cfg = { ...CFG, providerAudio: 'openai', providerText: 'openai', modelAudio: 'nvidia/parakeet' } as const;
    expect(await dictate(Buffer.from([1]), 'audio/webm', cfg)).toBe('limpo');
    const [chatUrl, , transcriptionUrl, transcriptionInit] = [
      fetchMock.mock.calls[0]![0],
      fetchMock.mock.calls[0]![1],
      fetchMock.mock.calls[1]![0],
      fetchMock.mock.calls[1]![1],
    ];
    expect(chatUrl).toContain('/chat/completions');
    expect(transcriptionUrl).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(transcriptionInit!.body).toBeInstanceOf(FormData);
  });

  it('keeps the refusal as an error when the message is not the transcription one', async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ error: { message: 'bad request' } }), { status: 400 })),
    );
    vi.stubGlobal('fetch', fetchMock);
    const cfg = { ...CFG, providerAudio: 'openai', providerText: 'openai' } as const;
    await expect(dictate(Buffer.from([1]), 'audio/webm', cfg)).rejects.toThrow(/openai\/test-audio/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('dictate — $VAR api keys', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('resolves a $NAME key from the process environment', async () => {
    vi.stubEnv('MY_OR_KEY', 'sk-or-live');
    const fetchMock = vi.fn().mockImplementation(() => jsonRes({ choices: [{ message: { content: 'ok' } }] }));
    vi.stubGlobal('fetch', fetchMock);
    const cfg = { ...CFG, apiKey: '$MY_OR_KEY', providerAudio: 'openai', providerText: 'openai' } as const;
    await dictate(Buffer.from([1]), 'audio/webm', cfg);
    expect(fetchMock.mock.calls[0]![1]!.headers).toMatchObject({ authorization: 'Bearer sk-or-live' });
  });

  it('names the variable when it is not set in the environment', async () => {
    const cfg = { ...CFG, apiKey: '$MISSING_KEY' } as const;
    await expect(dictate(Buffer.from([1]), 'audio/webm', cfg)).rejects.toThrow(
      'dictation key $MISSING_KEY is not set in the environment',
    );
  });

  it('leaves a literal key untouched', async () => {
    await expect(dictate(Buffer.from([1]), 'audio/webm', { ...CFG, apiKey: '' })).rejects.toThrow(
      'dictation is not configured',
    );
  });
});
