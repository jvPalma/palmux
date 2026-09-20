// ── `palmux` argv → a command ─────────────────────────────────────────────────
//
// Pure and total: no process, no filesystem, no exit. `index.ts` owns the exit
// codes, so every parsing rule here is a plain unit test rather than a
// subprocess spawn.
//
// The bare-path form is the `code`-style one the whole feature exists for:
// `palmux ~/.tmux.conf`. The generated launcher sends everything that is not
// `serve` (or a flag) here, so an unrecognised first word is a PATH, not a
// misspelled subcommand — `palmux tabs` opens the subcommand, and a file
// literally named `tabs` needs `palmux open ./tabs`.

export type CliCommand =
  | { kind: 'open'; path: string }
  | { kind: 'tabs' }
  | { kind: 'groups' }
  | { kind: 'settings' }
  | { kind: 'status' }
  | { kind: 'help' };

export type ParsedArgs = { ok: true; command: CliCommand } | { ok: false; error: string };

const NULLARY = ['tabs', 'groups', 'settings', 'status'] as const;
type Nullary = (typeof NULLARY)[number];

const isNullary = (word: string): word is Nullary =>
  (NULLARY as readonly string[]).includes(word);

export function parseArgs(argv: string[]): ParsedArgs {
  const first = argv[0];
  const rest = argv.slice(1);
  if (first === undefined) return { ok: true, command: { kind: 'help' } };
  if (first === 'help' || first === '--help' || first === '-h') {
    return { ok: true, command: { kind: 'help' } };
  }

  const extra = rest[0];
  if (first === 'open') {
    if (extra === undefined || extra === '') return { ok: false, error: 'open needs a path' };
    if (rest.length > 1) return { ok: false, error: `unexpected argument: ${rest[1]}` };
    return { ok: true, command: { kind: 'open', path: extra } };
  }
  // The launcher routes `serve` to the SERVER bundle, so this only fires when the
  // CLI is run directly (`yarn palmux serve`). Saying which command to use beats
  // the alternative, which is treating `serve` as a path and reporting that no
  // file called "serve" exists.
  if (first === 'serve') {
    return { ok: false, error: 'serve runs the server — use `yarn start`' };
  }
  if (isNullary(first)) {
    if (extra !== undefined) return { ok: false, error: `${first} takes no arguments` };
    return { ok: true, command: { kind: first } };
  }
  // Flags belong to the SERVER entry (`--print-config`, `--new-token`), and the
  // launcher routes them there. Seeing one here means it was run directly
  // against the CLI, so say so rather than opening a tab for `--help`.
  if (first.startsWith('-')) return { ok: false, error: `unknown option: ${first}` };
  if (extra !== undefined) return { ok: false, error: `unexpected argument: ${extra}` };
  return { ok: true, command: { kind: 'open', path: first } };
}
