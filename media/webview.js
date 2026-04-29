// @ts-check
'use strict';

// Configure Prism before its script loads (set via inline <script> before prism.min.js)
if (window.Prism) { window.Prism.manual = true; }

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

// Base column definitions with their default sort index
const BASE_COLS = [
  { key: 'severity',    label: 'Severity',    baseIndex: 0 },
  { key: 'categories',  label: 'Category',    baseIndex: 1 },
  { key: 'check_name',  label: 'Check Name',  baseIndex: 2 },
  { key: 'sourceFile',  label: 'Source',      baseIndex: 3 },
  { key: 'file',        label: 'File',        baseIndex: 4 },
  { key: 'line',        label: 'Line',        baseIndex: 5 },
  { key: 'description', label: 'Description', baseIndex: 6 },
];

/** @type {any[]} */
let allIssues = [];
/** @type {any[]} */
let allFiles = [];

/** @type {Array<{name:string, index:number}>} custom column definitions from config */
let customColumnDefs = [];

/**
 * @type {{
 *   severities: Set<string>,
 *   categories: Set<string>|null,
 *   quickTerms: Set<string>,
 *   sourceFiles: Set<string>,
 *   search: string,
 *   custom: Record<string, Set<string>|null>
 * }}
 */
let filters = {
  severities: new Set(SEVERITY_ORDER),
  categories: null,
  quickTerms: new Set(),
  sourceFiles: new Set(),
  search: '',
  custom: {},
};

/** @type {{ showChartLegends: boolean, customColumns: Array<{name:string,index:number}> }} */
let config = { showChartLegends: false, customColumns: [] };

/** @type {{ col: string, dir: 'asc'|'desc' }} */
let sortState = { col: 'severity', dir: 'asc' };
/** @type {Record<string, any>} */
const charts = {};

/** @type {Set<string>} expanded issue IDs */
const expandedIds = new Set();

/** IDs expanded in the CURRENT renderTable call — animate only these */
const newlyExpandedIds = new Set();

/** @type {Map<string, {lines: Array<{number:number,text:string}>, highlightLine:number}>} */
const snippetCache = new Map();

/** @type {Map<string, string>} snippet id → Prism language string */
const snippetMeta = new Map();

// ── Column management ─────────────────────────────────────────────────────────

/**
 * Returns all active columns sorted by display index.
 * Base columns use their baseIndex; custom columns use their configured index.
 * Tiebreaker: base before custom.
 * @returns {Array<{key:string, label:string, baseIndex:number, isCustom?:boolean, name?:string}>}
 */
function getActiveColumns() {
  const custom = customColumnDefs.map(c => ({
    key: 'custom:' + c.name,
    label: c.name,
    baseIndex: c.index,
    isCustom: true,
    name: c.name,
  }));
  const all = [...BASE_COLS.map(c => ({ ...c })), ...custom];
  all.sort((a, b) => {
    if (a.baseIndex !== b.baseIndex) return a.baseIndex - b.baseIndex;
    return (a.isCustom ? 1 : 0) - (b.isCustom ? 1 : 0);
  });
  return all;
}

// ── Prism language detection ──────────────────────────────────────────────────

/** Map file extension → Prism language identifier */
function extToLang(filePath) {
  const ext = (filePath.split('.').pop() ?? '').toLowerCase();
  /** @type {Record<string,string>} */
  const map = {
    js: 'javascript', jsx: 'jsx', ts: 'typescript', tsx: 'tsx',
    rb: 'ruby', py: 'python', go: 'go', java: 'java',
    php: 'php', cs: 'csharp', cpp: 'cpp', cc: 'cpp', cxx: 'cpp',
    c: 'c', h: 'c', rs: 'rust', swift: 'swift',
    kt: 'kotlin', scala: 'scala', sh: 'bash', bash: 'bash',
    css: 'css', scss: 'scss', sass: 'scss', html: 'html', xml: 'xml',
    json: 'json', yaml: 'yaml', yml: 'yaml', md: 'markdown', sql: 'sql',
    ex: 'elixir', exs: 'elixir', erl: 'erlang', lua: 'lua',
    r: 'r', pl: 'perl', pm: 'perl',
  };
  return map[ext] ?? 'plain';
}

