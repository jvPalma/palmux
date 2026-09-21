// ── Dictation: audio → injectable text, provider-agnostic ────────────────────
//
// TWO model calls, deliberately: pass 1 transcribes the audio verbatim, pass 2
// cleans up the TRANSCRIPT with the audio no longer in context.
//
// A single combined call (audio + cleanup rules in one request) is cheaper and
// ~2s faster, and it was rejected on evidence. With style rules sitting next to
// the audio the model starts composing instead of listening: on real clips it
// produced a sentence that was never spoken, swapped a European-Portuguese word
// for its Brazilian form despite an explicit rule against exactly that, and once
// prefixed the reply with a stray Arabic token. A text-only second pass can only
// rearrange words it was handed — the guarantee this feature needs before it
// types into a live shell.
//
// Providers (config `dictation.provider`): `gemini` (the default; its 3.x
// thinkingLevel retry is gemini-only), `openai` (any OpenAI-compatible
// chat-completions endpoint — OpenAI, OpenRouter, Groq, a local server — via
// `dictation.base-url`), and `anthropic` (text pass only: the Claude API has no
// audio input, and the refusal says so).
//
// The prompts are written in Portuguese on purpose: they encode pt-PT rules and
// were validated in that form.

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const OPENAI_DEFAULT_BASE = 'https://api.openai.com/v1';
const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';

/** Audio containers a browser MediaRecorder actually produces. */
const ALLOWED_MIME = new Set([
  'audio/webm',
  'audio/ogg',
  'audio/mp4',
  'audio/mpeg',
  'audio/wav',
  'audio/aac',
]);

const TRANSCRIBE_PROMPT = `Transcreve o áudio literalmente, palavra por palavra, incluindo hesitações e repetições.
O falante é bilingue: português europeu (pt-PT) e inglês americano, e troca de língua a meio das frases.
Transcreve cada palavra na língua em que foi realmente dita. Nunca traduzas.
Devolve apenas a transcrição, sem comentários.`;

const CLEAN_PROMPT = `Recebes a transcrição literal de um ditado e devolves o texto pronto a inserir num terminal.

O falante é bilingue: português europeu (pt-PT) e inglês americano (en-US). Troca de língua a meio de uma frase, e isso é INTENCIONAL — mantém sempre cada palavra na língua em que foi dita.

REGRAS
- Trabalha APENAS com as palavras que recebeste. Nunca acrescentes informação, nomes, números ou factos que não estejam no texto de entrada.
- Nunca traduzas. Termos técnicos em inglês ficam em inglês.
- Português europeu, nunca brasileiro.
- Aplica pontuação e capitalização.
- Remove muletas e falsos começos: "hã", "hum", "tipo", "pronto", "ok" isolado, "you know", "like", gaguejos e palavras repetidas por hesitação.
- Auto-correções faladas: se o falante se corrige ("não, quero dizer X", "sorry, I mean X", "ou melhor X", "espera, X"), fica APENAS a versão corrigida e a instrução de correção desaparece.
- Se a mesma ideia for dita duas vezes seguidas por hesitação, fica uma só vez.
- NÃO reformules, não melhores o estilo, não reordenes, não resumas. As palavras e o sentido são do falante.
- Se o texto ditar um comando, caminho ou nome de ficheiro por extenso ("ls dash la", "slash home slash user"), escreve-o na forma literal de código (ls -la, /home/user).

SAÍDA
- Uma ÚNICA linha de texto simples. Sem quebras de linha, sem markdown, sem aspas à volta, sem preâmbulo, sem explicações.
- Entrada vazia ou ininteligível → devolve string vazia.`;

export interface DictationConfig {
  /** Provider API key. Empty disables the feature. */
  apiKey: string;
  /** Which API speaks for both passes; `provider-audio`/`provider-text` override per pass. */
  provider: 'gemini' | 'openai' | 'anthropic';
  /** Per-pass providers, mirroring the per-pass models: a provider can serve
   *  TEXT while its audio path fails, and anthropic has NO audio at all — so
   *  transcribe on one, clean on another. */
  providerAudio: 'gemini' | 'openai' | 'anthropic';
  providerText: 'gemini' | 'openai' | 'anthropic';
  /** Base URL for the `openai` provider (OpenRouter, Groq, local…); empty = api.openai.com. */
  baseUrl: string;
  /**
   * The two passes get their own model because they fail independently: a model
   * can serve TEXT perfectly while answering 500 to inline AUDIO (measured on
   * gemini-3.6/3.7-flash, 2026-08-17). Splitting them means the newest model can
   * still do the cleanup pass while transcription falls back to one that works.
   * Config keys are `model-audio` / `model-text`; a legacy `model` sets both.
   */
  modelAudio: string;
  modelText: string;
}

export class DictationError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'DictationError';
  }
}

