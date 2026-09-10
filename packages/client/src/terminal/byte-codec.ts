// ── Byte ↔ string codec for the terminal data path ────────────────────────────
//
// PTY output arrives as raw binary WS frames, but the trzsz middleware works in
// the string domain. Latin-1 is the only lossless bridge: every byte 0x00–0xFF
// maps to the code point of the same value and back, so UTF-8 sequences survive
// as their individual bytes and xterm still decodes them itself.
//
// The one wrinkle is that trzsz ALSO emits its own UI text (a progress bar with
// box-drawing characters). Those carry code points above 0xFF, which is exactly
// how `writeMixed` tells the two apart.

/** Raw bytes → a byte-per-code-unit string. */
export function latin1Decode(bytes: Uint8Array): string {
  let out = '';
  // Chunked so a large frame can't blow the argument limit of String.fromCharCode.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return out;
}

/** A byte-per-code-unit string → the original bytes. */
export function latin1Encode(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/** True when every code unit fits in a byte (i.e. this is pass-through data). */
export function isLatin1(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 0xff) return false;
  }
  return true;
}

/**
 * Write terminal data that may be either latin-1-encoded raw bytes (PTY
 * pass-through, which MUST reach xterm byte-identical) or real text produced by
 * the middleware itself (which must be written as a string to render correctly).
 */
export function writeMixed(write: (d: string | Uint8Array) => void, data: string): void {
  write(isLatin1(data) ? latin1Encode(data) : data);
}