/** Highlight a single line of code using Prism if grammar is available */
function prismHighlight(text, lang) {
  if (lang === 'plain' || !window.Prism) return null;
  const grammar = window.Prism.languages[lang];
  if (!grammar) return null;
  try { return window.Prism.highlight(text ?? '', grammar, lang); } catch { return null; }
}

// ── Message handling ──────────────────────────────────────────────────────────

window.addEventListener('message', (event) => {
  const msg = event.data;
  if (msg.type === 'updateIssues') {
    allIssues = msg.issues ?? [];
    allFiles  = msg.files  ?? [];
    if (msg.config) config = { ...config, ...msg.config };
    customColumnDefs = config.customColumns ?? [];
    filters.sourceFiles = new Set(allFiles.map(/** @param {any} f */ f => f.uri));
    // Reset custom filters for columns that no longer exist
    const colNames = new Set(customColumnDefs.map(c => c.name));
    for (const k of Object.keys(filters.custom)) {
      if (!colNames.has(k)) delete filters.custom[k];
    }
    render();
  } else if (msg.type === 'snippet') {
    snippetCache.set(msg.issueId, { lines: msg.lines, highlightLine: msg.highlightLine });
    const container = document.getElementById(snippetContainerId(msg.issueId));
    const lang = snippetMeta.get(msg.issueId) ?? 'plain';
    if (container) renderSnippet(container, msg.lines, msg.highlightLine, lang);
  }
});

// ── Filtering ─────────────────────────────────────────────────────────────────

function parseTerms() {
  return filters.search.split(';').map(t => t.trim().toLowerCase()).filter(Boolean);
}

function getFiltered() {
  const typedTerms = parseTerms();
  return allIssues.filter((issue) => {
    if (!filters.severities.has(issue.severity ?? 'info')) return false;
    if (!filters.sourceFiles.has(issue.sourceUri))         return false;
    if (filters.categories !== null) {
      const cats = issue.categories ?? [];
      if (!cats.some(/** @param {string} c */ c => filters.categories.has(c))) return false;
    }
    for (const term of filters.quickTerms) {
      if (!matchesTerm(issue, term.toLowerCase())) return false;
    }
    // Custom column filters (AND between columns, OR within a column's values)
    for (const [colName, activeSet] of Object.entries(filters.custom)) {
      if (!activeSet || activeSet.size === 0) continue;
      const val = (issue.customColumns ?? {})[colName] ?? '';
      if (!activeSet.has(val)) return false;
    }
    if (typedTerms.length === 0) return true;
    return typedTerms.every(term => matchesTerm(issue, term));
  });
}

function matchesTerm(issue, term) {
  if (
    (issue.description    ?? '').toLowerCase().includes(term) ||
    (issue.location?.path ?? '').toLowerCase().includes(term) ||
    (issue.check_name     ?? '').toLowerCase().includes(term) ||
    (issue.sourceFile     ?? '').toLowerCase().includes(term) ||
    (issue.categories     ?? []).some(/** @param {string} c */ c => c.toLowerCase().includes(term))
  ) return true;
  for (const val of Object.values(issue.customColumns ?? {})) {
    if ((val ?? '').toLowerCase().includes(term)) return true;
  }
  return false;
}

/** @param {string} value */
function applyQuickFilter(value) {
  const v = value.trim();
  if (!v) return;
  const existing = [...filters.quickTerms].find(t => t.toLowerCase() === v.toLowerCase());
  if (existing !== undefined) filters.quickTerms.delete(existing);
  else filters.quickTerms.add(v);
  renderActiveFilters(); renderCharts(); renderTable();
}

