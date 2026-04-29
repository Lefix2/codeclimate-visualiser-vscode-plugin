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
  // Full line range (begin → end): coloured left border + subtle background tint
  private rangeDecTypes   = new Map<Severity, vscode.TextEditorDecorationType>();
  // Precise column range: coloured box around the exact symbol (when columns available)
  private preciseDecTypes = new Map<Severity, vscode.TextEditorDecorationType>();
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

      this.preciseDecTypes.set(severity, vscode.window.createTextEditorDecorationType({
        backgroundColor: colors.border + '45',
        border: `1px solid ${colors.border}99`,
        borderRadius: '2px',
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

    type Opts = { range: vscode.DecorationOptions[]; precise: vscode.DecorationOptions[] };
    const byS = new Map<Severity, Opts>();
    for (const sev of Object.keys(SEVERITY_COLORS) as Severity[]) byS.set(sev, { range: [], precise: [] });

    for (const issue of issues) {
      const rawBegin = issue.location.lines?.begin ?? issue.location.positions?.begin;
      const rawEnd   = issue.location.lines?.end   ?? issue.location.positions?.end;

      const beginLine = toLine(rawBegin) - 1; // 0-indexed
      if (beginLine < 0) continue;
      const endLine   = toLine(rawEnd ?? rawBegin) - 1;
      const beginCol  = toCol(rawBegin);
      const endCol    = toCol(rawEnd ?? rawBegin);

      const sev: Severity = issue.severity ?? 'info';
      const entry = byS.get(sev);
      if (!entry) continue;

      const lines = beginLine === endLine
        ? `Line ${beginLine + 1}`
        : `Lines ${beginLine + 1}–${endLine + 1}`;
      const body = issue.content?.body ? `\n\n---\n${issue.content.body}` : '';
      const hover = new vscode.MarkdownString(
        `**[${sev.toUpperCase()}]** \`${issue.check_name}\`  \n` +
        `${issue.description}${body}  \n\n` +
        `*${lines} · ${issue.sourceFile}*`,
      );

      // Whole-line decoration: border + tint spans begin → end
      entry.range.push({
        range: new vscode.Range(beginLine, 0, Math.max(beginLine, endLine), Number.MAX_SAFE_INTEGER),
        hoverMessage: hover,
      });

      // Precise decoration: coloured box on the exact column range (when available)
      if (beginCol > 0) {
        const colEnd = endCol > 0 ? endCol : beginCol + 1;
        entry.precise.push({
          range: new vscode.Range(beginLine, beginCol, Math.max(beginLine, endLine), colEnd),
          hoverMessage: hover,
        });
      }
    }

    for (const [sev, opts] of byS.entries()) {
      editor.setDecorations(this.rangeDecTypes.get(sev)!,   opts.range);
      editor.setDecorations(this.preciseDecTypes.get(sev)!, opts.precise);
    }
  }

  clearDecorations(): void {
    const allTypes = [...this.rangeDecTypes.values(), ...this.preciseDecTypes.values()];
    for (const editor of vscode.window.visibleTextEditors) {
      for (const dt of allTypes) editor.setDecorations(dt, []);
    }
  }

  dispose(): void {
    for (const dt of [...this.rangeDecTypes.values(), ...this.preciseDecTypes.values()]) dt.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

type RawRef = number | { line?: number; column?: number } | undefined;

/** Extracts a 1-based line number from a plain int or {line, column} object. */
function toLine(val: RawRef): number {
  if (typeof val === 'object' && val !== null && 'line' in val) {
    const n = Number(val.line);
    return n > 0 ? Math.floor(n) : 1;
  }
  const n = Number(val);
  return n > 0 ? Math.floor(n) : 1;
}

/** Extracts a 0-based column index from a {line, column} object. Returns 0 if unavailable. */
function toCol(val: RawRef): number {
  if (typeof val === 'object' && val !== null && 'column' in val) {
    const n = Number(val.column);
    return n > 0 ? Math.floor(n) - 1 : 0; // CodeClimate columns are 1-based
  }
  return 0;
}
