import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { IssueManager } from './issueManager';
import { DecorationProvider } from './decorationProvider';
import { CodeClimatePanel } from './webviewPanel';
import { PatternEntry, ProjectConfig } from './types';
import { SourcesViewProvider } from './sourcesViewProvider';

const logChannel = vscode.window.createOutputChannel('CodeClimate Visualiser');

function log(msg: string): void {
  logChannel.appendLine(`[${new Date().toISOString()}] ${msg}`);
}

/** Read .vscode/codeclimate-visualiser.json from the first workspace folder that has it. */
async function readProjectConfig(): Promise<ProjectConfig | null> {
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const configUri = vscode.Uri.joinPath(folder.uri, '.vscode', 'codeclimate-visualiser.json');
    try {
      const raw = await vscode.workspace.fs.readFile(configUri);
      return JSON.parse(Buffer.from(raw).toString('utf-8')) as ProjectConfig;
    } catch {
      // absent or invalid — try next folder
    }
  }
  return null;
}

interface ResolvedFile {
  uri: vscode.Uri;
  columnValues: Record<string, string>;
}

function resolveColumnValues(entry: PatternEntry, filePath: string): Record<string, string> {
  if (!entry.values) return {};
  let groups: string[] = [];
  if (entry.regex) {
    const match = path.basename(filePath).match(new RegExp(entry.regex));
    if (match) groups = Array.from(match).slice(1);
  }
  const result: Record<string, string> = {};
  for (const [col, val] of Object.entries(entry.values)) {
    if (val === null || val === undefined) {
      result[col] = '';
    } else {
      result[col] = val.replace(/\$(\d+)/g, (_, n) => groups[parseInt(n)] ?? '');
    }
  }
  return result;
}

function getRawPatterns(config: ProjectConfig | null): (string | PatternEntry)[] {
  return config?.reportPatterns?.length
    ? config.reportPatterns
    : vscode.workspace.getConfiguration('codeclimateVisualiser').get<string[]>('reportPatterns', []);
}

/** Resolve configured patterns → resolved file entries with column values. */
async function findConfiguredFiles(config: ProjectConfig | null): Promise<ResolvedFile[]> {
  const rawPatterns = getRawPatterns(config);

  const results: ResolvedFile[] = [];
  for (const raw of rawPatterns) {
    const entry: PatternEntry = typeof raw === 'string' ? { glob: raw } : raw;
    let uris: vscode.Uri[];
    if (path.isAbsolute(entry.glob)) {
      uris = [vscode.Uri.file(entry.glob)];
    } else {
      uris = await vscode.workspace.findFiles(entry.glob);
    }
    log(`Pattern "${entry.glob}" matched ${uris.length} file(s)`);
    for (const uri of uris) {
      results.push({ uri, columnValues: resolveColumnValues(entry, uri.fsPath) });
    }
  }
  return results;
}

export function activate(context: vscode.ExtensionContext): void {
  const issueManager = new IssueManager();
  const decorationProvider = new DecorationProvider(issueManager);
  const panel = new CodeClimatePanel(context, issueManager);

  async function loadFromEntries(entries: ResolvedFile[]): Promise<number> {
    let loaded = 0;
    for (const { uri, columnValues } of entries) {
      try {
        issueManager.loadFile(uri, columnValues);
        log(`Loaded ${uri.fsPath}`);
        loaded++;
      } catch (e) {
        log(`Error loading ${uri.fsPath}: ${String(e)}`);
        vscode.window.showErrorMessage(`Failed to load ${uri.fsPath}: ${String(e)}`);
      }
    }
    return loaded;
  }

  async function autoLoadFromConfig(): Promise<void> {
    if (!issueManager.isEmpty) return;
    const projectConfig = await readProjectConfig();
    issueManager.setCustomColumns(projectConfig?.customColumns ?? []);
    const entries = await findConfiguredFiles(projectConfig);
    await loadFromEntries(entries);
  }

  const sourcesView = new SourcesViewProvider(
    issueManager,
    autoLoadFromConfig,
    (issueId) => { panel.show(); panel.focusIssue(issueId); },
    async (filePath, line) => {
      let resolved: string | null = null;
      if (path.isAbsolute(filePath) && fs.existsSync(filePath)) {
        resolved = filePath;
      } else {
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
          const full = path.join(folder.uri.fsPath, filePath);
          if (fs.existsSync(full)) { resolved = full; break; }
        }
        if (!resolved && !path.isAbsolute(filePath) && fs.existsSync(filePath)) {
          resolved = filePath;
        }
      }
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
    },
  );
  context.subscriptions.push(decorationProvider, panel, logChannel,
    vscode.window.registerWebviewViewProvider(SourcesViewProvider.viewId, sourcesView));

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'codeclimateVisualiser.openFiles',
      async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
        let fileUris: vscode.Uri[];

        if (uris && uris.length > 0) {
          fileUris = uris;
        } else if (uri) {
          fileUris = [uri];
        } else {
          const selected = await vscode.window.showOpenDialog({
            canSelectMany: true,
            filters: { 'JSON files': ['json'] },
            title: 'Open CodeClimate Report(s)',
          });
          if (!selected || selected.length === 0) return;
          fileUris = selected;
        }

        const loaded = await loadFromEntries(fileUris.map(u => ({ uri: u, columnValues: {} })));
        if (loaded > 0) panel.show();
      },
    ),

    vscode.commands.registerCommand('codeclimateVisualiser.clearAll', () => {
      issueManager.clearAll();
      decorationProvider.clearDecorations();
      log('Cleared all reports');
    }),

    vscode.commands.registerCommand('codeclimateVisualiser.openView', async () => {
      panel.show();
      await autoLoadFromConfig();
    }),

    vscode.commands.registerCommand('codeclimateVisualiser.reloadConfig', async () => {
      issueManager.clearAll();
      decorationProvider.clearDecorations();
      const projectConfig = await readProjectConfig();
      issueManager.setCustomColumns(projectConfig?.customColumns ?? []);
      if (getRawPatterns(projectConfig).length === 0) {
        vscode.window.showInformationMessage(
          'No patterns configured. Create .vscode/codeclimate-visualiser.json or add ' +
          '"codeclimateVisualiser.reportPatterns" to .vscode/settings.json.',
        );
        return;
      }
      const entries = await findConfiguredFiles(projectConfig);
      if (entries.length === 0) {
        vscode.window.showWarningMessage(
          'No files matched the configured patterns. Check your glob patterns and verify the files exist.',
        );
        return;
      }
      const loaded = await loadFromEntries(entries);
      if (loaded > 0) {
        panel.show();
        vscode.window.showInformationMessage(`Reloaded ${loaded} report${loaded !== 1 ? 's' : ''}.`);
      } else {
        vscode.window.showWarningMessage('Patterns matched files but none could be loaded. Check the Output channel for details.');
      }
    }),
  );
}

export function deactivate(): void {}