/** @param {string} value */
function applySearchTerm(value) {
  const v = value.trim();
  const terms = filters.search.split(';').map(t => t.trim()).filter(Boolean);
  const idx = terms.findIndex(t => t.toLowerCase() === v.toLowerCase());
  if (idx >= 0) terms.splice(idx, 1); else terms.push(v);
  filters.search = terms.join('; ');
  const inp = /** @type {HTMLInputElement|null} */(document.getElementById('filter-search'));
  if (inp) inp.value = filters.search;
  renderActiveFilters(); renderCharts(); renderTable();
}

/** @param {string} cat */
function toggleCategoryFilter(cat) {
  if (filters.categories === null) {
    filters.categories = new Set([cat]);
  } else if (filters.categories.has(cat)) {
    filters.categories.delete(cat);
    if (filters.categories.size === 0) filters.categories = null;
  } else {
    filters.categories.add(cat);
  }
  renderActiveFilters(); renderCharts(); renderTable();
}

/** Isolate one source file (click again to restore all). */
function toggleSourceFileFilter(filename) {
  const file = allFiles.find(f => f.filename === filename);
  if (!file) return;
  const isIsolated = filters.sourceFiles.size === 1 && filters.sourceFiles.has(file.uri);
  filters.sourceFiles = isIsolated
    ? new Set(allFiles.map(/** @param {any} f */ f => f.uri))
    : new Set([file.uri]);
  renderCharts(); renderTable();
}

/**
 * Toggle a value in a custom column filter (OR logic within column).
 * @param {string} colName
 * @param {string} value
 */
function toggleCustomColumnFilter(colName, value) {
  let activeSet = filters.custom[colName] ?? null;
  if (activeSet === null) {
    filters.custom[colName] = new Set([value]);
  } else if (activeSet.has(value)) {
    activeSet.delete(value);
    if (activeSet.size === 0) filters.custom[colName] = null;
  } else {
    activeSet.add(value);
  }
  renderCustomColumnFilters(); renderActiveFilters(); renderCharts(); renderTable();
}

// ── Sorting ───────────────────────────────────────────────────────────────────

