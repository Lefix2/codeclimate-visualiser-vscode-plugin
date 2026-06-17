#!/usr/bin/env node
'use strict';

// Build a .vsix whose version is derived from git: <last-tag>[-g<hash>][-dirty].
//  - exactly on a tag, clean tree      → 1.4.0
//  - commits after the tag             → 1.4.0-gabc1234
//  - uncommitted changes               → 1.4.0-gabc1234-dirty (or 1.4.0-dirty when on the tag)
// vsce reads `version` from package.json, so we set it, package, then restore the original.

const fs = require('fs');
const path = require('path');
const { execSync, execFileSync } = require('child_process');

const pkgPath = path.join(__dirname, '..', 'package.json');

function git(args) {
  // Ignore stderr — probes like `describe --exact-match` are expected to fail off-tag.
  return execSync(`git ${args}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function computeVersion(fallback) {
  let base = fallback;
  try {
    base = git('describe --tags --abbrev=0').replace(/^v/, '');
  } catch {
    // no tags yet — fall back to the version already in package.json
  }

  let onTag = false;
  try { git('describe --tags --exact-match'); onTag = true; } catch { /* off-tag */ }

  const dirty = git('status --porcelain') !== '';

  let suffix = '';
  if (!onTag) suffix += `-g${git('rev-parse --short HEAD')}`;
  if (dirty) suffix += '-dirty';

  return base + suffix;
}

const original = fs.readFileSync(pkgPath, 'utf8');
const pkg = JSON.parse(original);
const version = computeVersion(pkg.version);

console.log(`Packaging version ${version}`);
fs.writeFileSync(pkgPath, JSON.stringify({ ...pkg, version }, null, 2) + '\n');

try {
  // Pass extra CLI args through (e.g. --out, --pre-release).
  execFileSync('npx', ['vsce', 'package', ...process.argv.slice(2)], { stdio: 'inherit' });
} finally {
  fs.writeFileSync(pkgPath, original);
}
