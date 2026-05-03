# CodeClimate Visualiser — Technical Documentation

> Developer reference for contributors. For end-user docs see [README](../README.md) or the [VS Code Marketplace page](https://marketplace.visualstudio.com/items?itemName=lefix2.codeclimate-visualiser).

## Table of Contents

- [Architecture](#architecture)
- [Source Map](#source-map)
- [Data Flow](#data-flow)
- [Key Types](#key-types)
- [Configuration Schema](#configuration-schema)
- [History & Fingerprinting](#history--fingerprinting)
- [Webview Protocol](#webview-protocol)
- [Custom Columns](#custom-columns)
- [Development](#development)
- [Release Process](#release-process)

---

## Architecture

```
Extension Host (Node.js)
├── extension.ts          — activate(), command registrations, wiring
├── issueManager.ts       — in-memory store, file load/remove, onChange events
├── parser.ts             — JSON array + NDJSON → CodeClimateIssue[]
├── historyManager.ts     — NDJSON snapshot store, fingerprint diff
├── decorationProvider.ts — inline gutter decorations
├── webviewPanel.ts       — main dashboard (WebviewPanel)
└── sourcesViewProvider.ts — sidebar panel (WebviewViewProvider)

Webview (sandboxed browser context)
├── media/webview.js      — full dashboard SPA (Overview/Issues/Files/Treemap/Trends)
├── media/webview.css     — dashboard styles
└── media/sidebar scripts — embedded in sourcesViewProvider.ts HTML template
```

The extension host and both webviews communicate exclusively via `postMessage` / `onDidReceiveMessage`.

---

## Source Map

| File | Responsibility |
|------|---------------|
| `src/extension.ts` | Entry point. Registers all commands, wires `IssueManager` → `SourcesViewProvider` → `WebviewPanel` → `HistoryManager`. Handles file-load commands and the project config (`autoLoadFromConfig`). |
| `src/parser.ts` | Parses a single report file. Accepts JSON array and NDJSON. Normalises `LineRef` variants (`number` vs `{line,column}`). Returns `CodeClimateIssue[]`. |
| `src/issueManager.ts` | Singleton store. Maps file URIs to parsed issues. Emits `onChange` to both the sidebar and the panel. Assigns stable `id` (UUID) to each issue on load. Attaches `customColumns` values. |
| `src/historyManager.ts` | Reads/writes `<workspace>/.vscode/codeclimate-visualiser.history.ndjson`. Saves snapshots with fingerprint sets. Computes new/fixed/persisting sets via `Set` intersection. Exposes `resolveIssueFingerprint()` for the panel to tag live issues as new. |
| `src/decorationProvider.ts` | Implements `FileDecorationProvider`. Listens for `onChange` and registers coloured gutter decorations per file/line. |
| `src/webviewPanel.ts` | Manages the `WebviewPanel`. Calls `issueManager.getAllIssues()`, augments each issue with `isNew` (comparing fingerprints against last snapshot), then posts the full state to the webview. |
| `src/sourcesViewProvider.ts` | Manages the sidebar `WebviewView`. Contains the full HTML/CSS/JS template as a template literal. Handles messages for `removeSource`, `focusIssue`, `openFile`, `deleteSnapshot`, `command`. |
| `media/webview.js` | Self-contained SPA. Receives `update` messages and re-renders all views. No bundler — plain ES2020 with `<script nonce>`. |

---

## Data Flow

```
Report file on disk
        │
        ▼
  parser.ts (parseFile)
        │  CodeClimateIssue[]
        ▼
  issueManager.ts (loadFile)
        │  onChange event
        ├──────────────────────────────────────────┐
        ▼                                          ▼
  webviewPanel.ts (updateWebview)         sourcesViewProvider.ts (update)
        │  augments isNew via historyManager       │  posts files + issues + history
        │  posts full state to dashboard webview   │  to sidebar webview
        ▼                                          ▼
  media/webview.js                        sidebar HTML/JS (inline)
  (renders Overview/Issues/Files/…)       (renders Reports/Issues/History sections)
```

---

## Key Types

Defined in `src/types.ts`:

```ts
type Severity = 'info' | 'minor' | 'major' | 'critical' | 'blocker';

interface CodeClimateIssue {
  type: string;
  check_name: string;
  description: string;
  categories: string[];
  location: CodeClimateLocation;
  severity?: Severity;
  fingerprint?: string;
}

interface IssueWithSource extends CodeClimateIssue {
  sourceFile: string;   // basename of report file
  sourceUri: string;    // absolute file URI
  id: string;           // stable UUID assigned on load
  customColumns: Record<string, string>;
  isNew?: true;         // set by webviewPanel when fingerprint absent from last snapshot
}

interface HistorySnapshot {
  id: string;
  timestamp: string;    // ISO 8601
  label?: string;
  sources: string[];
  counts: Record<Severity, number>;
  total: number;
  nativeCount: number;
  derivedCount: number;
  volatileCount: number;
  fingerprints: string[];
}

interface CustomColumn {
  name: string;
  index: number;
  showQuickFilter?: boolean;
  showFilter?: boolean;
  showChart?: boolean;
  fromField?: string;    // dot-path into the raw issue object
  fieldRegex?: string;   // regex applied to the field value
  captureGroup?: number;
}
```

---

## Configuration Schema

Per-project config lives at `.vscode/codeclimate-visualiser.json`. Full schema at `schemas/codeclimate-visualiser.schema.json`.

```jsonc
{
  // Glob patterns (VS Code glob syntax) or absolute paths to report files
  "reportPatterns": ["reports/*.json"],

  // Extra columns in the issue table, extracted from report fields
  "customColumns": [
    {
      "name": "Package",
      "index": 2,
      "fromField": "location.path",
      "fieldRegex": "^src/([^/]+)/",
      "captureGroup": 0,
      "showQuickFilter": true,
      "showFilter": false,
      "showChart": false
    }
  ]
}
```

`fromField` is a dot-path into the raw `CodeClimateIssue` JSON. `fieldRegex` is applied to the resolved value; `captureGroup` selects which capture group to display (0-indexed; default 0 = full match).

---

## History & Fingerprinting

Snapshots are stored as NDJSON at `<workspace>/.vscode/codeclimate-visualiser.history.ndjson` (one JSON object per line, append-only).

### Fingerprint resolution strategy

`historyManager.ts` attempts three strategies in order:

| Strategy | Source | Stability |
|----------|--------|-----------|
| **native** | `issue.fingerprint` from the report | Stable across runs |
| **derived** | SHA-256 of `check_name + path + begin_line` | Stable if location unchanged |
| **volatile** | SHA-256 of `check_name + description` | Changes if description varies |

`volatile` fingerprints are excluded from snapshot storage (they cannot reliably track issue identity across runs). `resolveIssueFingerprint()` returns `null` for volatile issues so they are never marked as new.

### Diff computation

```ts
const prevSet = new Set(lastSnapshot.fingerprints);
const currSet = new Set(currentFingerprints);

const newIssues     = currSet difference prevSet;   // appeared
const fixedIssues   = prevSet difference currSet;   // gone
const persisting    = currSet intersection prevSet; // unchanged
```

---

## Webview Protocol

### Extension → Dashboard (`media/webview.js`)

```ts
webview.postMessage({
  type: 'update',
  issues: IssueWithSource[],      // all live issues, isNew flagged
  history: HistorySnapshot[],     // full snapshot list
  config: {
    showSeverityFilter: boolean,
    showCategoryFilter: boolean,
    showCheckNameFilter: boolean,
    showChartLegends: boolean,
    customColumns: CustomColumn[],
  }
});

webview.postMessage({ type: 'focusIssue', id: string });
```

### Extension → Sidebar (`sourcesViewProvider.ts`)

```ts
webview.postMessage({
  type: 'update',
  files: { uri, name, count }[],
  issues: IssueWithSource[],
  customColumns: CustomColumn[],
  history: HistorySnapshot[],
});
```

### Sidebar → Extension

```ts
{ type: 'ready' }
{ type: 'removeSource', uri: string }
{ type: 'focusIssue', id: string }
{ type: 'openFile', path: string, line: number }
{ type: 'deleteSnapshot', id: string }
{ type: 'command', command: string }  // e.g. 'codeclimateVisualiser.reloadConfig'
```

---

## Custom Columns

Custom columns let you extract additional fields from report JSON and display them as filterable columns in the issue table.

**Example** — extract the top-level package from the file path:

```json
{
  "customColumns": [{
    "name": "Package",
    "index": 2,
    "fromField": "location.path",
    "fieldRegex": "^(?:src|lib)/([^/]+)/",
    "captureGroup": 0,
    "showQuickFilter": true
  }]
}
```

`captureGroup: 0` returns the first capture group (`([^/]+)`). Set to `-1` for the full regex match.

---

## Development

### Prerequisites

- Node.js 20+, npm 10+
- VS Code 1.85+

### Setup

```sh
git clone https://github.com/Lefix2/codeclimate-visualiser-vscode-plugin.git
cd codeclimate-visualiser-vscode-plugin
npm install
npm run compile
```

### Debug

Press `F5` in VS Code. The pre-launch task compiles TypeScript and seeds 10 realistic history snapshots into `testdata/.vscode/codeclimate-visualiser.history.ndjson` via `scripts/gen-test-snapshots.js`. The Extension Development Host opens with `testdata/` as the workspace.

### Tests

```sh
npm test
```

Tests use Mocha. No VS Code instance required — the VS Code API is mocked. Coverage:

- `src/parser.ts` — JSON array, NDJSON, edge cases, all severity levels, `{line,column}` refs
- `src/issueManager.ts` — load/reload/remove/clear, IDs, `onChange`, multi-file, path normalisation

### Project structure

```
src/           TypeScript source
out/           Compiled JS (git-ignored)
media/         Webview assets (webview.js, webview.css, icon*.svg)
schemas/       JSON schema for .vscode/codeclimate-visualiser.json
testdata/      Sample reports + seeded history for manual testing
scripts/       gen-test-snapshots.js — seeds history for debug session
docs/          This documentation (published to GitHub Pages)
.github/
  workflows/
    ci.yml              — compile + test on every PR
    semantic-release.yml — auto-version on merge to main
    release.yml          — package VSIX + publish to Marketplace on tag
    pages.yml            — publish docs/ to GitHub Pages on merge to main
```

---

## Release Process

Version management is fully automated via [semantic-release](https://semantic-release.gitbook.io/semantic-release/).

1. **Merge to `main`** — `semantic-release.yml` runs, analyses conventional commits (`feat:` → minor, `fix:` → patch, `BREAKING CHANGE` → major), creates a GitHub Release and pushes a `vX.Y.Z` tag.
2. **Tag push** — `release.yml` triggers, syncs `package.json` version from the tag, compiles, packages the VSIX, uploads it to the GitHub Release, and publishes to the VS Code Marketplace via `VSCE_PAT` secret.
3. **Manual release** — trigger `release.yml` via `workflow_dispatch`. If no version input is provided, the latest git tag is used automatically.

### Secrets required

| Secret | Purpose |
|--------|---------|
| `GITHUB_TOKEN` | Auto-provided. Used by semantic-release and gh CLI. |
| `VSCE_PAT` | Personal Access Token from [Azure DevOps](https://dev.azure.com/) with **Marketplace › Manage** scope. |
