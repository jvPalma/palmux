// ── Claude Code theme export (~/.claude/themes/palmux.json) ───────────────────
//
// Renders the active palmux palette as a Claude Code custom theme, so a `claude`
// running inside a palmux terminal is skinned by the SAME palette as the tab
// strip, prompt (p10k), tmux status bar and delta diffs.
//
// Colours are emitted as literal hex rather than `ansi:<name>` references. The
// refs would resolve to whatever the host terminal reports, which is only
// equivalent inside palmux — and they collapse the 12-accent palette onto 16
// ANSI slots, losing mauve/lavender/teal/peach and every derived background.
//
// `base` is `light`/`dark`, deliberately NOT the `-ansi` variants: those paint
// no diff backgrounds at all, so overriding diffAdded/diffRemoved on top of one
// does nothing.
//
// Claude Code reads a theme at startup (and on `/theme`), so a palmux theme
// change lands in the NEXT claude session, not the running one.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { deriveAccents, deriveUiTokens, getProfile, hex, isLightBg, mix } from '@palmux/shared';
import type { DiffColors } from './delta-colors';

/** Where Claude Code looks for user themes. */
export function claudeThemePath(): string {
  return join(homedir(), '.claude', 'themes', 'palmux.json');
}

/**
 * Which built-in base to inherit from.
 *
 * NEVER a `*-ansi` variant: those paint no diff background at all and force the
 * flat `ansi` syntax theme.
 *
 * The plain-vs-daltonized choice is a WORKAROUND for anthropics/claude-code#69445
 * — the file-diff renderer resolves its colours from the theme's BASE and
 * discards custom overrides, so the six diff tokens we emit are parsed and then
 * ignored. The base is the only lever left, and the single question it can answer
 * is the one that actually distinguishes the built-ins: are additions GREEN or
 * BLUE? The daltonized bases are the blue ones. Asking it as a hue comparison
 * rather than a colour distance matters — on raw RGB a pale green sits nearer the
 * pale blue than the saturated stock green, so distance picks the wrong base.
 *
 * Remove this once upstream honours the overrides; they are already in the file
 * and will simply start winning.
 */
export function pickBase(light: boolean, diff: DiffColors): string {
  const plain = light ? 'light' : 'dark';
  if (diff.added === undefined) return plain; // nothing to read the intent from
  const blueLeaning = (diff.added & 255) > ((diff.added >> 8) & 255);
  return blueLeaning ? `${plain}-daltonized` : plain;
}

/**
 * The `palmux.json` file body for a theme id.
 *
 * `diff` (the user's git-delta palette, when they have one) replaces the six diff
 * backgrounds VERBATIM — no blending, no re-derivation. Those colours are a
 * deliberate choice the user already made once (theirs turn every addition blue
 * rather than green), and a diff has to read the same in git, lazygit and Claude
 * to be worth anything. The only thing palmux decides is WHICH of delta's two
 * palettes applies, from the active theme's polarity.
 */
export function buildClaudeTheme(themeId: string, diff: DiffColors = {}): string {
  const p = getProfile(themeId);
  const a = deriveAccents(p);
  const ui = deriveUiTokens(p);
  const light = isLightBg(p);

  // Shimmers are the animated highlight of their base colour — push AWAY from
  // the background so they read as brighter on dark themes and deeper on light.
  const pole = light ? 0x000000 : 0xffffff;
  const shimmer = (c: number): string => hex(mix(c, pole, 0.32));
  // Backgrounds: the theme bg tinted toward a colour by `t` (0 = plain bg).
  const tint = (c: number, t: number): string => hex(mix(p.bg, c, t));

  const overrides: Record<string, string> = {
    claude: hex(a.mauve),
    claudeShimmer: shimmer(a.mauve),
    text: hex(ui.text),
    inverseText: hex(ui.base),
    inactive: hex(ui.subtext),
    inactiveShimmer: shimmer(ui.subtext),
    subtle: hex(ui.subtext),
    suggestion: hex(a.blue),
    permission: hex(a.teal),
    permissionShimmer: shimmer(a.teal),
    remember: hex(a.mauve),
    success: hex(a.green),
    error: hex(a.red),
    warning: hex(a.yellow),
    warningShimmer: shimmer(a.yellow),
    merged: hex(a.mauve),
    promptBorder: hex(ui.surface),
    promptBorderShimmer: shimmer(ui.surface),
    planMode: hex(a.teal),
    autoAccept: hex(a.green),
    bashBorder: hex(a.mauve),
    ide: hex(a.blue),
    fastMode: hex(a.yellow),
    fastModeShimmer: shimmer(a.yellow),
    diffAdded: diff.added === undefined ? tint(a.green, 0.28) : hex(diff.added),
    diffRemoved: diff.removed === undefined ? tint(a.red, 0.28) : hex(diff.removed),
    diffAddedDimmed: diff.addedDimmed === undefined ? tint(a.green, 0.15) : hex(diff.addedDimmed),
    diffRemovedDimmed: diff.removedDimmed === undefined ? tint(a.red, 0.15) : hex(diff.removedDimmed),
    diffAddedWord: diff.addedWord === undefined ? tint(a.green, 0.5) : hex(diff.addedWord),
    diffRemovedWord: diff.removedWord === undefined ? tint(a.red, 0.5) : hex(diff.removedWord),
    userMessageBackground: tint(ui.text, 0.07),
    userMessageBackgroundHover: hex(ui.surface),
    bashMessageBackgroundColor: tint(a.mauve, 0.1),
    memoryBackgroundColor: tint(a.pink, 0.1),
    selectionBg: tint(a.blue, 0.28),
    rate_limit_fill: hex(a.green),
    rate_limit_empty: hex(ui.surface),
    briefLabelYou: hex(a.blue),
    briefLabelClaude: hex(a.mauve),
    red_FOR_SUBAGENTS_ONLY: hex(a.red),
    blue_FOR_SUBAGENTS_ONLY: hex(a.blue),
    green_FOR_SUBAGENTS_ONLY: hex(a.green),
    yellow_FOR_SUBAGENTS_ONLY: hex(a.yellow),
    purple_FOR_SUBAGENTS_ONLY: hex(a.mauve),
    orange_FOR_SUBAGENTS_ONLY: hex(a.peach),
    pink_FOR_SUBAGENTS_ONLY: hex(a.pink),
    cyan_FOR_SUBAGENTS_ONLY: hex(a.teal),
  };

  // The rainbow ramp walks the palette's own hues instead of a fixed spectrum.
  const rainbow: Array<[string, number]> = [
    ['red', a.red],
    ['orange', a.peach],
    ['yellow', a.yellow],
    ['green', a.green],
    ['blue', a.sky],
    ['indigo', a.blue],
    ['violet', a.mauve],
  ];
  for (const [name, c] of rainbow) {
    overrides[`rainbow_${name}`] = hex(c);
    overrides[`rainbow_${name}_shimmer`] = shimmer(c);
  }

  return `${JSON.stringify({ name: 'Palmux', base: pickBase(light, diff), overrides }, null, 2)}\n`;
}
