// Runtime version identity: the package version plus a best-effort short git SHA.
// Read once at module load. In the bundled/no-git runtime the SHA is simply
// omitted (git call fails silently), leaving the bare package version.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function readPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // src/version.ts → ../package.json (packages/server/package.json)
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as {
      version?: unknown;
    };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function readGitSha(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: here,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000,
    })
      .toString()
      .trim();
    return /^[0-9a-f]{4,40}$/.test(sha) ? sha : '';
  } catch {
    return '';
  }
}

const pkgVersion = readPackageVersion();
const gitSha = readGitSha();

/** Build version, e.g. `2.0.0+ab12cd3` (source with git) or `2.0.0` (bundle). */
export const APP_VERSION: string = gitSha ? `${pkgVersion}+${gitSha}` : pkgVersion;
