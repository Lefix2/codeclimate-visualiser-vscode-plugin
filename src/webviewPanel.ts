import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { IssueManager } from './issueManager';
import { HistoryManager } from './historyManager';

export class CodeClimatePanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private disposables: vscode.Disposable[] = [];

  constructor(
    private context: vscode.ExtensionContext,
    private issueManager: IssueManager,
    private historyManager: HistoryManager | null,
  ) {
    this.disposables.push(issueManager.onChange(() => this.updateWebview()));
  }

  show(): void {
    if (this.panel) {
      this.panel.reveal();
      this.updateWebview();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'codeclimateVisualiser',
      'CodeClimate Visualiser',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
        retainContextWhenHidden: true,
      },
    );
    this.panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'icon.svg');

    this.panel.webview.onDidReceiveMessage(
      async (msg: WebviewMessage) => {
        switch (msg.type) {
          case 'openFile':
            await this.openFileAtLine(msg.filePath, msg.line);
            break;
          case 'removeSourceFile':
            this.issueManager.removeFile(msg.uri);
            break;
          case 'requestSnippet':
            this.sendSnippet(msg.issueId, msg.filePath, msg.line);
            break;
          case 'deleteSnapshot':
            this.historyManager?.deleteSnapshot(msg.id);
            this.updateWebview();
            break;
          case 'editSnapshotLabel':
            this.historyManager?.updateLabel(msg.id, msg.label);
            this.updateWebview();
            break;
        }
      },
      undefined,
      this.disposables,
    );

    this.panel.onDidDispose(() => { this.panel = undefined; }, null, this.disposables);
    this.panel.webview.html = this.buildHtml();
    this.updateWebview();
  }

  focusIssue(issueId: string): void {
    this.panel?.webview.postMessage({ type: 'focusIssue', issueId });
  }

  private updateWebview(): void {
    if (!this.panel) return;
    const cfg = vscode.workspace.getConfiguration('codeclimateVisualiser');
    this.panel.webview.postMessage({
      type: 'updateIssues',
      files: this.issueManager.getFileInfos(),
      issues: this.issueManager.getAllIssues(),
      config: {
        showChartLegends:    cfg.get<boolean>('showChartLegends',    false),
        showSeverityFilter:  cfg.get<boolean>('showSeverityFilter',  true),
        showCategoryFilter:  cfg.get<boolean>('showCategoryFilter',  true),
        showCheckNameFilter: cfg.get<boolean>('showCheckNameFilter', true),
        showSeverityChart:   cfg.get<boolean>('showSeverityChart',   true),
        showCategoryChart:   cfg.get<boolean>('showCategoryChart',   true),
        showCheckNameChart:  cfg.get<boolean>('showCheckNameChart',  true),
        showSourceChart:     cfg.get<boolean>('showSourceChart',     true),
        showFileChart:       cfg.get<boolean>('showFileChart',       true),
        customColumns:       this.issueManager.getCustomColumns(),
      },
      history: this.historyManager?.loadHistory() ?? [],
      currentState: this.historyManager?.computeCurrentState(this.issueManager.getAllIssues()) ?? null,
    });
  }

  refreshHistory(): void {
    this.updateWebview();
  }

  /** Resolve filePath to an existing absolute path, or null. */
  private resolveFilePath(filePath: string): string | null {
    if (path.isAbsolute(filePath) && fs.existsSync(filePath)) return filePath;
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const full = path.join(folder.uri.fsPath, filePath);
      if (fs.existsSync(full)) return full;
    }
    if (!path.isAbsolute(filePath) && fs.existsSync(filePath)) return filePath;
    return null;
  }

  private async openFileAtLine(filePath: string, line: number): Promise<void> {
    const resolved = this.resolveFilePath(filePath);
    if (!resolved) {
      vscode.window.showWarningMessage(`File not found: ${filePath}`);
      return;
    }
    const doc = await vscode.workspace.openTextDocument(resolved);
    const editor = await vscode.window.showTextDocument(doc, {
      preserveFocus: false,
      preview: false,
      viewColumn: vscode.ViewColumn.Active,
    });
    const pos = new vscode.Position(Math.max(0, line - 1), 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  }

  private sendSnippet(issueId: string, filePath: string, line: number): void {
    const resolved = this.resolveFilePath(filePath);
    if (!resolved) {
      this.panel?.webview.postMessage({ type: 'snippet', issueId, lines: [], highlightLine: line });
      return;
    }
    try {
      const all = fs.readFileSync(resolved, 'utf-8').split('\n');
      const ctx = 4;
      const start = Math.max(0, line - 1 - ctx);
      const end = Math.min(all.length - 1, line - 1 + ctx);
      const lines: { number: number; text: string }[] = [];
      for (let i = start; i <= end; i++) lines.push({ number: i + 1, text: all[i] ?? '' });
      this.panel?.webview.postMessage({ type: 'snippet', issueId, lines, highlightLine: line });
    } catch {
      this.panel?.webview.postMessage({ type: 'snippet', issueId, lines: [], highlightLine: line });
    }
  }

  private buildHtml(): string {
    const webview = this.panel!.webview;
    const mediaUri = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const jsUri  = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'webview.js'));
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'webview.css'));
    const nonce  = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' https://cdn.jsdelivr.net; img-src ${webview.cspSource} data:;">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${cssUri}">
  <title>CodeClimate Visualiser</title>
