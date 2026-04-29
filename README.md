# CodeClimate Visualiser

VS Code extension that visualises [CodeClimate](https://codeclimate.com/) JSON and NDJSON reports directly in the editor.

[![CI](https://github.com/Lefix2/codeclimate-visualiser-vscode-plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/Lefix2/codeclimate-visualiser-vscode-plugin/actions/workflows/ci.yml)

## Features

- **Charts** — pie charts by severity, category, check name, and source file
- **Filterable issue table** — sort by any column; filter by severity, category, or free text (`;`-separated AND terms)
- **Inline decorations** — colour-coded gutters and hover messages in the editor
- **One-click navigation** — jump from any table row to the exact file and line
- **Code snippets** — view highlighted code context inside the panel (12+ languages via Prism.js)
- **Multiple reports** — load and combine as many report files as needed
- **Formats** — JSON array and NDJSON (one object per line)

## Installation

Search for **CodeClimate Visualiser** in the VS Code Extension Marketplace, or download a `.vsix` from the [Releases](https://github.com/Lefix2/codeclimate-visualiser-vscode-plugin/releases) page and install it with:

```sh
code --install-extension codeclimate-visualiser-<version>.vsix
```

## Usage

### Commands

Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and run:

| Command | Description |
|---------|-------------|
| `CodeClimate: Open View` | Open the visualisation panel; auto-loads reports from the project config |
| `CodeClimate: Open Report(s)` | Browse for one or more report files to load |
| `CodeClimate: Load from Configured Paths` | Reload all reports matching the configured glob patterns |
| `CodeClimate: Clear All` | Unload all currently loaded reports |

You can also right-click any `.json` file in the Explorer or an open editor to load it directly.

### Workflow

1. Run your CodeClimate analysis and save the output as a `.json` or NDJSON file.
2. Open the Command Palette and run **CodeClimate: Open View**.
3. If a project config exists (see below), reports load automatically. Otherwise use **Open Report(s)** to browse for a file.
4. Use the charts to spot hot-spots and the table to drill down into individual issues.

## Configuration

### Per-project configuration (recommended)

Create `.vscode/codeclimate-visualiser.json` at the root of your workspace:

```json
{
  "$schema": "./schemas/codeclimate-visualiser.schema.json",
  "reportPatterns": [
    "reports/*.json"
  ]
}
```

The `reportPatterns` array accepts glob patterns (VS Code glob syntax) and absolute paths. All matching files are loaded when the view opens or when **Load from Configured Paths** is run.

### VS Code settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `codeclimateVisualiser.reportPatterns` | `string[]` | `[]` | Glob patterns or absolute paths to reports (workspace-level fallback) |
| `codeclimateVisualiser.showChartLegends` | `boolean` | `false` | Show legends on the charts |

## CodeClimate report format

The extension accepts any file that CodeClimate (or a compatible tool) produces.

**JSON array** (standard `--format json`):

```json
[
  {
    "type": "issue",
    "check_name": "rubocop/Style/StringLiterals",
    "description": "Prefer single-quoted strings when you don't need string interpolation.",
    "categories": ["Style"],
    "location": {
      "path": "app/models/user.rb",
      "lines": { "begin": 12, "end": 12 }
    },
    "severity": "minor",
    "fingerprint": "abc123"
  }
]
```

**NDJSON** (one JSON object per line, `--format ndjson` or streaming output):

```
{"type":"issue","check_name":"rubocop/Style/StringLiterals",...}
{"type":"issue","check_name":"rubocop/Metrics/MethodLength",...}
```

Supported `severity` values: `info`, `minor`, `major`, `critical`, `blocker`.

Both plain integer line numbers and `{ line, column }` objects are supported for `lines.begin` / `lines.end`.

## Development

### Prerequisites

- Node.js 20+
- npm 10+

### Build

```sh
npm install          # install dependencies
npm run compile      # compile TypeScript → out/
npm run watch        # watch mode (recompile on save)
```

### Test

Tests use [Mocha](https://mochajs.org/) and [ts-node](https://typestrong.org/ts-node/). The VS Code API is mocked so the suite runs without a VS Code instance.

```sh
npm test
```

Tests cover:

- `src/parser.ts` — JSON array parsing, NDJSON parsing, edge cases (empty input, malformed JSON, missing fields, all severity levels, `{line,column}` refs), real test-data files
- `src/issueManager.ts` — load/reload/remove/clear, unique IDs, `onChange` events, multi-file accumulation, `getIssuesForRelativePath` (relative, absolute, Windows backslash)

### Package

```sh
npm run package      # produces codeclimate-visualiser-<version>.vsix
```

### Debug in VS Code

Press `F5` to launch the **Extension Development Host** (configured in `.vscode/launch.json`). The `testdata/` folder is opened as the test workspace so you can exercise the extension immediately.

## Release process

1. Update `"version"` in `package.json`.
2. Commit and push.
3. Create and push a tag: `git tag v<version> && git push origin v<version>`.
4. The [Release workflow](.github/workflows/release.yml) runs automatically: it compiles, tests, packages the `.vsix`, and creates a GitHub Release with the file attached.

## Contributing

1. Fork the repository.
2. Create a feature branch from `main`.
3. Make your changes and add/update tests.
4. Verify everything passes: `npm run compile && npm test`.
5. Open a pull request targeting `main` — the CI workflow runs automatically.

## License

MIT — Copyright 2025 Félix TREFOU
