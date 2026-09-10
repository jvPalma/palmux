// ── Dictation: audio → injectable text ────────────────────────────────────────
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
// The prompts are written in Portuguese on purpose: they encode pt-PT rules and
// were validated in that form.

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

/** Audio containers a browser MediaRecorder actually produces, and Gemini accepts. */
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
  /** Gemini API key. Empty disables the feature. */
  apiKey: string;
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

interface GeminiPart {
  text?: string;
  inline_data?: { mime_type: string; data: string };
}

/** `thinkingLevel` is a 3.x field; a 2.5 model rejects the whole request over it. */
export function rejectsThinkingLevel(status: number, body: string): boolean {
  return status === 400 && /thinking level is not supported/i.test(body);
}

async function post(
  cfg: DictationConfig,
  model: string,
  parts: GeminiPart[],
  thinking: boolean,
): Promise<Response> {
  return fetch(`${ENDPOINT}/${encodeURIComponent(model)}:generateContent`, {
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

async function generate(
  cfg: DictationConfig,
  model: string,
  parts: GeminiPart[],
): Promise<string> {
  let res: Response;
  try {
    res = await post(cfg, model, parts, true);
    // Changing the model is the whole remedy when one regresses (measured
    // 2026-08-17: gemini-3.6/3.7-flash answer 500 INTERNAL to inline AUDIO while
    // still serving text, and the same clip transcribes fine on 3.5-flash). That
    // remedy must not trade one failure for another: the 2.5 family rejects the
    // request outright over `thinkingLevel`, so retry once without it rather
    // than making the config carry a per-model capability flag.
    if (!res.ok) {
      const peek = (await res.clone().text().catch(() => '')).slice(0, 200);
      if (rejectsThinkingLevel(res.status, peek)) res = await post(cfg, model, parts, false);
    }
  } catch (err) {
    throw new DictationError(`speech service unreachable: ${String(err)}`, 502);
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 200);
    // Name the model: the status alone sent us looking at palmux for an hour
    // when the answer was that this model had regressed upstream. With two
    // models in play it also says WHICH pass died.
    throw new DictationError(`speech service (${model}) returned ${res.status}: ${body}`, 502);
  }
  const json = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const out = (json.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
  return out.trim();
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
  if (!cfg.apiKey) {
    throw new DictationError('dictation is not configured (no API key)', 503);
  }
  // Strip any ;codecs=… parameter MediaRecorder appends before checking.
  const mime = mimeType.split(';')[0]!.trim().toLowerCase();
  if (!ALLOWED_MIME.has(mime)) {
    throw new DictationError(`unsupported audio type: ${mime || '(none)'}`, 415);
  }

  // Pass 1 carries the audio; pass 2 is pure text. Hence the two models.
  const transcript = await generate(cfg, cfg.modelAudio, [
    { text: TRANSCRIBE_PROMPT },
    { inline_data: { mime_type: mime, data: audio.toString('base64') } },
  ]);
  if (!transcript) return '';

  const cleaned = await generate(cfg, cfg.modelText, [
    { text: `${CLEAN_PROMPT}\n\n---\nTRANSCRIÇÃO:\n${transcript}` },
  ]);
  return toSingleLine(cleaned);
}
