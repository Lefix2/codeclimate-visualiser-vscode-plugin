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
  showQuickFilter?: boolean; // default true — show filter badges in main webview filter bar
  showFilter?: boolean;      // default true — show text filter input in sidebar filter panel
  showChart?: boolean;     // default false — show a pie chart for this column
  fromField?: string;      // dot-path into issue object (e.g. "location.path")
  fieldRegex?: string;     // regex applied to fromField value
  captureGroup?: number;   // which capture group to use (0-indexed, default 0)
}

export interface PatternEntry {
  glob: string;
  regex?: string;
  values?: Record<string, string | null>;
}

/** A chained action invocation: bare id, or id with arguments forwarded to the called action. */
export type ActionThenRef = string | { id: string; args?: unknown[] };

/**
 * Expand one templated action into many concrete ones — one per matched directory
 * (`dirs` glob, e.g. "sous-systemes/*") or per explicit `values` entry.
 * The matched name is bound to placeholder `${as}` in every string field of the template.
 */
export interface ForEachSpec {
  dirs?: string;
  values?: string[];
  as: string;
}

export interface ActionDefinition {
  id: string;
  label: string;
  description?: string;
  hidden?: boolean;
  command?: string;
  vsCodeCommand?: string;
  args?: unknown[];
  onSave?: string | string[];
  then?: ActionThenRef[];
  refreshView?: boolean;
  forEach?: ForEachSpec;
  /**
   * Groups this action belongs to (an action can be in several). Each entry is a `/`-separated
   * path, e.g. "Analyse/CodeParser" — every segment is a group, nested left-to-right. A group
   * exists only if named here by some action; group names are globally unique. Colours come from
   * `ProjectConfig.groupColors` (a default applies otherwise).
   */
  groups?: string[];
}

export interface ProjectConfig {
  reportPatterns?: (string | PatternEntry)[];
  customColumns?: CustomColumn[];
  actions?: ActionDefinition[];
  /** Per-group accent colour, keyed by group name (path leaf). Groups without an entry use a default. */
  groupColors?: Record<string, string>;
  historyPath?: string;
}

export interface LoadedFileInfo {
  uri: string;
  filename: string;
  issueCount: number;
}

export interface HistorySnapshot {
  id: string;
  timestamp: string;
  label?: string;
  sources: string[];
  counts: Record<Severity, number>;
  total: number;
  nativeCount: number;
  derivedCount: number;
  volatileCount: number;
  fingerprints: string[];
}
