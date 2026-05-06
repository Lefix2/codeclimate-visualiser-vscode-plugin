#!/usr/bin/env node
// Generates 10 realistic test snapshots in testdata history file.
// Run before debug session to populate Trends view for manual testing.
'use strict';
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const HISTORY_PATH = path.join(__dirname, '..', 'testdata', '.vscode', 'codeclimate-visualiser.history.ndjson');

const SEV_MAP = {
  'sg-sqli-001': 'blocker',  'sg-sqli-002': 'blocker',  'sg-secret-001': 'blocker',
  'sg-crypto-001': 'critical','sg-cred-001': 'critical', 'sg-token-001': 'critical',
  'sg-auth-001': 'critical',  'sg-bo-001': 'critical',   'sg-bo-002': 'critical',
  'sg-io-001': 'critical',    'sg-uaf-001': 'critical',  'sg-xss-001': 'critical',
  'sg-ssrf-001': 'critical',  'sg-path-001': 'major',
  'cp-bo-001': 'major',  'cp-null-001': 'major',  'cp-dbz-001': 'major',
  'cp-global-001': 'major',   'cp-bo-002': 'major',      'cp-uaf-001': 'major',
  'cp-ec-001': 'major',  'cp-global-002': 'major', 'cp-arr-001': 'major',
  'cp-fsb-001': 'major', 'cp-ptr-001': 'minor',    'cp-magic-001': 'info',
  'cp-io-001': 'minor',  'cp-race-001': 'major',   'cp-leak-001': 'major',
  'eslint-no-var-001': 'minor',    'eslint-no-any-001': 'minor',
  'eslint-eqeqeq-001': 'minor',   'eslint-no-any-002': 'minor',
  'eslint-returntype-001': 'minor','eslint-complexity-001': 'major',
  'eslint-console-001': 'info',    'eslint-fp-001': 'minor',
  'eslint-no-any-003': 'minor',    'eslint-unused-001': 'info',
  'eslint-sql-001': 'major',       'eslint-sql-002': 'major',
  'eslint-async-001': 'minor',
};

// Stable core fingerprints present in all snapshots
const CORE = [
  'sg-sqli-001','sg-sqli-002','sg-secret-001','sg-crypto-001','sg-cred-001',
  'sg-token-001','sg-bo-002','sg-io-001',
  'cp-bo-001','cp-null-001','cp-dbz-001','cp-global-001','cp-uaf-001','cp-ec-001',
  'cp-global-002','cp-arr-001','cp-fsb-001','cp-magic-001','cp-io-001',
  'eslint-no-var-001','eslint-no-any-001','eslint-eqeqeq-001','eslint-complexity-001',
  'eslint-sql-001','eslint-sql-002',
];

// Each snapshot: weeks ago + label + extra fingerprints beyond core
const CONFIGS = [
  { w: 11, label: 'v0.8.0', extra: [] },
  { w:  9, label: '',       extra: ['eslint-no-any-002','eslint-returntype-001','cp-bo-002'] },
  { w:  8, label: 'v0.9.0', extra: ['eslint-no-any-002','eslint-returntype-001','cp-bo-002','sg-uaf-001','cp-ptr-001'] },
  { w:  7, label: '',       extra: ['eslint-no-any-002','cp-bo-002','sg-uaf-001'] },
  { w:  6, label: '',       extra: ['eslint-no-any-002','cp-bo-002','sg-uaf-001','sg-path-001','cp-race-001'] },
  { w:  5, label: 'v1.0.0', extra: ['eslint-no-any-002','eslint-returntype-001','eslint-fp-001','cp-bo-002','sg-uaf-001','sg-auth-001','sg-bo-001','cp-ptr-001'] },
  { w:  4, label: '',       extra: ['eslint-no-any-002','eslint-returntype-001','eslint-fp-001','cp-bo-002','sg-uaf-001','sg-auth-001','sg-bo-001','cp-ptr-001','eslint-async-001'] },
  { w:  3, label: '',       extra: ['eslint-no-any-002','eslint-fp-001','cp-bo-002','sg-uaf-001','sg-auth-001','sg-bo-001'] },
  { w:  2, label: 'v1.1.0', extra: ['eslint-no-any-002','eslint-returntype-001','eslint-fp-001','eslint-no-any-003','cp-bo-002','sg-uaf-001','sg-auth-001','sg-bo-001','cp-ptr-001','cp-leak-001','eslint-unused-001'] },
  { w:  1, label: '',       extra: ['eslint-no-any-002','eslint-returntype-001','eslint-fp-001','eslint-no-any-003','cp-bo-002','sg-uaf-001','sg-auth-001','sg-bo-001','cp-ptr-001'] },
];

const now   = Date.now();
const WEEK  = 7 * 24 * 60 * 60 * 1000;

const lines = CONFIGS.map(cfg => {
  const fps = [...new Set([...CORE, ...cfg.extra])];
  const counts = { blocker: 0, critical: 0, major: 0, minor: 0, info: 0 };
  for (const fp of fps) counts[SEV_MAP[fp] ?? 'info']++;
  const snap = {
    id: crypto.randomUUID(),
    timestamp: new Date(now - cfg.w * WEEK).toISOString(),
    ...(cfg.label ? { label: cfg.label } : {}),
    sources: ['eslint-report.json', 'semgrep-report.json', 'codeparser-report.json'],
    counts,
    total: fps.length,
    nativeCount: fps.length,
    derivedCount: 0,
    volatileCount: 0,
    fingerprints: fps,
  };
  return JSON.stringify(snap);
});

fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true });
fs.writeFileSync(HISTORY_PATH, lines.join('\n') + '\n', 'utf-8');
console.log(`✓ ${lines.length} test snapshots → ${path.relative(process.cwd(), HISTORY_PATH)}`);
