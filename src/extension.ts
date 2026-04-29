import * as vscode from 'vscode';
import * as path from 'path';
import { IssueManager } from './issueManager';
import { DecorationProvider } from './decorationProvider';
import { CodeClimatePanel } from './webviewPanel';
import { PatternEntry, ProjectConfig } from './types';
import { SourcesViewProvider } from './sourcesViewProvider';

const logChannel = vscode.window.createOutputChannel('CodeClimate Visualiser');

function log(msg: string): void {
  const show = vscode.workspace.getConfiguration('codeclimateVisualiser').get<boolean>('showLogConsole', false);
  if (!show) return;
  logChannel.appendLine(`[${new Date().toISOString()}] ${msg}`);
  logChannel.show(true);
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

/** Resolve configured patterns → resolved file entries with column values. */
async function findConfiguredFiles(config: ProjectConfig | null): Promise<ResolvedFile[]> {
  const rawPatterns: (string | PatternEntry)[] = config?.reportPatterns?.length
    ? config.reportPatterns
    : vscode.workspace.getConfiguration('codeclimateVisualiser').get<string[]>('reportPatterns', []);

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

  const sourcesView = new SourcesViewProvider(issueManager);
  context.subscriptions.push(decorationProvider, panel, logChannel,
    vscode.window.registerWebviewViewProvider(SourcesViewProvider.viewId, sourcesView));


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
      if (issueManager.getFileInfos().length > 0) return;
      const projectConfig = await readProjectConfig();
      issueManager.setCustomColumns(projectConfig?.customColumns ?? []);
      const entries = await findConfiguredFiles(projectConfig);
      await loadFromEntries(entries);
    }),

    vscode.commands.registerCommand('codeclimateVisualiser.loadFromConfig', async () => {
      const projectConfig = await readProjectConfig();
      issueManager.setCustomColumns(projectConfig?.customColumns ?? []);
      const entries = await findConfiguredFiles(projectConfig);

      if (entries.length === 0) {
        vscode.window.showInformationMessage(
          'No patterns configured. Create .vscode/codeclimate-visualiser.json or add ' +
          '"codeclimateVisualiser.reportPatterns" to .vscode/settings.json.',
        );
        return;
      }

      const loaded = await loadFromEntries(entries);
      if (loaded > 0) {
        panel.show();
        vscode.window.showInformationMessage(`Loaded ${loaded} report${loaded !== 1 ? 's' : ''}.`);
      } else {
        vscode.window.showWarningMessage('No files matched the configured patterns.');
      }
    }),
  );
}

export function deactivate(): void {}
