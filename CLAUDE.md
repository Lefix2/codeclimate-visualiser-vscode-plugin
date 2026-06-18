# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run compile       # TypeScript → out/
npm run watch         # incremental compile
npm run test          # Mocha unit tests (no VS Code host needed)
npm run package       # build .vsix
```

Run single test file:
```bash
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON ./node_modules/.bin/mocha test/parser.test.ts
```

Tests use `tsx` transpiler via `.mocharc.cjs` — no separate compile step needed.

## Architecture

VS Code extension targeting `^1.85.0`. Entry: `src/extension.ts` → `out/extension.js`.

**Data flow:**
1. `extension.ts` reads `.vscode/codeclimate-visualiser.json` (`ProjectConfig`) or VS Code settings for `reportPatterns`
2. `IssueManager` parses files via `parser.ts` (`parseCodeClimateFile`) — supports JSON array and NDJSON
3. `CodeClimatePanel` (`webviewPanel.ts`) renders the main charts/table webview; `SourcesViewProvider` (`sourcesViewProvider.ts`) drives the sidebar
4. `DecorationProvider` decorates open editors with coloured gutters per severity
5. `HistoryManager` appends/reads snapshots to a `.ndjson` file (default `.vscode/codeclimate-visualiser.history.ndjson`)
6. `ActionManager` runs shell commands or VS Code commands on demand or on file save (`onSave` globs)

**Key source files:**
- `src/types.ts` — all shared interfaces (`CodeClimateIssue`, `IssueWithSource`, `ProjectConfig`, `ActionDefinition`, `CustomColumn`, `HistorySnapshot`)
- `src/parser.ts` — stateless; parses JSON array or NDJSON into `CodeClimateIssue[]`
- `src/issueManager.ts` — in-memory store keyed by file URI; emits `onChange`
- `src/decorationProvider.ts` — listens to `issueManager.onChange`, applies gutter decorations; skips re-apply when issue IDs unchanged to preserve VS Code's shifted-range tracking
- `src/historyManager.ts` — fingerprints issues (native > derived > volatile) for trend diffing
- `src/actionManager.ts` — `onSave` wired via `vscode.workspace.onDidSaveTextDocument`; actions chain via `then[]`

**Webview assets:** `media/webview.js` + `media/webview.css` — bundled as-is (no build step). Communication is message-passing: extension ↔ webview.

## Per-project config

`.vscode/codeclimate-visualiser.json` — validated by `schemas/codeclimate-visualiser.schema.json`:
- `reportPatterns` — glob strings or `PatternEntry` objects (`glob`, `regex`, `values`) for loading reports and populating custom columns
- `customColumns` — extra table columns; can extract values from issue fields via `fromField` + `fieldRegex`
- `actions` — shell/VS Code commands triggerable from the Actions tab or on file save; an action with `forEach` (`{ dirs: glob, as }` or `{ values: [], as }`) is a template expanded at config load (`src/actionExpand.ts`) into one action per match, with `${as}` substituted in every string field and a `then` ref to the template id fanning out to all generated children. An action's `groups: string[]` lists `/`-separated group paths (multi-membership; each path segment is a nested group, group exists iff named); the Actions webview builds a tree and renders each group as a colour-coded, expandable container card with a "Run all" button (`runActionGroup` message → sequential `runAction` over all descendant action ids). Group colours come from `ProjectConfig.groupColors` (name→colour, default otherwise); forEach children default `groups` to `[templateId]`
- `historyPath` — override for the history NDJSON file path

`testdata/.vscode/codeclimate-visualiser.json` is the canonical example of all features in use.

## Issue fingerprinting

`HistoryManager.resolveFingerprint` produces: `native` (uses issue's own `fingerprint` field) > `derived` (SHA-1 of `check_name:path:line`) > `volatile` (SHA-1 of `check_name:description`). Volatile fingerprints are excluded from trend diffs.
