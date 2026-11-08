// ── Source Control: the line endings a checkout writes ────────────────────────
//
// A discard writes a file back to its index version without running a git
// checkout, because every checkout path reads the WORK TREE's `.gitattributes` at
// the moment it runs (design B10). The one conversion a checkout would still apply,
// LF to CRLF, is ported here from git 2.43's convert.c, and the 720-case test in
// scm-discard.test.ts holds it equal to `git checkout-index`.

import { gitFailure, runGit, type ScmFailure } from './scm-git';
import { gatherStats, statsAreBinary } from './scm-snapshot';

/** `check-attr` values of one path, by attribute name. */
export type Attrs = Readonly<Record<string, string>>;

/** `core.autocrlf` and `core.eol` as git reads them. */
export interface EolConfig {
  autocrlf: 'true' | 'false' | 'input';
  eol: 'lf' | 'crlf' | 'native' | 'unset';
}

/** `git_config_bool`, plus `input`: a key with no value is true, an integer is true unless 0. */
function parseAutocrlf(value: string | null): EolConfig['autocrlf'] {
  if (value === null) return 'true';
  const v = value.toLowerCase();
  if (v === 'input') return 'input';
  if (v === 'true' || v === 'yes' || v === 'on') return 'true';
  if (/^[+-]?\d+$/.test(v)) return Number(v) === 0 ? 'false' : 'true';
  return 'false';
}

function parseCoreEol(value: string | null): EolConfig['eol'] {
  const v = value?.toLowerCase();
  return v === 'lf' || v === 'crlf' || v === 'native' ? v : 'unset';
}

export async function readEolConfig(top: string): Promise<EolConfig | ScmFailure> {
  const run = await runGit(top, ['config', '-z', '--get-regexp', '^core\\.(autocrlf|eol)$'], { okCodes: [0, 1] });
  if (!run.ok) return gitFailure(run, 'config');
  const config: EolConfig = { autocrlf: 'false', eol: 'unset' };
  // One record per setting, in the order git reads them, so the last one wins.
  for (const record of run.stdout.toString('utf8').split('\0')) {
    if (record === '') continue;
    const newline = record.indexOf('\n');
    const key = (newline < 0 ? record : record.slice(0, newline)).toLowerCase();
    const value = newline < 0 ? null : record.slice(newline + 1);
    if (key === 'core.autocrlf') config.autocrlf = parseAutocrlf(value);
    else if (key === 'core.eol') config.eol = parseCoreEol(value);
  }
  return config;
}

/** git's `enum convert_crlf_action`, before and after `convert_attrs` resolves it. */
type CrlfAction = 'undefined' | 'binary' | 'text' | 'text-input' | 'text-crlf' | 'auto' | 'auto-input' | 'auto-crlf';

/** `git_path_check_crlf`, for both `text` and the older `crlf`. */
function crlfActionOf(value: string | undefined): CrlfAction {
  switch (value) {
    case 'set':
      return 'text';
    case 'unset':
      return 'binary';
    case 'input':
      return 'text-input';
    case 'auto':
      return 'auto';
    default:
      return 'undefined';
  }
}

/**
 * The bytes `git checkout-index` writes for a blob of a path with these attributes
 * and no filter, encoding or `ident`: a port of `convert_attrs`, `output_eol`,
 * `will_convert_lf_to_crlf` and `crlf_to_worktree` from git's convert.c. The only
 * checkout conversion left is LF to CRLF; on this platform the native eol is LF.
 */
export function checkoutBytes(blob: Buffer, attrs: Attrs, config: EolConfig): Buffer {
  let action = crlfActionOf(attrs['text']);
  if (action === 'undefined') action = crlfActionOf(attrs['crlf']);
  if (action !== 'binary') {
    const eol = attrs['eol'];
    if (action === 'auto' && eol === 'lf') action = 'auto-input';
    else if (action === 'auto' && eol === 'crlf') action = 'auto-crlf';
    else if (eol === 'lf') action = 'text-input';
    else if (eol === 'crlf') action = 'text-crlf';
  }
  // `text_eol_is_crlf`: core.autocrlf decides first, core.eol only when it is false.
  const crlfByDefault = config.autocrlf === 'true' || (config.autocrlf === 'false' && config.eol === 'crlf');
  if (action === 'text') action = crlfByDefault ? 'text-crlf' : 'text-input';
  if (action === 'undefined') {
    action = config.autocrlf === 'true' ? 'auto-crlf' : config.autocrlf === 'input' ? 'auto-input' : 'binary';
  }
  const writesCrlf = action === 'text-crlf' || action === 'auto-crlf' || (action === 'auto' && crlfByDefault);
  if (!writesCrlf || blob.length === 0) return blob;
  const stats = gatherStats(blob);
  if (stats.lonelf === 0) return blob;
  // The auto modes leave a blob alone that already holds a CR, or is not text.
  if (action !== 'text-crlf' && (stats.lonecr > 0 || stats.crlf > 0 || statsAreBinary(stats))) return blob;
  const out = Buffer.allocUnsafe(blob.length + stats.lonelf);
  let n = 0;
  for (let i = 0; i < blob.length; i++) {
    const c = blob[i] as number;
    if (c === 10 && (i === 0 || blob[i - 1] !== 13)) out[n++] = 13;
    out[n++] = c;
  }
  return out;
}
