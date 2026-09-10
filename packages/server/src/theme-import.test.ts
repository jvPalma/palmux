// Theme import: whatever the user has to hand (a name, a gallery link, a github
// blob URL) has to resolve to something fetchable.

import { describe, expect, it } from 'vitest';
import { parseImportedTheme, resolveThemeUrl, themeNameFromCommand } from './theme-import';

const GOGH = 'https://raw.githubusercontent.com/Gogh-Co/Gogh/master/themes';

describe('resolveThemeUrl', () => {
  it('treats a bare name as a Gogh theme, encoded but NOT slugged', () => {
    // Gogh spells its files in Title Case with spaces — slugging breaks the lookup.
    expect(resolveThemeUrl('Dracula')).toBe(`${GOGH}/Dracula.yml`);
    expect(resolveThemeUrl('Tokyo Night')).toBe(`${GOGH}/Tokyo%20Night.yml`);
    expect(resolveThemeUrl('  Aci  ')).toBe(`${GOGH}/Aci.yml`);
  });

  it('rewrites a github blob URL to raw (a blob URL serves HTML)', () => {
    expect(resolveThemeUrl('https://github.com/Gogh-Co/Gogh/blob/master/themes/Aci.yml')).toBe(
      'https://raw.githubusercontent.com/Gogh-Co/Gogh/master/themes/Aci.yml',
    );
  });

  it('reads the theme name out of a Gogh gallery link', () => {
    expect(resolveThemeUrl('https://gogh-co.github.io/Gogh/#Dracula')).toBe(`${GOGH}/Dracula.yml`);
    // Already-encoded fragments must not get double-encoded.
    expect(resolveThemeUrl('https://gogh-co.github.io/Gogh/#Tokyo%20Night')).toBe(
      `${GOGH}/Tokyo%20Night.yml`,
    );
  });

  it('reads the name out of the install command the Gogh site hands you', () => {
    // The command is a carrier for the name — never executed, and the URL it
    // carries (the pre-rename Mayccoll repo) is deliberately ignored.
    expect(
      resolveThemeUrl(
        'bash -c "$(wget -qO- https://git.io/vQgMr)" -- "Everforest Light Hard"',
      ),
    ).toBe(`${GOGH}/Everforest%20Light%20Hard.yml`);
  });

  it('handles the curl variant, single quotes and an unquoted name', () => {
    expect(resolveThemeUrl('bash -c "$(curl -sLo- https://git.io/vQgMr)" -- "Dracula"')).toBe(
      `${GOGH}/Dracula.yml`,
    );
    expect(resolveThemeUrl("bash -c \"$(wget -qO- https://git.io/vQgMr)\" -- 'Aci'")).toBe(
      `${GOGH}/Aci.yml`,
    );
    expect(resolveThemeUrl('bash -c "$(wget -qO- https://git.io/vQgMr)" -- Dracula')).toBe(
      `${GOGH}/Dracula.yml`,
    );
  });

  it('takes the FIRST name when the command lists several', () => {
    expect(
      resolveThemeUrl('bash -c "$(wget -qO- https://git.io/vQgMr)" -- "Aci" "Dracula"'),
    ).toBe(`${GOGH}/Aci.yml`);
  });

  it('is not tripped up by the flags inside the command', () => {
    // `-qO-` / `-sLo-` must not read as the `--` end-of-options marker.
    expect(themeNameFromCommand('bash -c "$(wget -qO- https://git.io/vQgMr)"')).toBeNull();
    expect(themeNameFromCommand('curl -sLo- https://example.com/x.sh | bash')).toBeNull();
  });

  it('uses the URL directly for the newer per-theme install form', () => {
    const u = 'https://raw.githubusercontent.com/Gogh-Co/Gogh/master/installs/dracula.sh';
    expect(resolveThemeUrl(`bash -c "$(wget -qO- ${u})"`)).toBe(u);
  });

  it('ignores a `--` in ordinary text that is not a command', () => {
    expect(themeNameFromCommand('some notes -- "Dracula"')).toBeNull();
  });

  it('strips quotes off a name pasted on its own', () => {
    expect(resolveThemeUrl('"Everforest Light Hard"')).toBe(`${GOGH}/Everforest%20Light%20Hard.yml`);
  });

  it('passes any other http(s) URL straight through', () => {
    const u = 'https://example.com/my-theme.yml';
    expect(resolveThemeUrl(u)).toBe(u);
  });

  it('rejects empty and non-URL junk', () => {
    expect(resolveThemeUrl('')).toBeNull();
    expect(resolveThemeUrl('   ')).toBeNull();
    expect(resolveThemeUrl('file:///etc/passwd')).toBeNull();
    expect(resolveThemeUrl('../../etc/passwd')).toBeNull();
  });
});

describe('parseImportedTheme', () => {
  it('picks the JSON parser for a Windows-Terminal scheme', () => {
    const json = JSON.stringify({ name: 'WT', foreground: '#ffffff', background: '#000000' });
    expect(parseImportedTheme(json, 'x')?.name).toBe('WT');
  });

  it('picks the Gogh parser for everything else', () => {
    const p = parseImportedTheme("name: 'Aci'\nbackground: '#0f1419'\nforeground: '#e6e1cf'", 'x');
    expect(p?.name).toBe('Aci');
    expect(p?.bg).toBe(0x0f1419);
  });

  it('returns null for malformed JSON and for text with no colours', () => {
    expect(parseImportedTheme('{ not json', 'x')).toBeNull();
    expect(parseImportedTheme('<!doctype html><h1>404</h1>', 'x')).toBeNull();
  });
});
