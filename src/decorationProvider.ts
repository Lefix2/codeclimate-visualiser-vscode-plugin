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
  // Full range (begin → end): coloured border + subtle background tint
  private rangeDecTypes = new Map<Severity, vscode.TextEditorDecorationType>();
  // Begin line only: inline after-text annotation
  private annotDecTypes = new Map<Severity, vscode.TextEditorDecorationType>();
  private disposables: vscode.Disposable[] = [];

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

      // Empty base type — per-decoration renderOptions supply the after-text
      this.annotDecTypes.set(severity, vscode.window.createTextEditorDecorationType({}));
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

    type Opts = { range: vscode.DecorationOptions[]; annot: vscode.DecorationOptions[] };
    const byS = new Map<Severity, Opts>();
    for (const sev of Object.keys(SEVERITY_COLORS) as Severity[]) byS.set(sev, { range: [], annot: [] });

    for (const issue of issues) {
      const beginLine = toLine(issue.location.lines?.begin ?? issue.location.positions?.begin?.line) - 1;
      if (beginLine < 0) continue;
      const endLine = toLine(
        issue.location.lines?.end ??
        issue.location.positions?.end?.line ??
        issue.location.lines?.begin ??
        issue.location.positions?.begin?.line,
      ) - 1;

      const sev: Severity = issue.severity ?? 'info';
      const fullRange  = new vscode.Range(beginLine, 0, Math.max(beginLine, endLine), Number.MAX_SAFE_INTEGER);
      const firstLine  = new vscode.Range(beginLine, 0, beginLine, Number.MAX_SAFE_INTEGER);

      const entry = byS.get(sev);
      if (!entry) continue;

      entry.range.push({
        range: fullRange,
        hoverMessage: new vscode.MarkdownString(
          `**[${sev.toUpperCase()}]** \`${issue.check_name}\`  \n` +
          `${issue.description}  \n\n` +
          `*Lines ${beginLine + 1}–${endLine + 1} · ${issue.sourceFile}*`,
        ),
      });

      entry.annot.push({
        range: firstLine,
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

    for (const [sev, opts] of byS.entries()) {
      editor.setDecorations(this.rangeDecTypes.get(sev)!, opts.range);
      editor.setDecorations(this.annotDecTypes.get(sev)!, opts.annot);
    }
  }

  clearDecorations(): void {
    const allTypes = [...this.rangeDecTypes.values(), ...this.annotDecTypes.values()];
    for (const editor of vscode.window.visibleTextEditors) {
      for (const dt of allTypes) editor.setDecorations(dt, []);
    }
  }

  dispose(): void {
    for (const dt of [...this.rangeDecTypes.values(), ...this.annotDecTypes.values()]) dt.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

// Safely converts a raw value (number or string) to a 1-based line number.
function toLine(val: number | string | undefined): number {
  const n = Number(val);
  return n > 0 ? Math.floor(n) : 1;
}
