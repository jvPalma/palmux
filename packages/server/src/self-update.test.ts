import { describe, expect, it, vi } from 'vitest';
import { createHash, generateKeyPairSync, sign as signBytes } from 'node:crypto';
import { DEFAULT_SELF_UPDATE, type SelfUpdateConfig } from './app-config';
import {
  clampIntervalMs,
  createUpdater,
  isSourceDeployment,
  pickRelease,
  verifyBundle,
  type Release,
  type UpdateDeps,
} from './self-update';

// A real Ed25519 keypair + a real signature: the crypto path is exercised, not mocked.
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const OTHER_PEM = generateKeyPairSync('ed25519')
  .publicKey.export({ type: 'spki', format: 'pem' })
  .toString();

const BUNDLE = Buffer.from('palmux bundle bytes');
const SHA256 = createHash('sha256').update(BUNDLE).digest('hex');
const SIGNATURE = signBytes(null, BUNDLE, privateKey);

/** Far ahead of any real APP_VERSION, so "newer" never depends on the package version. */
const NEXT = '999.1.0';
const BUNDLE_ENTRY = '/opt/palmux/bin/palmux';

const makeRelease = (over: Partial<Release> = {}): Release => ({
  tag: `v${NEXT}`,
  prerelease: false,
  assets: [
    { name: 'palmux-linux-x64.tgz', url: 'https://rel/bundle' },
    { name: 'palmux-linux-x64.tgz.sha256', url: 'https://rel/sum' },
    { name: 'palmux-linux-x64.tgz.sig', url: 'https://rel/sig' },
  ],
  ...over,
});

const makeConfig = (over: Partial<SelfUpdateConfig> = {}): SelfUpdateConfig => ({
  ...DEFAULT_SELF_UPDATE,
  enabled: true,
  repo: 'jvpalma/palmux',
  publicKey: PUBLIC_PEM,
  ...over,
});

interface FakeOpts {
  release?: Release | null;
  sha256?: string;
  signature?: Buffer;
  health?: () => Promise<string>;
}

function makeDeps(opts: FakeOpts = {}) {
  const restore = vi.fn(async () => {});
  const deps = {
    fetchLatestRelease: vi.fn(async () =>
      opts.release === undefined ? makeRelease() : opts.release,
    ),
    download: vi.fn(async (url: string) => {
      if (url.endsWith('/sum')) return Buffer.from(`${opts.sha256 ?? SHA256}  palmux.tgz\n`);
      if (url.endsWith('/sig')) return opts.signature ?? SIGNATURE;
      return BUNDLE;
    }),
    stage: vi.fn(async () => ({ restore })),
    healthCheck: vi.fn(opts.health ?? (async () => NEXT)),
    notify: vi.fn(),
    now: vi.fn(() => 0),
  } satisfies UpdateDeps;
  return { deps, restore };
}

const stages = (deps: { notify: { mock: { calls: unknown[][] } } }): unknown[] =>
  deps.notify.mock.calls.map((c) => c[0]);

describe('isSourceDeployment', () => {
  it('is true for a .ts entry (tsx) and false for the bundle', () => {
    expect(isSourceDeployment('/home/u/palmux/packages/server/src/index.ts')).toBe(true);
    expect(isSourceDeployment('/home/u/palmux/src/index.mts')).toBe(true);
    expect(isSourceDeployment(BUNDLE_ENTRY)).toBe(false);
    expect(isSourceDeployment('/opt/palmux/bin/palmux.js')).toBe(false);
  });
});

