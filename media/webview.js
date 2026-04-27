// @ts-check
'use strict';

const vscode = acquireVsCodeApi();

const SEVERITY_ORDER = ['blocker', 'critical', 'major', 'minor', 'info'];
const SEVERITY_COLORS = {
  blocker:  '#7b1fa2',
  critical: '#e53935',
  major:    '#f4511e',
  minor:    '#f9a825',
  info:     '#78909c',
};
const PALETTE = [
  '#ff6384','#36a2eb','#ffce56','#4bc0c0','#9966ff',
  '#ff9f40','#c9cbcf','#e74c3c','#2ecc71','#3498db',
  '#f39c12','#9b59b6','#1abc9c','#34495e','#e67e22',
];
const COL_COUNT = 7;

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

/** @type {Set<string>} issue IDs currently expanded */
const expandedIds = new Set();

// ── Message handling ──────────────────────────────────────────────────────────

window.addEventListener('message', (event) => {
  const msg = event.data;
  if (msg.type === 'updateIssues') {
    allIssues = msg.issues ?? [];
    allFiles  = msg.files  ?? [];
    filters.sourceFiles = new Set(allFiles.map(/** @param {any} f */ f => f.uri));
    render();
  }
});

// ── Filtering ─────────────────────────────────────────────────────────────────

/** Parse ';'-separated search string into trimmed non-empty terms */
function parseTerms() {
  return filters.search.split(';').map(t => t.trim().toLowerCase()).filter(Boolean);
}

function getFiltered() {
  const terms = parseTerms();
  return allIssues.filter((issue) => {
    if (!filters.severities.has(issue.severity ?? 'info')) return false;
    if (!filters.sourceFiles.has(issue.sourceUri))         return false;
    if (terms.length === 0) return true;
    return terms.every(term => matchesTerm(issue, term));
  });
}

function matchesTerm(issue, term) {
  return (
    (issue.description    ?? '').toLowerCase().includes(term) ||
    (issue.location?.path ?? '').toLowerCase().includes(term) ||
    (issue.check_name     ?? '').toLowerCase().includes(term) ||
    (issue.sourceFile     ?? '').toLowerCase().includes(term) ||
    (issue.categories     ?? []).some(/** @param {string} c */ c => c.toLowerCase().includes(term))
  );
}

/**
 * Add or remove `value` from the ';'-separated search string (toggle).
 * Updates the search input and re-renders.
 * @param {string} value
 */
function applySearchTerm(value) {
  const v = value.trim();
  const terms = filters.search.split(';').map(t => t.trim()).filter(Boolean);
  const idx = terms.findIndex(t => t.toLowerCase() === v.toLowerCase());
  if (idx >= 0) {
    terms.splice(idx, 1);
  } else {
    terms.push(v);
  }
  filters.search = terms.join('; ');
  const inp = /** @type {HTMLInputElement|null} */(document.getElementById('filter-search'));
  if (inp) inp.value = filters.search;
  renderActiveFilters();
  renderCharts();
  renderTable();
}

// ── Sorting ───────────────────────────────────────────────────────────────────

function getSorted(issues) {
  const { col, dir } = sortState;
  return [...issues].sort((a, b) => {
    let va, vb;
    switch (col) {
      case 'severity':    va = SEVERITY_ORDER.indexOf(a.severity ?? 'info'); vb = SEVERITY_ORDER.indexOf(b.severity ?? 'info'); break;
      case 'line':        va = getBeginLine(a);          vb = getBeginLine(b);          break;
      case 'file':        va = basename(a.location?.path ?? ''); vb = basename(b.location?.path ?? ''); break;
      case 'sourceFile':  va = a.sourceFile  ?? '';      vb = b.sourceFile  ?? '';      break;
      case 'check_name':  va = a.check_name  ?? '';      vb = b.check_name  ?? '';      break;
      case 'description': va = a.description ?? '';      vb = b.description ?? '';      break;
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
  el('empty-state').style.display  = hasData ? 'none' : '';
  el('main-content').style.display = hasData ? ''     : 'none';
  if (!hasData) return;

  renderFileChips();
  renderSeverityFilter();
  renderSourceFileFilter();
  renderActiveFilters();
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
    btn.addEventListener('click', () => vscode.postMessage({ type: 'removeSourceFile', uri: file.uri }));
    chip.appendChild(btn);
    container.appendChild(chip);
  }
}

// ── Filter bar ────────────────────────────────────────────────────────────────

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
      renderCharts(); renderTable();
    });
    const badge = document.createElement('span');
    badge.className = `severity-badge sev-${sev}`;
    badge.textContent = sev;
    label.appendChild(cb); label.appendChild(badge);
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
      renderCharts(); renderTable();
    });
    label.appendChild(cb);
    label.appendChild(document.createTextNode(' ' + file.filename));
    container.appendChild(label);
  }
}

