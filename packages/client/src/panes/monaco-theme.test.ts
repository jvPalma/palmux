// The editor's palette. Every assertion here stands for a defect that shipped:
// a dark editor inside a light app, a theme change that moved everything except
// the editor, and syntax colours that never came from the palette at all.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ColorProfile } from '@palmux/shared';
import {
  buildMonacoTheme,
  editorProfile,
  onEditorProfile,
  setEditorProfile,
} from './monaco-theme';

const DARK: ColorProfile = {
  id: 'test-dark',
  name: 'Test Dark',
  fg: 0xcdd6f4,
  bg: 0x1e1e2e,
  ansi16: [
    0x45475a, 0xf38ba8, 0xa6e3a1, 0xf9e2af, 0x89b4fa, 0xf5c2e7, 0x94e2d5, 0xcdd6f4, 0x585b70,
    0xf38ba8, 0xa6e3a1, 0xf9e2af, 0x89b4fa, 0xf5c2e7, 0x94e2d5, 0xb4befe,
  ],
};
const LIGHT: ColorProfile = { ...DARK, id: 'test-light', name: 'Test Light', bg: 0xeff1f5, fg: 0x4c4f69 };

const ruleFor = (p: ColorProfile, token: string) =>
  buildMonacoTheme(p).rules.find((r) => r.token === token);

afterEach(() => {
  onEditorProfile(() => {});
  vi.restoreAllMocks();
});

describe('buildMonacoTheme', () => {
  // The whole of the reported bug: `base` was hardcoded to 'vs-dark', so a light
  // palmux theme still inherited VS Code's dark syntax colours and the editor
  // read as a dark hole in a light app.
  it('picks the base from the background, not a constant', () => {
    expect(buildMonacoTheme(DARK).base).toBe('vs-dark');
    expect(buildMonacoTheme(LIGHT).base).toBe('vs');
  });

  it('paints the editor with the theme background and foreground', () => {
    const t = buildMonacoTheme(LIGHT);
    expect(t.colors['editor.background']).toBe('#eff1f5');
    expect(t.colors['editor.foreground']).toBe('#4c4f69');
  });

  // `rules: []` meant syntax highlighting never used the palette. A terminal
  // theme already says what its green and its magenta are; the editor should
  // agree with the shell next to it.
  it('takes syntax colours from the ANSI slots', () => {
    expect(ruleFor(DARK, 'string')?.foreground).toBe('a6e3a1'); // ansi2, green
    expect(ruleFor(DARK, 'keyword')?.foreground).toBe('f5c2e7'); // ansi5, magenta
    expect(ruleFor(DARK, 'number')?.foreground).toBe('f9e2af'); // ansi3, yellow
    expect(ruleFor(DARK, 'type')?.foreground).toBe('89b4fa'); // ansi4, blue
  });

  it('recedes comments to the dim slot rather than the foreground', () => {
    const c = ruleFor(DARK, 'comment');
    expect(c?.foreground).toBe('585b70'); // ansi8
    expect(c?.foreground).not.toBe('cdd6f4'); // never the body text colour
    expect(c?.fontStyle).toBe('italic');
  });

  // Monaco is strict about this and fails silently on the wrong one: `rules`
  // take bare `rrggbb`, `colors` take `#rrggbb(aa)`.
  it('uses the hex form each half of the theme requires', () => {
    const t = buildMonacoTheme(DARK);
    for (const r of t.rules) expect(r.foreground).toMatch(/^[0-9a-f]{6}$/);
    for (const v of Object.values(t.colors)) expect(v).toMatch(/^#[0-9a-f]{6}([0-9a-f]{2})?$/);
  });

  it('tints the selection instead of covering the text under it', () => {
    expect(buildMonacoTheme(DARK).colors['editor.selectionBackground']).toMatch(/^#[0-9a-f]{6}cc$/);
  });

  it('survives a profile with a short ansi16 rather than emitting undefined', () => {
    const short: ColorProfile = { ...DARK, ansi16: [0x111111, 0x222222] };
    const t = buildMonacoTheme(short);
    for (const r of t.rules) expect(r.foreground).toMatch(/^[0-9a-f]{6}$/);
  });
});

describe('the editor-profile bridge', () => {
  // The bridge exists so App can publish a palette without importing the loader,
  // which would pull monaco's 3.7 MB chunk into every terminal-only session.
  it('remembers a profile published before any editor exists', () => {
    setEditorProfile(LIGHT);
    expect(editorProfile()?.id).toBe('test-light');
  });

  it('notifies the loader once it has subscribed', () => {
    const seen: string[] = [];
    onEditorProfile((p) => seen.push(p.id));
    setEditorProfile(DARK);
    setEditorProfile(LIGHT);
    expect(seen).toEqual(['test-dark', 'test-light']);
  });
});
