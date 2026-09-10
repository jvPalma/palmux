// ── Opt-in self-update ────────────────────────────────────────────────────────
//
// Polls GitHub Releases and swaps the running bundle — but only when the
// operator turned it on and pinned a public key. Every side effect (network,
// filesystem, health-check, client notification, clock) is INJECTED via
// `UpdateDeps`, so the policy that lives here — channel filtering, checksum +
// signature verification, staging, rollback — is testable without a network or
// a real bundle directory.
//
// Verification is AND-ed on purpose: a bundle must match its SHA-256 *and*
// carry a valid detached Ed25519 signature. A missing integrity asset is a
// rejection, never a silent downgrade to the weaker check.

import {
  createHash,
  createPublicKey,
  timingSafeEqual,
  verify as verifySignature,
} from 'node:crypto';
import { MIN_UPDATE_INTERVAL_HOURS, type SelfUpdateConfig } from './app-config';
import { APP_VERSION } from './version';

export type UpdateOutcome =
  | 'disabled'
  | 'source-deployment'
  | 'up-to-date'
  | 'no-release'
  | 'rejected-checksum'
  | 'rejected-signature'
  | 'staged'
  | 'rolled-back'
  | 'error';

export interface ReleaseAsset {
  name: string;
  url: string;
}

export interface Release {
  tag: string;
  prerelease: boolean;
  assets: ReleaseAsset[];
}

export interface UpdateDeps {
  fetchLatestRelease(repo: string, channel: 'stable' | 'prerelease'): Promise<Release | null>;
  download(url: string): Promise<Buffer>;
  /** Replace the live bundle dir with `staged`, moving the old one aside. Returns a restore fn. */
  stage(bundle: Buffer, version: string): Promise<{ restore: () => Promise<void> }>;
  /** Run the staged bundle's `--version`; resolve the reported version (health-check). */
  healthCheck(): Promise<string>;
  notify(stage: 'downloading' | 'staging' | 'restarting' | 'failed', version?: string): void;
  now(): number;
}

/** Running from a `.ts` entry means tsx/source — git is the update path there. */
export function isSourceDeployment(entry: string): boolean {
  return /\.[cm]?tsx?$/.test(entry);
}

const stripTag = (v: string): string => v.replace(/^v/, '').trim();

/** Numeric core of a semver-ish tag: build metadata and pre-release suffix dropped. */
function versionParts(v: string): number[] {
  const core = stripTag(v).split('+')[0]!.split('-')[0]!;
  return core.split('.').map((s) => Number.parseInt(s, 10) || 0);
}

function compareVersions(a: string, b: string): number {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/** The release to install, or null when it is filtered out / not newer. */
export function pickRelease(
  rel: Release | null,
  channel: 'stable' | 'prerelease',
  currentVersion: string,
): Release | null {
  if (!rel) return null;
  if (channel === 'stable' && rel.prerelease) return null;
  if (compareVersions(rel.tag, currentVersion) <= 0) return null;
  return rel;
}

export function verifyBundle(args: {
  bundle: Buffer;
  sha256: string;
  signature: Buffer;
  publicKey: string;
}): { ok: true } | { ok: false; reason: 'checksum' | 'signature' | 'key' } {
  const actual = Buffer.from(createHash('sha256').update(args.bundle).digest('hex'));
  const expected = Buffer.from(args.sha256.trim().toLowerCase());
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return { ok: false, reason: 'checksum' };
  }

  let key;
  try {
    key = createPublicKey({ key: args.publicKey, format: 'pem' });
  } catch {
    return { ok: false, reason: 'key' };
  }

  try {
    if (!verifySignature(null, args.bundle, key, args.signature)) {
      return { ok: false, reason: 'signature' };
    }
  } catch {
    // Wrong key type / malformed signature bytes are just a failed verification.
    return { ok: false, reason: 'signature' };
  }
  return { ok: true };
}

/** Poll interval in ms, floored so a mistyped 0 cannot hammer the API. */
export function clampIntervalMs(hours: number): number {
  const safe = Number.isFinite(hours) ? hours : MIN_UPDATE_INTERVAL_HOURS;
  return Math.max(MIN_UPDATE_INTERVAL_HOURS, safe) * 60 * 60 * 1000;
}

const findAsset = (assets: ReleaseAsset[], suffix: string): ReleaseAsset | undefined =>
  assets.find((a) => a.name.endsWith(suffix));

const firstToken = (text: string): string => text.trim().split(/\s+/)[0] ?? '';

export function createUpdater(
  cfg: SelfUpdateConfig,
  deps: UpdateDeps,
  opts: { entry?: string } = {},
): { checkNow(): Promise<UpdateOutcome>; start(): void; stop(): void } {
  const entry = opts.entry ?? process.argv[1] ?? '';
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastCheckAt = 0;

  const checkNow = async (): Promise<UpdateOutcome> => {
    lastCheckAt = deps.now();
    if (!cfg.enabled) return 'disabled';
    if (isSourceDeployment(entry)) return 'source-deployment';

    try {
      const latest = await deps.fetchLatestRelease(cfg.repo, cfg.channel);
      if (!latest) return 'no-release';
      const release = pickRelease(latest, cfg.channel, APP_VERSION);
      if (!release) return 'up-to-date';

      const version = stripTag(release.tag);
      const sumAsset = findAsset(release.assets, '.sha256');
      const sigAsset = findAsset(release.assets, '.sig');
      const bundleAsset = release.assets.find((a) => a !== sumAsset && a !== sigAsset);
      if (!bundleAsset) return 'no-release';
      if (!sumAsset) {
        deps.notify('failed', version);
        return 'rejected-checksum';
      }
      if (!sigAsset) {
        deps.notify('failed', version);
        return 'rejected-signature';
      }

      deps.notify('downloading', version);
      const [bundle, sumBytes, signature] = await Promise.all([
        deps.download(bundleAsset.url),
        deps.download(sumAsset.url),
        deps.download(sigAsset.url),
      ]);

      const checked = verifyBundle({
        bundle,
        sha256: firstToken(sumBytes.toString('utf8')),
        signature,
        publicKey: cfg.publicKey,
      });
      if (!checked.ok) {
        deps.notify('failed', version);
        return checked.reason === 'checksum' ? 'rejected-checksum' : 'rejected-signature';
      }

      deps.notify('staging', version);
      const staged = await deps.stage(bundle, version);
      try {
        const reported = await deps.healthCheck();
        if (compareVersions(reported, version) !== 0) {
          throw new Error(`health-check reported ${reported}, expected ${version}`);
        }
      } catch {
        try {
          await staged.restore();
        } catch {
          /* the previous bundle is unrecoverable — the operator must intervene */
        }
        deps.notify('failed', version);
        return 'rolled-back';
      }

      deps.notify('restarting', version);
      return 'staged';
    } catch {
      deps.notify('failed');
      return 'error';
    }
  };

  const start = (): void => {
    if (!cfg.enabled || timer) return;
    const every = clampIntervalMs(cfg.intervalHours);
    timer = setInterval(() => {
      // Something already polled recently (a manual check) — skip this tick.
      if (deps.now() - lastCheckAt < every / 2) return;
      void checkNow();
    }, every);
    timer.unref();
  };

  const stop = (): void => {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  };

  return { checkNow, start, stop };
}
