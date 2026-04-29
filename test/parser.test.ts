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
    it('parses NDJSON testdata file (codeparser-dispatch.json)', () => {
      const content = fs.readFileSync(
        path.join(TESTDATA_DIR, 'codeparser-dispatch.json'),
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

    it('parses NDJSON testdata file (codeparser-gesmaj.json)', () => {
      const content = fs.readFileSync(
        path.join(TESTDATA_DIR, 'codeparser-gesmaj.json'),
        'utf-8'
      );
      const issues = parseCodeClimateFile(content);
      assert.ok(issues.length > 0, 'should parse at least one issue');
    });
  });
});
