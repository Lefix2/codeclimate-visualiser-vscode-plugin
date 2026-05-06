#!/usr/bin/env node
'use strict';
// Grep for "error" keyword in src/ and emit a CodeClimate-format JSON report.
// Run from workspace root (testdata/): node scripts/grep-errors.js

const { execSync } = require('child_process');
const { createHash } = require('crypto');
const fs = require('fs');

const OUTPUT = 'reports/grep-report.json';
const EXTS = ['ts', 'js', 'c', 'h', 'rb', 'py', 'go', 'java'];
const INCLUDE_FLAGS = EXTS.map(e => `--include="*.${e}"`).join(' ');

let raw = '';
try {
  raw = execSync(`grep -rn -i ${INCLUDE_FLAGS} "error" src/ 2>/dev/null`, {
    encoding: 'utf-8',
    shell: true,
  });
} catch (e) {
  // grep exits 1 when no matches — that's fine
  raw = e.stdout ?? '';
}

const issues = [];
for (const line of raw.split('\n')) {
  const m = line.match(/^([^:]+):(\d+):(.*)$/);
  if (!m) continue;
  const [, filePath, lineno, text] = m;
  const fp = createHash('md5').update(`${filePath}:${lineno}`).digest('hex');
  issues.push({
    type: 'issue',
    check_name: 'grep/error-keyword',
    description: `Found "error": ${text.trim().slice(0, 150)}`,
    categories: ['Bug Risk'],
    location: { path: filePath, lines: { begin: parseInt(lineno, 10) } },
    severity: 'minor',
    fingerprint: fp,
  });
}

fs.mkdirSync('reports', { recursive: true });
fs.writeFileSync(OUTPUT, JSON.stringify(issues, null, 2));
console.log(`grep-errors: ${issues.length} issue(s) written to ${OUTPUT}`);