describe('pickRelease', () => {
  it('ignores prereleases on the stable channel and accepts them on prerelease', () => {
    const pre = makeRelease({ prerelease: true });
    expect(pickRelease(pre, 'stable', '1.0.0')).toBeNull();
    expect(pickRelease(pre, 'prerelease', '1.0.0')).toBe(pre);
  });

  it('returns null for an equal or older tag, ignoring build metadata', () => {
    expect(pickRelease(makeRelease({ tag: 'v2.0.0' }), 'stable', '2.0.0+ab12cd3')).toBeNull();
    expect(pickRelease(makeRelease({ tag: 'v1.9.9' }), 'stable', '2.0.0')).toBeNull();
    expect(pickRelease(null, 'stable', '2.0.0')).toBeNull();
  });

  it('returns a newer release', () => {
    const rel = makeRelease({ tag: 'v2.1.0' });
    expect(pickRelease(rel, 'stable', '2.0.0+ab12cd3')).toBe(rel);
  });
});

describe('verifyBundle', () => {
  const base = { bundle: BUNDLE, sha256: SHA256, signature: SIGNATURE, publicKey: PUBLIC_PEM };

  it('accepts a matching checksum and a valid signature', () => {
    expect(verifyBundle(base)).toEqual({ ok: true });
  });

  it('rejects a bad checksum before looking at the signature', () => {
    expect(verifyBundle({ ...base, sha256: 'aa'.repeat(32) })).toEqual({
      ok: false,
      reason: 'checksum',
    });
    expect(verifyBundle({ ...base, sha256: 'short' })).toEqual({ ok: false, reason: 'checksum' });
  });

  it('rejects a signature made by another key', () => {
    expect(verifyBundle({ ...base, publicKey: OTHER_PEM })).toEqual({
      ok: false,
      reason: 'signature',
    });
    expect(verifyBundle({ ...base, signature: Buffer.alloc(64) })).toEqual({
      ok: false,
      reason: 'signature',
    });
  });

  it('reports an unusable public key', () => {
    expect(verifyBundle({ ...base, publicKey: 'not a pem' })).toEqual({ ok: false, reason: 'key' });
  });
});

describe('clampIntervalMs', () => {
  it('floors zero, negative, tiny and non-finite values at one hour', () => {
    expect(clampIntervalMs(0)).toBe(3_600_000);
    expect(clampIntervalMs(-5)).toBe(3_600_000);
    expect(clampIntervalMs(0.1)).toBe(3_600_000);
    expect(clampIntervalMs(Number.NaN)).toBe(3_600_000);
  });

  it('keeps a sane interval', () => {
    expect(clampIntervalMs(24)).toBe(24 * 3_600_000);
  });
});

