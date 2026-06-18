import * as vscode from 'vscode';
import * as cp from 'child_process';
import { ActionDefinition, GroupStyle } from './types';

export type ActionStatus = 'idle' | 'running' | 'waiting' | 'success' | 'error';

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

/** Replace `$1`, `$2`, … and `${1}` placeholders in a shell command with forwarded args (1-based). */
function substituteArgs(cmd: string, args?: unknown[]): string {
  if (!args || args.length === 0) return cmd;
  return cmd.replace(/\$\{(\d+)\}|\$(\d+)/g, (m, braced, bare) => {
    const n = parseInt(braced ?? bare, 10);
    const v = args[n - 1];
    return v === undefined || v === null ? '' : String(v);
  });
}

export class ActionManager implements vscode.Disposable {
  private actions: ActionDefinition[] = [];
  private groupStyles: Record<string, GroupStyle> = {};
  private states = new Map<string, ActionState>();
  private saveDisposables: vscode.Disposable[] = [];
  private changeEmitter = new vscode.EventEmitter<void>();
  readonly onChange = this.changeEmitter.event;

  constructor(
    private workspaceRoot: string | undefined,
    private onRefreshView: () => Promise<void>,
    private output?: vscode.OutputChannel,
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

  setGroupStyles(styles: Record<string, GroupStyle>): void { this.groupStyles = styles ?? {}; }

  getGroupStyles(): Record<string, GroupStyle> { return this.groupStyles; }

  getStates(): Record<string, ActionState> {
    const result: Record<string, ActionState> = {};
    for (const [id, state] of this.states) result[id] = state;
    return result;
  }

  /**
   * Run an action. `callArgs`, when provided by a chaining action, override the
   * action's own `args` (vsCodeCommand) and are substituted as `$1`, `$2`… in shell commands.
   */
  async runAction(id: string, callArgs?: unknown[]): Promise<void> {
    const action = this.actions.find(a => a.id === id);
    if (!action) return;
    const current = this.states.get(id)?.status;
    if (current === 'running' || current === 'waiting') return;

    const startedAt = new Date().toISOString();
    this.setState({ id, status: 'running', lastRunAt: startedAt });
    this.log(`▶ ${action.label} (${id})${callArgs?.length ? ` args=[${callArgs.join(', ')}]` : ''}`);

    try {
      const pre = action.before ?? [];
      if (pre.length > 0) {
        this.log(`⏮ ${action.label} (${id}) running ${pre.length} pre-action(s)`);
        for (const prev of pre) {
          if (typeof prev === 'string') await this.runAction(prev);
          else await this.runAction(prev.id, prev.args);
        }
      }

      if (action.vsCodeCommand) {
        const args = callArgs ?? action.args ?? [];
        await vscode.commands.executeCommand(action.vsCodeCommand, ...args);
      } else if (action.command) {
        const cmd = substituteArgs(action.command, callArgs);
        await this.runShellCommand(cmd);
      }

      if (action.refreshView) {
        await this.onRefreshView();
      }

      const chain = action.then ?? [];
      if (chain.length > 0) {
        // Own command done, but the chain isn't — stay 'waiting' until every chained action finishes.
        this.setState({ id, status: 'waiting', lastRunAt: startedAt });
        this.log(`⏳ ${action.label} (${id}) waiting on ${chain.length} chained action(s)`);
        for (const next of chain) {
          if (typeof next === 'string') await this.runAction(next);
          else await this.runAction(next.id, next.args);
        }
      }

      this.setState({ id, status: 'success', lastRunAt: startedAt });
      this.log(`✔ ${action.label} (${id})`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.setState({ id, status: 'error', lastError: msg, lastRunAt: startedAt });
      this.log(`✖ ${action.label} (${id}): ${msg}`);
    }
  }

  private log(msg: string): void {
    this.output?.appendLine(`[${new Date().toISOString()}] [action] ${msg}`);
  }

  private setState(state: ActionState): void {
    this.states.set(state.id, state);
    this.changeEmitter.fire();
  }

  private runShellCommand(cmd: string): Promise<void> {
    this.log(`$ ${cmd}`);
    return new Promise((resolve, reject) => {
      const proc = cp.spawn(cmd, { shell: true, cwd: this.workspaceRoot });
      let stderr = '';
      proc.stdout?.on('data', (d: Buffer) => { this.output?.append(d.toString()); });
      proc.stderr?.on('data', (d: Buffer) => {
        const s = d.toString();
        stderr += s;
        this.output?.append(s);
      });
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
