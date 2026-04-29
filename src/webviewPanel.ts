import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { IssueManager } from './issueManager';

export class CodeClimatePanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private disposables: vscode.Disposable[] = [];

  constructor(
    private context: vscode.ExtensionContext,
    private issueManager: IssueManager,
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
        }
      },
      undefined,
      this.disposables,
    );

    this.panel.onDidDispose(() => { this.panel = undefined; }, null, this.disposables);
    this.panel.webview.html = this.buildHtml();
    this.updateWebview();
  }

  private updateWebview(): void {
    if (!this.panel) return;
    const showChartLegends = vscode.workspace
      .getConfiguration('codeclimateVisualiser')
      .get<boolean>('showChartLegends', false);
    this.panel.webview.postMessage({
      type: 'updateIssues',
      files: this.issueManager.getFileInfos(),
      issues: this.issueManager.getAllIssues(),
      config: { showChartLegends, customColumns: this.issueManager.getCustomColumns() },
    });
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
      viewColumn: vscode.ViewColumn.Beside,
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

    <div id="main-content" style="display:none">
      <div id="charts-row">
        <div class="chart-card"><h3>By Severity</h3><canvas id="chart-severity"></canvas></div>
        <div class="chart-card"><h3>By Category</h3><canvas id="chart-category"></canvas></div>
        <div class="chart-card"><h3>Top Check Names</h3><canvas id="chart-checkname"></canvas></div>
        <div class="chart-card"><h3>By Source</h3><canvas id="chart-source"></canvas></div>
        <div class="chart-card"><h3>Top Files</h3><canvas id="chart-file"></canvas></div>
      </div>

      <div id="filters">
        <div id="filter-severity"></div>
        <div id="filter-custom"></div>
      </div>
      <div id="search-row">
        <input type="text" id="filter-search" placeholder="Filter by description, file, check name, category… use ; to AND terms">
      </div>
      <div id="active-filters"></div>

      <div id="issues-count-bar"></div>

      <div id="table-container">
        <table id="issues-table">
          <thead id="issues-thead"></thead>
          <tbody id="issues-tbody"></tbody>
        </table>
        <div id="table-footer"></div>
      </div>
    </div>
  </div>

  <script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
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
  | { type: 'requestSnippet'; issueId: string; filePath: string; line: number };

function getNonce(): string {
  let t = '';
  const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) t += c.charAt(Math.floor(Math.random() * c.length));
  return t;
}
