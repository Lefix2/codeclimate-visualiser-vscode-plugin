// @ts-check
'use strict';

const vscode = acquireVsCodeApi();

const SEVERITY_ORDER = ['blocker', 'critical', 'major', 'minor', 'info'];
const SEVERITY_COLORS = {
  blocker:  '#ff3b30',
  critical: '#ff6b35',
  major:    '#ff9f0a',
  minor:    '#ffd60a',
  info:     '#0a84ff',
};
const PALETTE = [
  '#ff6384','#36a2eb','#ffce56','#4bc0c0','#9966ff',
  '#ff9f40','#c9cbcf','#e74c3c','#2ecc71','#3498db',
  '#f39c12','#9b59b6','#1abc9c','#34495e','#e67e22',
];

/** @type {any[]} */
let allIssues = [];
/** @type {any[]} */
let allFiles = [];
/** @type {{ severities: Set<string>, sourceFiles: Set<string>, search: string }} */
let filters = {
  severities: new Set(SEVERITY_ORDER),
  sourceFiles: new Set(),
  search: '',
};
/** @type {{ col: string, dir: 'asc'|'desc' }} */
let sortState = { col: 'severity', dir: 'asc' };
/** @type {Record<string, any>} */
const charts = {};

// ── Message handling ──────────────────────────────────────────────────────────

window.addEventListener('message', (event) => {
  const msg = event.data;
  if (msg.type === 'updateIssues') {
    allIssues = msg.issues ?? [];
    allFiles  = msg.files  ?? [];
    // reset source-file filter to show all loaded files
    filters.sourceFiles = new Set(allFiles.map(/** @param {any} f */ f => f.uri));
    render();
  }
});

// ── Filtering & sorting ───────────────────────────────────────────────────────

function getFiltered() {
  const q = filters.search.toLowerCase();
  return allIssues.filter((issue) => {
    if (!filters.severities.has(issue.severity ?? 'info')) return false;
    if (!filters.sourceFiles.has(issue.sourceUri))         return false;
    if (q) {
      return (
        (issue.description  ?? '').toLowerCase().includes(q) ||
        (issue.check_name   ?? '').toLowerCase().includes(q) ||
        (issue.location?.path ?? '').toLowerCase().includes(q)
      );
    }
    return true;
  });
}

function getSorted(issues) {
  const { col, dir } = sortState;
  return [...issues].sort((a, b) => {
    let va, vb;
    switch (col) {
      case 'severity':
        va = SEVERITY_ORDER.indexOf(a.severity ?? 'info');
        vb = SEVERITY_ORDER.indexOf(b.severity ?? 'info');
        break;
      case 'line':
        va = getBeginLine(a);
        vb = getBeginLine(b);
        break;
      case 'path':        va = a.location?.path   ?? ''; vb = b.location?.path   ?? ''; break;
      case 'sourceFile':  va = a.sourceFile        ?? ''; vb = b.sourceFile        ?? ''; break;
      case 'check_name':  va = a.check_name        ?? ''; vb = b.check_name        ?? ''; break;
      case 'description': va = a.description       ?? ''; vb = b.description       ?? ''; break;
      case 'categories':  va = (a.categories ?? []).join(); vb = (b.categories ?? []).join(); break;
      default: return 0;
    }
    if (va < vb) return dir === 'asc' ? -1 : 1;
    if (va > vb) return dir === 'asc' ?  1 : -1;
    return 0;
  });
}

// ── Render orchestration ──────────────────────────────────────────────────────

function render() {
  const hasData = allIssues.length > 0;
  el('empty-state').style.display   = hasData ? 'none' : '';
  el('main-content').style.display  = hasData ? ''     : 'none';
  if (!hasData) return;

  renderFileChips();
  renderSeverityFilter();
  renderSourceFileFilter();
  renderCharts();
  renderTable();
}

// ── File chips ────────────────────────────────────────────────────────────────