function getSorted(issues) {
  const { col, dir } = sortState;
  return [...issues].sort((a, b) => {
    let va, vb;
    if (col.startsWith('custom:')) {
      const name = col.slice(7);
      va = (a.customColumns ?? {})[name] ?? '';
      vb = (b.customColumns ?? {})[name] ?? '';
    } else {
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
  renderCustomColumnFilters();
  renderActiveFilters();
  renderTableHeader();
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

function renderCustomColumnFilters() {
  const container = document.getElementById('filter-custom');
  if (!container) return;
  container.innerHTML = '';

  for (const colDef of customColumnDefs) {
    const values = [...new Set(allIssues.map(i => (i.customColumns ?? {})[colDef.name] ?? ''))].filter(v => v !== '').sort();
    if (values.length <= 1) continue;

    const group = document.createElement('div');
    group.className = 'filter-group';

    const label = document.createElement('span');
    label.className = 'filter-label';
    label.textContent = colDef.name + ':';
    group.appendChild(label);

    const activeSet = filters.custom[colDef.name] ?? null;
    for (const val of values) {
      const badge = document.createElement('span');
      const isActive = activeSet !== null && activeSet.has(val);
      badge.className = 'cat-badge' + (isActive ? ' cat-active' : '');
      badge.textContent = val;
      badge.title = `${val} — click to filter`;
      badge.addEventListener('click', (e) => { e.stopPropagation(); toggleCustomColumnFilter(colDef.name, val); });
      group.appendChild(badge);
    }
    container.appendChild(group);
  }
}

function renderActiveFilters() {
  const container = el('active-filters');
  container.innerHTML = '';
  if (filters.categories !== null) {
    for (const cat of filters.categories) {
      container.appendChild(makeChip('cat: ' + cat, 'cat-filter-chip', () => toggleCategoryFilter(cat)));
    }
  }
  for (const [colName, activeSet] of Object.entries(filters.custom)) {
    if (!activeSet) continue;
    for (const val of activeSet) {
      container.appendChild(makeChip(`${colName}: ${val}`, 'cat-filter-chip', () => toggleCustomColumnFilter(colName, val)));
    }
  }
  for (const term of filters.quickTerms) {
    container.appendChild(makeChip(term, '', () => applyQuickFilter(term)));
  }
}

/**
 * @param {string} text
 * @param {string} extraClass
 * @param {() => void} onRemove
 */
function makeChip(text, extraClass, onRemove) {
  const chip = document.createElement('span');
  chip.className = 'active-filter-chip' + (extraClass ? ' ' + extraClass : '');
  const lbl = document.createElement('span');
  lbl.textContent = text;
  const btn = document.createElement('button');
  btn.className = 'chip-remove';
  btn.title = 'Remove filter';
  btn.textContent = '×';
  btn.addEventListener('click', onRemove);
  chip.appendChild(lbl); chip.appendChild(btn);
  return chip;
}

document.getElementById('filter-search')?.addEventListener('input', (e) => {
  filters.search = /** @type {HTMLInputElement} */(e.target).value;
  renderActiveFilters(); renderCharts(); renderTable();
});

// ── Table header (dynamic) ────────────────────────────────────────────────────

function renderTableHeader() {
  const thead = document.getElementById('issues-thead');
  if (!thead) return;
  thead.innerHTML = '';
  const tr = document.createElement('tr');
  for (const col of getActiveColumns()) {
    const th = document.createElement('th');
    th.setAttribute('data-col', col.key);
    th.textContent = col.label;
    th.className = 'col-' + colCssKey(col.key);
    if (sortState.col === col.key) th.classList.add(sortState.dir === 'asc' ? 'sort-asc' : 'sort-desc');
    th.addEventListener('click', () => {
      sortState.dir = (sortState.col === col.key && sortState.dir === 'asc') ? 'desc' : 'asc';
      sortState.col = col.key;
      renderTableHeader();
      renderTable();
    });
    tr.appendChild(th);
  }
  thead.appendChild(tr);
}

/** @param {string} key  column key → safe CSS class segment */
function colCssKey(key) { return key.replace(/[^a-zA-Z0-9_-]/g, '_'); }

// ── Charts ────────────────────────────────────────────────────────────────────

function renderCharts() {
  const filtered = getFiltered();
  renderPieChart('chart-severity',
    countBy(filtered, i => [i.severity ?? 'info'], SEVERITY_ORDER, SEVERITY_COLORS),
    (label) => {
      const isIsolated = filters.severities.size === 1 && filters.severities.has(label);
      filters.severities = isIsolated ? new Set(SEVERITY_ORDER) : new Set([label]);
      renderSeverityFilter(); renderCharts(); renderTable();
    });
  renderPieChart('chart-category',
    countBy(filtered, i => i.categories?.length ? i.categories : ['Uncategorized']),
    (label) => toggleCategoryFilter(label));
  renderPieChart('chart-checkname',
    topN(countBy(filtered, i => [i.check_name ?? '—']), 10),
    (label) => applyQuickFilter(label));
  renderPieChart('chart-source',
    countBy(filtered, i => [i.sourceFile ?? '—']),
    (label) => toggleSourceFileFilter(label));
  renderPieChart('chart-file',
    topN(countBy(filtered, i => [basename(i.location?.path ?? '—')]), 10),
    (label) => applyQuickFilter(label));
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

/**
 * @param {string} canvasId
 * @param {{ counts: Record<string,number>, colorMap: Record<string,string> }} data
 * @param {(label: string) => void} onClickLabel
 */
function renderPieChart(canvasId, { counts, colorMap }, onClickLabel) {
  const canvas = /** @type {HTMLCanvasElement|null} */(document.getElementById(canvasId));
  if (!canvas) return;
  const labels = Object.keys(counts).filter(k => counts[k] > 0);
  const values = labels.map(l => counts[l]);
  if (charts[canvasId]) { charts[canvasId].destroy(); }
  if (labels.length === 0) return;
  const total   = values.reduce((a, b) => a + b, 0);
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
        if (elements.length > 0) onClickLabel(labels[elements[0].index]);
      },
      onHover: (evt, elements) => {
        if (evt.native) /** @type {HTMLElement} */(evt.native.target).style.cursor =
          elements.length > 0 ? 'pointer' : 'default';
      },
      plugins: {
        legend: config.showChartLegends
          ? { display: true, position: 'bottom', labels: { color: fgColor, padding: 8, font: { size: 11 }, boxWidth: 12 } }
          : { display: false },
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
  const activeCols = getActiveColumns();

  // Issues count above the table
  const countBar = document.getElementById('issues-count-bar');
  if (countBar) {
    countBar.textContent = filtered.length === allIssues.length
      ? `${filtered.length} issue${filtered.length !== 1 ? 's' : ''}`
      : `${filtered.length} of ${allIssues.length} issues`;
  }

  for (const issue of filtered) {
    const line     = getBeginLine(issue);
    const sev      = issue.severity ?? 'info';
    const isExpanded = expandedIds.has(issue.id);
    const filePath = issue.location?.path ?? '';
    const fname    = basename(filePath);

    // ── Main row ──────────────────────────────────────────────────────────────
    const tr = document.createElement('tr');
    tr.className = `row-sev-${sev}${isExpanded ? ' row-expanded' : ''}`;
    tr.title = 'Click to expand';

    for (const col of activeCols) {
      let td;
      switch (col.key) {
        case 'severity': {
          td = document.createElement('td');
          td.className = 'col-severity';
          const badge = document.createElement('span');
          badge.className = `severity-badge sev-${sev} sev-badge-btn`;
          badge.textContent = sev;
          badge.title = `${sev} — click to isolate`;
          badge.addEventListener('click', (e) => {
            e.stopPropagation();
            const isIsolated = filters.severities.size === 1 && filters.severities.has(sev);
            filters.severities = isIsolated ? new Set(SEVERITY_ORDER) : new Set([sev]);
            renderSeverityFilter(); renderCharts(); renderTable();
          });
          td.appendChild(badge);
          break;
        }
        case 'categories': {
          td = document.createElement('td');
          td.className = 'col-categories';
          for (const cat of (issue.categories ?? [])) {
            const b = document.createElement('span');
            const isCatActive = filters.categories !== null && filters.categories.has(cat);
            b.className = 'cat-badge cat-clickable' + (isCatActive ? ' cat-active' : '');
            b.textContent = cat;
            b.title = `${cat} — click to filter`;
            b.addEventListener('click', (e) => { e.stopPropagation(); toggleCategoryFilter(cat); });
            td.appendChild(b);
          }
          break;
        }
        case 'check_name':
          td = makeFilterCell(issue.check_name ?? '', 'cell-mono col-check_name', () => applyQuickFilter(issue.check_name ?? ''));
          break;
        case 'sourceFile':
          td = makeFilterCell(issue.sourceFile ?? '', 'cell-mono col-sourceFile', () => applyQuickFilter(issue.sourceFile ?? ''));
          break;
        case 'file': {
          td = makeFilterCell(fname, 'cell-mono col-file', () => applyQuickFilter(fname));
          td.title = filePath;
          break;
        }
        case 'line': {
          td = document.createElement('td');
          td.className = 'cell-num col-line';
          td.textContent = String(line);
          break;
        }
        case 'description': {
          td = document.createElement('td');
          td.className = 'col-description';
          td.title = issue.description;
          td.textContent = issue.description;
          break;
        }
        default: {
          if (col.isCustom && col.name) {
            const val = (issue.customColumns ?? {})[col.name] ?? '';
            td = makeFilterCell(val, 'cell-mono col-custom', () => { if (val) toggleCustomColumnFilter(col.name ?? '', val); });
          } else {
            td = document.createElement('td');
          }
        }
      }
      tr.appendChild(td);
    }

    // Row click → expand / collapse
    tr.addEventListener('click', () => {
      if (expandedIds.has(issue.id)) {
        expandedIds.delete(issue.id);
      } else {
        expandedIds.add(issue.id);
        newlyExpandedIds.add(issue.id);
        if (!snippetCache.has(issue.id)) {
          snippetMeta.set(issue.id, extToLang(filePath));
          vscode.postMessage({ type: 'requestSnippet', issueId: issue.id, filePath, line });
        }
        for (const [idx, ol] of (issue.other_locations ?? []).entries()) {
          const olId = otherLocId(issue.id, idx);
          if (!snippetCache.has(olId)) {
            const olLine = resolveLineRef(ol.lines?.begin ?? ol.positions?.begin);
            snippetMeta.set(olId, extToLang(ol.path ?? ''));
            vscode.postMessage({ type: 'requestSnippet', issueId: olId, filePath: ol.path ?? '', line: olLine });
          }
        }
      }
      renderTable();
    });

    tbody.appendChild(tr);

    // ── Detail row ────────────────────────────────────────────────────────────
    if (isExpanded) {
      const detailTr = makeDetailRow(issue, line, filePath, activeCols.length);
      tbody.appendChild(detailTr);
      const anim = detailTr.querySelector('.detail-anim');
      if (newlyExpandedIds.has(issue.id)) {
        if (anim) requestAnimationFrame(() => anim.classList.add('detail-anim-open'));
      } else {
        if (anim) anim.classList.add('detail-anim-open');
      }
    }
  }

  newlyExpandedIds.clear();

  el('table-footer').textContent =
    `${filtered.length} issue${filtered.length !== 1 ? 's' : ''} shown  (${allIssues.length} total)`;
}

/**
 * Cell where only the text span is the filter hitbox; td does the clipping.
 * @param {string} text
 * @param {string} extraClass
 * @param {() => void} onClick
 */
function makeFilterCell(text, extraClass, onClick) {
  const td = document.createElement('td');
  if (extraClass) td.className = extraClass;
  const span = document.createElement('span');
  span.className = 'filter-text' + (isActiveFilter(text) ? ' filter-text-active' : '');
  span.title = `${text} — click to filter`;
  span.textContent = text;
  span.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
  td.appendChild(span);
  return td;
}

/**
 * @param {any} issue
 * @param {number} line
 * @param {string} fullPath
 * @param {number} colSpan
 */
function makeDetailRow(issue, line, fullPath, colSpan) {
  const tr = document.createElement('tr');
  tr.className = 'detail-row';

  const td = document.createElement('td');
  td.colSpan = colSpan;

  const anim = document.createElement('div');
  anim.className = 'detail-anim';

  const wrap = document.createElement('div');
  wrap.className = 'detail-content';
  wrap.addEventListener('click', e => e.stopPropagation());

  // 1. Full path:line — clickable, opens file
  if (fullPath) {
    const pathEl = document.createElement('div');
    pathEl.className = 'detail-path-link';
    pathEl.textContent = line ? `${fullPath}:${line}` : fullPath;
    pathEl.title = 'Click to open in editor';
    pathEl.addEventListener('click', (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: 'openFile', filePath: fullPath, line });
    });
    wrap.appendChild(pathEl);
  }

  // 2. Description
  if (issue.description) {
    const descEl = document.createElement('div');
    descEl.className = 'detail-desc';
    descEl.textContent = issue.description;
    wrap.appendChild(descEl);
  }

  // 3. Code snippet (main location)
  wrap.appendChild(makeSnippetContainer(issue.id));

  // 4. Body (fix guidance)
  if (issue.content?.body) {
    const bodyEl = document.createElement('div');
    bodyEl.className = 'detail-body';
    bodyEl.textContent = issue.content.body;
    wrap.appendChild(bodyEl);
  }

  // 5. Other locations
  for (const [idx, ol] of (issue.other_locations ?? []).entries()) {
    const olPath = ol.path ?? '';
    const olLine = resolveLineRef(ol.lines?.begin ?? ol.positions?.begin);

    const block = document.createElement('div');
    block.className = 'other-loc-block';

    const label = document.createElement('span');
    label.className = 'other-loc-label';
    label.textContent = 'Référencé ici';

    const pathEl = document.createElement('span');
    pathEl.className = 'other-loc-path detail-path-link';
    pathEl.textContent = olLine ? `${olPath}:${olLine}` : olPath;
    pathEl.title = 'Click to open in editor';
    pathEl.addEventListener('click', (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: 'openFile', filePath: olPath, line: olLine });
    });

    block.appendChild(label);
    block.appendChild(pathEl);
    block.appendChild(makeSnippetContainer(otherLocId(issue.id, idx)));
    wrap.appendChild(block);
  }

  // 6. Fingerprint — right-aligned, click copies
  if (issue.fingerprint) {
    const fpEl = document.createElement('div');
    fpEl.className = 'detail-fingerprint';
    fpEl.textContent = issue.fingerprint;
    fpEl.title = 'Click to copy fingerprint';
    fpEl.addEventListener('click', (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(issue.fingerprint).then(() => {
        fpEl.textContent = 'Copied!';
        fpEl.classList.add('copied');
        setTimeout(() => { fpEl.textContent = issue.fingerprint; fpEl.classList.remove('copied'); }, 1500);
      });
    });
    wrap.appendChild(fpEl);
  }

  anim.appendChild(wrap);
  td.appendChild(anim);
  tr.appendChild(td);
  return tr;
}

/** @param {string} id */
function makeSnippetContainer(id) {
  const div = document.createElement('div');
  div.className = 'snippet-container';
  div.id = snippetContainerId(id);
  const cached = snippetCache.get(id);
  const lang = snippetMeta.get(id) ?? 'plain';
  if (cached) {
    renderSnippet(div, cached.lines, cached.highlightLine, lang);
  } else {
    div.innerHTML = '<span class="snippet-loading">Loading snippet…</span>';
  }
  return div;
}

/**
 * @param {HTMLElement} container
 * @param {Array<{number:number,text:string}>} lines
 * @param {number} highlightLine
 * @param {string} [lang]
 */
function renderSnippet(container, lines, highlightLine, lang = 'plain') {
  container.innerHTML = '';
  if (!lines || lines.length === 0) {
    container.innerHTML = '<span class="snippet-loading">Snippet not available.</span>';
    return;
  }
  const pre = document.createElement('pre');
  pre.className = 'snippet-pre';
  for (const { number, text } of lines) {
    const lineEl = document.createElement('div');
    lineEl.className = 'snippet-line' + (number === highlightLine ? ' snippet-hl' : '');
    const numEl = document.createElement('span');
    numEl.className = 'snippet-num';
    numEl.textContent = String(number);
    const textEl = document.createElement('span');
    textEl.className = 'snippet-text';
    const highlighted = prismHighlight(text ?? '', lang);
    if (highlighted !== null) {
      textEl.innerHTML = highlighted;
    } else {
      textEl.textContent = text ?? '';
    }
    lineEl.appendChild(numEl);
    lineEl.appendChild(textEl);
    pre.appendChild(lineEl);
  }
  container.appendChild(pre);
}

/** @param {string} issueId @param {number} idx */
function otherLocId(issueId, idx) { return `${issueId}::ol::${idx}`; }

/** @param {string} id */
function snippetContainerId(id) { return 'snip-' + id.replace(/[^a-zA-Z0-9]/g, '_'); }

function isActiveFilter(value) {
  if (!value || filters.quickTerms.size === 0) return false;
  const lv = value.toLowerCase();
  for (const t of filters.quickTerms) { if (lv.includes(t.toLowerCase())) return true; }
  return false;
}

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

function basename(p) { return p.slice(p.lastIndexOf('/') + 1); }

function el(id) { return /** @type {HTMLElement} */(document.getElementById(id)); }
