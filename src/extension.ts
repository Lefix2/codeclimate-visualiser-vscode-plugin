import * as vscode from 'vscode';
import * as path from 'path';
import { IssueManager } from './issueManager';
import { DecorationProvider } from './decorationProvider';
import { CodeClimatePanel } from './webviewPanel';

interface ProjectConfig {
  reportPatterns?: string[];
}

/** Read .vscode/codeclimate-visualiser.json from workspace root, or null if absent/invalid. */
async function readProjectConfig(): Promise<ProjectConfig | null> {
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const configUri = vscode.Uri.joinPath(folder.uri, '.vscode', 'codeclimate-visualiser.json');
    try {
      const raw = await vscode.workspace.fs.readFile(configUri);
      return JSON.parse(Buffer.from(raw).toString('utf-8')) as ProjectConfig;
    } catch {
      // file absent or invalid JSON — try next folder
    }
  }
  return null;
}

/** Resolve configured patterns to file URIs (project config, then VS Code setting). */
async function findConfiguredFiles(): Promise<vscode.Uri[]> {
  const projectConfig = await readProjectConfig();
  const patterns: string[] = projectConfig?.reportPatterns?.length
    ? projectConfig.reportPatterns
    : vscode.workspace.getConfiguration('codeclimateVisualiser').get<string[]>('reportPatterns', []);

  const found: vscode.Uri[] = [];
  for (const pattern of patterns) {
    if (path.isAbsolute(pattern)) {
      found.push(vscode.Uri.file(pattern));
    } else {
      found.push(...await vscode.workspace.findFiles(pattern));
    }
  }
  return found;
}

export function activate(context: vscode.ExtensionContext): void {
  const issueManager = new IssueManager();
  const decorationProvider = new DecorationProvider(issueManager);
  const panel = new CodeClimatePanel(context, issueManager);

  context.subscriptions.push(decorationProvider, panel);

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

        let loaded = 0;
        for (const fileUri of fileUris) {
          try {
            issueManager.loadFile(fileUri);
            loaded++;
          } catch (e) {
            vscode.window.showErrorMessage(`Failed to load ${fileUri.fsPath}: ${String(e)}`);
          }
        }

        if (loaded > 0) {
          panel.show();
        }
      },
    ),

    vscode.commands.registerCommand('codeclimateVisualiser.clearAll', () => {
      issueManager.clearAll();
      decorationProvider.clearDecorations();
    }),

    vscode.commands.registerCommand('codeclimateVisualiser.openView', async () => {
      panel.show();
      // Auto-load from config only when no reports are currently loaded
      if (issueManager.getFileInfos().length > 0) return;
      const found = await findConfiguredFiles();
      for (const fileUri of found) {
        try { issueManager.loadFile(fileUri); } catch { /* silent */ }
      }
    }),

    vscode.commands.registerCommand('codeclimateVisualiser.loadFromConfig', async () => {
      const found = await findConfiguredFiles();

      if (found.length === 0) {
        vscode.window.showInformationMessage(
          'No patterns configured. Create .vscode/codeclimate-visualiser.json or add ' +
          '"codeclimateVisualiser.reportPatterns" to .vscode/settings.json.',
        );
        return;
      }

      let loaded = 0;
      for (const fileUri of found) {
        try {
          issueManager.loadFile(fileUri);
          loaded++;
        } catch (e) {
          vscode.window.showErrorMessage(`Failed to load ${fileUri.fsPath}: ${String(e)}`);
        }
      }

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