describe('createUpdater', () => {
  it('does nothing while disabled (the default) — no release is even fetched', async () => {
    const { deps } = makeDeps();
    const updater = createUpdater(DEFAULT_SELF_UPDATE, deps, { entry: BUNDLE_ENTRY });
    await expect(updater.checkNow()).resolves.toBe('disabled');
    updater.start();
    updater.stop();
    expect(deps.fetchLatestRelease).not.toHaveBeenCalled();
    expect(deps.notify).not.toHaveBeenCalled();
  });

  it('is a no-op on a source deployment', async () => {
    const { deps } = makeDeps();
    const updater = createUpdater(makeConfig(), deps, { entry: '/src/index.ts' });
    await expect(updater.checkNow()).resolves.toBe('source-deployment');
    expect(deps.fetchLatestRelease).not.toHaveBeenCalled();
  });

  it('reports no-release when the repo has none', async () => {
    const { deps } = makeDeps({ release: null });
    const updater = createUpdater(makeConfig(), deps, { entry: BUNDLE_ENTRY });
    await expect(updater.checkNow()).resolves.toBe('no-release');
    expect(deps.download).not.toHaveBeenCalled();
  });

  it('reports up-to-date for an older release', async () => {
    const { deps } = makeDeps({ release: makeRelease({ tag: 'v0.0.1' }) });
    const updater = createUpdater(makeConfig(), deps, { entry: BUNDLE_ENTRY });
    await expect(updater.checkNow()).resolves.toBe('up-to-date');
    expect(deps.download).not.toHaveBeenCalled();
  });

  it('filters a prerelease out on the stable channel', async () => {
    const { deps } = makeDeps({ release: makeRelease({ prerelease: true }) });
    const updater = createUpdater(makeConfig({ channel: 'stable' }), deps, { entry: BUNDLE_ENTRY });
    await expect(updater.checkNow()).resolves.toBe('up-to-date');
    expect(deps.download).not.toHaveBeenCalled();
  });

  it('takes the same prerelease on the prerelease channel', async () => {
    const { deps } = makeDeps({ release: makeRelease({ prerelease: true }) });
    const updater = createUpdater(makeConfig({ channel: 'prerelease' }), deps, {
      entry: BUNDLE_ENTRY,
    });
    await expect(updater.checkNow()).resolves.toBe('staged');
  });

  it('rejects a checksum mismatch without staging', async () => {
    const { deps } = makeDeps({ sha256: 'bb'.repeat(32) });
    const updater = createUpdater(makeConfig(), deps, { entry: BUNDLE_ENTRY });
    await expect(updater.checkNow()).resolves.toBe('rejected-checksum');
    expect(deps.stage).not.toHaveBeenCalled();
    expect(stages(deps)).toEqual(['downloading', 'failed']);
  });

  it('rejects a signature mismatch without staging', async () => {
    const { deps } = makeDeps({ signature: signBytes(null, Buffer.from('other'), privateKey) });
    const updater = createUpdater(makeConfig(), deps, { entry: BUNDLE_ENTRY });
    await expect(updater.checkNow()).resolves.toBe('rejected-signature');
    expect(deps.stage).not.toHaveBeenCalled();
    expect(stages(deps)).toEqual(['downloading', 'failed']);
  });

  it('rejects a release missing its integrity assets', async () => {
    const bundleOnly = makeRelease({ assets: [{ name: 'palmux.tgz', url: 'https://rel/bundle' }] });
    const { deps } = makeDeps({ release: bundleOnly });
    const updater = createUpdater(makeConfig(), deps, { entry: BUNDLE_ENTRY });
    await expect(updater.checkNow()).resolves.toBe('rejected-checksum');
    expect(deps.download).not.toHaveBeenCalled();
    expect(deps.stage).not.toHaveBeenCalled();
  });

  it('stages a verified bundle and announces every stage', async () => {
    const { deps } = makeDeps();
    const updater = createUpdater(makeConfig(), deps, { entry: BUNDLE_ENTRY });
    await expect(updater.checkNow()).resolves.toBe('staged');
    expect(deps.stage).toHaveBeenCalledWith(BUNDLE, NEXT);
    expect(stages(deps)).toEqual(['downloading', 'staging', 'restarting']);
  });

  it('rolls back when the health-check throws', async () => {
    const { deps, restore } = makeDeps({
      health: async () => {
        throw new Error('staged bundle will not start');
      },
    });
    const updater = createUpdater(makeConfig(), deps, { entry: BUNDLE_ENTRY });
    await expect(updater.checkNow()).resolves.toBe('rolled-back');
    expect(restore).toHaveBeenCalledTimes(1);
    expect(stages(deps)).toEqual(['downloading', 'staging', 'failed']);
  });

  it('rolls back when the health-check reports the wrong version', async () => {
    const { deps, restore } = makeDeps({ health: async () => '1.2.3' });
    const updater = createUpdater(makeConfig(), deps, { entry: BUNDLE_ENTRY });
    await expect(updater.checkNow()).resolves.toBe('rolled-back');
    expect(restore).toHaveBeenCalledTimes(1);
  });

  it('surfaces a transport failure as error', async () => {
    const { deps } = makeDeps();
    deps.download.mockRejectedValueOnce(new Error('connection reset'));
    const updater = createUpdater(makeConfig(), deps, { entry: BUNDLE_ENTRY });
    await expect(updater.checkNow()).resolves.toBe('error');
    expect(deps.stage).not.toHaveBeenCalled();
  });
});
