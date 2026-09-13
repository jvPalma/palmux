// ── The palmux palette, as a Monaco theme ─────────────────────────────────────
//
// Monaco ships its own themes and its own idea of what a keyword looks like. Left
// alone it paints every editor in VS Code's colours, which on a light palmux theme
// produced a DARK editor sitting inside a light app — reported from real use and
// visible in a screenshot of `everforest-light-hard`.
//
// Three separate things were wrong and all three are addressed here rather than
// in the loader, so they can be tested without instantiating Monaco:
//   1. the theme was built once and never rebuilt, so changing the palmux theme
//      moved every token EXCEPT the editor;
//   2. `base` was hardcoded to `vs-dark`, so even a correct background inherited
//      dark-theme syntax colours;
//   3. `rules` was empty, so syntax highlighting never used the palette at all —
//      the sixteen ANSI slots palmux already resolves per theme went unused.
//
// The mapping below is the one a terminal colour scheme already implies: a theme's
// green is its string green, its magenta is its keyword magenta. That is why this
// takes a `ColorProfile` and not a bag of CSS variables — the profile is the
// source, and reading computed CSS would be a second copy that can go stale.

// This module must NEVER import monaco-editor. App calls `setEditorProfile` on
// every theme change, and a static path from App to the loader would drag the
// whole 3.7 MB editor chunk into a session that only ever opens a terminal —
// exactly what the loader's dynamic import exists to prevent. The loader
// subscribes here instead, so the dependency points the safe way.

import { hex, isLightBg, deriveUiTokens, type ColorProfile } from '@palmux/shared';

/** Monaco's theme shape, declared locally so this module never imports Monaco. */
export interface MonacoThemeData {
  base: 'vs' | 'vs-dark';
  inherit: boolean;
  rules: { token: string; foreground?: string; fontStyle?: string }[];
  colors: Record<string, string>;
}

/** Monaco wants `rrggbb`, with no leading `#`, in `rules`. */
const bare = (n: number): string => hex(n).slice(1);

/** `#rrggbbaa` — Monaco accepts 8-digit hex in `colors` (not in `rules`). */
const alpha = (n: number, aa: string): string => `${hex(n)}${aa}`;

export function buildMonacoTheme(profile: ColorProfile): MonacoThemeData {
  const t = deriveUiTokens(profile);
  const a = profile.ansi16;
  // Normal slots 0-7, bright 8-15. Bright is used where a token needs to stay
  // legible against a busy line (comments are the exception — they should recede).
  const [, red, green, yellow, blue, magenta, cyan] = a;
  const dim = a[8] ?? t.subtext;

  const c = (n: number | undefined, fallback: number) => bare(n ?? fallback);

  return {
    // The base decides every token this file does NOT name, plus the built-in
    // widget styling. Getting it from the background is the whole fix for a
    // light theme: `vs` and `vs-dark` are not interchangeable defaults.
    base: isLightBg(profile) ? 'vs' : 'vs-dark',
    inherit: true,
    rules: [
      { token: '', foreground: bare(profile.fg) },
      { token: 'comment', foreground: c(dim, t.subtext), fontStyle: 'italic' },
      { token: 'string', foreground: c(green, t.accent) },
      { token: 'string.escape', foreground: c(cyan, t.accentAlt) },
      { token: 'number', foreground: c(yellow, t.accent) },
      { token: 'constant', foreground: c(yellow, t.accent) },
      { token: 'keyword', foreground: c(magenta, t.accentAlt) },
      { token: 'operator', foreground: c(cyan, t.subtext) },
      { token: 'delimiter', foreground: c(a[7], t.subtext) },
      { token: 'type', foreground: c(blue, t.accentAlt) },
      { token: 'type.identifier', foreground: c(blue, t.accentAlt) },
      { token: 'identifier', foreground: bare(profile.fg) },
      { token: 'function', foreground: c(cyan, t.accent) },
      { token: 'variable', foreground: bare(profile.fg) },
      { token: 'variable.predefined', foreground: c(red, t.accent) },
      { token: 'tag', foreground: c(red, t.accent) },
      { token: 'attribute.name', foreground: c(yellow, t.accent) },
      { token: 'attribute.value', foreground: c(green, t.accentAlt) },
      { token: 'regexp', foreground: c(red, t.accent) },
      { token: 'annotation', foreground: c(dim, t.subtext) },
      // JSON: the key is the thing you scan for, so it gets the accent hue.
      { token: 'string.key.json', foreground: c(blue, t.accentAlt) },
      { token: 'string.value.json', foreground: c(green, t.accent) },
      // Markdown, for the editor half of a .md file.
      { token: 'keyword.md', foreground: c(magenta, t.accentAlt), fontStyle: 'bold' },
      { token: 'string.link.md', foreground: c(blue, t.accentAlt) },
    ],
    colors: {
      'editor.background': hex(t.base),
      'editor.foreground': hex(profile.fg),
      'editorLineNumber.foreground': hex(t.subtext),
      'editorLineNumber.activeForeground': hex(t.text),
      'editorCursor.foreground': hex(profile.cursor ?? profile.fg),
      // 8-digit hex: a selection must tint, not cover, the text under it.
      'editor.selectionBackground': alpha(t.surface, 'cc'),
      'editor.inactiveSelectionBackground': alpha(t.surface, '80'),
      'editor.lineHighlightBackground': alpha(t.mantle, '80'),
      'editorIndentGuide.background1': alpha(t.surface, '99'),
      'editorIndentGuide.activeBackground1': hex(t.subtext),
      'editorWhitespace.foreground': alpha(t.surface, 'cc'),
      'editorWidget.background': hex(t.mantle),
      'editorWidget.border': hex(t.surface),
      'editorHoverWidget.background': hex(t.mantle),
      'editorSuggestWidget.background': hex(t.mantle),
      'editorSuggestWidget.selectedBackground': hex(t.surface),
      'editorBracketMatch.background': alpha(t.surface, '80'),
      'editorBracketMatch.border': hex(t.accent),
      'editor.findMatchBackground': alpha(t.accent, '66'),
      'editor.findMatchHighlightBackground': alpha(t.accentAlt, '44'),
      'editorGutter.background': hex(t.base),
      'scrollbarSlider.background': alpha(t.surface, '99'),
      'scrollbarSlider.hoverBackground': alpha(t.surface, 'cc'),
      'scrollbarSlider.activeBackground': hex(t.subtext),
      'editorError.foreground': hex(a[1] ?? t.accent),
      'editorWarning.foreground': hex(a[3] ?? t.accent),
    },
  };
}

// ── The bridge App uses ───────────────────────────────────────────────────────

let current: ColorProfile | null = null;
let listener: ((p: ColorProfile) => void) | null = null;

/**
 * Record the app's palette and repaint any live editor.
 *
 * Safe to call before Monaco exists (and before it ever does): with no listener
 * this only remembers the profile, which the loader then reads when it starts.
 * That ordering is the point — an editor opened later is correct on its FIRST
 * frame instead of flashing VS Code's default palette and correcting itself.
 */
export function setEditorProfile(p: ColorProfile): void {
  current = p;
  listener?.(p);
}

/** The palette the next editor should use, or null before App has set one. */
export const editorProfile = (): ColorProfile | null => current;

/** The loader registers here as it initialises; there is only ever one. */
export function onEditorProfile(cb: (p: ColorProfile) => void): void {
  listener = cb;
}