function renderFileChips() {
  const container = el('file-chips');
  container.innerHTML = '';
  for (const file of allFiles) {
    const chip = document.createElement('span');
    chip.className = 'file-chip';
    chip.textContent = `${file.filename} (${file.issueCount})`;

    const btn = document.createElement('button');
    btn.className = 'chip-remove';
    btn.title = 'Remove this file';
    btn.textContent = '×';
    btn.addEventListener('click', () => {
      vscode.postMessage({ type: 'removeSourceFile', uri: file.uri });
    });
    chip.appendChild(btn);
    container.appendChild(chip);
  }
}

// ── Filters ───────────────────────────────────────────────────────────────────

function renderSeverityFilter() {
  const container = el('filter-severity');
  container.innerHTML = '<span class="filter-label">Severity:</span>';
  for (const sev of SEVERITY_ORDER) {
    const label = document.createElement('label');
    label.className = 'filter-checkbox';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = filters.severities.has(sev);
    cb.addEventListener('change', () => {
      cb.checked ? filters.severities.add(sev) : filters.severities.delete(sev);
      renderCharts();
      renderTable();
    });

    const badge = document.createElement('span');
    badge.className = `severity-badge sev-${sev}`;
    badge.textContent = sev;

    label.appendChild(cb);
    label.appendChild(badge);
    container.appendChild(label);
  }
}

function renderSourceFileFilter() {
  const container = el('filter-sourcefile');
  container.innerHTML = '';
  if (allFiles.length <= 1) return;

  container.innerHTML = '<span class="filter-label">File:</span>';
  for (const file of allFiles) {
    const label = document.createElement('label');
    label.className = 'filter-checkbox';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = filters.sourceFiles.has(file.uri);
    cb.addEventListener('change', () => {
      cb.checked ? filters.sourceFiles.add(file.uri) : filters.sourceFiles.delete(file.uri);
      renderCharts();
      renderTable();
    });

    label.appendChild(cb);
    label.appendChild(document.createTextNode(' ' + file.filename));
    container.appendChild(label);
  }
}

// Wire search input once (it exists in the static HTML)
document.getElementById('filter-search')?.addEventListener('input', (e) => {
  filters.search = /** @type {HTMLInputElement} */(e.target).value;
  renderCharts();
  renderTable();
});

// ── Charts ────────────────────────────────────────────────────────────────────

function renderCharts() {
  const filtered = getFiltered();
  renderPieChart('chart-severity',  countBy(filtered, (i) => [i.severity ?? 'info'],          SEVERITY_ORDER, SEVERITY_COLORS));
  renderPieChart('chart-category',  countBy(filtered, (i) => i.categories?.length ? i.categories : ['Uncategorized']));
  renderPieChart('chart-checkname', topN(countBy(filtered, (i) => [i.check_name ?? '—']), 10));
}

/**
 * @param {any[]} issues
 * @param {(i: any) => string[]} keyFn
 * @param {string[]} [order]
 * @param {Record<string,string>} [colorMap]
 */
function countBy(issues, keyFn, order, colorMap = {}) {
  /** @type {Record<string,number>} */
  const counts = {};
  if (order) for (const k of order) counts[k] = 0;
  for (const issue of issues) {
    for (const k of keyFn(issue)) counts[k] = (counts[k] ?? 0) + 1;
  }
  // remove zero-count ordered keys
  if (order) for (const k of order) { if (counts[k] === 0) delete counts[k]; }
  return { counts, colorMap };
}

/** @param {{ counts: Record<string,number>, colorMap: Record<string,string> }} data */
function topN(data, n) {
  const top = Object.fromEntries(
    Object.entries(data.counts).sort((a, b) => b[1] - a[1]).slice(0, n)
  );
  return { counts: top, colorMap: data.colorMap };
}

/**
 * @param {string} canvasId
 * @param {{ counts: Record<string,number>, colorMap: Record<string,string> }} data
 */
