// End-to-end self-update against a LOCAL fake release server.
//
// self-update.test.ts covers the policy with injected fakes; this file exercises
// the real plumbing — a real HTTP fetch, a real .tar.gz, a real Ed25519 signature,
// a real directory swap and a real `--version` health-check on a spawned process.
// It never touches the network: the release API is served from 127.0.0.1.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUpdater } from './self-update';
import { createUpdateDeps } from './self-update-runtime';
import { DEFAULT_SELF_UPDATE } from './app-config';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();

let root: string;
let server: Server;
let base: string;
/** Served assets, keyed by URL path. */
const assets = new Map<string, Buffer>();
let releaseTag = 'v9.9.0';

/** A stand-in bundle: one executable that prints the version it claims to be. */
function makeBundle(reportedVersion: string): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'palmux-mkbundle-'));
  mkdirSync(join(dir, 'bin'));
  const exe = join(dir, 'bin', 'palmux');
  writeFileSync(exe, `#!/bin/sh\necho ${reportedVersion}\n`);
  chmodSync(exe, 0o755);
  execFileSync('tar', ['-czf', join(dir, 'b.tar.gz'), '-C', dir, 'bin']);
  const buf = readFileSync(join(dir, 'b.tar.gz'));
  rmSync(dir, { recursive: true, force: true });
  return buf;
}

/** Publish a bundle as a release, optionally corrupting one integrity input. */
function publish(reportedVersion: string, tamper?: 'bundle' | 'signature'): void {
  let bundle = makeBundle(reportedVersion);
  const signature = cryptoSign(null, bundle, privateKey);
  const digest = createHash('sha256').update(bundle).digest('hex');
  if (tamper === 'bundle') bundle = Buffer.concat([bundle, Buffer.from('x')]);
  assets.set('/dl/bundle.tar.gz', bundle);
  assets.set('/dl/bundle.tar.gz.sha256', Buffer.from(`${digest}  bundle.tar.gz\n`));
  assets.set(
    '/dl/bundle.tar.gz.sig',
    tamper === 'signature' ? Buffer.from(signature).fill(0) : signature,
  );
}

const liveExe = (): string => join(root, 'bin', 'palmux');
const runLive = (): string => execFileSync(liveExe(), ['--version']).toString().trim();

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'palmux-update-e2e-'));
  mkdirSync(join(root, 'bin'));
  writeFileSync(liveExe(), '#!/bin/sh\necho 1.0.0\n');
  chmodSync(liveExe(), 0o755);

  server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0] ?? '';
    if (path.endsWith('/releases')) {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify([
          {
            tag_name: releaseTag,
            prerelease: false,
            draft: false,
            assets: [...assets.keys()].map((p) => ({
              name: p.slice(p.lastIndexOf('/') + 1),
              browser_download_url: `${base}${p}`,
            })),
          },
        ]),
      );
      return;
    }
    const body = assets.get(path);
    if (!body) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? String(addr.port) : '0'}`;
});

afterAll(() => {
  server.close();
  rmSync(root, { recursive: true, force: true });
});

const updaterFor = () =>
  createUpdater(
    { ...DEFAULT_SELF_UPDATE, enabled: true, repo: 'o/r', publicKey: PUBLIC_PEM },
    createUpdateDeps({
      repo: 'o/r',
      bundleDir: join(root, 'bin'),
      apiBase: base,
      notify: () => {},
    }),
    // A .ts entry would (correctly) short-circuit as a source deployment.
    { entry: join(root, 'bin', 'palmux') },
  );

describe('self-update end-to-end against a local release server', () => {
  it('verifies, stages and swaps the bundle, retaining the previous one', async () => {
    publish('9.9.0');
    expect(runLive()).toBe('1.0.0');

    const outcome = await updaterFor().checkNow();

    expect(outcome).toBe('staged');
    expect(runLive()).toBe('9.9.0'); // the live bundle really was replaced
    expect(
      execFileSync(join(root, 'bin.prev', 'palmux'), ['--version'])
        .toString()
        .trim(),
    ).toBe('1.0.0'); // and the previous one is retained for rollback
  }, 30000);

  it('rolls back when the staged bundle fails its health-check', async () => {
    // Tag says 9.9.0 but the binary reports something else — exactly the
    // "shipped the wrong artifact" case rollback exists for.
    publish('0.0.7');
    const before = runLive();

    const outcome = await updaterFor().checkNow();

    expect(outcome).toBe('rolled-back');
    expect(runLive()).toBe(before); // restored, not left broken
  }, 30000);

  it('rejects a tampered bundle without touching the live install', async () => {
    publish('9.9.0', 'bundle');
    const before = runLive();

    const outcome = await updaterFor().checkNow();

    expect(outcome).toBe('rejected-checksum');
    expect(runLive()).toBe(before);
  }, 30000);

  it('rejects a bad signature even when the checksum matches', async () => {
    publish('9.9.0', 'signature');
    const before = runLive();

    const outcome = await updaterFor().checkNow();

    expect(outcome).toBe('rejected-signature');
    expect(runLive()).toBe(before);
  }, 30000);

  it('is up-to-date when the release is not newer than the running version', async () => {
    releaseTag = 'v0.0.1';
    publish('0.0.1');
    const before = runLive();

    const outcome = await updaterFor().checkNow();

    releaseTag = 'v9.9.0';
    expect(outcome).toBe('up-to-date');
    expect(runLive()).toBe(before);
    expect(existsSync(join(root, 'bin', 'palmux'))).toBe(true);
  }, 30000);
});
