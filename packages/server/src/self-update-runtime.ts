// ── Self-update runtime deps ──────────────────────────────────────────────────
//
// The real I/O behind `self-update.ts`'s injected `UpdateDeps`: talk to the
// GitHub Releases API, download the bundle, swap it atomically, and health-check
// the result. self-update.ts owns the POLICY (what is verified, what rolls back);
// this file owns the plumbing, so the policy stays unit-testable without a
// network or a filesystem.
//
// `apiBase` is injectable for exactly one reason: it lets the whole flow be
// exercised end-to-end against a local fake release server, which is the only way
// to test this without publishing a real signed release.

import { spawn } from 'node:child_process';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { Release, ReleaseAsset, UpdateDeps } from './self-update';

export const GITHUB_API_BASE = 'https://api.github.com';

/** Refuse absurd downloads outright rather than filling the disk. */
const MAX_BUNDLE_BYTES = 256 * 1024 * 1024;
const HTTP_TIMEOUT_MS = 30_000;

export interface UpdateRuntimeOptions {
  repo: string;
  /** Directory holding the live bundle (the `bin/` dir). */
  bundleDir: string;
  /** Executable inside the bundle used for the `--version` health-check. */
  entryName?: string;
  notify: UpdateDeps['notify'];
  apiBase?: string;
  fetchImpl?: typeof fetch;
}

interface GhAsset {
  name?: unknown;
  browser_download_url?: unknown;
}

interface GhRelease {
  tag_name?: unknown;
  prerelease?: unknown;
  draft?: unknown;
  assets?: unknown;
}

function toRelease(raw: GhRelease): Release | null {
  if (typeof raw.tag_name !== 'string' || raw.draft === true) return null;
  const assets: ReleaseAsset[] = [];
  if (Array.isArray(raw.assets)) {
    for (const a of raw.assets as GhAsset[]) {
      if (typeof a?.name === 'string' && typeof a?.browser_download_url === 'string') {
        assets.push({ name: a.name, url: a.browser_download_url });
      }
    }
  }
  return { tag: raw.tag_name, prerelease: raw.prerelease === true, assets };
}

/** Extract a `.tar.gz` with the system tar — Node ships gzip but no tar. */
async function untar(archive: string, into: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('tar', ['-xzf', archive, '-C', into], { stdio: 'ignore' });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`tar exited with ${String(code)}`)),
    );
  });
}

function runVersion(exe: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
    });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0
        ? resolve(out.trim())
        : reject(new Error(`health-check exited with ${String(code)}`)),
    );
  });
}

export function createUpdateDeps(opts: UpdateRuntimeOptions): UpdateDeps {
  const api = opts.apiBase ?? GITHUB_API_BASE;
  const doFetch = opts.fetchImpl ?? fetch;
  const entryName = opts.entryName ?? 'palmux';

  return {
    async fetchLatestRelease(repo, channel) {
      try {
        const res = await doFetch(`${api}/repos/${repo}/releases?per_page=20`, {
          headers: { accept: 'application/vnd.github+json' },
          signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        });
        if (!res.ok) return null;
        const body: unknown = await res.json();
        if (!Array.isArray(body)) return null;
        // The API returns newest-first; hand back the first release the channel
        // accepts and let self-update.ts decide whether it is actually newer.
        for (const raw of body as GhRelease[]) {
          const rel = toRelease(raw);
          if (!rel) continue;
          if (channel === 'stable' && rel.prerelease) continue;
          return rel;
        }
        return null;
      } catch {
        // Network/DNS/timeout — indistinguishable from "no release" for our
        // purposes, and must never take the server down.
        return null;
      }
    },

    async download(url) {
      const res = await doFetch(url, {
        headers: { accept: 'application/octet-stream' },
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`download failed: HTTP ${String(res.status)}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_BUNDLE_BYTES) throw new Error('bundle exceeds the size cap');
      return buf;
    },

    async stage(bundle, version) {
      const parent = dirname(opts.bundleDir);
      const work = await mkdtemp(join(tmpdir(), `palmux-update-${version}-`));
      const archive = join(work, 'bundle.tar.gz');
      await writeFile(archive, bundle);
      await untar(archive, work);

      // A release tarball may or may not wrap its payload in a directory; accept
      // both rather than dictating the packaging.
      const inner = join(work, 'bin');
      const root = existsSync(join(inner, entryName)) ? inner : work;
      if (!existsSync(join(root, entryName))) {
        await rm(work, { recursive: true, force: true });
        throw new Error(`staged bundle has no ${entryName}`);
      }

      // Exactly ONE previous bundle is retained — that is what rollback needs,
      // and keeping every past version would silently fill the disk.
      const prev = join(parent, `${basename(opts.bundleDir)}.prev`);
      await rm(prev, { recursive: true, force: true });
      const hadLive = existsSync(opts.bundleDir);
      if (hadLive) await rename(opts.bundleDir, prev);
      await rename(root, opts.bundleDir);

      return {
        restore: async () => {
          await rm(opts.bundleDir, { recursive: true, force: true });
          if (hadLive) await rename(prev, opts.bundleDir);
        },
      };
    },

    healthCheck: () => runVersion(join(opts.bundleDir, entryName)),
    notify: opts.notify,
    now: () => Date.now(),
  };
}