/**
 * Reduce a model reply to one safe terminal line: control characters (newlines
 * included — a stray \n in a shell RUNS the line) become spaces, runs of
 * whitespace collapse, ends are trimmed.
 */
export function toSingleLine(text: string): string {
  // eslint-disable-next-line no-control-regex -- stripping C0/C1 is the point
  return text
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

interface ProviderAdapter {
  /** Short name, used in error messages so a failure names its provider. */
  name: string;
  transcribe(cfg: DictationConfig, model: string, audio: Buffer, mime: string, prompt: string): Promise<string>;
  clean(cfg: DictationConfig, model: string, prompt: string): Promise<string>;
}

const err = (provider: string, model: string, status: number, body: string): DictationError =>
  new DictationError(`speech service (${provider}/${model}) returned ${status}: ${body}`, 502);

// ── gemini ───────────────────────────────────────────────────────────────────

interface GeminiPart {
  text?: string;
  inline_data?: { mime_type: string; data: string };
}

/** `thinkingLevel` is a 3.x field; a 2.5 model rejects the whole request over it. */
export function rejectsThinkingLevel(status: number, body: string): boolean {
  return status === 400 && /thinking level is not supported/i.test(body);
}

async function geminiPost(
  cfg: DictationConfig,
  model: string,
  parts: GeminiPart[],
  thinking: boolean,
): Promise<Response> {
  return fetch(`${GEMINI_ENDPOINT}/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': cfg.apiKey },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: {
        temperature: 0,
        ...(thinking ? { thinkingConfig: { thinkingLevel: 'low' } } : {}),
      },
    }),
  });
}

async function geminiGenerate(
  cfg: DictationConfig,
  model: string,
  parts: GeminiPart[],
): Promise<string> {
  let res: Response;
  try {
    res = await geminiPost(cfg, model, parts, true);
    // Changing the model is the whole remedy when one regresses (measured
    // 2026-08-17: gemini-3.6/3.7-flash answer 500 INTERNAL to inline AUDIO while
    // still serving text, and the same clip transcribes fine on 3.5-flash). That
    // remedy must not trade one failure for another: the 2.5 family rejects the
    // request outright over `thinkingLevel`, so retry once without it rather
    // than making the config carry a per-model capability flag.
    if (!res.ok) {
      const peek = (await res.clone().text().catch(() => '')).slice(0, 200);
      if (rejectsThinkingLevel(res.status, peek)) res = await geminiPost(cfg, model, parts, false);
    }
  } catch (err) {
    throw new DictationError(`speech service unreachable (gemini): ${String(err)}`, 502);
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 200);
    // Name the provider and the model: a bare status once sent us looking at
    // palmux for an hour when the answer was an upstream model regression. With
    // two models and three providers in play it also says WHICH call died.
    throw err('gemini', model, res.status, body);
  }
  const json = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const out = (json.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
  return out.trim();
}

const geminiAdapter: ProviderAdapter = {
  name: 'gemini',
  transcribe: (cfg, model, audio, mime, prompt) =>
    geminiGenerate(cfg, model, [
      { text: prompt },
      { inline_data: { mime_type: mime, data: audio.toString('base64') } },
    ]),
  clean: (cfg, model, prompt) => geminiGenerate(cfg, model, [{ text: prompt }]),
};

// ── openai (and every OpenAI-compatible endpoint) ────────────────────────────

/** Container → the `format` field of the OpenAI-compatible audio block. */
function openaiAudioFormat(mime: string): string {
  const known: Record<string, string> = {
    'audio/wav': 'wav',
    'audio/mpeg': 'mp3',
    'audio/webm': 'webm',
    'audio/ogg': 'ogg',
    'audio/mp4': 'mp4',
    'audio/aac': 'aac',
  };
  return known[mime] ?? mime.split('/')[1] ?? mime;
}

async function openaiCall(cfg: DictationConfig, model: string, content: unknown): Promise<string> {
  const base = (cfg.baseUrl || OPENAI_DEFAULT_BASE).replace(/\/+$/, '');
  let res: Response;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({ model, temperature: 0, messages: [{ role: 'user', content }] }),
    });
  } catch (err) {
    throw new DictationError(`speech service unreachable (openai): ${String(err)}`, 502);
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 200);
    throw err('openai', model, res.status, body);
  }
  const json = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
  const out = json.choices?.[0]?.message?.content;
  return typeof out === 'string' ? out.trim() : '';
}

/**
 * OpenRouter's ASR models (parakeet, qwen3-asr, chirp…) refuse the
 * chat/completions endpoint with exactly this message: their shape is the
 * OpenAI speech-to-text one at /audio/transcriptions. Retry there rather than
 * making the config carry a per-model capability flag — the same principle as
 * the gemini thinkingLevel retry.
 */
export function isTranscriptionModelRefusal(status: number, body: string): boolean {
  return status === 400 && /is a transcription model/i.test(body);
}

/** OpenAI speech-to-text: multipart file + model → `{ text }`. */
async function openaiTranscriptions(cfg: DictationConfig, model: string, audio: Buffer, mime: string): Promise<string> {
  const base = (cfg.baseUrl || OPENAI_DEFAULT_BASE).replace(/\/+$/, '');
  let res: Response;
  try {
    const form = new FormData();
    form.append('file', new Blob([audio], { type: mime }), `clip.${mime.split('/')[1] ?? 'bin'}`);
    form.append('model', model);
    res = await fetch(`${base}/audio/transcriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.apiKey}` },
      body: form,
    });
  } catch (err) {
    throw new DictationError(`speech service unreachable (openai): ${String(err)}`, 502);
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 200);
    throw err('openai', model, res.status, body);
  }
  const json = (await res.json()) as { text?: unknown };
  return typeof json.text === 'string' ? json.text.trim() : '';
}

const openaiAdapter: ProviderAdapter = {
  name: 'openai',
  transcribe: async (cfg, model, audio, mime, prompt) => {
    try {
      return await openaiCall(cfg, model, [
        { type: 'text', text: prompt },
        {
          type: 'input_audio',
          input_audio: { data: audio.toString('base64'), format: openaiAudioFormat(mime) },
        },
      ]);
    } catch (e) {
      // An ASR model's refusal is the signal to use its real endpoint.
      if (!(e instanceof Error) || !/is a transcription model/i.test(e.message)) throw e;
    }
    return openaiTranscriptions(cfg, model, audio, mime);
  },
  clean: (cfg, model, prompt) => openaiCall(cfg, model, prompt),
};

// ── anthropic (text pass only — the API has no audio input) ──────────────────

const anthropicAdapter: ProviderAdapter = {
  name: 'anthropic',
  transcribe: () => {
    // A refusal with a named remedy, not a 502: the operator must pick a
    // provider that accepts audio for the transcribe pass.
    throw new DictationError(
      'provider anthropic does not accept audio — transcribe with a provider that does (gemini or openai)',
      501,
    );
  },
  clean: async (cfg, model, prompt) => {
    let res: Response;
    try {
      res = await fetch(ANTHROPIC_ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': cfg.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 1024,
          temperature: 0,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
    } catch (err) {
      throw new DictationError(`speech service unreachable (anthropic): ${String(err)}`, 502);
    }
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 200);
      throw err('anthropic', model, res.status, body);
    }
    const json = (await res.json()) as { content?: { type?: string; text?: string }[] };
    const out = (json.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
    return out.trim();
  },
};

const ADAPTERS: Record<DictationConfig['provider'], ProviderAdapter> = {
  gemini: geminiAdapter,
  openai: openaiAdapter,
  anthropic: anthropicAdapter,
};

/**
 * A `$NAME` apiKey is an ENV INDIRECTION: the value comes from the palmux
 * process environment (dotrun loads it), never from the file. A missing
 * variable is a 503 that NAMES it — a placeholder reaching the provider would
 * surface as a meaningless upstream 401 instead.
 */
function resolveApiKey(cfg: DictationConfig): string {
  const raw = cfg.apiKey.trim();
  if (!raw.startsWith('$')) return raw;
  const name = raw.slice(1).trim();
  const value = process.env[name]?.trim();
  if (!value) {
    throw new DictationError(`dictation key \$${name} is not set in the environment`, 503);
  }
  return value;
}

/**
 * Transcribe a recorded snippet and return the cleaned, single-line text to
 * inject. Empty string means "nothing was said" — the caller injects nothing.
 */
export async function dictate(
  audio: Buffer,
  mimeType: string,
  cfg: DictationConfig,
): Promise<string> {
  const key = resolveApiKey(cfg);
  if (!key) {
    throw new DictationError('dictation is not configured (no API key)', 503);
  }
  const resolved = { ...cfg, apiKey: key };
  // Strip any ;codecs=… parameter MediaRecorder appends before checking.
  const mime = mimeType.split(';')[0]!.trim().toLowerCase();
  if (!ALLOWED_MIME.has(mime)) {
    throw new DictationError(`unsupported audio type: ${mime || '(none)'}`, 415);
  }

  const providerAudio = ADAPTERS[resolved.providerAudio] ?? geminiAdapter;
  const providerText = ADAPTERS[resolved.providerText] ?? geminiAdapter;
  // Pass 1 carries the audio; pass 2 is pure text. Hence the two models.
  const transcript = await providerAudio.transcribe(resolved, resolved.modelAudio, audio, mime, TRANSCRIBE_PROMPT);
  if (!transcript) return '';

  const cleaned = await providerText.clean(resolved, resolved.modelText, `${CLEAN_PROMPT}\n\n---\nTRANSCRIÇÃO:\n${transcript}`);
  return toSingleLine(cleaned);
}
