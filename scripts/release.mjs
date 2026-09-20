#!/usr/bin/env node
// ── palmux — release: one command bumps the version everywhere ───────────────
//
// The root package.json `version` is the single source of truth. This script
// propagates it to the three workspace package.jsons (the server reads its own
// at runtime, the bundle reads the root's), then commits and tags. Pushing the
// tag fires .github/workflows/release.yml, which builds the bundle and creates
// the GitHub release with generated notes.
//
//   yarn release patch | minor | major | <x.y.z>
//   yarn release 1.0.0 --no-git   # bump the files only, print the git commands
//
// The commit/tag run only when YOU run this script. --no-git exists so the bump
// can be verified (and the release prepared) without touching git.

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const PKG_FILES = [
  'package.json',
  'packages/shared/package.json',
  'packages/server/package.json',
  'packages/client/package.json',
];
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

const usage = () => {
  console.error('usage: yarn release <patch|minor|major|<x.y.z>> [--no-git]');
  process.exit(1);
};

const readRootVersion = () => {
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  const m = SEMVER.exec(String(pkg.version ?? ''));
  if (!m) {
    console.error(`root package.json has no semver version (got ${JSON.stringify(pkg.version)})`);
    process.exit(1);
  }
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
};

const nextVersion = (current, arg) => {
  const m = SEMVER.exec(arg);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  if (arg === 'patch') return [current.major, current.minor, current.patch + 1];
  if (arg === 'minor') return [current.major, current.minor + 1, 0];
  if (arg === 'major') return [current.major + 1, 0, 0];
  usage();
};

const args = process.argv.slice(2);
const noGit = args.includes('--no-git');
const target = args.filter((a) => !a.startsWith('--'));
if (target.length !== 1) usage();

const current = readRootVersion();
const [major, minor, patch] = nextVersion(current, target[0]);
const version = `${major}.${minor}.${patch}`;

const before = current.major * 1e6 + current.minor * 1e3 + current.patch;
const after = major * 1e6 + minor * 1e3 + patch;
if (after < before) {
  console.warn(`⚠  downgrade: ${current.major}.${current.minor}.${current.patch} → ${version} (intentional reset?)`);
}

for (const file of PKG_FILES) {
  const path = join(repo, file);
  const pkg = JSON.parse(readFileSync(path, 'utf8'));
  pkg.version = version;
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`bumped ${file} → ${version}`);
}

const git = (args, label) => {
  console.log(`$ git ${args}`);
  try {
    execSync(`git ${args}`, { cwd: repo, stdio: 'inherit' });
  } catch {
    console.error(`✗ ${label} failed — run it by hand and finish the release.`);
    process.exit(1);
  }
};

const commit = `chore: release v${version}`;
if (noGit) {
  console.log('\n--no-git: files bumped, git left to you:');
  console.log(`  git add ${PKG_FILES.join(' ')}`);
  console.log(`  git commit -m "${commit}"`);
  console.log(`  git tag -a v${version} -m "palmux v${version}"`);
} else {
  git(`add ${PKG_FILES.join(' ')}`, 'git add');
  git(`commit -m "${commit}"`, 'git commit');
  git(`tag -a v${version} -m "palmux v${version}"`, 'git tag');
}

console.log(`\nv${version} ready. Publish with:`);
console.log('  git push origin master --follow-tags');
console.log('Pushing the tag builds the bundle in CI and creates the GitHub release.');
console.log('(bin/ is not rebuilt here — the workflow builds it from the tag.)');