/** Active search terms shown as removable chips */
function renderActiveFilters() {
  const container = el('active-filters');
  container.innerHTML = '';
  const terms = parseTerms();
  for (const term of terms) {
    const chip = document.createElement('span');
    chip.className = 'active-filter-chip';
    const lbl = document.createElement('span');
    lbl.textContent = term;
    const btn = document.createElement('button');
    btn.className = 'chip-remove';
    btn.title = 'Remove filter';
    btn.textContent = '×';
    btn.addEventListener('click', () => {
      const kept = parseTerms().filter(t => t.toLowerCase() !== term.toLowerCase());
      filters.search = kept.join('; ');
      const inp = /** @type {HTMLInputElement|null} */(document.getElementById('filter-search'));
      if (inp) inp.value = filters.search;
      renderActiveFilters(); renderCharts(); renderTable();
    });
    chip.appendChild(lbl); chip.appendChild(btn);
    container.appendChild(chip);
  }
}

document.getElementById('filter-search')?.addEventListener('input', (e) => {
  filters.search = /** @type {HTMLInputElement} */(e.target).value;
  renderActiveFilters(); renderCharts(); renderTable();
});

// ── Charts ────────────────────────────────────────────────────────────────────

function renderCharts() {
  const filtered = getFiltered();
  renderPieChart('chart-severity',  countBy(filtered, i => [i.severity ?? 'info'],                             SEVERITY_ORDER, SEVERITY_COLORS));
  renderPieChart('chart-category',  countBy(filtered, i => i.categories?.length ? i.categories : ['Uncategorized']));
  renderPieChart('chart-checkname', topN(countBy(filtered, i => [i.check_name ?? '—']), 10));
}

function countBy(issues, keyFn, order, colorMap = {}) {
  /** @type {Record<string,number>} */
  const counts = {};
  if (order) for (const k of order) counts[k] = 0;
  for (const issue of issues) for (const k of keyFn(issue)) counts[k] = (counts[k] ?? 0) + 1;
  if (order) for (const k of order) { if (counts[k] === 0) delete counts[k]; }
  return { counts, colorMap };
}

function topN(data, n) {
  const top = Object.fromEntries(Object.entries(data.counts).sort((a, b) => b[1] - a[1]).slice(0, n));
  return { counts: top, colorMap: data.colorMap };
}

