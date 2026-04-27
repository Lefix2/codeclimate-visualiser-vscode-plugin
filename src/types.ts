export type Severity = 'info' | 'minor' | 'major' | 'critical' | 'blocker';

export interface CodeClimateLines {
  begin: number;
  end?: number;
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
}

export interface LoadedFileInfo {
  uri: string;
  filename: string;
  issueCount: number;
}
