import * as vscode from 'vscode';
import { IssueManager } from './issueManager';
import { DecorationProvider } from './decorationProvider';
import { CodeClimatePanel } from './webviewPanel';

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
  );
}

export function deactivate(): void {}
