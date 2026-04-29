import * as vscode from 'vscode';
import { IssueManager } from './issueManager';

export class SourcesViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'codeclimateVisualiser.sourcesView';

  private view?: vscode.WebviewView;

  constructor(private readonly issueManager: IssueManager) {
    issueManager.onChange(() => this.update());
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.onDidReceiveMessage(async (msg: { type: string; uri?: string; command?: string }) => {
      if (msg.type === 'removeSource' && msg.uri) {
        this.issueManager.removeFile(msg.uri);
      } else if (msg.type === 'command' && msg.command) {
        await vscode.commands.executeCommand(msg.command);
      }
    });
    this.update();
  }

  private update(): void {
    if (!this.view) return;
    this.view.webview.html = this.buildHtml();
  }

  private buildHtml(): string {
    const files = this.issueManager.getFileInfos();
    const nonce = getNonce();

    const fileRows = files.length === 0
      ? '<p class="empty">No reports loaded.</p>'
      : files.map(f => `
        <div class="source-item">
          <span class="source-name" title="${esc(f.uri)}">${esc(f.filename)}<span class="count">&nbsp;${f.issueCount}</span></span>
          <button class="remove-btn" data-uri="${esc(f.uri)}" title="Remove">×</button>
        </div>`).join('');

    const clearBtn = files.length > 0
      ? `<button class="btn btn-secondary" data-cmd="codeclimateVisualiser.clearAll">Clear All</button>`
      : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); }
    .actions { display: flex; flex-direction: column; gap: 4px; padding: 8px; border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, #333); }
    .btn { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 5px 8px; border-radius: 2px; cursor: pointer; font-size: inherit; text-align: left; width: 100%; }
    .btn:hover { background: var(--vscode-button-hoverBackground); }
    .btn-secondary { background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-button-secondaryForeground, #ccc); }
    .btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
    .section-title { font-size: 0.75em; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; opacity: 0.5; padding: 8px 8px 2px; }
    .sources { padding: 2px 0; }
    .source-item { display: flex; align-items: center; padding: 3px 8px; gap: 4px; }
    .source-item:hover { background: var(--vscode-list-hoverBackground); }
    .source-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.9em; }
    .count { opacity: 0.55; font-size: 0.88em; font-variant-numeric: tabular-nums; }
    .remove-btn { background: none; border: none; color: var(--vscode-foreground); cursor: pointer; opacity: 0.35; padding: 0 2px; font-size: 1.1em; flex-shrink: 0; line-height: 1; }
    .remove-btn:hover { opacity: 1; }
    .empty { padding: 12px 8px; font-size: 0.85em; opacity: 0.5; font-style: italic; }
  </style>
</head>
<body>
  <div class="actions">
    <button class="btn" data-cmd="codeclimateVisualiser.loadFromConfig">Load from Config</button>
    <button class="btn btn-secondary" data-cmd="codeclimateVisualiser.openFiles">Open Report(s)…</button>
    ${clearBtn}
  </div>
  ${files.length > 0 ? '<div class="section-title">Loaded reports</div>' : ''}
  <div class="sources">${fileRows}</div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.querySelectorAll('[data-cmd]').forEach(btn => {
      btn.addEventListener('click', () => vscode.postMessage({ type: 'command', command: btn.dataset.cmd }));
    });
    document.querySelectorAll('.remove-btn[data-uri]').forEach(btn => {
      btn.addEventListener('click', () => vscode.postMessage({ type: 'removeSource', uri: btn.dataset.uri }));
    });
  </script>
</body>
</html>`;
  }
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getNonce(): string {
  let t = '';
  const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) t += c.charAt(Math.floor(Math.random() * c.length));
  return t;
}
