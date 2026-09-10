// ── Copied-text cleanup ───────────────────────────────────────────────────────
//
// TUI apps (Claude Code, htop, vim …) paint the screen full-width, so the cells
// to the right of the visible text are real spaces in xterm's buffer — a
// selection copies them verbatim and every line arrives padded to the terminal
// width. Strip that padding at copy time. Leading whitespace is preserved on
// purpose: it's meaningful indentation in copied code.

/** Remove trailing whitespace from every line of a copied selection. */
export function stripTrailingSpaces(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n');
}