function renderPieChart(canvasId, { counts, colorMap }) {
  const canvas = /** @type {HTMLCanvasElement|null} */(document.getElementById(canvasId));
  if (!canvas) return;

  const labels = Object.keys(counts).filter(k => counts[k] > 0);
  const values = labels.map(l => counts[l]);

  if (charts[canvasId]) { charts[canvasId].destroy(); }
  if (labels.length === 0) return;

  const total  = values.reduce((a, b) => a + b, 0);
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
      onClick: (_evt, elements) => {
        if (elements.length > 0) applySearchTerm(labels[elements[0].index]);
      },
      onHover: (evt, elements) => {
        if (evt.native) /** @type {HTMLElement} */(evt.native.target).style.cursor =
          elements.length > 0 ? 'pointer' : 'default';
      },
      plugins: {
        legend: { position: 'bottom', labels: { color: fgColor, padding: 8, font: { size: 11 }, boxWidth: 12 } },
        tooltip: {
          callbacks: {
            label: ctx => ` ${ctx.label}: ${ctx.raw} (${Math.round(/** @type {number} */(ctx.raw) / total * 100)}%)`,
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
  const terms = parseTerms();

  for (const issue of filtered) {
    const line = getBeginLine(issue);
    const sev  = issue.severity ?? 'info';
    const isExpanded = expandedIds.has(issue.id);

    // ── Main row ──────────────────────────────────────────────────────────────
    const tr = document.createElement('tr');
    tr.className = `row-sev-${sev}${isExpanded ? ' row-expanded' : ''}`;
    tr.title = 'Click to expand';

    // Severity
    const tdSev = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = `severity-badge sev-${sev}`;
    badge.textContent = sev;
    tdSev.appendChild(badge);
    tr.appendChild(tdSev);

    // Category (clickable badges)
    const tdCat = document.createElement('td');
    for (const cat of (issue.categories ?? [])) {
      const b = document.createElement('span');
      b.className = 'cat-badge cat-clickable';
      b.textContent = cat;
      b.title = `${cat} — click to filter`;
      b.addEventListener('click', (e) => { e.stopPropagation(); applySearchTerm(cat); });
      tdCat.appendChild(b);
    }
    tr.appendChild(tdCat);

    // Check Name (clickable)
    const tdCheck = document.createElement('td');
    tdCheck.className = 'cell-truncate cell-clickable' + (isActiveFilter(terms, issue.check_name) ? ' cell-active-filter' : '');
    tdCheck.title = `${issue.check_name} — click to filter`;
    tdCheck.textContent = issue.check_name;
    tdCheck.addEventListener('click', (e) => { e.stopPropagation(); applySearchTerm(issue.check_name); });
    tr.appendChild(tdCheck);

    // Source file (clickable)
    const tdSrc = document.createElement('td');
    tdSrc.className = 'cell-mono cell-truncate cell-clickable' + (isActiveFilter(terms, issue.sourceFile) ? ' cell-active-filter' : '');
    tdSrc.title = `${issue.sourceFile} — click to filter`;
    tdSrc.textContent = issue.sourceFile;
    tdSrc.addEventListener('click', (e) => { e.stopPropagation(); applySearchTerm(issue.sourceFile); });
    tr.appendChild(tdSrc);

    // File — filename only, tooltip = full path, clickable
    const path = issue.location?.path ?? '';
    const fname = basename(path);
    const tdFile = document.createElement('td');
    tdFile.className = 'cell-mono cell-truncate cell-clickable' + (isActiveFilter(terms, fname) ? ' cell-active-filter' : '');
    tdFile.title = `${path} — click to filter`;
    tdFile.textContent = fname;
    tdFile.addEventListener('click', (e) => { e.stopPropagation(); applySearchTerm(fname); });
    tr.appendChild(tdFile);

    // Line
    const tdLine = document.createElement('td');
    tdLine.className = 'cell-num';
    tdLine.textContent = String(line);
    tr.appendChild(tdLine);

    // Description (truncated)
    const tdDesc = document.createElement('td');
    tdDesc.className = 'cell-desc';
    tdDesc.title = issue.description;
    tdDesc.textContent = issue.description;
    tr.appendChild(tdDesc);

    // Row click → expand / collapse
    tr.addEventListener('click', () => {
      if (expandedIds.has(issue.id)) expandedIds.delete(issue.id);
      else expandedIds.add(issue.id);
      renderTable();
    });

    tbody.appendChild(tr);

    // ── Detail row (when expanded) ────────────────────────────────────────────
    if (isExpanded) {
      tbody.appendChild(makeDetailRow(issue, line, path));
    }
  }

  el('table-footer').textContent =
    `${filtered.length} issue${filtered.length !== 1 ? 's' : ''} shown  (${allIssues.length} total)`;
}

/**
 * @param {any} issue
 * @param {number} line
 * @param {string} fullPath
 */
function makeDetailRow(issue, line, fullPath) {
  const tr = document.createElement('tr');
  tr.className = 'detail-row';

  const td = document.createElement('td');
  td.colSpan = COL_COUNT;

  const wrap = document.createElement('div');
  wrap.className = 'detail-content';

  /** @param {string} label @param {string|undefined} value @param {boolean} [mono] */
  function addField(label, value, mono = false) {
    if (!value) return;
    const row = document.createElement('div');
    row.className = 'detail-field';
    const lbl = document.createElement('span');
    lbl.className = 'detail-label';
    lbl.textContent = label + ':';
    const val = document.createElement('span');
    val.className = 'detail-value' + (mono ? ' detail-mono' : '');
    val.textContent = value;
    row.appendChild(lbl); row.appendChild(val);
    wrap.appendChild(row);
  }

  addField('Full path', fullPath, true);
  addField('Description', issue.description);
  if (issue.content?.body) addField('Details', issue.content.body);
  if (issue.fingerprint) addField('Fingerprint', issue.fingerprint, true);
  if (issue.remediation_points) addField('Remediation', `${issue.remediation_points} pts`);
  if (issue.other_locations?.length) {
    addField('Other locations', issue.other_locations.map(/** @param {any} l */ l => l.path).join(', '), true);
  }

  const btn = document.createElement('button');
  btn.className = 'open-file-btn';
  btn.textContent = 'Open in editor ↗';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    vscode.postMessage({ type: 'openFile', filePath: fullPath, line });
  });
  wrap.appendChild(btn);

  td.appendChild(wrap);
  tr.appendChild(td);
  return tr;
}

/** True if `value` matches any active search term */
function isActiveFilter(terms, value) {
  if (!value || terms.length === 0) return false;
  const lv = value.toLowerCase();
  return terms.some(t => lv.includes(t));
}

// ── Table header sort ─────────────────────────────────────────────────────────

document.querySelectorAll('#issues-table th[data-col]').forEach((th) => {
  th.addEventListener('click', () => {
    const col = th.getAttribute('data-col') ?? '';
    sortState.dir = (sortState.col === col && sortState.dir === 'asc') ? 'desc' : 'asc';
    sortState.col = col;
    document.querySelectorAll('#issues-table th[data-col]').forEach(h => h.classList.remove('sort-asc', 'sort-desc'));
    th.classList.add(sortState.dir === 'asc' ? 'sort-asc' : 'sort-desc');
    renderTable();
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function getBeginLine(issue) {
  return resolveLineRef(issue.location?.lines?.begin ?? issue.location?.positions?.begin);
}

function resolveLineRef(ref) {
  if (ref === undefined || ref === null) return 1;
  if (typeof ref === 'object' && 'line' in ref) { const n = Number(ref.line); return n > 0 ? n : 1; }
  const n = Number(ref);
  return n > 0 ? n : 1;
}

function basename(p) {
  return p.slice(p.lastIndexOf('/') + 1);
}

function esc(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function el(id) {
  return /** @type {HTMLElement} */(document.getElementById(id));
}
