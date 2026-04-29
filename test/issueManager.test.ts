import * as assert from 'assert';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
// vscode is intercepted by test/setup.ts — imported here for types only
import type * as vscode from 'vscode';
import { IssueManager } from '../src/issueManager';

// Minimal vscode.Uri-like object accepted by IssueManager
function makeUri(fsPath: string): vscode.Uri {
  return {
    fsPath,
    scheme: 'file',
    toString: () => `file://${fsPath.replace(/\\/g, '/')}`,
  } as unknown as vscode.Uri;
}

function makeIssues(count: number, pathPrefix = 'src/file') {
  return Array.from({ length: count }, (_, i) => ({
    type: 'issue',
    check_name: `Rule/${i}`,
    description: `Issue ${i}`,
    categories: ['Bug Risk'],
    location: { path: `${pathPrefix}${i}.rb`, lines: { begin: i + 1, end: i + 1 } },
    severity: 'minor',
  }));
}

let tmpDir: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccv-test-'));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeReport(name: string, issues: unknown[]): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, JSON.stringify(issues), 'utf-8');
  return p;
}

describe('IssueManager', () => {
  describe('initial state', () => {
    it('starts empty', () => {
      const manager = new IssueManager();
      assert.strictEqual(manager.isEmpty, true);
      assert.deepStrictEqual(manager.getAllIssues(), []);
      assert.deepStrictEqual(manager.getFileInfos(), []);
    });
  });

  describe('loadFile', () => {
    it('loads issues from a JSON array report', () => {
      const p = writeReport('load-basic.json', makeIssues(3));
      const manager = new IssueManager();
      manager.loadFile(makeUri(p));

      assert.strictEqual(manager.isEmpty, false);
      assert.strictEqual(manager.getAllIssues().length, 3);
    });

    it('sets sourceFile to the report basename', () => {
      const p = writeReport('my-report.json', makeIssues(1));
      const manager = new IssueManager();
      manager.loadFile(makeUri(p));

      assert.strictEqual(manager.getAllIssues()[0].sourceFile, 'my-report.json');
    });

    it('assigns unique IDs to every issue', () => {
      const p = writeReport('ids.json', makeIssues(5));
      const manager = new IssueManager();
      manager.loadFile(makeUri(p));

      const ids = manager.getAllIssues().map((i) => i.id);
      assert.strictEqual(new Set(ids).size, 5);
    });

    it('replaces issues when the same file is loaded again', () => {
      const p = writeReport('reload.json', makeIssues(1));
      const manager = new IssueManager();
      manager.loadFile(makeUri(p));
      assert.strictEqual(manager.getAllIssues().length, 1);

      fs.writeFileSync(p, JSON.stringify(makeIssues(4)));
      manager.loadFile(makeUri(p));
      assert.strictEqual(manager.getAllIssues().length, 4);
    });

    it('fires onChange after loading', (done) => {
      const p = writeReport('onchange-load.json', makeIssues(1));
      const manager = new IssueManager();
      manager.onChange(() => done());
      manager.loadFile(makeUri(p));
    });

    it('accumulates issues from multiple files', () => {
      const p1 = writeReport('multi-a.json', makeIssues(2, 'a/'));
      const p2 = writeReport('multi-b.json', makeIssues(3, 'b/'));
      const manager = new IssueManager();
      manager.loadFile(makeUri(p1));
      manager.loadFile(makeUri(p2));

      assert.strictEqual(manager.getAllIssues().length, 5);
      assert.strictEqual(manager.getFileInfos().length, 2);
    });

    it('records correct issueCount in file info', () => {
      const p = writeReport('fileinfo.json', makeIssues(7));
      const manager = new IssueManager();
      manager.loadFile(makeUri(p));

      const info = manager.getFileInfos()[0];
      assert.strictEqual(info.issueCount, 7);
      assert.strictEqual(info.filename, 'fileinfo.json');
    });
  });

  describe('removeFile', () => {
    it('removes a previously loaded file', () => {
      const p = writeReport('remove.json', makeIssues(2));
      const uri = makeUri(p);
      const manager = new IssueManager();
      manager.loadFile(uri);
      assert.strictEqual(manager.isEmpty, false);

      manager.removeFile(uri.toString());
      assert.strictEqual(manager.isEmpty, true);
      assert.deepStrictEqual(manager.getAllIssues(), []);
    });

    it('fires onChange after removing', (done) => {
      const p = writeReport('onchange-remove.json', makeIssues(1));
      const uri = makeUri(p);
      const manager = new IssueManager();
      manager.loadFile(uri);

      let calls = 0;
      manager.onChange(() => {
        calls++;
        if (calls === 1) done(); // fired by removeFile
      });
      manager.removeFile(uri.toString());
    });

    it('is a no-op for an unknown URI', () => {
      const manager = new IssueManager();
      assert.doesNotThrow(() => manager.removeFile('file:///does-not-exist.json'));
    });
  });

  describe('clearAll', () => {
    it('removes all loaded files', () => {
      const manager = new IssueManager();
      for (let i = 0; i < 3; i++) {
        const p = writeReport(`clear-${i}.json`, makeIssues(1));
        manager.loadFile(makeUri(p));
      }
      assert.strictEqual(manager.isEmpty, false);

      manager.clearAll();
      assert.strictEqual(manager.isEmpty, true);
      assert.deepStrictEqual(manager.getAllIssues(), []);
      assert.deepStrictEqual(manager.getFileInfos(), []);
    });

    it('fires onChange after clear', (done) => {
      const p = writeReport('onchange-clear.json', makeIssues(1));
      const manager = new IssueManager();
      manager.loadFile(makeUri(p));

      let calls = 0;
      manager.onChange(() => {
        calls++;
        if (calls === 1) done();
      });
      manager.clearAll();
    });
  });

  describe('getIssuesForRelativePath', () => {
    it('returns issues matching an exact relative path', () => {
      const issues = [
        {
          type: 'issue',
          check_name: 'A',
          description: 'd',
          categories: [],
          location: { path: 'app/models/user.rb' },
        },
        {
          type: 'issue',
          check_name: 'B',
          description: 'd',
          categories: [],
          location: { path: 'app/controllers/users_controller.rb' },
        },
      ];
      const p = writeReport('relpath.json', issues);
      const manager = new IssueManager();
      manager.loadFile(makeUri(p));

      const matched = manager.getIssuesForRelativePath('app/models/user.rb');
      assert.strictEqual(matched.length, 1);
      assert.strictEqual(matched[0].check_name, 'A');
    });

    it('matches when the stored path ends with the relative path (absolute path support)', () => {
      const issues = [
        {
          type: 'issue',
          check_name: 'AbsMatch',
          description: 'd',
          categories: [],
          location: { path: '/home/user/project/src/main.c' },
        },
      ];
      const p = writeReport('abspath.json', issues);
      const manager = new IssueManager();
      manager.loadFile(makeUri(p));

      const matched = manager.getIssuesForRelativePath('src/main.c');
      assert.strictEqual(matched.length, 1);
      assert.strictEqual(matched[0].check_name, 'AbsMatch');
    });

    it('returns empty array for unmatched path', () => {
      const p = writeReport('nomatch.json', makeIssues(2));
      const manager = new IssueManager();
      manager.loadFile(makeUri(p));

      const matched = manager.getIssuesForRelativePath('no/such/file.rb');
      assert.deepStrictEqual(matched, []);
    });

    it('normalises Windows backslashes', () => {
      const issues = [
        {
          type: 'issue',
          check_name: 'WinPath',
          description: 'd',
          categories: [],
          location: { path: 'src\\models\\user.rb' },
        },
      ];
      const p = writeReport('winpath.json', issues);
      const manager = new IssueManager();
      manager.loadFile(makeUri(p));

      const matched = manager.getIssuesForRelativePath('src/models/user.rb');
      assert.strictEqual(matched.length, 1);
    });
  });
});
