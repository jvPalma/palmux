// Which grammar a path resolves to. Reported live: a .json read exactly like a
// .txt, because Monaco carried markdown alone. These pin the map AND the two
// deliberate substitutions, which are the entries most likely to be "corrected"
// into something that silently stops colouring.

import { describe, expect, it } from 'vitest';
import { languageOf } from './EditorPane';

describe('languageOf', () => {
  it('resolves the kinds a terminal user opens', () => {
    const cases: [string, string][] = [
      ['/etc/app/config.yaml', 'yaml'],
      ['/x/docker-compose.yml', 'yaml'],
      ['/x/run.sh', 'shell'],
      ['/x/App.tsx', 'typescript'],
      ['/x/server.ts', 'typescript'],
      ['/x/build.mjs', 'javascript'],
      ['/x/main.py', 'python'],
      ['/x/main.go', 'go'],
      ['/x/lib.rs', 'rust'],
      ['/x/index.css', 'css'],
      ['/x/page.html', 'html'],
      ['/x/pom.xml', 'xml'],
      ['/x/schema.sql', 'sql'],
      ['/x/main.tf', 'hcl'],
      ['/x/README.md', 'markdown'],
    ];
    for (const [path, lang] of cases) expect(languageOf(path), path).toBe(lang);
  });

  // json has no basic-language grammar — its colouring is in the language
  // SERVICE, a worker palmux deliberately does not load. javascript is a
  // superset of every valid JSON document and is already bundled.
  it('borrows the javascript grammar for JSON', () => {
    expect(languageOf('/x/package.json')).toBe('javascript');
    expect(languageOf('/x/tsconfig.jsonc')).toBe('javascript');
  });

  it('falls back to ini for toml, which has no grammar at all', () => {
    expect(languageOf('/x/Cargo.toml')).toBe('ini');
    expect(languageOf('/x/app.ini')).toBe('ini');
  });

  it('reads a name when there is no extension', () => {
    expect(languageOf('/x/Dockerfile')).toBe('dockerfile');
    expect(languageOf('/x/dockerfile')).toBe('dockerfile');
  });

  // A leading dot is part of the NAME. Looking up `zshrc` as an extension finds
  // nothing and shadows the name hit — the same trap the file icons had.
  it('does not read a dotfile as an extension', () => {
    expect(languageOf('/home/user/.zshrc')).toBe('shell');
    expect(languageOf('/home/user/.env')).toBe('ini');
    expect(languageOf('/home/user/.tmux.conf')).toBe('shell');
  });

  it('is plaintext for anything unregistered, never undefined', () => {
    expect(languageOf('/x/notes.txt')).toBe('plaintext');
    expect(languageOf('/x/data.parquet')).toBe('plaintext');
    expect(languageOf('/x/Makefile')).toBe('plaintext');
    expect(languageOf('/x/noextension')).toBe('plaintext');
    expect(languageOf('')).toBe('plaintext');
  });

  it('ignores case and directory names', () => {
    expect(languageOf('/x.py/thing.YML')).toBe('yaml');
    expect(languageOf('/PATH/TO/Main.PY')).toBe('python');
  });
});
