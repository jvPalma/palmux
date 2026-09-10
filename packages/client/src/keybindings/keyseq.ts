// ── Key-sequence escape grammar ───────────────────────────────────────────────
//
// Parse a small, user-writable escape grammar into the raw bytes it denotes, so a
// keybinding action can emit an arbitrary byte sequence (e.g. a custom `undo`).
// Grammar:
//   ^X     → control byte (X & 0x1f):  ^A→0x01 … ^Z→0x1a, ^_→0x1f, ^[→0x1b
//   \xNN   → the byte 0xNN (two hex digits)
//   \e     → ESC (0x1b)
//   \n \r \t → newline / carriage-return / tab
//   \\     → a literal backslash
//   anything else → passed through verbatim
//
// Returns a string whose char codes ARE the bytes (matching how palmux writes
// keystrokes to the PTY elsewhere).

export function encodeKeySeq(spec: string): string {
  let out = '';
  for (let i = 0; i < spec.length; i++) {
    const c = spec[i]!;

    if (c === '^' && i + 1 < spec.length) {
      const code = spec[++i]!.toUpperCase().charCodeAt(0);
      out += String.fromCharCode(code & 0x1f);
      continue;
    }

    if (c === '\\' && i + 1 < spec.length) {
      const n = spec[i + 1]!;
      if (n === 'x') {
        const hex = spec.slice(i + 2, i + 4);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 3;
          continue;
        }
        // Malformed \x — emit a literal 'x' and consume the backslash.
        out += 'x';
        i += 1;
        continue;
      }
      const simple: Record<string, string> = {
        e: '\x1b',
        n: '\n',
        r: '\r',
        t: '\t',
        '\\': '\\',
      };
      if (n in simple) {
        out += simple[n];
        i += 1;
        continue;
      }
      // Unknown escape — pass the following char through literally.
      out += n;
      i += 1;
      continue;
    }

    out += c;
  }
  return out;
}
