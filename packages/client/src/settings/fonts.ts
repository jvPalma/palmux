// ── Discovered web-font registration ──────────────────────────────────────────
//
// The server streams the user's ~/.fonts faces (see server/fonts.ts). We
// register each as a FontFace with its real weight/style so xterm's bold/italic
// rendering maps to the right file, and return the unique family names for the
// settings picker.

import type { FontInfo } from '@palmux/shared';

const registered = new Set<string>();

// Programming fonts (Nerd Fonts included) lack many symbol codepoints (⏵ U+23F5,
// media keys, arrows…). Desktop browsers silently fill those from system fonts,
// but Android's canvas fallback stack has no such font — the result is tofu.
// We serve this family from the server (~/.fonts/symbols-fallback) and append
// it to every terminal font stack; it never appears in the picker.
export const SYMBOL_FALLBACK_FAMILY = 'Noto Sans Symbols2';

// Color-emoji families MUST come before the symbols fallback: Symbols2 carries
// monochrome glyphs for many emoji codepoints (🔵🟡⚫ …) and would otherwise
// hijack them into gray circles. These resolve to the platform emoji font
// (Android/Linux: Noto, iOS/macOS: Apple); unknown names are skipped by CSS.
const EMOJI_FAMILIES = '"Apple Color Emoji", "Noto Color Emoji"';

/** Terminal font stack with emoji + symbols fallbacks as last-resort glyph sources. */
export function withSymbolFallback(family: string): string {
  if (family.includes(SYMBOL_FALLBACK_FAMILY)) return family;
  return `${family}, ${EMOJI_FAMILIES}, "${SYMBOL_FALLBACK_FAMILY}"`;
}

let emojiPromise: Promise<void> | null = null;

/**
 * Register the BUNDLED color-emoji font once. The terminal stack already lists
 * "Noto Color Emoji" ahead of the mono symbols fallback; on mobile the platform
 * emoji font isn't resolved for the WebGL/canvas glyph atlas, so those glyphs
 * fall through to the monochrome symbols font (gray circles). Shipping + adding
 * our own FontFace under that exact name makes the color emoji resolve. Loaded
 * lazily (it's ~2 MB) — callers should refresh the terminal atlas once it lands.
 */
export function ensureColorEmojiFont(): Promise<void> {
  if (emojiPromise) return emojiPromise;
  if (typeof FontFace === 'undefined' || typeof document === 'undefined') {
    emojiPromise = Promise.resolve();
    return emojiPromise;
  }
  const face = new FontFace('Noto Color Emoji', 'url("/webfonts/noto-color-emoji.woff2")', {
    style: 'normal',
    weight: '400',
  });
  emojiPromise = face
    .load()
    .then((loaded) => {
      document.fonts.add(loaded);
    })
    .catch(() => {
      /* blocked/unsupported — the platform fallback remains */
    });
  return emojiPromise;
}

export interface RegisteredFonts {
  families: string[];
  /** Resolves once every face has finished loading (failures ignored). */
  loaded: Promise<void>;
}

export function registerFonts(fonts: FontInfo[]): RegisteredFonts {
  const loading: Promise<unknown>[] = [];
  if (typeof FontFace !== 'undefined' && typeof document !== 'undefined') {
    for (const f of fonts) {
      const key = `${f.family}|${f.weight}|${f.style}|${f.url}`;
      if (registered.has(key)) continue;
      registered.add(key);
      try {
        const face = new FontFace(f.family, `url("${f.url}")`, {
          weight: String(f.weight),
          style: f.style,
        });
        loading.push(
          face
            .load()
            .then((loadedFace) => document.fonts.add(loadedFace))
            .catch(() => {
              /* unreachable/blocked font — ignore */
            }),
        );
      } catch {
        /* invalid descriptor — ignore */
      }
    }
  }
  return {
    families: [...new Set(fonts.map((f) => f.family))]
      .filter((f) => f !== SYMBOL_FALLBACK_FAMILY)
      .sort((a, b) => a.localeCompare(b)),
    loaded: Promise.all(loading).then(() => undefined),
  };
}
