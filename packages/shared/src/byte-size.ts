// ── Human byte sizes in config.json ───────────────────────────────────────────
//
// `"maxUploadBytes": 1073741824` is a number nobody types correctly and nobody
// reads back. The config accepts `"1GB"` instead, and a bare number still works
// so existing files keep their meaning.
//
// The grammar is deliberately narrow — a size is `<number><KB|MB|GB>` and
// nothing else. No `B`, no `KiB`, no bare `1G`. A config parser that guesses is
// worse than one that refuses: this value decides whether a request is rejected,
// so a typo silently read as a different magnitude is exactly the failure the
// strictness exists to prevent. Units are binary (1 KB = 1024 B), matching what
// every other size in this project already means.

const UNITS: Record<string, number> = {
  KB: 1024,
  MB: 1024 * 1024,
  GB: 1024 * 1024 * 1024,
};

/** `<number><KB|MB|GB>`, case-insensitive, optional space, optional decimals. */
const SIZE_RE = /^(\d+(?:\.\d+)?)\s*(KB|MB|GB)$/i;

/**
 * Bytes for a config size, or null if the value is not a usable size.
 *
 * Accepts a non-negative number (bytes, as before) or a `"<n><KB|MB|GB>"`
 * string. **Zero means NO LIMIT** wherever palmux reads one of these, which is
 * why 0 is valid rather than rejected — see the `maxUploadBytes` handling in
 * app-config.ts. Anything else — a negative, a NaN, `"1G"`, `"1 gigabyte"`,
 * `""` — is null, and the caller keeps its default.
 */
export function parseByteSize(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
  }
  if (typeof value !== 'string') return null;
  const m = SIZE_RE.exec(value.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = UNITS[m[2]!.toUpperCase()];
  if (!Number.isFinite(n) || unit === undefined) return null;
  return Math.floor(n * unit);
}

/**
 * Render bytes back in the config's own vocabulary, for error messages and
 * `--print-config`. Exact multiples stay whole (`1GB`, not `1.00GB`).
 */
export function formatByteSize(bytes: number): string {
  if (bytes === 0) return '0';
  for (const unit of ['GB', 'MB', 'KB'] as const) {
    const scale = UNITS[unit]!;
    if (bytes >= scale) {
      const n = bytes / scale;
      return `${Number.isInteger(n) ? n : n.toFixed(2)}${unit}`;
    }
  }
  return String(bytes);
}
