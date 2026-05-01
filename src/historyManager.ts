import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { IssueWithSource, HistorySnapshot, Severity } from './types';

function beginLine(issue: IssueWithSource): number {
  const b = issue.location?.lines?.begin;
  if (typeof b === 'number') return b;
  if (b && typeof b === 'object') return (b as { line?: number }).line ?? -1;
  return issue.location?.positions?.begin?.line ?? -1;
}

function sha1(s: string): string {
  return crypto.createHash('sha1').update(s).digest('hex');
}

type FpSource = 'native' | 'derived' | 'volatile';

function resolveFingerprint(issue: IssueWithSource): { fp: string; source: FpSource } {
  if (issue.fingerprint) return { fp: issue.fingerprint, source: 'native' };
  if (issue.check_name && issue.location?.path) {
    return { fp: sha1(`${issue.check_name}:${issue.location.path}:${beginLine(issue)}`), source: 'derived' };
  }
  return { fp: sha1(`${issue.check_name ?? ''}:${issue.description ?? ''}`), source: 'volatile' };
}

export class HistoryManager {
  private readonly historyPath: string;

  constructor(workspaceRoot: string) {
    this.historyPath = path.join(workspaceRoot, '.vscode', 'codeclimate-visualiser.history.ndjson');
  }

  saveSnapshot(issues: IssueWithSource[], sources: string[], label?: string): HistorySnapshot {
    const counts: Record<Severity, number> = { blocker: 0, critical: 0, major: 0, minor: 0, info: 0 };
    let nativeCount = 0, derivedCount = 0, volatileCount = 0;
    const fingerprints: string[] = [];

    for (const issue of issues) {
      counts[issue.severity ?? 'info']++;
      const { fp, source } = resolveFingerprint(issue);
      if (source === 'volatile') {
        volatileCount++;
      } else {
        fingerprints.push(fp);
        if (source === 'native') nativeCount++; else derivedCount++;
      }
    }

    const snapshot: HistorySnapshot = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      label: label || undefined,
      sources,
      counts,
      total: issues.length,
      nativeCount,
      derivedCount,
      volatileCount,
      fingerprints,
    };

    fs.appendFileSync(this.historyPath, JSON.stringify(snapshot) + '\n', 'utf-8');
    return snapshot;
  }

  loadHistory(): HistorySnapshot[] {
    try {
      const raw = fs.readFileSync(this.historyPath, 'utf-8');
      return raw
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => { try { return JSON.parse(line) as HistorySnapshot; } catch { return null; } })
        .filter((s): s is HistorySnapshot => s !== null);
    } catch {
      return [];
    }
  }

  private rewrite(snapshots: HistorySnapshot[]): void {
    const content = snapshots.map(s => JSON.stringify(s)).join('\n');
    fs.writeFileSync(this.historyPath, content ? content + '\n' : '', 'utf-8');
  }

  deleteSnapshot(id: string): void {
    this.rewrite(this.loadHistory().filter(s => s.id !== id));
  }

  updateLabel(id: string, label: string): void {
    this.rewrite(this.loadHistory().map(s => s.id === id ? { ...s, label: label || undefined } : s));
  }
}
