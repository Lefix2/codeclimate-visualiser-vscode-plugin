import { CodeClimateIssue } from './types';

export function parseCodeClimateFile(content: string): CodeClimateIssue[] {
  const trimmed = content.trim();
  if (!trimmed) return [];

  // Try JSON array first
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.filter(isIssue);
      }
    } catch {
      // fall through to NDJSON
    }
  }

  // Try NDJSON (one JSON object per line)
  const issues: CodeClimateIssue[] = [];
  for (const line of trimmed.split('\n')) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;
    try {
      const obj: unknown = JSON.parse(trimmedLine);
      if (isIssue(obj)) issues.push(obj);
    } catch {
      // skip non-JSON lines
    }
  }
  return issues;
}

function isIssue(obj: unknown): obj is CodeClimateIssue {
  if (typeof obj !== 'object' || obj === null) return false;
  const o = obj as Record<string, unknown>;
  return o['type'] === 'issue' && typeof o['check_name'] === 'string';
}
