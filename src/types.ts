export type Severity = 'info' | 'minor' | 'major' | 'critical' | 'blocker';

// Standard spec: begin/end are plain integers.
// Some tools use {line, column} objects instead — we support both.
export type LineRef = number | { line: number; column?: number };

export interface CodeClimateLines {
  begin: LineRef;
  end?: LineRef;
}

export interface CodeClimatePosition {
  line: number;
  column: number;
}

export interface CodeClimatePositions {
  begin: CodeClimatePosition;
  end: CodeClimatePosition;
}

export interface CodeClimateLocation {
  path: string;
  lines?: CodeClimateLines;
  positions?: CodeClimatePositions;
}

export interface CodeClimateIssue {
  type: string;
  check_name: string;
  description: string;
  categories: string[];
  location: CodeClimateLocation;
  severity?: Severity;
  fingerprint?: string;
  remediation_points?: number;
  content?: { body: string };
  other_locations?: CodeClimateLocation[];
}

export interface IssueWithSource extends CodeClimateIssue {
  sourceFile: string;
  sourceUri: string;
  id: string;
  customColumns: Record<string, string>;
}

export interface CustomColumn {
  name: string;
  index: number;
}

export interface PatternEntry {
  glob: string;
  regex?: string;
  values?: Record<string, string | null>;
}

export interface ProjectConfig {
  reportPatterns?: (string | PatternEntry)[];
  customColumns?: CustomColumn[];
}

export interface LoadedFileInfo {
  uri: string;
  filename: string;
  issueCount: number;
}
