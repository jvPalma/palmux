// ── Pre-compressed build artifacts ────────────────────────────────────────────
//
// Writes `.gz` and `.br` siblings next to every compressible file in `dist/`,
// so `@fastify/static`'s `preCompressed` can serve them by `Accept-Encoding`.
//
// Measured against the built bundle before this existed: `GET /assets/index-*.js`
// answered **962 KB with no `content-encoding` at all**, with `Accept-Encoding:
// gzip, deflate, br` on the request. Across all assets it is 5.14 MB → 1.38 MB.
//
// Compressing at BUILD time rather than per request is the whole point: brotli
// at maximum quality is far too slow to run on the fly, and these files never
// change — the hash in their name says so.
//
// No new dependency: `node:zlib` has both codecs, which is the same reasoning
// `download.ts` already uses for its zip writer.

import { createReadStream, createWriteStream, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip, createBrotliCompress, constants } from 'node:zlib';
import type { Plugin } from 'vite';

/**
 * Extensions worth compressing. Everything absent is either already compressed
 * (woff2 is brotli inside, png/jpg/webp are their own codecs) or too small for
 * the two extra files to pay for themselves.
 */
const COMPRESSIBLE = new Set([
  '.js',
  '.mjs',
  '.css',
  '.html',
  '.json',
  '.svg',
  '.map',
  '.txt',
  '.webmanifest',
]);

/**
 * Below this, the sibling files cost more than they save — a 500-byte SVG gzips
 * to ~300 and then costs a stat on every request that asks for it.
 */
const MIN_BYTES = 1024;

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile()) yield path;
  }
}

export interface PrecompressResult {
  files: number;
  raw: number;
  gzip: number;
  brotli: number;
}

/** Compress every eligible file under `dir`, in place. Returns the totals. */
export async function precompressDir(dir: string): Promise<PrecompressResult> {
  const out: PrecompressResult = { files: 0, raw: 0, gzip: 0, brotli: 0 };
  for await (const path of walk(dir)) {
    if (path.endsWith('.gz') || path.endsWith('.br')) continue;
    if (!COMPRESSIBLE.has(extname(path))) continue;
    const size = statSync(path).size;
    if (size < MIN_BYTES) continue;

    await pipeline(createReadStream(path), createGzip({ level: 9 }), createWriteStream(`${path}.gz`));
    await pipeline(
      createReadStream(path),
      createBrotliCompress({
        params: {
          [constants.BROTLI_PARAM_QUALITY]: 11,
          [constants.BROTLI_PARAM_SIZE_HINT]: size,
        },
      }),
      createWriteStream(`${path}.br`),
    );

    out.files++;
    out.raw += size;
    out.gzip += statSync(`${path}.gz`).size;
    out.brotli += statSync(`${path}.br`).size;
  }
  return out;
}

const mb = (n: number): string => `${(n / 1024 / 1024).toFixed(2)} MB`;

export function precompress(): Plugin {
  let outDir = 'dist';
  return {
    name: 'palmux-precompress',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir;
    },
    // closeBundle, not writeBundle: every emitted file (and everything copied
    // out of public/) is on disk by then, which is what the walk depends on.
    async closeBundle() {
      const r = await precompressDir(outDir);
      // eslint-disable-next-line no-console -- build output, same channel as Vite's own
      console.log(
        `precompress: ${r.files} files · ${mb(r.raw)} raw → ${mb(r.gzip)} gzip · ${mb(r.brotli)} brotli`,
      );
    },
  };
}