function renderPieChart(canvasId, { counts, colorMap }) {
  const canvas = /** @type {HTMLCanvasElement|null} */(document.getElementById(canvasId));
  if (!canvas) return;

  const labels = Object.keys(counts).filter(k => counts[k] > 0);
  const values = labels.map(l => counts[l]);

  if (charts[canvasId]) { charts[canvasId].destroy(); }
  if (labels.length === 0) return;

  const total = values.reduce((a, b) => a + b, 0);
  const bgColor = getVsColor('--vscode-editor-background', '#1e1e1e');
  const fgColor = getVsColor('--vscode-foreground', '#cccccc');

  charts[canvasId] = new Chart(canvas, {
    type: 'pie',
    data: {
      labels,
      datasets: [{
        data: values,
        backgroundColor: labels.map((l, i) => colorMap[l] || PALETTE[i % PALETTE.length]),
        borderWidth: 2,
        borderColor: bgColor,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            color: fgColor,
            padding: 8,
            font: { size: 11 },
            boxWidth: 12,
          },
        },
        tooltip: {
          callbacks: {
            label: (ctx) => ` ${ctx.label}: ${ctx.raw} (${Math.round(/** @type {number} */(ctx.raw) / total * 100)}%)`,
          },
        },
      },
    },
  });
}

function getVsColor(varName, fallback) {
  return getComputedStyle(document.documentElement).getPropertyValue(varName).trim() || fallback;
}

// ── Table ─────────────────────────────────────────────────────────────────────

function renderTable() {
  const filtered = getSorted(getFiltered());
  const tbody = el('issues-tbody');
  tbody.innerHTML = '';

  for (const issue of filtered) {
    const line = getBeginLine(issue);
    const tr = document.createElement('tr');
    tr.className = `row-sev-${issue.severity ?? 'info'}`;
    tr.title = 'Click to open file at line ' + line;
    tr.innerHTML = [
      `<td><span class="severity-badge sev-${issue.severity ?? 'info'}">${esc(issue.severity ?? 'info')}</span></td>`,
      `<td class="cell-mono cell-truncate" title="${esc(issue.sourceFile)}">${esc(issue.sourceFile)}</td>`,
      `<td class="cell-path" title="${esc(issue.location?.path)}">${esc(issue.location?.path ?? '')}</td>`,
      `<td class="cell-num">${line}</td>`,
      `<td class="cell-truncate" title="${esc(issue.check_name)}">${esc(issue.check_name)}</td>`,
      `<td class="cell-desc" title="${esc(issue.description)}">${esc(issue.description)}</td>`,
      `<td>${(issue.categories ?? []).map((c) => `<span class="cat-badge">${esc(c)}</span>`).join('')}</td>`,
    ].join('');

    tr.addEventListener('click', () => {
      vscode.postMessage({ type: 'openFile', filePath: issue.location?.path, line });
    });

    tbody.appendChild(tr);
  }

  el('table-footer').textContent =
    `${filtered.length} issue${filtered.length !== 1 ? 's' : ''} shown  (${allIssues.length} total)`;
}

// ── Table sort ────────────────────────────────────────────────────────────────

document.querySelectorAll('#issues-table th[data-col]').forEach((th) => {
  th.addEventListener('click', () => {
    const col = th.getAttribute('data-col') ?? '';
    if (sortState.col === col) {
      sortState.dir = sortState.dir === 'asc' ? 'desc' : 'asc';
    } else {
      sortState.col = col;
      sortState.dir = 'asc';
    }
    document.querySelectorAll('#issues-table th[data-col]').forEach((h) => {
      h.classList.remove('sort-asc', 'sort-desc');
    });
    th.classList.add(sortState.dir === 'asc' ? 'sort-asc' : 'sort-desc');
    renderTable();
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function getBeginLine(issue) {
  if (issue.location?.lines?.begin)            return issue.location.lines.begin;
  if (issue.location?.positions?.begin?.line)  return issue.location.positions.begin.line;
  return 1;
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function el(id) {
  return /** @type {HTMLElement} */(document.getElementById(id));
}
