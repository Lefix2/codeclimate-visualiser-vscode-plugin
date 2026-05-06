import * as vscode from 'vscode';
import * as cp from 'child_process';
import { ActionDefinition } from './types';

export type ActionStatus = 'idle' | 'running' | 'success' | 'error';

export interface ActionState {
  id: string;
  status: ActionStatus;
  lastError?: string;
  lastRunAt?: string;
}

function matchesGlob(relPath: string, pattern: string): boolean {
  const p = relPath.replace(/\\/g, '/');
  const g = pattern.replace(/\\/g, '/');
  const regexStr = g
    .replace(/[.+^${}()|[\]]/g, '\\$&')
    .replace(/\*\*/g, '\x00')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\x00/g, '.*');
  return new RegExp(`^${regexStr}$`).test(p);
}

export class ActionManager implements vscode.Disposable {
  private actions: ActionDefinition[] = [];
  private states = new Map<string, ActionState>();
  private saveDisposables: vscode.Disposable[] = [];
  private changeEmitter = new vscode.EventEmitter<void>();
  readonly onChange = this.changeEmitter.event;

  constructor(
    private workspaceRoot: string | undefined,
    private onRefreshView: () => Promise<void>,
  ) {}

  setActions(actions: ActionDefinition[]): void {
    this.actions = actions;
    for (const a of actions) {
      if (!this.states.has(a.id)) {
        this.states.set(a.id, { id: a.id, status: 'idle' });
      }
    }
    this.rewireSaveListeners();
  }

  private rewireSaveListeners(): void {
    for (const d of this.saveDisposables) d.dispose();
    this.saveDisposables = [];
    if (!this.actions.some(a => a.onSave)) return;
    this.saveDisposables.push(
      vscode.workspace.onDidSaveTextDocument(doc => {
        const relPath = vscode.workspace.asRelativePath(doc.uri, false);
        for (const action of this.actions) {
          if (!action.onSave) continue;
          const patterns = Array.isArray(action.onSave) ? action.onSave : [action.onSave];
          if (patterns.some(p => matchesGlob(relPath, p))) {
            this.runAction(action.id);
          }
        }
      }),
    );
  }

  getActions(): ActionDefinition[] { return this.actions; }

  getStates(): Record<string, ActionState> {
    const result: Record<string, ActionState> = {};
    for (const [id, state] of this.states) result[id] = state;
    return result;
  }

  async runAction(id: string): Promise<void> {
    const action = this.actions.find(a => a.id === id);
    if (!action) return;
    if (this.states.get(id)?.status === 'running') return;

    const startedAt = new Date().toISOString();
    this.setState({ id, status: 'running', lastRunAt: startedAt });

    try {
      if (action.vsCodeCommand) {
        await vscode.commands.executeCommand(action.vsCodeCommand, ...(action.args ?? []));
      } else if (action.command) {
        await this.runShellCommand(action.command);
      }

      this.setState({ id, status: 'success', lastRunAt: startedAt });

      if (action.refreshView) {
        await this.onRefreshView();
      }

      for (const nextId of action.then ?? []) {
        await this.runAction(nextId);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.setState({ id, status: 'error', lastError: msg, lastRunAt: startedAt });
    }
  }

  private setState(state: ActionState): void {
    this.states.set(state.id, state);
    this.changeEmitter.fire();
  }

  private runShellCommand(cmd: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = cp.spawn(cmd, { shell: true, cwd: this.workspaceRoot });
      let stderr = '';
      proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(stderr.trim() || `Exit code ${code}`));
      });
      proc.on('error', reject);
    });
  }

  dispose(): void {
    for (const d of this.saveDisposables) d.dispose();
    this.changeEmitter.dispose();
  }
}
