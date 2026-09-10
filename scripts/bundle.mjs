#!/usr/bin/env node
// ── palmux — self-contained runtime bundler ───────────────────────────────────
//
// Produces a ready-to-run runtime under bin/ that needs ONLY Node (>= 22) on the
// target — no yarn, no build step, no toolchain:
//
//   bin/palmux.mjs            single ESM server bundle (fastify/ws/fontkit/… inlined)
//   bin/build/Release/pty.node  the node-pty native addon (dynamically required at boot;
//                               node-pty checks ./build/Release when bundled)
//   bin/client/               the built web client (served via PALMUX_CLIENT_DIR)
//   bin/palmux                launcher: sets PALMUX_CLIENT_DIR and runs the bundle
//
// Run it on a build machine of the SAME os/arch as the target (the .node is
// native). Commit bin/ to master:  git add -f bin  (bin/build is under a
// gitignored name, so force-add once; tracked files stay tracked after).
//
//   node scripts/bundle.mjs

import { build } from 'esbuild';
import { execSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bin = join(repo, 'bin');
const ptyRoot = join(repo, 'node_modules', 'node-pty');
const nativeSrc = join(ptyRoot, 'build', 'Release', 'pty.node');
const clientDist = join(repo, 'packages', 'client', 'dist');

const log = (m) => console.log(`\x1b[36m[bundle]\x1b[0m ${m}`);

// 0. Clean slate.
rmSync(bin, { recursive: true, force: true });
mkdirSync(bin, { recursive: true });

// 1. Build the web client (Vite) so bin/client is fresh.
log('building web client (vite)…');
execSync('yarn workspace @palmux/client build', { cwd: repo, stdio: 'inherit' });
cpSync(clientDist, join(bin, 'client'), { recursive: true });

// 2. Bundle the server to a single ESM file. node-pty's JS is inlined; its
//    native .node is required dynamically at runtime (kept out of the bundle).
//    The banner gives the ESM bundle a `require` resolving next to the file, so
//    node-pty finds ./build/Release/pty.node.
log('bundling server (esbuild)…');
await build({
  entryPoints: [join(repo, 'packages', 'server', 'src', 'index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: join(bin, 'palmux.mjs'),
  // ESM has no require/__dirname/__filename, but the inlined node-pty CJS needs
  // all three (require to load ./build/Release/pty.node, __dirname to resolve its
  // spawn-helper path). Recreate them relative to this bundle file.
  banner: {
    js: [
      "import{createRequire as __pcr}from'module';",
      "import{fileURLToPath as __pfu}from'url';",
      "import{dirname as __pdn}from'path';",
      'const require=__pcr(import.meta.url);',
      'const __filename=__pfu(import.meta.url);',
      'const __dirname=__pdn(__filename);',
    ].join(''),
  },
  logLevel: 'info',
});

// 3. Vendor the native addon where node-pty looks for it when bundled.
log('vendoring node-pty native addon…');
mkdirSync(join(bin, 'build', 'Release'), { recursive: true });
cpSync(nativeSrc, join(bin, 'build', 'Release', 'pty.node'));

// 4. Launcher.
const launcher = `#!/usr/bin/env sh
# palmux self-contained runtime. Only needs Node >= 22 on PATH.
# Honors PALMUX_PORT / PALMUX_HOST / PALMUX_NO_AUTH / PALMUX_CONFIG_DIR (see README).
set -eu
DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
export PALMUX_CLIENT_DIR="\${PALMUX_CLIENT_DIR:-$DIR/client}"
exec "\${PALMUX_NODE:-node}" "$DIR/palmux.mjs" "$@"
`;
writeFileSync(join(bin, 'palmux'), launcher);
chmodSync(join(bin, 'palmux'), 0o755);

log('done → bin/ (run: ./bin/palmux  |  commit: git add -f bin)');
