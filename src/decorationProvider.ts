import * as vscode from 'vscode';
import { IssueManager } from './issueManager';
import { IssueWithSource, Severity } from './types';

const SEVERITY_COLORS: Record<Severity, { border: string; overview: string }> = {
  blocker:  { border: '#ff3b30', overview: '#ff3b30' },
  critical: { border: '#ff6b35', overview: '#ff6b35' },
  major:    { border: '#ff9f0a', overview: '#ff9f0a' },
  minor:    { border: '#ffd60a', overview: '#ffd60a' },
  info:     { border: '#0a84ff', overview: '#0a84ff' },
};

export class DecorationProvider implements vscode.Disposable {
  private decorationTypes = new Map<Severity, vscode.TextEditorDecorationType>();
  private disposables: vscode.Disposable[] = [];

  constructor(private issueManager: IssueManager) {
    for (const [severity, colors] of Object.entries(SEVERITY_COLORS) as [Severity, typeof SEVERITY_COLORS[Severity]][]) {
      this.decorationTypes.set(severity, vscode.window.createTextEditorDecorationType({
        borderWidth: '0 0 0 3px',
        borderStyle: 'solid',
        borderColor: colors.border,
        overviewRulerColor: colors.overview,
        overviewRulerLane: vscode.OverviewRulerLane.Left,
      }));
    }

    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor) this.applyDecorations(editor);
      }),
      vscode.window.onDidChangeVisibleTextEditors((editors) => {
        for (const editor of editors) this.applyDecorations(editor);
      }),
      issueManager.onChange(() => this.refreshAllEditors()),
    );
  }

  refreshAllEditors(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this.applyDecorations(editor);
    }
  }

  applyDecorations(editor: vscode.TextEditor): void {
    const docPath = vscode.workspace.asRelativePath(editor.document.uri, false);
    const issues = this.issueManager.getIssuesForRelativePath(docPath);

    const byS = new Map<Severity, vscode.DecorationOptions[]>();
    for (const sev of Object.keys(SEVERITY_COLORS) as Severity[]) byS.set(sev, []);

    for (const issue of issues) {
      const beginLine = getBeginLine(issue) - 1; // convert to 0-indexed
      if (beginLine < 0) continue;
      const endLine = getEndLine(issue) - 1;
      const sev: Severity = issue.severity ?? 'info';
      const range = new vscode.Range(beginLine, 0, Math.max(beginLine, endLine), Number.MAX_SAFE_INTEGER);

      byS.get(sev)?.push({
        range,
        hoverMessage: new vscode.MarkdownString(
          `**[${sev.toUpperCase()}]** \`${issue.check_name}\`\n\n${issue.description}\n\n*Source: ${issue.sourceFile}*`,
        ),
        renderOptions: {
          after: {
            contentText: `  ● ${issue.check_name}`,
            color: SEVERITY_COLORS[sev].border,
            fontStyle: 'italic',
            margin: '0 0 0 2rem',
          },
        },
      });
    }

    for (const [sev, decType] of this.decorationTypes.entries()) {
      editor.setDecorations(decType, byS.get(sev) ?? []);
    }
  }

  clearDecorations(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      for (const decType of this.decorationTypes.values()) {
        editor.setDecorations(decType, []);
      }
    }
  }

  dispose(): void {
    for (const dt of this.decorationTypes.values()) dt.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

function getBeginLine(issue: IssueWithSource): number {
  if (issue.location.lines?.begin) return issue.location.lines.begin;
  if (issue.location.positions?.begin?.line) return issue.location.positions.begin.line;
  return 1;
}

function getEndLine(issue: IssueWithSource): number {
  if (issue.location.lines?.end) return issue.location.lines.end;
  if (issue.location.lines?.begin) return issue.location.lines.begin;
  if (issue.location.positions?.end?.line) return issue.location.positions.end.line;
  return 1;
}
