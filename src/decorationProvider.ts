import * as vscode from 'vscode';
import { IssueManager } from './issueManager';
import { IssueWithSource, Severity } from './types';

const SEVERITY_COLORS: Record<Severity, { border: string; overview: string }> = {
  blocker:  { border: '#7b1fa2', overview: '#7b1fa2' },
  critical: { border: '#e53935', overview: '#e53935' },
  major:    { border: '#f4511e', overview: '#f4511e' },
  minor:    { border: '#f9a825', overview: '#f9a825' },
  info:     { border: '#78909c', overview: '#78909c' },
};

export class DecorationProvider implements vscode.Disposable {
  // Full range (begin → end): coloured border + subtle background tint
  private rangeDecTypes = new Map<Severity, vscode.TextEditorDecorationType>();
  private disposables: vscode.Disposable[] = [];
  // uri → sorted issue-id hash last applied; skip re-apply if unchanged so VS Code keeps tracking shifted ranges.
  private appliedHashes = new Map<string, string>();
  // URIs visible in the previous onDidChangeVisibleTextEditors event; used to detect editors re-entering the visible set.
  private prevVisibleUris = new Set<string>();

  constructor(private issueManager: IssueManager) {
    for (const [severity, colors] of Object.entries(SEVERITY_COLORS) as [Severity, typeof SEVERITY_COLORS[Severity]][]) {
      this.rangeDecTypes.set(severity, vscode.window.createTextEditorDecorationType({
        borderWidth: '0 0 0 3px',
        borderStyle: 'solid',
        borderColor: colors.border,
        backgroundColor: colors.border + '18', // ~10% opacity tint over the full range
        overviewRulerColor: colors.overview,
        overviewRulerLane: vscode.OverviewRulerLane.Left,
        isWholeLine: true,
      }));
    }

    for (const editor of vscode.window.visibleTextEditors) {
      this.prevVisibleUris.add(editor.document.uri.toString());
    }

    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor) this.applyDecorations(editor);
      }),
      vscode.window.onDidChangeVisibleTextEditors((editors) => {
        const newUris = new Set(editors.map(e => e.document.uri.toString()));
        for (const editor of editors) {
          const key = editor.document.uri.toString();
          if (!this.prevVisibleUris.has(key)) {
            // Editor re-entered the visible set — VS Code may have discarded its decorations.
            this.appliedHashes.delete(key);
          }
          this.applyDecorations(editor);
        }
        this.prevVisibleUris = newUris;
      }),
      issueManager.onChange(() => this.refreshAllEditors()),
    );
  }

  refreshAllEditors(): void {
    if (!vscode.workspace.getConfiguration('codeclimateVisualiser').get<boolean>('showInFileDecorations', true)) return;
    for (const editor of vscode.window.visibleTextEditors) {
      this.applyDecorations(editor);
    }
  }

  applyDecorations(editor: vscode.TextEditor): void {
    if (!vscode.workspace.getConfiguration('codeclimateVisualiser').get<boolean>('showInFileDecorations', true)) return;
    const docPath = vscode.workspace.asRelativePath(editor.document.uri, false);
    const issues = this.issueManager.getIssuesForRelativePath(docPath);

    const key = editor.document.uri.toString();
    // Sort IDs so hash is stable regardless of report load order.
    const hash = issues.map(i => i.id).sort().join('|');
    if (this.appliedHashes.get(key) === hash) return; // same data — let VS Code keep tracking shifted ranges
    this.appliedHashes.set(key, hash);

    const byS = new Map<Severity, vscode.DecorationOptions[]>();
    for (const sev of Object.keys(SEVERITY_COLORS) as Severity[]) byS.set(sev, []);

    for (const issue of issues) {
      const rawBegin = issue.location.lines?.begin ?? issue.location.positions?.begin;
      const rawEnd   = issue.location.lines?.end   ?? issue.location.positions?.end;
      const beginLine = toLine(rawBegin as Parameters<typeof toLine>[0]) - 1;
      if (beginLine < 0) continue;
      const endLine = toLine((rawEnd ?? rawBegin) as Parameters<typeof toLine>[0]) - 1;

      const sev: Severity = issue.severity ?? 'info';
      const fullRange = new vscode.Range(beginLine, 0, Math.max(beginLine, endLine), Number.MAX_SAFE_INTEGER);

      const dot: Record<Severity, string> = { blocker: '🟣', critical: '🔴', major: '🟠', minor: '🟡', info: '🔵' };
      const focusArg = encodeURIComponent(JSON.stringify(issue.id));
      const md = new vscode.MarkdownString(
        `${dot[sev]} **${issue.check_name}**` +
        (issue.description ? `\n\n*${issue.description}*` : '') +
        `\n\n[$(table) Voir dans le tableau](command:codeclimateVisualiser.focusIssueInTable?${focusArg})`,
      );
      md.isTrusted = true;
      md.supportThemeIcons = true;
      byS.get(sev)?.push({ range: fullRange, hoverMessage: md });
    }

    for (const [sev, opts] of byS.entries()) {
      editor.setDecorations(this.rangeDecTypes.get(sev)!, opts);
    }
  }

  clearDecorations(): void {
    this.appliedHashes.clear();
    this.prevVisibleUris.clear();
    for (const editor of vscode.window.visibleTextEditors) {
      for (const dt of this.rangeDecTypes.values()) editor.setDecorations(dt, []);
    }
  }

  dispose(): void {
    for (const dt of this.rangeDecTypes.values()) dt.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

// Resolves a LineRef (plain int or {line, column} object) to a 1-based line number.
function toLine(val: number | { line: number; column?: number } | string | undefined): number {
  if (typeof val === 'object' && val !== null && 'line' in val) {
    const n = Number(val.line);
    return n > 0 ? Math.floor(n) : 1;
  }
  const n = Number(val);
  return n > 0 ? Math.floor(n) : 1;
}