</head>
<body>
  <div id="app">
    <div id="empty-state">
      <p>No CodeClimate report loaded.</p>
      <p>Run <strong>CodeClimate: Open Report(s)</strong> from the command palette,<br>
         or right-click a <code>.json</code> file in the explorer.</p>
    </div>

    <div id="dashboard" style="display:none">
      <div class="dash-header">
        <div class="dash-icon">
          <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="1"    y="4"  width="3" height="18" rx="1" fill="#c084fc"/>
            <rect x="5.5"  y="8"  width="3" height="14" rx="1" fill="#f87171"/>
            <rect x="10"   y="11" width="3" height="11" rx="1" fill="#fb923c"/>
            <rect x="14.5" y="15" width="3" height="7"  rx="1" fill="#fbbf24"/>
            <rect x="19"   y="19" width="3" height="3"  rx="1" fill="#71717a"/>
          </svg>
        </div>
        <div class="dash-title-wrap">
          <div class="dash-title">CodeClimate Visualiser</div>
          <div class="dash-sub" id="dash-subtitle">Loading…</div>
        </div>
      </div>

      <nav class="dash-nav" id="dash-nav">
        <button class="dash-nav-tab active" data-view="overview">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/>
            <rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>
          </svg>
          Overview
        </button>
        <button class="dash-nav-tab" data-view="issues">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="9"/><path d="M12 8v4"/><circle cx="12" cy="16" r="0.5" fill="currentColor"/>
          </svg>
          Issues
        </button>
        <button class="dash-nav-tab" data-view="files">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4 5a2 2 0 0 1 2-2h6l2 3h4a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/>
          </svg>
          Files
        </button>
        <button class="dash-nav-tab" data-view="treemap">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="3" width="9" height="11"/><rect x="14" y="3" width="7" height="7"/>
            <rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="9" height="5"/>
          </svg>
          Treemap
        </button>
        <button class="dash-nav-tab" data-view="trends">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 17 9 11 13 15 21 7"/><polyline points="14 7 21 7 21 14"/>
          </svg>
          Trends
        </button>
      </nav>

      <div id="view-container"></div>
    </div>
  </div>

  <script nonce="${nonce}">window.Prism = window.Prism || {}; window.Prism.manual = true;</script>
  <script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/prism.min.js"></script>
  <script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-ruby.min.js"></script>
  <script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-python.min.js"></script>
  <script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-go.min.js"></script>
  <script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-typescript.min.js"></script>
  <script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-java.min.js"></script>
  <script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-bash.min.js"></script>
  <script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-c.min.js"></script>
  <script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-cpp.min.js"></script>
  <script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-csharp.min.js"></script>
  <script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-rust.min.js"></script>
  <script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-kotlin.min.js"></script>
  <script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-scala.min.js"></script>
  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.panel?.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

type WebviewMessage =
  | { type: 'openFile'; filePath: string; line: number }
  | { type: 'removeSourceFile'; uri: string }
  | { type: 'requestSnippet'; issueId: string; filePath: string; line: number }
  | { type: 'deleteSnapshot'; id: string }
  | { type: 'editSnapshotLabel'; id: string; label: string };

function getNonce(): string {
  let t = '';
  const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) t += c.charAt(Math.floor(Math.random() * c.length));
  return t;
}
