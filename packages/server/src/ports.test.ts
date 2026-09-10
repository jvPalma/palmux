// The /proc/net/tcp reader: LISTEN + own-uid filtering, the single-pass
// inode→pid walk, dual-stack dedup, the non-Linux answer, and the 2s cache.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_APP_CONFIG, type AppConfig } from './app-config';
import { buildInodeOwners, clearPortsCache, getPorts, listPorts, parseProcNetTcp } from './ports';
import { createServer, createSessionRegistry } from './server';
import { memoryTabsStore } from './tabs-store';

const secret = 'a'.repeat(64);
const uid = process.getuid?.() ?? 0;

/** One /proc/net/tcp row in the kernel's exact column layout. */
const row = (sl: number, hexPort: string, state: string, owner: number, inode: string): string =>
  `  ${sl}: 0100007F:${hexPort} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000` +
  `  ${owner}        0 ${inode} 1 0000000000000000 100 0 0 10 0`;

const HEADER =
  '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';

describe('parseProcNetTcp', () => {
  it('keeps LISTEN rows for our uid only, decoding the hex port', () => {
    const text = [
      HEADER,
      row(0, 'AC0A', '0A', uid, '111'), // 44042, ours, LISTEN
      row(1, 'BB8', '0A', uid, '112'), // malformed-length port still parses
      row(2, '1F90', '01', uid, '113'), // ESTABLISHED — not a listener
      row(3, '2328', '0A', uid + 1, '114'), // another user
      '',
    ].join('\n');
    expect(parseProcNetTcp(text, uid)).toEqual([
      { port: 0xac0a, inode: '111' },
      { port: 0x0bb8, inode: '112' },
    ]);
  });

  it('reads the port off a v6 address (32 hex digits before the colon)', () => {
    const text = [
      HEADER,
      '   0: 00000000000000000000000000000000:1F90 00000000000000000000000000000000:0000 0A ' +
        `00000000:00000000 00:00000000 00000000  ${uid}        0 900 1 0000 100 0 0 10 0`,
      '',
    ].join('\n');
    expect(parseProcNetTcp(text, uid)).toEqual([{ port: 8080, inode: '900' }]);
  });

  it('ignores the header and any short/blank line', () => {
    expect(parseProcNetTcp(`${HEADER}\n\n   junk\n`, uid)).toEqual([]);
  });
});

describe('buildInodeOwners', () => {
  let procRoot: string;

  beforeAll(() => {
    procRoot = mkdtempSync(join(tmpdir(), 'palmux-proc-'));
    for (const [pid, inode] of [
      ['4242', '111'],
      ['4343', '112'],
    ] as const) {
      mkdirSync(join(procRoot, pid, 'fd'), { recursive: true });
      writeFileSync(join(procRoot, pid, 'comm'), `proc-${pid}\n`);
      // A dangling symlink is exactly what /proc/<pid>/fd holds; readlink still
      // returns the target text, which is all the resolver reads.
      symlinkSync(`socket:[${inode}]`, join(procRoot, pid, 'fd', '3'));
      symlinkSync('/dev/null', join(procRoot, pid, 'fd', '0'));
    }
    // Noise the walk must skip: a non-numeric /proc entry and an unreadable fd dir.
    mkdirSync(join(procRoot, 'self'), { recursive: true });
    mkdirSync(join(procRoot, 'net'), { recursive: true });
  });
  afterAll(() => rmSync(procRoot, { recursive: true, force: true }));

  it('maps every requested inode to its holder', async () => {
    const owners = await buildInodeOwners(new Set(['111', '112']), procRoot);
    expect(owners.get('111')).toBe(4242);
    expect(owners.get('112')).toBe(4343);
  });

  it('does no work at all for an empty inode set', async () => {
    expect((await buildInodeOwners(new Set(), '/nonexistent-proc')).size).toBe(0);
  });

  it('returns an empty map rather than throwing on an unreadable /proc', async () => {
    expect((await buildInodeOwners(new Set(['1']), '/nonexistent-proc')).size).toBe(0);
  });
});

describe('listPorts', () => {
  let procRoot: string;

  beforeAll(() => {
    procRoot = mkdtempSync(join(tmpdir(), 'palmux-ports-'));
    mkdirSync(join(procRoot, 'net'), { recursive: true });
    writeFileSync(
      join(procRoot, 'net', 'tcp'),
      [
        HEADER,
        row(0, 'AC0A', '0A', uid, '111'), // 44042 → pid 4242
        row(1, '1F90', '0A', uid, '999'), // 8080, owner unresolvable
        '',
      ].join('\n'),
    );
    // The SAME listener as inode 111, seen again on the v6 table: one entry.
    writeFileSync(
      join(procRoot, 'net', 'tcp6'),
      [
        HEADER,
        '   0: 00000000000000000000000000000000:AC0A 00000000000000000000000000000000:0000 0A ' +
          `00000000:00000000 00:00000000 00000000  ${uid}        0 111 1 0000 100 0 0 10 0`,
        '',
      ].join('\n'),
    );
    mkdirSync(join(procRoot, '4242', 'fd'), { recursive: true });
    writeFileSync(join(procRoot, '4242', 'comm'), 'vite\n');
    symlinkSync('socket:[111]', join(procRoot, '4242', 'fd', '3'));
  });
  afterAll(() => rmSync(procRoot, { recursive: true, force: true }));

  it('resolves owners, dedups dual-stack, and sorts by port', async () => {
    expect(await listPorts(procRoot)).toEqual({
      available: true,
      ports: [
        { port: 8080, pid: 0, process: '' },
        { port: 44042, pid: 4242, process: 'vite' },
      ],
    });
  });

  it('answers available:false when there is no /proc/net/tcp', async () => {
    expect(await listPorts('/nonexistent-proc')).toEqual({ available: false, ports: [] });
  });
});

describe('getPorts cache', () => {
  afterEach(() => clearPortsCache());

  it('returns the identical object within the window and shares an in-flight scan', async () => {
    clearPortsCache();
    const [a, b] = await Promise.all([getPorts(), getPorts()]);
    expect(a).toBe(b);
    expect(await getPorts()).toBe(a);
    clearPortsCache();
    expect(await getPorts()).not.toBe(a);
  });
});

describe('GET /ports', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const cfg: AppConfig = { ...DEFAULT_APP_CONFIG, fontDirs: [], auth: false };
    app = await createServer(cfg, secret, createSessionRegistry(cfg, memoryTabsStore()));
  });
  afterAll(async () => {
    await app.close();
    clearPortsCache();
  });

  it('answers the listing shape', async () => {
    const res = await app.inject({ method: 'GET', url: '/ports' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body['available']).toBe('boolean');
    expect(Array.isArray(body['ports'])).toBe(true);
    for (const entry of body['ports'] as Array<Record<string, unknown>>) {
      expect(typeof entry['port']).toBe('number');
      expect(typeof entry['pid']).toBe('number');
      expect(typeof entry['process']).toBe('string');
    }
  });
});
