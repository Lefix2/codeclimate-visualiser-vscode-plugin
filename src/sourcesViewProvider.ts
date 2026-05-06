import * as vscode from 'vscode';
import { IssueManager } from './issueManager';
import { HistorySnapshot } from './types';

export class SourcesViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'codeclimateVisualiser.sourcesView';

  private view?: vscode.WebviewView;
  private historySnapshots: HistorySnapshot[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly issueManager: IssueManager,
    private readonly onInit: () => Promise<void>,
    private readonly onFocusIssue: (id: string) => void,
    private readonly onDeleteSnapshot: (id: string) => void,
    private readonly onOpenFile: (filePath: string, line: number) => Promise<void>,
    private readonly historyLoader?: () => HistorySnapshot[],
  ) {
    issueManager.onChange(() => this.update());
  }

  setHistory(snapshots: HistorySnapshot[]): void {
    this.historySnapshots = snapshots;
    this.update();
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    const codiconsDistUri = vscode.Uri.joinPath(this.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist');
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [codiconsDistUri],
    };
    webviewView.webview.html = this.buildHtml(webviewView.webview);

    if (this.historyLoader) {
      this.historySnapshots = this.historyLoader();
    }

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        if (this.historyLoader) this.historySnapshots = this.historyLoader();
        this.update();
      }
    });

    webviewView.webview.onDidReceiveMessage(async (msg: {
      type: string; uri?: string; command?: string; id?: string; path?: string; line?: number;
    }) => {
      if (msg.type === 'ready') {
        this.update();
      } else if (msg.type === 'removeSource' && msg.uri) {
        this.issueManager.removeFile(msg.uri);
      } else if (msg.type === 'command' && msg.command) {
        await vscode.commands.executeCommand(msg.command);
      } else if (msg.type === 'focusIssue' && msg.id) {
        this.onFocusIssue(msg.id);
      } else if (msg.type === 'openFile' && msg.path) {
        await this.onOpenFile(msg.path, msg.line ?? 1);
      } else if (msg.type === 'deleteSnapshot' && msg.id) {
        this.onDeleteSnapshot(msg.id);
      } else if (msg.type === 'openSourceFile' && msg.uri) {
        await vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(msg.uri));
      }
    });

    this.onInit();
  }

  private update(): void {
    if (!this.view?.visible) return;
    const files = this.issueManager.getFileInfos();
    const issues = this.issueManager.getAllIssues().map(i => ({
      id: i.id,
      severity: i.severity,
      description: i.description,
      check_name: i.check_name,
      sourceFile: i.sourceFile,
      location: i.location,
      customColumns: i.customColumns,
    }));
    const customColumns = this.issueManager.getCustomColumns();
    this.view.webview.postMessage({ type: 'update', files, issues, customColumns, history: this.historySnapshots });
  }

  private buildHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const codiconsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css')
    );
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${codiconsUri}">
  <style>
    html, body {
      height: 100%; overflow: hidden;
      margin: 0; padding: 0;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
    }
    *, *::before, *::after { box-sizing: border-box; }
    body { display: flex; flex-direction: column; }

    /* ── Top action ─────────────────────────── */
    .actions { flex-shrink: 0; padding: 6px 8px; }
    .btn {
      display: block; width: 100%; padding: 4px 10px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none; border-radius: 2px; cursor: pointer;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      text-align: center;
    }
    .btn:hover { background: var(--vscode-button-hoverBackground); }

    /* ── Section layout ─────────────────────── */
    .section { flex-shrink: 0; }
    .section-stretch { flex: 1; display: flex; flex-direction: column; min-height: 80px; overflow: hidden; }
    .section-body { display: none; }
    .section-body.open { display: block; }
    .section-body-flex { display: none; flex: 1; flex-direction: column; min-height: 0; overflow: hidden; }
    .section-body-flex.open { display: flex; }

    /* ── Section header ─────────────────────── */
    .section-header {
      display: flex; align-items: center;
      height: 22px; padding: 0 4px 0 8px;
      cursor: pointer; user-select: none;
      font-size: 11px; font-weight: 700;
      letter-spacing: 0.08em; text-transform: uppercase;
      color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-foreground));
    }
    .section-header:hover { background: var(--vscode-list-hoverBackground); }
    .arrow {
      width: 16px; height: 16px; flex-shrink: 0;
      display: inline-flex; align-items: center; justify-content: center;
      margin-right: 2px;
    }
    .hdr-title { flex: 1; }
    .hdr-count {
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      border-radius: 10px; padding: 1px 6px;
      font-size: 0.82em; font-weight: 400; letter-spacing: 0;
      min-width: 18px; text-align: center;
    }

    /* ── Icon buttons ───────────────────────── */
    .icon-btn {
      background: none; border: none;
      color: var(--vscode-foreground);
      cursor: pointer; padding: 1px 2px;
      display: inline-flex; align-items: center; justify-content: center;
      flex-shrink: 0; border-radius: 2px; line-height: 0;
    }
    .icon-btn:hover { background: var(--vscode-toolbar-hoverBackground); }
    .hdr-more { margin-left: 2px; }
    .hdr-more:hover { background: var(--vscode-toolbar-hoverBackground); }
    .hdr-more.active { color: var(--vscode-button-background); }
    .section-header:not(.expanded) .hdr-more { display: none; }

    /* ── Sources list ───────────────────────── */
    .source-item { display: flex; align-items: center; height: 22px; padding: 0 8px; gap: 4px; }
    .source-item:hover { background: var(--vscode-list-hoverBackground); }
    .close-btn { opacity: 0.25; transition: opacity 0.1s; }
    .source-item:hover .close-btn { opacity: 0.65; }
    .source-item:hover .close-btn:hover { opacity: 1; }
    .source-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .count { opacity: 0.55; font-variant-numeric: tabular-nums; }
    .load-link {
      display: flex; align-items: center; height: 22px; padding: 0 8px 0 22px;
      background: none; border: none; width: 100%; cursor: pointer; text-align: left;
      font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
      color: var(--vscode-textLink-foreground, var(--vscode-button-background));
    }
    .load-link:hover { background: var(--vscode-list-hoverBackground); }

    /* ── Issues list ────────────────────────── */
    #issues-list { flex: 1; overflow-y: auto; min-height: 0; }
    .issue-item {
      display: flex; align-items: center; height: 22px; gap: 4px;
      padding: 0 4px 0 22px; cursor: pointer;
    }
    .issue-item:hover { background: var(--vscode-list-hoverBackground); }
    .sev-dot { flex-shrink: 0; width: 8px; height: 8px; border-radius: 50%; }
    .issue-desc { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .issue-loc { flex-shrink: 0; opacity: 0.5; font-size: 0.85em; }
    .focus-btn { opacity: 0; transition: opacity 0.1s; }
    .issue-item:hover .focus-btn { opacity: 0.5; }
    .issue-item:hover .focus-btn:hover { opacity: 1; }
    .more-issues {
      height: 22px; display: flex; align-items: center; padding: 0 8px 0 22px;
      opacity: 0.5; font-style: italic; flex-shrink: 0;
    }

    /* ── File mode items ────────────────────── */
    .issue-main { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .check-part { flex-shrink: 0; }
    .desc-part { color: var(--vscode-descriptionForeground); }
    .file-mode-item .focus-btn { opacity: 0.35; }
    .file-mode-item .focus-btn:hover { opacity: 1; }

    /* ── File / folder groups ───────────────── */
    .file-group-hdr, .tree-node-hdr {
      display: flex; align-items: center; height: 22px; padding: 0 8px;
      cursor: pointer; user-select: none;
    }
    .file-group-hdr:hover, .tree-node-hdr:hover { background: var(--vscode-list-hoverBackground); }
    .file-icon {
      display: inline-flex; align-items: center; justify-content: center;
      width: 16px; height: 16px; flex-shrink: 0; margin-right: 4px;
    }
    .file-group-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .file-group-body { display: none; }
    .file-group-body.open { display: block; }
    .file-group-body .file-mode-item { padding: 0 4px 0 28px; }

    /* ── Filter dropdown ────────────────────── */
    #filter-dropdown { width: 214px; }
    .filter-section-lbl {
      padding: 4px 10px 2px; font-size: 10px; font-weight: 700;
      letter-spacing: 0.06em; text-transform: uppercase; opacity: 0.5; user-select: none;
    }
    .filter-sev-item {
      display: flex; align-items: center; height: 24px; padding: 0 10px; gap: 6px;
      cursor: pointer; color: var(--vscode-menu-foreground, var(--vscode-foreground)); user-select: none;
    }
    .filter-sev-item:hover { background: var(--vscode-list-hoverBackground); }
    .filter-sev-item input[type="checkbox"] { margin: 0; cursor: pointer; accent-color: var(--vscode-button-background); }
    .filter-input-wrap { padding: 2px 8px; }
    .filter-input {
      width: 100%; padding: 3px 6px;
      background: var(--vscode-input-background); color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.3));
      border-radius: 2px; outline: none;
      font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
    }
    .filter-input:focus { border-color: var(--vscode-focusBorder); }
    .filter-clear-btn {
      display: block; width: calc(100% - 16px); margin: 4px 8px 2px;
      padding: 3px 8px; cursor: pointer;
      background: none; border: 1px solid rgba(128,128,128,0.3);
      color: var(--vscode-foreground); border-radius: 2px;
      font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); text-align: center;
    }
    .filter-clear-btn:hover { background: var(--vscode-list-hoverBackground); }

    /* ── Dropdowns ──────────────────────────── */
    .dropdown {
      position: fixed;
      background: var(--vscode-menu-background, var(--vscode-editorWidget-background, var(--vscode-editor-background)));
      border: 1px solid var(--vscode-menu-border, var(--vscode-contrastBorder, rgba(128,128,128,0.3)));
      border-radius: 3px; padding: 4px 0; z-index: 1000; min-width: 160px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.2); display: none;
    }
    .dropdown.open { display: block; }
    .dropdown-item {
      display: flex; align-items: center; height: 24px; padding: 0 10px; gap: 8px;
      cursor: pointer; color: var(--vscode-menu-foreground, var(--vscode-foreground));
      font-size: var(--vscode-font-size); font-family: var(--vscode-font-family); user-select: none;
    }
    .dropdown-item:hover {
      background: var(--vscode-menu-selectionBackground, var(--vscode-list-activeSelectionBackground));
      color: var(--vscode-menu-selectionForeground, var(--vscode-list-activeSelectionForeground));
    }
    .dropdown-check { width: 14px; text-align: center; font-size: 0.9em; }
    .dropdown-sep { height: 1px; background: var(--vscode-menu-separatorBackground, rgba(128,128,128,0.2)); margin: 4px 0; }

    /* ── Empty state ────────────────────────── */
    #empty-msg { padding: 8px; opacity: 0.5; font-style: italic; }

    /* ── History section ────────────────────── */
    .snap-item {
      display: flex; align-items: flex-start; padding: 4px 8px 4px 22px; gap: 4px;
      cursor: default; flex-direction: column;
    }
    .snap-item:hover { background: var(--vscode-list-hoverBackground); }
    .snap-row1 { display: flex; align-items: center; width: 100%; gap: 4px; }
    .snap-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
    .snap-date { opacity: 0.5; font-size: 0.82em; flex-shrink: 0; }
    .snap-total { font-variant-numeric: tabular-nums; flex-shrink: 0; }
    .snap-delete { opacity: 0; transition: opacity 0.1s; flex-shrink: 0; }
    .snap-item:hover .snap-delete { opacity: 0.45; }
    .snap-item:hover .snap-delete:hover { opacity: 1; }
    .snap-diff { display: flex; gap: 6px; font-size: 0.82em; opacity: 0.75; margin-top: 1px; }
    .snap-diff .new  { color: #f87171; }
    .snap-diff .fixed { color: #4ade80; }
    .snap-empty { padding: 6px 8px 6px 22px; opacity: 0.5; font-style: italic; font-size: 0.9em; }
    #history-body { max-height: 128px; overflow-y: auto; }
  </style>
</head>
<body>
  <div class="actions">
    <button class="btn" id="btn-view">Open View</button>
  </div>

  <div id="sources-section" class="section" style="display:none">
    <div class="section-header expanded" id="sources-header">
      <span class="arrow" id="sources-arrow"></span>
      <span class="hdr-title">Reports</span>
      <span class="hdr-count" id="sources-count"></span>
      <button class="icon-btn hdr-more" id="btn-reload-config" title="Reload Config"><i class="codicon codicon-refresh"></i></button>
    </div>
    <div class="section-body open" id="sources-body">
      <div id="sources-list"></div>
      <button class="load-link" id="btn-open">+ Load report…</button>
    </div>
  </div>

  <div id="issues-section" class="section section-stretch" style="display:none">
    <div class="section-header expanded" id="issues-header">
      <span class="arrow" id="issues-arrow"></span>
      <span class="hdr-title">Issues</span>
      <span class="hdr-count" id="issues-count"></span>
      <button class="icon-btn hdr-more" id="btn-collapse-all" title="Collapse All"><i class="codicon codicon-collapse-all"></i></button>
      <button class="icon-btn hdr-more" id="btn-filter" title="Filter"><i class="codicon codicon-filter"></i></button>
      <button class="icon-btn hdr-more" id="btn-sort" title="Sort"><i class="codicon codicon-sort-precedence"></i></button>
      <button class="icon-btn hdr-more" id="btn-more" title="View options"><i class="codicon codicon-ellipsis"></i></button>
    </div>
    <div class="section-body-flex open" id="issues-body">
      <div id="issues-list"></div>
    </div>
  </div>

  <!-- Filter dropdown -->
  <div class="dropdown" id="filter-dropdown">
    <div class="filter-section-lbl">Severity</div>
    <label class="filter-sev-item"><input type="checkbox" class="filter-sev-cb" value="blocker"><span class="sev-dot" style="background:#7b1fa2"></span><span>Blocker</span></label>
    <label class="filter-sev-item"><input type="checkbox" class="filter-sev-cb" value="critical"><span class="sev-dot" style="background:#e53935"></span><span>Critical</span></label>
    <label class="filter-sev-item"><input type="checkbox" class="filter-sev-cb" value="major"><span class="sev-dot" style="background:#f4511e"></span><span>Major</span></label>
    <label class="filter-sev-item"><input type="checkbox" class="filter-sev-cb" value="minor"><span class="sev-dot" style="background:#f9a825"></span><span>Minor</span></label>
    <label class="filter-sev-item"><input type="checkbox" class="filter-sev-cb" value="info"><span class="sev-dot" style="background:#78909c"></span><span>Info</span></label>
    <div class="dropdown-sep"></div>
    <div class="filter-section-lbl">Check Name</div>
    <div class="filter-input-wrap"><input class="filter-input" type="text" id="fcheck" placeholder="Filter…"></div>
    <div class="dropdown-sep"></div>
    <div class="filter-section-lbl">File Name</div>
    <div class="filter-input-wrap"><input class="filter-input" type="text" id="ffile" placeholder="Filter…"></div>
    <div id="filter-custom-cols"></div>
    <div class="dropdown-sep"></div>
    <button class="filter-clear-btn" id="btn-filter-clear">Clear filters</button>
  </div>

  <!-- Sort dropdown -->
  <div class="dropdown" id="sort-dropdown">
    <div class="dropdown-item" id="menu-sort-severity"><span class="dropdown-check" id="check-sort-severity"></span><span>Sort by Severity</span></div>
    <div class="dropdown-item" id="menu-sort-checkname"><span class="dropdown-check" id="check-sort-checkname"></span><span>Sort by Check Name</span></div>
    <div class="dropdown-item" id="menu-sort-filename"><span class="dropdown-check" id="check-sort-filename"></span><span>Sort by File Name</span></div>
  </div>

  <!-- Group/view dropdown -->
  <div class="dropdown" id="group-dropdown">
    <div class="dropdown-item" id="menu-by-issue"><span class="dropdown-check" id="check-issue"></span><span>View by issue</span></div>
    <div class="dropdown-item" id="menu-by-file"><span class="dropdown-check" id="check-file"></span><span>View by file</span></div>
    <div class="dropdown-item" id="menu-by-tree"><span class="dropdown-check" id="check-tree"></span><span>Tree view</span></div>
  </div>

  <div id="empty-msg">No reports loaded.</div>

  <div id="history-section" class="section" style="display:none">
    <div class="section-header expanded" id="history-header">
      <span class="arrow" id="history-arrow"></span>
      <span class="hdr-title">History</span>
      <span class="hdr-count" id="history-count"></span>
      <button class="icon-btn hdr-more" id="btn-save-snapshot" title="Save Snapshot"><i class="codicon codicon-tag"></i></button>
    </div>
    <div class="section-body open" id="history-body">
      <div id="history-list"></div>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const SEV = { blocker:'#7b1fa2', critical:'#e53935', major:'#f4511e', minor:'#f9a825', info:'#78909c' };
    const SEV_ORDER = ['blocker', 'critical', 'major', 'minor', 'info'];
    let groupBy = 'file';
    let lastIssues = [];
    let sortBy  = 'severity';  // 'severity' | 'checkname' | 'filename'
    let sortDir = 'asc';       // 'asc' | 'desc'
    let filters = { severities: new Set(), checkName: '', fileName: '', custom: {} };
    let customColumnDefs = [];  // CustomColumn[] from last update

    // ── SVG icons (tree only — header buttons use codicons) ──────────────
    const ICONS = {
      chevronRight: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="5.5,3 10.5,8 5.5,13"/></svg>',
      chevronDown:  '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3,5.5 8,10.5 13,5.5"/></svg>',
      close:        '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><line x1="3.5" y1="3.5" x2="12.5" y2="12.5"/><line x1="12.5" y1="3.5" x2="3.5" y2="12.5"/></svg>',
      focusTable:   '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="12" height="10" rx="1"/><line x1="2" y1="7" x2="14" y2="7"/><line x1="6" y1="3" x2="6" y2="13"/></svg>',
      folder:       '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 4C1.5 3.45 1.95 3 2.5 3H5.5L7 4.5H11.5C12.05 4.5 12.5 4.95 12.5 5.5V10.5C12.5 11.05 12.05 11.5 11.5 11.5H2.5C1.95 11.5 1.5 11.05 1.5 10.5V4z"/></svg>',
    };

    // ── Helpers ──────────────────────────────────────────────────────────
    function maxSev(issues) {
      for (const sev of SEV_ORDER) {
        if (issues.some(i => i.severity === sev)) return sev;
      }
      return 'info';
    }
    function fileIcon(color) {
      return '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="' + color +
        '" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M8 1H2.5C1.95 1 1.5 1.45 1.5 2v10c0 .55.45 1 1 1h8c.55 0 1-.45 1-1V5L8 1z"/>' +
        '<polyline points="8,1 8,5 11.5,5"/></svg>';
    }
    function extractLine(raw) {
      if (!raw && raw !== 0) return undefined;
      return typeof raw === 'object' ? raw.line : raw;
    }
    function getIssueLine(issue) {
      const raw = issue.location && (
        (issue.location.positions && issue.location.positions.begin &&
          issue.location.positions.begin.line) ||
        (issue.location.lines && issue.location.lines.begin)
      );
      return extractLine(raw) || 0;
    }

    // ── Custom column value resolution (mirrors webview.js) ──────────────
    function getNestedField(obj, path) {
      return path.split('.').reduce((o, k) => (o != null ? o[k] : undefined), obj);
    }
    function getSidebarCustomValue(issue, colDef) {
      if (colDef.fromField && colDef.fieldRegex) {
        const fieldVal = String(getNestedField(issue, colDef.fromField) ?? '');
        const match = fieldVal.match(new RegExp(colDef.fieldRegex));
        if (match) return match[(colDef.captureGroup ?? 0) + 1] ?? '';
        return '';
      }
      return (issue.customColumns ?? {})[colDef.name] ?? '';
    }

    // ── Filter logic ─────────────────────────────────────────────────────
    function filtersActive() {
      return filters.severities.size > 0 || filters.checkName !== '' || filters.fileName !== '' ||
        Object.values(filters.custom).some(v => v !== '');
    }
    function applyFilters(issues) {
      if (!filtersActive()) return issues;
      return issues.filter(i => {
        if (filters.severities.size > 0 && !filters.severities.has(i.severity)) return false;
        if (filters.checkName && !(i.check_name || '').toLowerCase().includes(filters.checkName.toLowerCase())) return false;
        if (filters.fileName) {
          const p = (i.location && i.location.path) || '';
          if (!p.toLowerCase().includes(filters.fileName.toLowerCase())) return false;
        }
        for (const [col, val] of Object.entries(filters.custom)) {
          if (!val) continue;
          const colDef = customColumnDefs.find(c => c.name === col);
          const colVal = colDef ? getSidebarCustomValue(i, colDef) : ((i.customColumns && i.customColumns[col]) || '');
          if (!colVal.toLowerCase().includes(val.toLowerCase())) return false;
        }
        return true;
      });
    }
    function updateFilterBtn() {
      const active = filtersActive();
      document.getElementById('btn-filter').classList.toggle('active', active);
      document.getElementById('btn-filter').title = active ? 'Filters active' : 'Filter';
    }
    function rebuildCustomFilterInputs(customColumns) {
      customColumnDefs = customColumns || [];
      const container = document.getElementById('filter-custom-cols');
      container.innerHTML = '';
      const visible = customColumnDefs.filter(c => c.showFilter !== false);
      for (const col of visible) {
        const sep = document.createElement('div'); sep.className = 'dropdown-sep';
        const lbl = document.createElement('div'); lbl.className = 'filter-section-lbl';
        lbl.textContent = col.name;
        const wrap = document.createElement('div'); wrap.className = 'filter-input-wrap';
        const inp = document.createElement('input');
        inp.className = 'filter-input'; inp.type = 'text'; inp.placeholder = 'Filter…';
        inp.value = filters.custom[col.name] || '';
        inp.dataset.col = col.name;
        inp.addEventListener('input', e => {
          filters.custom[e.target.dataset.col] = e.target.value;
          updateFilterBtn(); renderIssues(lastIssues);
        });
        wrap.appendChild(inp);
        container.appendChild(sep); container.appendChild(lbl); container.appendChild(wrap);
      }
    }

    // ── Sort logic ───────────────────────────────────────────────────────
    function sevRank(s) {
      const r = SEV_ORDER.indexOf(s);
      return r < 0 ? SEV_ORDER.length : r;
    }
    function applySort(issues) {
      if (!sortBy) return issues;
      const dir = sortDir === 'asc' ? 1 : -1;
      return [...issues].sort((a, b) => {
        if (sortBy === 'severity') return dir * (sevRank(a.severity) - sevRank(b.severity));
        if (sortBy === 'checkname') return dir * (a.check_name || '').localeCompare(b.check_name || '');
        if (sortBy === 'filename') {
          const fa = (a.location && a.location.path) || '';
          const fb = (b.location && b.location.path) || '';
          return dir * fa.localeCompare(fb);
        }
        return 0;
      });
    }
    function updateSortMenu() {
      const dir = sortDir === 'asc' ? ' ↑' : ' ↓';
      document.getElementById('check-sort-severity').textContent  = sortBy === 'severity'  ? dir : '';
      document.getElementById('check-sort-checkname').textContent = sortBy === 'checkname' ? dir : '';
      document.getElementById('check-sort-filename').textContent  = sortBy === 'filename'  ? dir : '';
    }
    updateSortMenu();

    // ── Button handlers ──────────────────────────────────────────────────
    document.getElementById('btn-view').addEventListener('click', () =>
      vscode.postMessage({ type: 'command', command: 'codeclimateVisualiser.openView' }));
    document.getElementById('btn-open').addEventListener('click', e => {
      e.stopPropagation();
      vscode.postMessage({ type: 'command', command: 'codeclimateVisualiser.openFiles' });
    });

    // ── Filter dropdown ──────────────────────────────────────────────────
    const btnFilter      = document.getElementById('btn-filter');
    const filterDropdown = document.getElementById('filter-dropdown');

    btnFilter.addEventListener('click', e => {
      e.stopPropagation();
      const rect = btnFilter.getBoundingClientRect();
      filterDropdown.style.left = Math.max(0, rect.right - 214) + 'px';
      filterDropdown.style.top  = (rect.bottom + 2) + 'px';
      filterDropdown.classList.toggle('open');
      document.getElementById('sort-dropdown').classList.remove('open');
      document.getElementById('group-dropdown').classList.remove('open');
    });
    filterDropdown.addEventListener('click', e => e.stopPropagation());

    document.querySelectorAll('.filter-sev-cb').forEach(cb => {
      cb.addEventListener('change', () => {
        if (cb.checked) filters.severities.add(cb.value);
        else filters.severities.delete(cb.value);
        updateFilterBtn(); renderIssues(lastIssues);
      });
    });
    document.getElementById('fcheck').addEventListener('input', e => {
      filters.checkName = e.target.value; updateFilterBtn(); renderIssues(lastIssues);
    });
    document.getElementById('ffile').addEventListener('input', e => {
      filters.fileName = e.target.value; updateFilterBtn(); renderIssues(lastIssues);
    });
    document.getElementById('btn-filter-clear').addEventListener('click', () => {
      filters.severities.clear(); filters.checkName = ''; filters.fileName = ''; filters.custom = {};
      document.querySelectorAll('.filter-sev-cb').forEach(cb => cb.checked = false);
      document.getElementById('fcheck').value = '';
      document.getElementById('ffile').value  = '';
      document.querySelectorAll('#filter-custom-cols .filter-input').forEach(inp => inp.value = '');
      updateFilterBtn(); renderIssues(lastIssues);
      filterDropdown.classList.remove('open');
    });

    // ── Sort dropdown ────────────────────────────────────────────────────
    const btnSort    = document.getElementById('btn-sort');
    const sortDropdown = document.getElementById('sort-dropdown');

    btnSort.addEventListener('click', e => {
      e.stopPropagation();
      const rect = btnSort.getBoundingClientRect();
      sortDropdown.style.left = Math.max(0, rect.right - 180) + 'px';
      sortDropdown.style.top  = (rect.bottom + 2) + 'px';
      sortDropdown.classList.toggle('open');
      filterDropdown.classList.remove('open');
      document.getElementById('group-dropdown').classList.remove('open');
    });

    function setSortBy(key) {
      if (sortBy === key) {
        sortDir = sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        sortBy  = key;
        sortDir = 'asc';
      }
      updateSortMenu();
      sortDropdown.classList.remove('open');
      renderIssues(lastIssues);
    }
    document.getElementById('menu-sort-severity').addEventListener('click',  () => setSortBy('severity'));
    document.getElementById('menu-sort-checkname').addEventListener('click', () => setSortBy('checkname'));
    document.getElementById('menu-sort-filename').addEventListener('click',  () => setSortBy('filename'));

    // ── Group/view dropdown ──────────────────────────────────────────────
    const btnMore  = document.getElementById('btn-more');
    const dropdown = document.getElementById('group-dropdown');

    function updateGroupMenu() {
      document.getElementById('check-issue').textContent = groupBy === 'issue' ? '✓' : '';
      document.getElementById('check-file').textContent  = groupBy === 'file'  ? '✓' : '';
      document.getElementById('check-tree').textContent  = groupBy === 'tree'  ? '✓' : '';
    }
    updateGroupMenu();

    btnMore.addEventListener('click', e => {
      e.stopPropagation();
      const rect = btnMore.getBoundingClientRect();
      dropdown.style.left = Math.max(0, rect.right - 164) + 'px';
      dropdown.style.top  = (rect.bottom + 2) + 'px';
      dropdown.classList.toggle('open');
      sortDropdown.classList.remove('open');
      filterDropdown.classList.remove('open');
    });
    document.addEventListener('click', () => {
      dropdown.classList.remove('open');
      sortDropdown.classList.remove('open');
      filterDropdown.classList.remove('open');
    });
    document.getElementById('menu-by-issue').addEventListener('click', () => {
      groupBy = 'issue'; updateGroupMenu(); dropdown.classList.remove('open'); renderIssues(lastIssues);
    });
    document.getElementById('menu-by-file').addEventListener('click', () => {
      groupBy = 'file'; updateGroupMenu(); dropdown.classList.remove('open'); renderIssues(lastIssues);
    });
    document.getElementById('menu-by-tree').addEventListener('click', () => {
      groupBy = 'tree'; updateGroupMenu(); dropdown.classList.remove('open'); renderIssues(lastIssues);
    });

    // ── Collapsible sections ─────────────────────────────────────────────
    function wireToggle(headerId, bodyId, arrowId) {
      const hdr   = document.getElementById(headerId);
      const body  = document.getElementById(bodyId);
      const arrow = document.getElementById(arrowId);
      if (arrow) arrow.innerHTML = hdr.classList.contains('expanded') ? ICONS.chevronDown : ICONS.chevronRight;
      hdr.addEventListener('click', () => {
        const open = hdr.classList.toggle('expanded');
        body.classList.toggle('open', open);
        if (arrow) arrow.innerHTML = open ? ICONS.chevronDown : ICONS.chevronRight;
      });
    }
    wireToggle('sources-header', 'sources-body', 'sources-arrow');
    wireToggle('issues-header',  'issues-body',  'issues-arrow');
    wireToggle('history-header', 'history-body', 'history-arrow');

    // ── Reload config button ────────────────────────────────────────────
    document.getElementById('btn-reload-config').addEventListener('click', e => {
      e.stopPropagation();
      vscode.postMessage({ type: 'command', command: 'codeclimateVisualiser.reloadConfig' });
    });

    // ── Save snapshot button ─────────────────────────────────────────────
    document.getElementById('btn-save-snapshot').addEventListener('click', e => {
      e.stopPropagation();
      vscode.postMessage({ type: 'command', command: 'codeclimateVisualiser.saveSnapshot' });
    });

    // ── Collapse all button ───────────────────────────────────────────────
    document.getElementById('btn-collapse-all').addEventListener('click', e => {
      e.stopPropagation();
      const list = document.getElementById('issues-list');
      list.querySelectorAll('.file-group-hdr.expanded, .tree-node-hdr.expanded').forEach(hdr => {
        hdr.classList.remove('expanded');
        const arrow = hdr.querySelector('.arrow');
        if (arrow) arrow.innerHTML = ICONS.chevronRight;
      });
      list.querySelectorAll('.file-group-body.open').forEach(body => body.classList.remove('open'));
    });

    // ── Data updates ─────────────────────────────────────────────────────
    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.type === 'update') {
        rebuildCustomFilterInputs(msg.customColumns || []);
        renderSources(msg.files    || []);
        renderIssues (msg.issues   || []);
        renderHistory(msg.history  || []);
      }
    });

    // ── Sources ──────────────────────────────────────────────────────────
    function renderSources(files) {
      const section = document.getElementById('sources-section');
      const list    = document.getElementById('sources-list');
      const empty   = document.getElementById('empty-msg');
      const count   = document.getElementById('sources-count');
      section.style.display = files.length ? '' : 'none';
      empty.style.display   = files.length ? 'none' : '';
      count.textContent = files.length;
      list.innerHTML = '';
      for (const f of files) {
        const item = document.createElement('div');
        item.className = 'source-item';
        const rm = document.createElement('button');
        rm.className = 'icon-btn close-btn'; rm.title = 'Remove'; rm.innerHTML = ICONS.close;
        rm.addEventListener('click', e => {
          e.stopPropagation();
          vscode.postMessage({ type: 'removeSource', uri: f.uri });
        });
        const name = document.createElement('span');
        name.className = 'source-name'; name.title = 'Open file'; name.textContent = f.filename;
        name.style.cursor = 'pointer';
        name.addEventListener('click', e => {
          e.stopPropagation();
          vscode.postMessage({ type: 'openSourceFile', uri: f.uri });
        });
        const cnt = document.createElement('span');
        cnt.className = 'count'; cnt.textContent = f.issueCount;
        item.appendChild(rm); item.appendChild(name); item.appendChild(cnt);
        list.appendChild(item);
      }
    }

    // ── History ──────────────────────────────────────────────────────────
    function renderHistory(snapshots) {
      const section = document.getElementById('history-section');
      const list    = document.getElementById('history-list');
      const count   = document.getElementById('history-count');
      section.style.display = '';
      count.textContent = snapshots.length;
      list.innerHTML = '';

      if (snapshots.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'snap-empty';
        empty.textContent = 'No snapshots yet.';
        list.appendChild(empty);
        return;
      }

      // Newest first
      const sorted = [...snapshots].sort((a, b) => b.timestamp.localeCompare(a.timestamp));

      sorted.forEach((snap, idx) => {
        const prev = sorted[idx + 1];
        const item = document.createElement('div');
        item.className = 'snap-item';

        // Row 1: label + date + delete
        const row1 = document.createElement('div');
        row1.className = 'snap-row1';

        const labelSpan = document.createElement('span');
        labelSpan.className = 'snap-label';
        labelSpan.title = snap.sources ? snap.sources.join(', ') : '';
        labelSpan.textContent = snap.label || new Date(snap.timestamp).toLocaleString(undefined, { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });

        const dateSpan = document.createElement('span');
        dateSpan.className = 'snap-date';
        if (snap.label) dateSpan.textContent = new Date(snap.timestamp).toLocaleDateString(undefined, { month:'short', day:'numeric' });

        const totalSpan = document.createElement('span');
        totalSpan.className = 'snap-total';
        totalSpan.textContent = snap.total;

        const delBtn = document.createElement('button');
        delBtn.className = 'icon-btn snap-delete'; delBtn.title = 'Delete snapshot';
        delBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><line x1="3" y1="3" x2="11" y2="11"/><line x1="11" y1="3" x2="3" y2="11"/></svg>';
        delBtn.addEventListener('click', e => {
          e.stopPropagation();
          vscode.postMessage({ type: 'deleteSnapshot', id: snap.id });
        });

        row1.appendChild(labelSpan);
        row1.appendChild(dateSpan);
        row1.appendChild(totalSpan);
        row1.appendChild(delBtn);
        item.appendChild(row1);

        // Row 2: diff vs next-older snapshot
        if (prev) {
          const prevSet = new Set(prev.fingerprints || []);
          const currSet = new Set(snap.fingerprints || []);
          const newCount  = (snap.fingerprints || []).filter(fp => !prevSet.has(fp)).length;
          const fixedCount = (prev.fingerprints || []).filter(fp => !currSet.has(fp)).length;
          if (newCount > 0 || fixedCount > 0) {
            const diff = document.createElement('div');
            diff.className = 'snap-diff';
            if (newCount  > 0) { const s = document.createElement('span'); s.className = 'new';   s.textContent = '+' + newCount + ' new'; diff.appendChild(s); }
            if (fixedCount > 0) { const s = document.createElement('span'); s.className = 'fixed'; s.textContent = '-' + fixedCount + ' fixed'; diff.appendChild(s); }
            if (snap.derivedCount > 0) {
              const w = document.createElement('span'); w.style.opacity = '0.55'; w.title = snap.derivedCount + ' issues tracked via derived fingerprint (may be inaccurate if code moved)'; w.textContent = '⚠';
              diff.appendChild(w);
            }
            item.appendChild(diff);
          }
        }

        list.appendChild(item);
      });
    }

    // ── Issue item builders ──────────────────────────────────────────────
    function makeIssueItem(issue, showFile) {
      const p      = (issue.location && issue.location.path) || '';
      const file   = p.split('/').pop() || '';
      const lineNum = getIssueLine(issue);

      const item = document.createElement('div');
      item.className = 'issue-item';
      item.title = issue.description || '';

      const dot = document.createElement('span');
      dot.className = 'sev-dot';
      dot.style.background = SEV[issue.severity] || SEV.info;

      const desc = document.createElement('span');
      desc.className = 'issue-desc';
      desc.textContent = issue.check_name || issue.description || '';

      const loc = document.createElement('span');
      loc.className = 'issue-loc';
      loc.textContent = (showFile ? file : '') + (lineNum > 0 ? ':' + lineNum : '');

      const focusBtn = document.createElement('button');
      focusBtn.className = 'icon-btn focus-btn'; focusBtn.title = 'Focus in table';
      focusBtn.innerHTML = ICONS.focusTable;
      focusBtn.addEventListener('click', e => {
        e.stopPropagation();
        vscode.postMessage({ type: 'focusIssue', id: issue.id });
      });

      item.appendChild(dot); item.appendChild(desc); item.appendChild(loc); item.appendChild(focusBtn);
      item.addEventListener('click', () => {
        if (p) vscode.postMessage({ type: 'openFile', path: p, line: lineNum || 1 });
      });
      return item;
    }

    function makeFileIssueItem(issue) {
      const p       = (issue.location && issue.location.path) || '';
      const lineNum = getIssueLine(issue);

      const item = document.createElement('div');
      item.className = 'issue-item file-mode-item';
      item.title = p + (lineNum > 0 ? '\\nLine ' + lineNum : '');

      const dot = document.createElement('span');
      dot.className = 'sev-dot';
      dot.style.background = SEV[issue.severity] || SEV.info;

      const main = document.createElement('span');
      main.className = 'issue-main';

      const checkPart = document.createElement('span');
      checkPart.className = 'check-part';
      checkPart.textContent = issue.check_name || '';

      const descPart = document.createElement('span');
      descPart.className = 'desc-part';
      if (issue.description) descPart.textContent = ' – ' + issue.description;

      main.appendChild(checkPart); main.appendChild(descPart);

      const focusBtn = document.createElement('button');
      focusBtn.className = 'icon-btn focus-btn'; focusBtn.title = 'Focus in table';
      focusBtn.innerHTML = ICONS.focusTable;
      focusBtn.addEventListener('click', e => {
        e.stopPropagation();
        vscode.postMessage({ type: 'focusIssue', id: issue.id });
      });

      item.appendChild(dot); item.appendChild(main); item.appendChild(focusBtn);
      item.addEventListener('click', () => {
        if (p) vscode.postMessage({ type: 'openFile', path: p, line: lineNum || 1 });
      });
      return item;
    }

    // ── Render ───────────────────────────────────────────────────────────
    function renderIssues(issues) {
      lastIssues = issues;
      const section  = document.getElementById('issues-section');
      const countEl  = document.getElementById('issues-count');
      const list     = document.getElementById('issues-list');
      if (!issues.length) { section.style.display = 'none'; list.innerHTML = ''; return; }
      section.style.display = '';
      const filtered = applyFilters(issues);
      countEl.textContent = filtersActive()
        ? filtered.length + '/' + issues.length
        : issues.length;
      const sorted = applySort(filtered);
      list.innerHTML = '';
      const frag = document.createDocumentFragment();
      if      (groupBy === 'file') renderByFile(sorted, frag);
      else if (groupBy === 'tree') renderTree(sorted, frag);
      else                         renderFlat(sorted, frag);

      list.appendChild(frag);
    }

    function renderFlat(issues, frag) {
      const shown = issues.slice(0, 500);
      for (const issue of shown) frag.appendChild(makeIssueItem(issue, true));
      if (issues.length > 500) appendMore(frag, issues.length - 500);
    }

    function renderByFile(issues, frag) {
      const groupMap = new Map();
      for (const issue of issues) {
        const p = (issue.location && issue.location.path) || '';
        if (!groupMap.has(p)) groupMap.set(p, []);
        groupMap.get(p).push(issue);
      }
      // Groups always alphabetical by path
      const groups = [...groupMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      let total = 0;
      for (const [path, groupIssues] of groups) {
        if (total >= 500) break;
        const file   = path.split('/').pop() || path || '(unknown)';
        // Issues within each file: apply active sort
        const sorted = applySort(groupIssues);

        const groupEl = document.createElement('div');
        const hdr = document.createElement('div');
        hdr.className = 'file-group-hdr';
        const arrow = document.createElement('span'); arrow.className = 'arrow'; arrow.innerHTML = ICONS.chevronRight;
        const icon  = document.createElement('span'); icon.className  = 'file-icon';
        icon.innerHTML = fileIcon(SEV[maxSev(groupIssues)] || SEV.info);
        const name = document.createElement('span'); name.className = 'file-group-name'; name.textContent = file; name.title = path;
        const cnt  = document.createElement('span'); cnt.className  = 'count'; cnt.textContent = groupIssues.length;
        hdr.appendChild(arrow); hdr.appendChild(icon); hdr.appendChild(name); hdr.appendChild(cnt);

        const body = document.createElement('div'); body.className = 'file-group-body';
        hdr.addEventListener('click', () => {
          const exp = hdr.classList.toggle('expanded');
          body.classList.toggle('open', exp);
          arrow.innerHTML = exp ? ICONS.chevronDown : ICONS.chevronRight;
        });

        for (const issue of sorted) {
          if (total >= 500) break;
          body.appendChild(makeFileIssueItem(issue));
          total++;
        }
        groupEl.appendChild(hdr); groupEl.appendChild(body);
        frag.appendChild(groupEl);
      }
      if (issues.length > 500) appendMore(frag, issues.length - 500);
    }

    // ── Tree view ────────────────────────────────────────────────────────
    function buildTree(issues) {
      const root = { name: '', path: '', isFile: false, issues: [], children: new Map(), _c: -1 };
      for (const issue of issues) {
        const p     = (issue.location && issue.location.path) || '';
        const parts = p ? p.split('/').filter(Boolean) : [];
        let node = root;
        for (let i = 0; i < parts.length - 1; i++) {
          const seg = parts[i];
          if (!node.children.has(seg)) {
            node.children.set(seg, { name: seg, path: parts.slice(0, i + 1).join('/'), isFile: false, issues: [], children: new Map(), _c: -1 });
          }
          node = node.children.get(seg);
        }
        const leaf = parts.length > 0 ? parts[parts.length - 1] : '(no path)';
        if (!node.children.has(leaf)) {
          node.children.set(leaf, { name: leaf, path: p, isFile: true, issues: [], children: new Map(), _c: -1 });
        }
        node.children.get(leaf).issues.push(issue);
      }
      return root;
    }
    function countNode(node) {
      if (node._c >= 0) return node._c;
      let c = node.issues.length;
      for (const ch of node.children.values()) c += countNode(ch);
      node._c = c; return c;
    }
    function sortedChildren(node) {
      const dirs  = [...node.children.values()].filter(n => !n.isFile).sort((a, b) => a.name.localeCompare(b.name));
      const files = [...node.children.values()].filter(n =>  n.isFile).sort((a, b) => a.name.localeCompare(b.name));
      return [...dirs, ...files];
    }

    function renderTree(issues, frag) {
      const root = buildTree(issues);
      let total = 0;

      function renderNode(node, depth, container) {
        if (total >= 500) return;
        const c = countNode(node);
        if (c === 0) return;
        const indent = 8 + depth * 14;

        const groupEl = document.createElement('div');
        const hdr   = document.createElement('div');
        hdr.className = 'tree-node-hdr';
        hdr.style.paddingLeft = indent + 'px';

        const arrow = document.createElement('span'); arrow.className = 'arrow'; arrow.innerHTML = ICONS.chevronRight;
        const icon  = document.createElement('span'); icon.className  = 'file-icon';
        icon.innerHTML = node.isFile ? fileIcon(SEV[maxSev(node.issues)] || SEV.info) : ICONS.folder;
        const name  = document.createElement('span'); name.className  = 'file-group-name';
        name.textContent = node.isFile ? node.name : node.name + '/';
        name.title = node.path;
        const cnt   = document.createElement('span'); cnt.className   = 'count'; cnt.textContent = c;
        hdr.appendChild(arrow); hdr.appendChild(icon); hdr.appendChild(name); hdr.appendChild(cnt);

        const body = document.createElement('div'); body.className = 'file-group-body';
        hdr.addEventListener('click', () => {
          const exp = hdr.classList.toggle('expanded');
          body.classList.toggle('open', exp);
          arrow.innerHTML = exp ? ICONS.chevronDown : ICONS.chevronRight;
        });

        if (node.isFile) {
          const sorted = applySort(node.issues);
          for (const issue of sorted) {
            if (total >= 500) break;
            const el = makeFileIssueItem(issue);
            el.style.paddingLeft = (indent + 16) + 'px';
            el.style.paddingRight = '4px';
            body.appendChild(el);
            total++;
          }
        } else {
          for (const child of sortedChildren(node)) renderNode(child, depth + 1, body);
        }

        groupEl.appendChild(hdr); groupEl.appendChild(body);
        container.appendChild(groupEl);
      }

      for (const child of sortedChildren(root)) renderNode(child, 0, frag);
      if (issues.length > 500) appendMore(frag, issues.length - 500);
    }

    function appendMore(frag, n) {
      const more = document.createElement('div');
      more.className = 'more-issues';
      more.textContent = '+ ' + n + ' more…';
      frag.appendChild(more);
    }

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let t = '';
  const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) t += c.charAt(Math.floor(Math.random() * c.length));
  return t;
}
