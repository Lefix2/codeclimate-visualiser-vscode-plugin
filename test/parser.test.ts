import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import { parseCodeClimateFile } from '../src/parser';

const TESTDATA_DIR = path.join(__dirname, '..', 'testdata', 'reports');

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    type: 'issue',
    check_name: 'test/Rule',
    description: 'A test issue',
    categories: ['Bug Risk'],
    location: { path: 'src/foo.rb', lines: { begin: 1, end: 1 } },
    severity: 'minor',
    ...overrides,
  };
}

describe('parseCodeClimateFile', () => {
  describe('JSON array format', () => {
    it('parses a valid array with one issue', () => {
      const content = JSON.stringify([makeIssue()]);
      const issues = parseCodeClimateFile(content);
      assert.strictEqual(issues.length, 1);
      assert.strictEqual(issues[0].check_name, 'test/Rule');
      assert.strictEqual(issues[0].severity, 'minor');
    });

    it('parses a valid array with multiple issues', () => {
      const content = JSON.stringify([
        makeIssue({ check_name: 'Rule/A' }),
        makeIssue({ check_name: 'Rule/B' }),
        makeIssue({ check_name: 'Rule/C' }),
      ]);
      const issues = parseCodeClimateFile(content);
      assert.strictEqual(issues.length, 3);
      assert.deepStrictEqual(
        issues.map((i) => i.check_name),
        ['Rule/A', 'Rule/B', 'Rule/C']
      );
    });

    it('returns empty array for an empty JSON array', () => {
      assert.deepStrictEqual(parseCodeClimateFile('[]'), []);
    });

    it('filters out entries missing type=issue', () => {
      const content = JSON.stringify([
        { type: 'coverage', value: 85 },
        makeIssue({ check_name: 'kept' }),
      ]);
      const issues = parseCodeClimateFile(content);
      assert.strictEqual(issues.length, 1);
      assert.strictEqual(issues[0].check_name, 'kept');
    });

    it('filters out entries missing check_name', () => {
      const content = JSON.stringify([
        { type: 'issue', description: 'no check_name', categories: [], location: { path: 'a.rb' } },
        makeIssue({ check_name: 'kept' }),
      ]);
      const issues = parseCodeClimateFile(content);
      assert.strictEqual(issues.length, 1);
    });

    it('filters out entries where check_name is not a string', () => {
      const content = JSON.stringify([
        { type: 'issue', check_name: 42, description: 'd', categories: [], location: { path: 'a.rb' } },
        makeIssue({ check_name: 'kept' }),
      ]);
      const issues = parseCodeClimateFile(content);
      assert.strictEqual(issues.length, 1);
    });

    it('preserves optional fields: fingerprint, severity, other_locations', () => {
      const content = JSON.stringify([
        makeIssue({
          severity: 'critical',
          fingerprint: 'abc123',
          other_locations: [{ path: 'other.rb', lines: { begin: 5, end: 5 } }],
        }),
      ]);
      const issues = parseCodeClimateFile(content);
      assert.strictEqual(issues[0].severity, 'critical');
      assert.strictEqual(issues[0].fingerprint, 'abc123');
      assert.strictEqual(issues[0].other_locations?.length, 1);
    });

    it('handles broken JSON gracefully by falling through to NDJSON', () => {
      const issues = parseCodeClimateFile('[{broken');
      assert.deepStrictEqual(issues, []);
    });
  });

  describe('NDJSON format', () => {
    it('parses valid NDJSON with multiple lines', () => {
      const lines = [
        JSON.stringify(makeIssue({ check_name: 'Rule/A' })),
        JSON.stringify(makeIssue({ check_name: 'Rule/B' })),
      ].join('\n');
      const issues = parseCodeClimateFile(lines);
      assert.strictEqual(issues.length, 2);
      assert.strictEqual(issues[0].check_name, 'Rule/A');
      assert.strictEqual(issues[1].check_name, 'Rule/B');
    });

    it('skips non-JSON lines', () => {
      const content = [
        'not valid json at all',
        JSON.stringify(makeIssue({ check_name: 'kept' })),
        '{broken}',
      ].join('\n');
      const issues = parseCodeClimateFile(content);
      assert.strictEqual(issues.length, 1);
      assert.strictEqual(issues[0].check_name, 'kept');
    });

    it('skips blank lines', () => {
      const content = [
        '',
        JSON.stringify(makeIssue({ check_name: 'kept' })),
        '   ',
      ].join('\n');
      const issues = parseCodeClimateFile(content);
      assert.strictEqual(issues.length, 1);
    });

    it('skips non-issue NDJSON objects', () => {
      const content = [
        JSON.stringify({ type: 'header', version: '2.0' }),
        JSON.stringify(makeIssue({ check_name: 'kept' })),
      ].join('\n');
      const issues = parseCodeClimateFile(content);
      assert.strictEqual(issues.length, 1);
    });

    it('supports {line, column} LineRef format in locations', () => {
      const content = JSON.stringify(
        makeIssue({
          location: {
            path: 'src/foo.c',
            lines: { begin: { line: 10, column: 5 }, end: { line: 10, column: 20 } },
          },
        })
      );
      const issues = parseCodeClimateFile(content);
      assert.strictEqual(issues.length, 1);
      const begin = issues[0].location.lines?.begin;
      assert.deepStrictEqual(begin, { line: 10, column: 5 });
    });
  });

  describe('edge cases', () => {
    it('returns empty array for empty string', () => {
      assert.deepStrictEqual(parseCodeClimateFile(''), []);
    });

    it('returns empty array for whitespace-only string', () => {
      assert.deepStrictEqual(parseCodeClimateFile('   \n  \t  '), []);
    });

    it('parses a single JSON object as NDJSON (single-line)', () => {
      // A single JSON object on one line is valid single-entry NDJSON
      const issues = parseCodeClimateFile(JSON.stringify(makeIssue()));
      assert.strictEqual(issues.length, 1);
    });

    it('handles all severity levels', () => {
      const severities = ['info', 'minor', 'major', 'critical', 'blocker'] as const;
      for (const severity of severities) {
        const content = JSON.stringify([makeIssue({ severity })]);
        const issues = parseCodeClimateFile(content);
        assert.strictEqual(issues[0].severity, severity, `severity ${severity} should be parsed`);
      }
    });

    it('handles issues with multiple categories', () => {
      const content = JSON.stringify([
        makeIssue({ categories: ['Complexity', 'Bug Risk', 'Style'] }),
      ]);
      const issues = parseCodeClimateFile(content);
      assert.deepStrictEqual(issues[0].categories, ['Complexity', 'Bug Risk', 'Style']);
    });
  });

  describe('real test data', () => {
    for (const filename of ['eslint-report.json', 'codeparser-report.json', 'semgrep-report.json']) {
      it(`parses NDJSON testdata file (${filename})`, () => {
        const content = fs.readFileSync(
          path.join(TESTDATA_DIR, filename),
          'utf-8'
        );
        const issues = parseCodeClimateFile(content);
        assert.ok(issues.length > 0, 'should parse at least one issue');
        for (const issue of issues) {
          assert.strictEqual(issue.type, 'issue');
          assert.strictEqual(typeof issue.check_name, 'string');
          assert.ok(issue.location?.path, 'each issue should have a path');
        }
      });
    }

    it('eslint report contains expected check names', () => {
      const content = fs.readFileSync(path.join(TESTDATA_DIR, 'eslint-report.json'), 'utf-8');
      const issues = parseCodeClimateFile(content);
      const checkNames = issues.map((i) => i.check_name);
      assert.ok(checkNames.includes('no-var'), 'should include no-var');
      assert.ok(checkNames.includes('eqeqeq'), 'should include eqeqeq');
    });

    it('eslint report severity range includes minor through major', () => {
      const content = fs.readFileSync(path.join(TESTDATA_DIR, 'eslint-report.json'), 'utf-8');
      const issues = parseCodeClimateFile(content);
      const severities = new Set(issues.map((i) => i.severity));
      assert.ok(severities.has('minor'));
      assert.ok(severities.has('major'));
    });

    it('codeparser report includes issues with other_locations', () => {
      const content = fs.readFileSync(path.join(TESTDATA_DIR, 'codeparser-report.json'), 'utf-8');
      const issues = parseCodeClimateFile(content);
      const withOther = issues.filter((i) => i.other_locations && i.other_locations.length > 0);
      assert.ok(withOther.length > 0, 'at least one issue should have other_locations');
    });

    it('codeparser report references C source files', () => {
      const content = fs.readFileSync(path.join(TESTDATA_DIR, 'codeparser-report.json'), 'utf-8');
      const issues = parseCodeClimateFile(content);
      const paths = issues.map((i) => i.location.path);
      assert.ok(paths.some((p) => p.endsWith('.c') || p.endsWith('.h')), 'should reference .c or .h files');
    });

    it('semgrep report contains only Security/Bug Risk categories', () => {
      const content = fs.readFileSync(path.join(TESTDATA_DIR, 'semgrep-report.json'), 'utf-8');
      const issues = parseCodeClimateFile(content);
      const allCategories = issues.flatMap((i) => i.categories ?? []);
      const unexpected = allCategories.filter((c) => c !== 'Security' && c !== 'Bug Risk');
      assert.strictEqual(unexpected.length, 0, `unexpected categories: ${unexpected.join(', ')}`);
    });

    it('semgrep report includes blocker severity', () => {
      const content = fs.readFileSync(path.join(TESTDATA_DIR, 'semgrep-report.json'), 'utf-8');
      const issues = parseCodeClimateFile(content);
      const severities = new Set(issues.map((i) => i.severity));
      assert.ok(severities.has('blocker'), 'semgrep report should have blocker severity');
    });

    it('all reports have fingerprints', () => {
      for (const filename of ['eslint-report.json', 'codeparser-report.json', 'semgrep-report.json']) {
        const content = fs.readFileSync(path.join(TESTDATA_DIR, filename), 'utf-8');
        const issues = parseCodeClimateFile(content);
        for (const issue of issues) {
          assert.ok(issue.fingerprint, `${filename}: issue "${issue.check_name}" missing fingerprint`);
        }
      }
    });
  });
});
