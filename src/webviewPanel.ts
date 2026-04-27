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
    this.panel.webview.postMessage({
      type: 'updateIssues',
      files: this.issueManager.getFileInfos(),
      issues: this.issueManager.getAllIssues(),
    });
  }

  private async openFileAtLine(filePath: string, line: number): Promise<void> {
    const candidates: string[] = [];

    // Absolute path first (common when CodeClimate runs on the full FS)
    if (path.isAbsolute(filePath)) {
      candidates.push(filePath);
    }

    // Try joining with each workspace folder (handles relative paths)
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      candidates.push(path.join(folder.uri.fsPath, filePath));
    }

    // Also try the raw path as-is (relative to CWD)
    if (!path.isAbsolute(filePath)) {
      candidates.push(filePath);
    }

    for (const candidate of candidates) {
      if (!fs.existsSync(candidate)) continue;
      const doc = await vscode.workspace.openTextDocument(candidate);
      const editor = await vscode.window.showTextDocument(doc, {
        preserveFocus: false,
        preview: false,
        viewColumn: vscode.ViewColumn.Beside,
      });
      const pos = new vscode.Position(Math.max(0, line - 1), 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      return;
    }

    vscode.window.showWarningMessage(`File not found: ${filePath}`);
  }

  private buildHtml(): string {
    const webview = this.panel!.webview;
    const mediaUri = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'webview.js'));
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'webview.css'));
    const nonce = getNonce();

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
    <div id="header">
      <h1>&#9673; CodeClimate Visualiser</h1>
      <div id="file-chips"></div>
    </div>

    <div id="empty-state">
      <p>No CodeClimate report loaded.</p>
      <p>Run <strong>CodeClimate: Open Report(s)</strong> from the command palette,<br>
         or right-click a <code>.json</code> file in the explorer.</p>
    </div>

    <div id="main-content" style="display:none">
      <div id="charts-row">
        <div class="chart-card">
          <h3>By Severity</h3>
          <canvas id="chart-severity"></canvas>
        </div>
        <div class="chart-card">
          <h3>By Category</h3>
          <canvas id="chart-category"></canvas>
        </div>
        <div class="chart-card">
          <h3>Top Check Names</h3>
          <canvas id="chart-checkname"></canvas>
        </div>
      </div>

      <div id="filters">
        <div id="filter-severity"></div>
        <div id="filter-sourcefile"></div>
        <input type="text" id="filter-search" placeholder="Search description, check name, path…">
      </div>

      <div id="table-container">
        <table id="issues-table">
          <thead>
            <tr>
              <th data-col="severity">Severity</th>
              <th data-col="sourceFile">Source File</th>
              <th data-col="path">Path</th>
              <th data-col="line">Line</th>
              <th data-col="check_name">Check Name</th>
              <th data-col="description">Description</th>
              <th data-col="categories">Categories</th>
            </tr>
          </thead>
          <tbody id="issues-tbody"></tbody>
        </table>
        <div id="table-footer"></div>
      </div>
    </div>
  </div>

  <script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
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
  | { type: 'removeSourceFile'; uri: string };

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}
