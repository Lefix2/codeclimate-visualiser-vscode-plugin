import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { parseCodeClimateFile } from './parser';
import { IssueWithSource, LoadedFileInfo } from './types';

interface FileEntry {
  info: LoadedFileInfo;
  issues: IssueWithSource[];
}

export class IssueManager {
  private files = new Map<string, FileEntry>();
  private _onChange = new vscode.EventEmitter<void>();
  readonly onChange = this._onChange.event;

  loadFile(fileUri: vscode.Uri): void {
    const content = fs.readFileSync(fileUri.fsPath, 'utf-8');
    const rawIssues = parseCodeClimateFile(content);
    const filename = path.basename(fileUri.fsPath);
    const uri = fileUri.toString();

    const issues: IssueWithSource[] = rawIssues.map((issue, idx) => ({
      ...issue,
      sourceFile: filename,
      sourceUri: uri,
      id: `${uri}::${idx}`,
    }));

    this.files.set(uri, {
      info: { uri, filename, issueCount: issues.length },
      issues,
    });
    this._onChange.fire();
  }

  removeFile(uri: string): void {
    this.files.delete(uri);
    this._onChange.fire();
  }

  clearAll(): void {
    this.files.clear();
    this._onChange.fire();
  }

  getFileInfos(): LoadedFileInfo[] {
    return Array.from(this.files.values()).map((f) => f.info);
  }

  getAllIssues(): IssueWithSource[] {
    return Array.from(this.files.values()).flatMap((f) => f.issues);
  }

  getIssuesForRelativePath(relPath: string): IssueWithSource[] {
    const rel = relPath.replace(/\\/g, '/');
    return this.getAllIssues().filter((i) => {
      const p = (i.location.path ?? '').replace(/\\/g, '/');
      // exact match (relative paths from standard CodeClimate)
      if (p === rel) return true;
      // absolute path: check if it ends with /relPath
      if (p.endsWith('/' + rel)) return true;
      return false;
    });
  }

  get isEmpty(): boolean {
    return this.files.size === 0;
  }
}
