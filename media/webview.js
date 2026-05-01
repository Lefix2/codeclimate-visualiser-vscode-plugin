// @ts-check
'use strict';

if (window.Prism) { window.Prism.manual = true; }

const vscode = acquireVsCodeApi();

const SEVERITY_ORDER = ['blocker', 'critical', 'major', 'minor', 'info'];
const SEVERITY_COLORS = {
  blocker:  '#c084fc',
  critical: '#f87171',
  major:    '#fb923c',
  minor:    '#fbbf24',
  info:     '#71717a',
};

const BASE_COLS = [
  { key: 'severity',    label: 'Severity',    baseIndex: 0 },
  { key: 'categories',  label: 'Category',    baseIndex: 1 },
  { key: 'check_name',  label: 'Check',       baseIndex: 2 },
  { key: 'file',        label: 'File',        baseIndex: 3 },
  { key: 'line',        label: 'Line',        baseIndex: 4 },
  { key: 'description', label: 'Description', baseIndex: 5 },
];

/** @type {any[]} */
let allIssues = [];
/** @type {any[]} */
let allFiles = [];
/** @type {Array<{name:string, index:number}>} */
let customColumnDefs = [];
/** @type {any[]} */
let historySnapshots = [];

/** @type {{severities:Set<string>, categories:Set<string>|null, quickTerms:Set<string>, sourceFiles:Set<string>, search:string, custom:Record<string,Set<string>|null>}} */
let filters = {
  severities: new Set(SEVERITY_ORDER),
  categories: null,
  quickTerms: new Set(),
  sourceFiles: new Set(),
  search: '',
  custom: {},
};

let config = {
  showChartLegends:    false,
  showSeverityFilter:  true,
  showCategoryFilter:  true,
  showCheckNameFilter: true,
  showSeverityChart:   true,
  showCategoryChart:   true,
  showCheckNameChart:  true,
  showSourceChart:     true,
  showFileChart:       true,
  /** @type {Array<{name:string,index:number}>} */
  customColumns: [],
};

/** @type {{ col: string, dir: 'asc'|'desc' }} */
let sortState = { col: 'severity', dir: 'asc' };

/** @type {Set<string>} */
const expandedIds = new Set();
const newlyExpandedIds = new Set();

/** @type {Map<string, {lines:Array<{number:number,text:string}>, highlightLine:number}>} */
const snippetCache = new Map();
/** @type {Map<string, string>} */
const snippetMeta = new Map();

// ── View state ────────────────────────────────────────────────────────────────

let currentView = 'overview';
let navTabsReady = false;

function setView(view) {
  currentView = view;
  document.querySelectorAll('.dash-nav-tab').forEach(btn => {
    /** @type {HTMLElement} */(btn).classList.toggle('active', /** @type {HTMLElement} */(btn).dataset.view === view);
  });
  renderCurrentView();
}

function setupNavTabs() {
  if (navTabsReady) return;
  navTabsReady = true;
  document.querySelectorAll('.dash-nav-tab').forEach(btn => {
    btn.addEventListener('click', () => setView(/** @type {HTMLElement} */(btn).dataset.view ?? 'overview'));
  });
}

function updateSubtitle() {
  const sub = document.getElementById('dash-subtitle');
  if (!sub) return;
  const fileCount = new Set(allIssues.map(i => i.sourceUri)).size;
  sub.textContent = `${allIssues.length.toLocaleString()} issues · ${fileCount} source file${fileCount !== 1 ? 's' : ''}`;
}

function renderCurrentView() {
  const container = el('view-container');
  if (!container) return;
  switch (currentView) {
    case 'overview': buildOverviewView(container); break;
    case 'issues':   buildIssuesView(container);   break;
    case 'files':    buildFilesView(container);     break;
    case 'treemap':  buildTreemapView(container);   break;
    case 'trends':   buildTrendsView(container);    break;
  }
}

// ── Column management ─────────────────────────────────────────────────────────

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

// ── Prism ─────────────────────────────────────────────────────────────────────

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

function prismHighlight(text, lang) {
  if (lang === 'plain' || !window.Prism) return null;
  const grammar = window.Prism.languages[lang];
  if (!grammar) return null;
  try { return window.Prism.highlight(text ?? '', grammar, lang); } catch { return null; }
}

// ── Custom columns ────────────────────────────────────────────────────────────

function getNestedField(obj, path) {
  return path.split('.').reduce((o, k) => (o != null ? o[k] : undefined), obj);
}

function getIssueCustomValue(issue, colDef) {
  if (colDef.fromField && colDef.fieldRegex) {
    const fieldVal = String(getNestedField(issue, colDef.fromField) ?? '');
    const match = fieldVal.match(new RegExp(colDef.fieldRegex));
    if (match) {
      const g = (colDef.captureGroup ?? 0) + 1;
      return match[g] ?? '';
    }
    return '';
  }
  return (issue.customColumns ?? {})[colDef.name] ?? '';
}

// ── Message handling ──────────────────────────────────────────────────────────

window.addEventListener('message', (event) => {
  const msg = event.data;
  if (msg.type === 'updateIssues') {
    allIssues        = msg.issues   ?? [];
    allFiles         = msg.files    ?? [];
    historySnapshots = msg.history  ?? [];
    if (msg.config) config = { ...config, ...msg.config };
    customColumnDefs = config.customColumns ?? [];
    filters.sourceFiles = new Set(allFiles.map(/** @param {any} f */ f => f.uri));
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
  } else if (msg.type === 'focusIssue') {
    handleFocusIssue(msg.issueId);
  }
});

function handleFocusIssue(issueId) {
  filters.severities = new Set(SEVERITY_ORDER);
  filters.categories = null;
  filters.quickTerms = new Set();
  filters.sourceFiles = new Set(allFiles.map(/** @param {any} f */ f => f.uri));
  filters.search = '';
  filters.custom = {};

  expandedIds.add(issueId);
  newlyExpandedIds.add(issueId);

  setView('issues');

  if (!snippetCache.has(issueId)) {
    const issue = allIssues.find(i => i.id === issueId);
    if (issue) {
      const filePath = issue.location?.path ?? '';
      const line = resolveLineRef(issue.location?.lines?.begin ?? issue.location?.positions?.begin);
      snippetMeta.set(issueId, extToLang(filePath));
      vscode.postMessage({ type: 'requestSnippet', issueId, filePath, line });
    }
  }

  requestAnimationFrame(() => {
    let targetRow = null;
    for (const row of document.querySelectorAll('tr[data-issue-id]')) {
      if (/** @type {HTMLElement} */(row).dataset.issueId === issueId) { targetRow = row; break; }
    }
    if (targetRow) {
      targetRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
      targetRow.classList.add('row-flash');
      setTimeout(() => targetRow.classList.remove('row-flash'), 1400);
    }
  });
}

// ── Main render ───────────────────────────────────────────────────────────────

function render() {
  const hasData = allIssues.length > 0;
  el('empty-state').style.display  = hasData ? 'none' : '';
  el('dashboard').style.display    = hasData ? ''     : 'none';
  if (!hasData) return;
  updateSubtitle();
  setupNavTabs();
  renderCurrentView();
}

// ── Overview view ─────────────────────────────────────────────────────────────

function buildOverviewView(container) {
  container.innerHTML = '';
  const view = document.createElement('div');
  view.className = 'view';

  const counts = { blocker: 0, critical: 0, major: 0, minor: 0, info: 0 };
  for (const i of allIssues) counts[(i.severity ?? 'info')]++;
  const total = allIssues.length;
  const fileCount = new Set(allIssues.map(i => i.location?.path ?? '').filter(Boolean)).size;

  // KPI grid (3 large)
  const kpiGrid = document.createElement('div');
  kpiGrid.className = 'kpi-grid';
  kpiGrid.appendChild(makeKPICard('Total Issues', total.toLocaleString(), null, null));
  kpiGrid.appendChild(makeKPICard('Blocker',  counts.blocker,  'blocker',  '--sev-blocker'));
  kpiGrid.appendChild(makeKPICard('Critical', counts.critical, 'critical', '--sev-critical'));
  view.appendChild(kpiGrid);

  // KPI sev row (4 small)
  const sevRow = document.createElement('div');
  sevRow.className = 'kpi-sev-row';
  const sevSmall = [
    { label: 'Major', color: SEVERITY_COLORS.major, val: counts.major },
    { label: 'Minor', color: SEVERITY_COLORS.minor, val: counts.minor },
    { label: 'Info',  color: SEVERITY_COLORS.info,  val: counts.info },
    { label: 'Files', color: 'var(--border-strong)', val: fileCount },
  ];
  for (const s of sevSmall) {
    const card = document.createElement('div');
    card.className = 'kpi-sev';
    const bar = document.createElement('div');
    bar.className = 'kpi-sev-bar';
    bar.style.background = s.color;
    const info = document.createElement('div');
    info.className = 'kpi-sev-info';
    const lbl = document.createElement('div');
    lbl.className = 'kpi-sev-label';
    lbl.style.color = s.color;
    lbl.textContent = s.label;
    const val = document.createElement('div');
    val.className = 'kpi-sev-val';
    val.style.color = s.color;
    val.textContent = s.val.toLocaleString();
    info.appendChild(lbl);
    info.appendChild(val);
    card.appendChild(bar);
    card.appendChild(info);
    sevRow.appendChild(card);
  }
  view.appendChild(sevRow);

  // Row 1: donut | by category | top check names
  const row1 = document.createElement('div');
  row1.className = 'row row-3col';

  // Donut card
  const donutCard = document.createElement('div');
  donutCard.className = 'card';
  const donutHeader = document.createElement('div');
  donutHeader.className = 'card-header';
  const donutTitle = document.createElement('div');
  donutTitle.className = 'card-title';
  donutTitle.textContent = 'Severity Breakdown';
  const donutAction = document.createElement('div');
  donutAction.className = 'card-action';
  donutAction.textContent = 'Open issues →';
  donutAction.addEventListener('click', () => setView('issues'));
  donutHeader.appendChild(donutTitle);
  donutHeader.appendChild(donutAction);
  const donutWrap = buildDonutChart(counts, total);
  donutCard.appendChild(donutHeader);
  donutCard.appendChild(donutWrap);
  row1.appendChild(donutCard);

  // Category bar
  const catEntries = computeTopN(allIssues, i => (i.categories ?? [])[0] ?? '—', 8);
  row1.appendChild(buildBarCard('By Category', catEntries, '#22d3ee'));

  // Check name bar
  const checkEntries = computeTopN(allIssues, i => i.check_name ?? '—', 8);
  row1.appendChild(buildBarCard('Top Check Names', checkEntries, '#7c5cff'));

  view.appendChild(row1);

  // Row 2: top files | by source
  const row2 = document.createElement('div');
  row2.className = 'row row-2col';

  const fileEntries = computeTopN(allIssues, i => basename(i.location?.path ?? '—'), 10);
  const fileCard = buildBarCard('Top Files by Issue Count', fileEntries, 'var(--accent)');
  row2.appendChild(fileCard);

  const srcEntries = computeTopN(allIssues, i => i.sourceFile ?? '—', 8);
  const srcCard = buildBarCard('By Source Report', srcEntries, '#fb923c');
  row2.appendChild(srcCard);

  view.appendChild(row2);
  container.appendChild(view);
}

/**
 * @param {string} label
 * @param {string|number} value
 * @param {string|null} sev
 * @param {string|null} colorVar
 */
function makeKPICard(label, value, sev, colorVar) {
  const card = document.createElement('div');
  card.className = 'kpi';
  const lbl = document.createElement('div');
  lbl.className = 'kpi-label';
  if (sev) {
    const dot = document.createElement('span');
    dot.className = 'kpi-dot';
    dot.style.background = SEVERITY_COLORS[sev] ?? 'var(--accent)';
    lbl.appendChild(dot);
  }
  lbl.appendChild(document.createTextNode(label));
  const body = document.createElement('div');
  body.className = 'kpi-body';
  const valEl = document.createElement('div');
  valEl.className = 'kpi-value';
  if (colorVar) valEl.style.color = `var(${colorVar})`;
  valEl.textContent = String(value);
  body.appendChild(valEl);
  card.appendChild(lbl);
  card.appendChild(body);
  return card;
}

function buildDonutChart(counts, total) {
  const size = 160, thickness = 22;
  const r = size / 2 - thickness / 2 - 2;
  const c = 2 * Math.PI * r;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.style.flexShrink = '0';

  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  bg.setAttribute('cx', String(size / 2));
  bg.setAttribute('cy', String(size / 2));
  bg.setAttribute('r', String(r));
  bg.setAttribute('fill', 'none');
  bg.style.stroke = 'var(--surface-2)';
  bg.setAttribute('stroke-width', String(thickness));
  svg.appendChild(bg);

  let offset = 0;
  for (const sev of SEVERITY_ORDER) {
    const val = counts[sev] ?? 0;
    if (val === 0) continue;
    const len = c * (val / total);
    const arc = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    arc.setAttribute('cx', String(size / 2));
    arc.setAttribute('cy', String(size / 2));
    arc.setAttribute('r', String(r));
    arc.setAttribute('fill', 'none');
    arc.style.stroke = SEVERITY_COLORS[sev];
    arc.setAttribute('stroke-width', String(thickness));
    arc.setAttribute('stroke-dasharray', `${len} ${c}`);
    arc.setAttribute('stroke-dashoffset', String(-offset));
    arc.setAttribute('transform', `rotate(-90 ${size / 2} ${size / 2})`);
    arc.style.cursor = 'pointer';
    arc.style.transition = 'opacity 0.12s';
    arc.addEventListener('mouseenter', () => { arc.style.opacity = '0.7'; });
    arc.addEventListener('mouseleave', () => { arc.style.opacity = '1'; });
    arc.addEventListener('click', () => {
      filters.severities = new Set([sev]);
      setView('issues');
    });
    svg.appendChild(arc);
    offset += len;
  }

  // Center text
  const t1 = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  t1.setAttribute('x', String(size / 2));
  t1.setAttribute('y', String(size / 2 - 4));
  t1.setAttribute('text-anchor', 'middle');
  t1.setAttribute('font-size', '20');
  t1.setAttribute('font-weight', '600');
  t1.style.fill = 'var(--fg)';
  t1.style.fontFamily = 'var(--font-mono)';
  t1.style.fontVariantNumeric = 'tabular-nums';
  t1.textContent = total.toLocaleString();
  svg.appendChild(t1);

  const t2 = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  t2.setAttribute('x', String(size / 2));
  t2.setAttribute('y', String(size / 2 + 14));
  t2.setAttribute('text-anchor', 'middle');
  t2.setAttribute('font-size', '8');
  t2.setAttribute('letter-spacing', '0.1em');
  t2.style.fill = 'var(--fg-muted)';
  t2.textContent = 'TOTAL';
  svg.appendChild(t2);

  // Legend
  const legend = document.createElement('div');
  legend.className = 'donut-legend';
  for (const sev of SEVERITY_ORDER) {
    const val = counts[sev] ?? 0;
    const pct = total ? Math.round(val / total * 100) : 0;
    const row = document.createElement('div');
    row.className = 'legend-row';
    row.title = `${sev}: click to filter`;
    row.addEventListener('click', () => {
      filters.severities = new Set([sev]);
      setView('issues');
    });
    const swatch = document.createElement('span');
    swatch.className = 'legend-swatch';
    swatch.style.background = SEVERITY_COLORS[sev];
    const lbl = document.createElement('span');
    lbl.className = 'legend-label';
    lbl.textContent = sev;
    const valEl = document.createElement('span');
    valEl.className = 'legend-val';
    valEl.textContent = String(val);
    const pctEl = document.createElement('span');
    pctEl.className = 'legend-pct';
    pctEl.textContent = pct + '%';
    row.appendChild(swatch);
    row.appendChild(lbl);
    row.appendChild(valEl);
    row.appendChild(pctEl);
    legend.appendChild(row);
  }

  const wrap = document.createElement('div');
  wrap.className = 'donut-wrap';
  wrap.appendChild(svg);
  wrap.appendChild(legend);
  return wrap;
}

/**
 * @param {any[]} issues
 * @param {(i:any)=>string} keyFn
 * @param {number} limit
 * @returns {Array<[string,number]>}
 */
function computeTopN(issues, keyFn, limit) {
  /** @type {Record<string,number>} */
  const m = {};
  for (const i of issues) {
    const k = keyFn(i);
    if (k) m[k] = (m[k] ?? 0) + 1;
  }
  return Object.entries(m)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
}

/**
 * @param {string} title
 * @param {Array<[string,number]>} entries
 * @param {string} color
 */
function buildBarCard(title, entries, color) {
  const card = document.createElement('div');
  card.className = 'card';
  const hdr = document.createElement('div');
  hdr.className = 'card-header';
  const titleEl = document.createElement('div');
  titleEl.className = 'card-title';
  titleEl.textContent = title;
  hdr.appendChild(titleEl);
  card.appendChild(hdr);
  if (entries.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'font-size:11px;color:var(--fg-dim);padding:8px 0;';
    empty.textContent = 'No data';
    card.appendChild(empty);
    return card;
  }
  const chart = document.createElement('div');
  chart.className = 'barchart';
  const max = entries.reduce((m, [, v]) => Math.max(m, v), 1);
  for (const [label, value] of entries) {
    const row = document.createElement('div');
    row.className = 'bar-row';
    const lbl = document.createElement('div');
    lbl.className = 'bar-label';
    lbl.textContent = label;
    lbl.title = label;
    const track = document.createElement('div');
    track.className = 'bar-track';
    const fill = document.createElement('div');
    fill.className = 'bar-fill';
    fill.style.width = `${(value / max) * 100}%`;
    fill.style.background = color;
    track.appendChild(fill);
    const valEl = document.createElement('div');
    valEl.className = 'bar-val';
    valEl.textContent = String(value);
    row.appendChild(lbl);
    row.appendChild(track);
    row.appendChild(valEl);
    chart.appendChild(row);
  }
  card.appendChild(chart);
  return card;
}

// ── Issues view ───────────────────────────────────────────────────────────────

function buildIssuesView(container) {
  container.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'view issues-view-card';

  // Severity toolbar
  if (config.showSeverityFilter) {
    const toolbar = document.createElement('div');
    toolbar.className = 'issues-toolbar';
    const lbl = document.createElement('span');
    lbl.className = 'toolbar-label';
    lbl.textContent = 'Sev';
    const sevToggles = document.createElement('div');
    sevToggles.id = 'filter-severity';
    sevToggles.className = 'sev-toggles';
    const countEl = document.createElement('span');
    countEl.id = 'issues-count-bar';
    countEl.className = 'issues-count';
    toolbar.appendChild(lbl);
    toolbar.appendChild(sevToggles);
    toolbar.appendChild(countEl);
    wrap.appendChild(toolbar);
  }

  // Category qf-bar
  if (config.showCategoryFilter) {
    const catBar = document.createElement('div');
    catBar.id = 'filter-categories';
    wrap.appendChild(catBar);
  }

  // Check name qf-bar
  if (config.showCheckNameFilter) {
    const chkBar = document.createElement('div');
    chkBar.id = 'filter-checknames';
    wrap.appendChild(chkBar);
  }

  // Custom column qf-bars
  const customWrap = document.createElement('div');
  customWrap.id = 'filter-custom';
  wrap.appendChild(customWrap);

  // Search row
  const searchRow = document.createElement('div');
  searchRow.className = 'issues-toolbar';
  searchRow.style.cssText = 'border-bottom:none;';
  const searchWrap = document.createElement('div');
  searchWrap.className = 'toolbar-search';
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('class', 'search-icon-pos');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('fill', 'none');
  icon.setAttribute('stroke', 'currentColor');
  icon.setAttribute('stroke-width', '2');
  icon.innerHTML = '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>';
  const inp = document.createElement('input');
  inp.type = 'text';
  inp.id = 'filter-search';
  inp.className = 'search-input';
  inp.placeholder = 'Filter by description, file, check name, category… use ; to AND terms';
  inp.value = filters.search;
  inp.addEventListener('input', (e) => {
    filters.search = /** @type {HTMLInputElement} */(e.target).value;
    renderActiveFilters();
    renderTable();
  });
  searchWrap.appendChild(icon);
  searchWrap.appendChild(inp);
  searchRow.appendChild(searchWrap);
  wrap.appendChild(searchRow);

  // Active filters
  const activeFilt = document.createElement('div');
  activeFilt.id = 'active-filters';
  wrap.appendChild(activeFilt);

  // Table
  const tblWrap = document.createElement('div');
  tblWrap.id = 'table-container';
  const table = document.createElement('table');
  table.id = 'issues-table';
  const thead = document.createElement('thead');
  thead.id = 'issues-thead';
  const tbody = document.createElement('tbody');
  tbody.id = 'issues-tbody';
  table.appendChild(thead);
  table.appendChild(tbody);
  const footer = document.createElement('div');
  footer.id = 'table-footer';
  tblWrap.appendChild(table);
  tblWrap.appendChild(footer);
  wrap.appendChild(tblWrap);

  container.appendChild(wrap);

  // Populate filters and table
  if (config.showSeverityFilter)  renderSeverityFilter();
  if (config.showCategoryFilter)  renderCategoryFilter();
  if (config.showCheckNameFilter) renderCheckNameFilter();
  renderCustomColumnFilters();
  renderActiveFilters();
  renderTableHeader();
  renderTable();
}

// ── Files view ────────────────────────────────────────────────────────────────

function buildFilesView(container) {
  container.innerHTML = '';
  const view = document.createElement('div');
  view.className = 'view issues-view-card';

  /** @type {Record<string,{total:number,blocker:number,critical:number,major:number,minor:number,info:number}>} */
  const m = {};
  for (const i of allIssues) {
    const p = i.location?.path ?? '(unknown)';
    if (!m[p]) m[p] = { total: 0, blocker: 0, critical: 0, major: 0, minor: 0, info: 0 };
    m[p].total++;
    m[p][(i.severity ?? 'info')]++;
  }
  const files = Object.entries(m)
    .map(([file, c]) => ({ file, ...c }))
    .sort((a, b) => b.total - a.total);

  const hdr = document.createElement('div');
  hdr.className = 'card-header';
  hdr.style.cssText = 'padding:12px 16px;border-bottom:1px solid var(--border);margin:0;';
  const htitle = document.createElement('div');
  htitle.className = 'card-title';
  htitle.textContent = `Files · ranked by issue count`;
  const hcount = document.createElement('span');
  hcount.className = 'issues-count';
  hcount.textContent = `${files.length} file${files.length !== 1 ? 's' : ''}`;
  hdr.appendChild(htitle);
  hdr.appendChild(hcount);
  view.appendChild(hdr);

  const list = document.createElement('div');
  list.className = 'file-list';

  const headRow = document.createElement('div');
  headRow.className = 'file-row head';
  headRow.innerHTML = `<div>File</div><div style="text-align:center">Distribution</div>
    <div class="file-num">Block</div><div class="file-num">Crit</div>
    <div class="file-num">Major</div><div class="file-num tot">Total</div>`;
  list.appendChild(headRow);

  for (const f of files) {
    const bn = basename(f.file);
    const dir = f.file.length > bn.length ? f.file.slice(0, f.file.length - bn.length) : '';
    const row = document.createElement('div');
    row.className = 'file-row';
    row.title = f.file;
    row.addEventListener('click', () => {
      filters.severities = new Set(SEVERITY_ORDER);
      filters.categories = null;
      filters.quickTerms = new Set([basename(f.file)]);
      filters.search = '';
      setView('issues');
    });

    const nameDiv = document.createElement('div');
    nameDiv.className = 'file-name';
    const bn_el = document.createElement('span');
    bn_el.className = 'basename';
    bn_el.textContent = bn;
    const dir_el = document.createElement('span');
    dir_el.className = 'dir';
    dir_el.textContent = dir;
    nameDiv.appendChild(bn_el);
    nameDiv.appendChild(dir_el);

    const barDiv = document.createElement('div');
    barDiv.className = 'file-bar';
    for (const sev of SEVERITY_ORDER) {
      if (f[sev] <= 0) continue;
      const seg = document.createElement('div');
      seg.className = 'file-bar-seg';
      seg.style.width = `${(f[sev] / f.total) * 100}%`;
      seg.style.background = SEVERITY_COLORS[sev];
      seg.title = `${sev}: ${f[sev]}`;
      barDiv.appendChild(seg);
    }

    const blEl = numCell(f.blocker, f.blocker > 0 ? SEVERITY_COLORS.blocker : null);
    const crEl = numCell(f.critical, f.critical > 0 ? SEVERITY_COLORS.critical : null);
    const mjEl = numCell(f.major, f.major > 0 ? SEVERITY_COLORS.major : null);
    const totEl = document.createElement('div');
    totEl.className = 'file-num tot';
    totEl.textContent = String(f.total);

    row.appendChild(nameDiv);
    row.appendChild(barDiv);
    row.appendChild(blEl);
    row.appendChild(crEl);
    row.appendChild(mjEl);
    row.appendChild(totEl);
    list.appendChild(row);
  }
  view.appendChild(list);
  container.appendChild(view);
}

function numCell(val, color) {
  const el = document.createElement('div');
  el.className = 'file-num';
  el.textContent = val > 0 ? String(val) : '·';
  if (color) el.style.color = color;
  return el;
}

// ── Treemap view ──────────────────────────────────────────────────────────────

function buildTreemapView(container) {
  container.innerHTML = '';
  const view = document.createElement('div');
  view.className = 'view card';
  view.style.cssText = 'padding:18px 20px;';

  const hdr = document.createElement('div');
  hdr.className = 'card-header';
  hdr.innerHTML = `<div class="card-title">Treemap · file size = issue count · color = worst severity</div>
    <div class="card-action">Click a cell to filter by file</div>`;
  view.appendChild(hdr);

  const map = /** @type {Record<string,{file:string,value:number,sev:Record<string,number>}>} */({});
  for (const i of allIssues) {
    const p = i.location?.path ?? '(unknown)';
    if (!map[p]) map[p] = { file: p, value: 0, sev: {} };
    map[p].value++;
    map[p].sev[(i.severity ?? 'info')] = (map[p].sev[(i.severity ?? 'info')] ?? 0) + 1;
  }

  const items = Object.values(map).map(it => {
    const worst = SEVERITY_ORDER.find(s => it.sev[s] > 0) ?? 'info';
    return { ...it, color: SEVERITY_COLORS[worst] };
  }).sort((a, b) => b.value - a.value);

  const H = 460;
  const tmEl = document.createElement('div');
  tmEl.className = 'treemap';
  tmEl.style.height = H + 'px';

  function renderCells() {
    tmEl.innerHTML = '';
    const W = tmEl.clientWidth || container.clientWidth || 800;
    const cells = layoutTreemap(items, W, H);
    for (const c of cells) {
    const div = document.createElement('div');
    div.className = 'tm-cell';
    div.style.cssText = `left:${c.x.toFixed(1)}px;top:${c.y.toFixed(1)}px;width:${c.w.toFixed(1)}px;height:${c.h.toFixed(1)}px;background:${c.color};opacity:0.85;`;
    div.title = `${c.file} · ${c.value} issues`;
    div.addEventListener('click', () => {
      filters.severities = new Set(SEVERITY_ORDER);
      filters.categories = null;
      filters.quickTerms = new Set([basename(c.file)]);
      filters.search = '';
      setView('issues');
    });
    if (c.w > 80 && c.h > 36) {
      const name = document.createElement('div');
      name.className = 'tm-cell-name';
      name.textContent = basename(c.file);
      div.appendChild(name);
    }
    if (c.w > 50 && c.h > 22) {
      const num = document.createElement('div');
      num.className = 'tm-cell-num';
      num.textContent = String(c.value);
      div.appendChild(num);
    }
    tmEl.appendChild(div);
    }
  }
  view.appendChild(tmEl);
  requestAnimationFrame(renderCells);
  const ro = new ResizeObserver(() => renderCells());
  ro.observe(tmEl);

  const legend = document.createElement('div');
  legend.className = 'treemap-legend';
  for (const sev of SEVERITY_ORDER) {
    const item = document.createElement('div');
    item.className = 'treemap-legend-item';
    const sw = document.createElement('span');
    sw.className = 'treemap-legend-swatch';
    sw.style.background = SEVERITY_COLORS[sev];
    const lbl = document.createElement('span');
    lbl.textContent = sev;
    item.appendChild(sw);
    item.appendChild(lbl);
    legend.appendChild(item);
  }
  view.appendChild(legend);
  container.appendChild(view);
}

function layoutTreemap(items, width, height) {
  if (items.length === 0) return [];
  const total = items.reduce((a, b) => a + b.value, 0);
  /** @type {Array<any>} */
  const cells = [];
  let remaining = items.slice();
  let rect = { x: 0, y: 0, w: width || 800, h: height };

  function layout(r, row, vertical) {
    const sum = row.reduce((a, b) => a + b.value, 0);
    if (vertical) {
      let x = r.x;
      const h = (sum / total) * height;
      for (const it of row) { const w = (it.value / sum) * r.w; cells.push({ ...it, x, y: r.y, w, h }); x += w; }
      return { x: r.x, y: r.y + h, w: r.w, h: r.h - h };
    } else {
      let y = r.y;
      const w = (sum / total) * rect.w;
      for (const it of row) { const h = (it.value / sum) * r.h; cells.push({ ...it, x: r.x, y, w, h }); y += h; }
      return { x: r.x + w, y: r.y, w: r.w - w, h: r.h };
    }
  }

  let chunkSize = Math.max(2, Math.ceil(items.length / 5));
  let vertical = rect.w > rect.h;
  while (remaining.length > 0) {
    const row = remaining.splice(0, chunkSize);
    rect = layout(rect, row, vertical);
    vertical = rect.w > rect.h;
    chunkSize = Math.max(2, Math.ceil(remaining.length / 4));
  }
  return cells;
}

// ── Trends view ───────────────────────────────────────────────────────────────

function buildTrendsView(container) {
  container.innerHTML = '';
  const view = document.createElement('div');
  view.className = 'view';

  const snaps = [...historySnapshots].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  if (snaps.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'trends-note';
    empty.innerHTML = 'No history yet.<br><br>Load a CodeClimate report, then click <strong>Save Snapshot</strong> in the sidebar to start tracking trends over time.';
    view.appendChild(empty);
    container.appendChild(view);
    return;
  }

  // ── Line chart ──────────────────────────────────────────────────────────
  if (snaps.length >= 2) {
    const chartRow = document.createElement('div');
    chartRow.className = 'row row-full';
    const card = document.createElement('div');
    card.className = 'card';
    const hdr = document.createElement('div'); hdr.className = 'card-header';
    const t = document.createElement('div'); t.className = 'card-title'; t.textContent = 'Total Issues Over Time';
    hdr.appendChild(t); card.appendChild(hdr);
    card.insertAdjacentHTML('beforeend', buildTrendSvg(snaps));
    chartRow.appendChild(card); view.appendChild(chartRow);
  }

  // ── Latest diff KPIs ────────────────────────────────────────────────────
  if (snaps.length >= 2) {
    const prev = snaps[snaps.length - 2];
    const curr = snaps[snaps.length - 1];
    const prevSet = new Set(prev.fingerprints ?? []);
    const currSet = new Set(curr.fingerprints ?? []);
    const newCount      = (curr.fingerprints ?? []).filter(fp => !prevSet.has(fp)).length;
    const fixedCount    = (prev.fingerprints ?? []).filter(fp => !currSet.has(fp)).length;
    const persistCount  = (curr.fingerprints ?? []).filter(fp =>  prevSet.has(fp)).length;
    const delta         = curr.total - prev.total;

    const diffRow = document.createElement('div');
    diffRow.className = 'row row-3col';

    /** @param {string} label @param {number} val @param {string} color @param {string} [sub] */
    function diffCard(label, val, color, sub) {
      const c = document.createElement('div'); c.className = 'card';
      const h = document.createElement('div'); h.className = 'card-header';
      const tl = document.createElement('div'); tl.className = 'card-title'; tl.textContent = label;
      h.appendChild(tl); c.appendChild(h);
      const n = document.createElement('div');
      n.style.cssText = `font-size:32px;font-weight:600;font-variant-numeric:tabular-nums;color:${color};margin-top:6px;`;
      n.textContent = (val > 0 && color === 'var(--sev-critical)' ? '+' : '') + val.toLocaleString();
      c.appendChild(n);
      if (sub) { const s = document.createElement('div'); s.className = 'trends-sub'; s.textContent = sub; c.appendChild(s); }
      return c;
    }
    const hasDerived = (curr.derivedCount ?? 0) > 0 || (prev.derivedCount ?? 0) > 0;
    const fpWarn = hasDerived ? ' ⚠' : '';
    diffRow.appendChild(diffCard('New Issues',    newCount,   'var(--sev-critical)', 'vs previous snapshot' + fpWarn));
    diffRow.appendChild(diffCard('Fixed Issues',  fixedCount, 'var(--sev-info)',     'vs previous snapshot' + fpWarn));
    diffRow.appendChild(diffCard('Net Change',    delta,      delta > 0 ? 'var(--sev-major)' : delta < 0 ? '#4ade80' : 'var(--fg-muted)', `${persistCount} persisting`));
    if (hasDerived) {
      const warn = document.createElement('div'); warn.className = 'trends-note trends-warn';
      warn.textContent = '⚠ Some issues use derived fingerprints (no native fingerprint in report). New/Fixed counts may be inaccurate if code moved between snapshots.';
      view.appendChild(diffRow); view.appendChild(warn);
    } else {
      view.appendChild(diffRow);
    }
  } else {
    // Single snapshot — show severity KPIs
    const curr = snaps[0];
    const sevRow = document.createElement('div'); sevRow.className = 'row row-3col';
    for (const sev of SEVERITY_ORDER.slice(0, 3)) {
      const c = document.createElement('div'); c.className = 'card';
      const h = document.createElement('div'); h.className = 'card-header';
      const badge = document.createElement('span'); badge.className = `sev-badge ${sev}`; badge.textContent = sev;
      h.appendChild(badge); c.appendChild(h);
      const n = document.createElement('div');
      n.style.cssText = `font-size:36px;font-weight:600;font-variant-numeric:tabular-nums;color:${SEVERITY_COLORS[sev]};margin-top:8px;`;
      n.textContent = (curr.counts?.[sev] ?? 0).toLocaleString();
      c.appendChild(n); sevRow.appendChild(c);
    }
    view.appendChild(sevRow);
  }

  // ── Snapshot table ──────────────────────────────────────────────────────
  const tableRow = document.createElement('div'); tableRow.className = 'row row-full';
  const tableCard = document.createElement('div'); tableCard.className = 'card';
  const tableHdr = document.createElement('div'); tableHdr.className = 'card-header';
  const tableTitle = document.createElement('div'); tableTitle.className = 'card-title'; tableTitle.textContent = 'Snapshot History';
  tableHdr.appendChild(tableTitle); tableCard.appendChild(tableHdr);

  const tbl = document.createElement('table'); tbl.className = 'snap-table';
  tbl.innerHTML = '<thead><tr><th>Date</th><th>Label</th><th>Total</th><th>B</th><th>C</th><th>Maj</th><th>Min</th><th>I</th><th></th></tr></thead>';
  const tbody = document.createElement('tbody');

  [...snaps].reverse().forEach((snap, idx) => {
    const prev = snaps[snaps.length - 1 - idx - 1];
    const tr = document.createElement('tr');
    const d = new Date(snap.timestamp);
    const dateTd = document.createElement('td'); dateTd.className = 'snap-ts'; dateTd.title = d.toISOString(); dateTd.textContent = d.toLocaleDateString(undefined, { month:'short', day:'numeric', year:'2-digit' }) + ' ' + d.toLocaleTimeString(undefined, { hour:'2-digit', minute:'2-digit' });

    const labelTd = document.createElement('td'); labelTd.className = 'snap-lbl-cell';
    const labelEl = document.createElement('span'); labelEl.className = 'snap-lbl-edit'; labelEl.textContent = snap.label ?? '—'; labelEl.title = 'Click to edit label';
    labelEl.addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'text'; input.value = snap.label ?? ''; input.className = 'snap-lbl-input';
      labelTd.replaceChild(input, labelEl); input.focus(); input.select();
      const commit = () => {
        vscode.postMessage({ type: 'editSnapshotLabel', id: snap.id, label: input.value });
        labelTd.replaceChild(labelEl, input);
        labelEl.textContent = input.value || '—';
      };
      input.addEventListener('blur', commit);
      input.addEventListener('keydown', e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') labelTd.replaceChild(labelEl, input); });
    });
    labelTd.appendChild(labelEl);

    const totalTd = document.createElement('td'); totalTd.style.cssText = 'text-align:right;font-variant-numeric:tabular-nums;font-weight:600;';
    if (prev) {
      const delta = snap.total - prev.total;
      totalTd.textContent = snap.total.toLocaleString();
      if (delta !== 0) {
        const d2 = document.createElement('span'); d2.className = delta > 0 ? 'delta-pos' : 'delta-neg';
        d2.textContent = ' ' + (delta > 0 ? '+' : '') + delta; totalTd.appendChild(d2);
      }
    } else {
      totalTd.textContent = snap.total.toLocaleString();
    }

    const delTd = document.createElement('td');
    const delBtn = document.createElement('button'); delBtn.className = 'snap-del-btn'; delBtn.title = 'Delete';
    delBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><polyline points="2,4 12,4"/><path d="M5,4V3h4v1"/><path d="M3,4l1,8h6l1-8"/></svg>';
    delBtn.addEventListener('click', () => vscode.postMessage({ type: 'deleteSnapshot', id: snap.id }));
    delTd.appendChild(delBtn);

    tr.appendChild(dateTd); tr.appendChild(labelTd); tr.appendChild(totalTd);
    for (const sev of SEVERITY_ORDER) {
      const td = document.createElement('td');
      td.style.cssText = `text-align:right;font-variant-numeric:tabular-nums;color:${SEVERITY_COLORS[sev]};`;
      td.textContent = (snap.counts?.[sev] ?? 0) || '';
      tr.appendChild(td);
    }
    tr.appendChild(delTd);
    tbody.appendChild(tr);
  });
  tbl.appendChild(tbody); tableCard.appendChild(tbl);
  tableRow.appendChild(tableCard); view.appendChild(tableRow);

  container.appendChild(view);
}

function buildTrendSvg(snaps) {
  const W = 560, H = 140, PL = 44, PR = 12, PT = 10, PB = 28;
  const cW = W - PL - PR, cH = H - PT - PB;
  const n = snaps.length;
  const maxVal = Math.max(...snaps.map(s => s.total), 1);

  /** @param {number} i */ const xOf = i => PL + (n < 2 ? cW / 2 : (i / (n - 1)) * cW);
  /** @param {number} v */ const yOf = v => PT + cH - (v / maxVal) * cH;

  const gridLines = [0, 0.25, 0.5, 0.75, 1].map(f => {
    const y = yOf(f * maxVal); const lbl = Math.round(f * maxVal);
    return `<line x1="${PL}" y1="${y.toFixed(1)}" x2="${W - PR}" y2="${y.toFixed(1)}" stroke="currentColor" stroke-opacity="0.08"/>
            <text x="${PL - 4}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="currentColor" fill-opacity="0.5">${lbl}</text>`;
  }).join('');

  const totalPts = snaps.map((s, i) => `${xOf(i).toFixed(1)},${yOf(s.total).toFixed(1)}`).join(' ');

  const sevLines = SEVERITY_ORDER.map(sev =>
    `<polyline points="${snaps.map((s, i) => `${xOf(i).toFixed(1)},${yOf(s.counts?.[sev] ?? 0).toFixed(1)}`).join(' ')}" fill="none" stroke="${SEVERITY_COLORS[sev]}" stroke-width="1.2" stroke-opacity="0.5"/>`
  ).join('');

  const dots = snaps.map((s, i) =>
    `<circle cx="${xOf(i).toFixed(1)}" cy="${yOf(s.total).toFixed(1)}" r="3" fill="var(--accent)" stroke="var(--bg)" stroke-width="1.5"><title>${s.label ?? new Date(s.timestamp).toLocaleDateString()}: ${s.total}</title></circle>`
  ).join('');

  const xLabels = [0, Math.floor(n / 2), n - 1].filter((v, i, a) => a.indexOf(v) === i && v < n).map(i => {
    const x = xOf(i); const lbl = new Date(snaps[i].timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const anchor = i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle';
    return `<text x="${x.toFixed(1)}" y="${H - 4}" text-anchor="${anchor}" font-size="10" fill="currentColor" fill-opacity="0.5">${lbl}</text>`;
  }).join('');

  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:${H}px;display:block;">${gridLines}<polyline points="${totalPts}" fill="none" stroke="var(--accent)" stroke-width="2"/>${sevLines}${dots}${xLabels}</svg>`;
}

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
    for (const [colName, activeSet] of Object.entries(filters.custom)) {
      if (!activeSet || activeSet.size === 0) continue;
      const colDef = customColumnDefs.find(c => c.name === colName);
      const val = colDef ? getIssueCustomValue(issue, colDef) : (issue.customColumns ?? {})[colName] ?? '';
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

function applyQuickFilter(value) {
  const v = value.trim();
  if (!v) return;
  const existing = [...filters.quickTerms].find(t => t.toLowerCase() === v.toLowerCase());
  if (existing !== undefined) filters.quickTerms.delete(existing);
  else filters.quickTerms.add(v);
  renderCheckNameFilter(); renderActiveFilters(); renderTable();
}

function applySearchTerm(value) {
  const v = value.trim();
  const terms = filters.search.split(';').map(t => t.trim()).filter(Boolean);
  const idx = terms.findIndex(t => t.toLowerCase() === v.toLowerCase());
  if (idx >= 0) terms.splice(idx, 1); else terms.push(v);
  filters.search = terms.join('; ');
  const inp = /** @type {HTMLInputElement|null} */(document.getElementById('filter-search'));
  if (inp) inp.value = filters.search;
  renderActiveFilters(); renderTable();
}

function toggleCategoryFilter(cat) {
  if (filters.categories === null) {
    filters.categories = new Set([cat]);
  } else if (filters.categories.has(cat)) {
    filters.categories.delete(cat);
    if (filters.categories.size === 0) filters.categories = null;
  } else {
    filters.categories.add(cat);
  }
  renderCategoryFilter(); renderActiveFilters(); renderTable();
}

function toggleSourceFileFilter(filename) {
  const file = allFiles.find(f => f.filename === filename);
  if (!file) return;
  const isIsolated = filters.sourceFiles.size === 1 && filters.sourceFiles.has(file.uri);
  filters.sourceFiles = isIsolated
    ? new Set(allFiles.map(/** @param {any} f */ f => f.uri))
    : new Set([file.uri]);
  renderTable();
}

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
  renderCustomColumnFilters(); renderActiveFilters(); renderTable();
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
        case 'line':        va = getBeginLine(a); vb = getBeginLine(b); break;
        case 'file':        va = basename(a.location?.path ?? ''); vb = basename(b.location?.path ?? ''); break;
        case 'sourceFile':  va = a.sourceFile  ?? ''; vb = b.sourceFile  ?? ''; break;
        case 'check_name':  va = a.check_name  ?? ''; vb = b.check_name  ?? ''; break;
        case 'description': va = a.description ?? ''; vb = b.description ?? ''; break;
        case 'categories':  va = (a.categories ?? []).join(); vb = (b.categories ?? []).join(); break;
        default: return 0;
      }
    }
    if (va < vb) return dir === 'asc' ? -1 : 1;
    if (va > vb) return dir === 'asc' ?  1 : -1;
    return 0;
  });
}

// ── Filter renderers ──────────────────────────────────────────────────────────

function renderSeverityFilter() {
  const container = document.getElementById('filter-severity');
  if (!container) return;
  container.innerHTML = '';
  const counts = /** @type {Record<string,number>} */({});
  for (const i of allIssues) counts[i.severity ?? 'info'] = (counts[i.severity ?? 'info'] ?? 0) + 1;

  for (const sev of SEVERITY_ORDER) {
    const isActive = filters.severities.has(sev);
    const btn = document.createElement('button');
    btn.className = `sev-toggle ${sev}${isActive ? ' active' : ''}`;
    const dot = document.createElement('span');
    dot.className = 'dot';
    btn.appendChild(dot);
    btn.appendChild(document.createTextNode(sev));
    const ct = document.createElement('span');
    ct.className = 'ct';
    ct.textContent = String(counts[sev] ?? 0);
    btn.appendChild(ct);
    btn.addEventListener('click', () => {
      if (filters.severities.has(sev)) {
        if (filters.severities.size > 1) filters.severities.delete(sev);
      } else {
        filters.severities.add(sev);
      }
      renderSeverityFilter();
      renderTable();
    });
    container.appendChild(btn);
  }
}

function renderCategoryFilter() {
  const container = document.getElementById('filter-categories');
  if (!container) return;
  container.innerHTML = '';
  const values = [...new Set(allIssues.flatMap(i => i.categories?.length ? i.categories : []))].sort();
  if (values.length <= 1) return;

  container.className = 'qf-bar';
  const lbl = document.createElement('span');
  lbl.className = 'toolbar-label';
  lbl.textContent = 'Cat';
  container.appendChild(lbl);

  for (const cat of values) {
    const isActive = filters.categories !== null && filters.categories.has(cat);
    const chip = document.createElement('button');
    chip.className = 'qf-chip' + (isActive ? ' active' : '');
    chip.textContent = cat;
    chip.title = `${cat} — click to filter`;
    chip.addEventListener('click', () => toggleCategoryFilter(cat));
    container.appendChild(chip);
  }
}

function renderCheckNameFilter() {
  const container = document.getElementById('filter-checknames');
  if (!container) return;
  container.innerHTML = '';
  const counts = countBy(allIssues, i => [i.check_name ?? '']);
  const top = topN(counts, 15);
  const names = Object.keys(top.counts).filter(l => l !== '');
  if (names.length <= 1) return;

  container.className = 'qf-bar';
  const lbl = document.createElement('span');
  lbl.className = 'toolbar-label';
  lbl.textContent = 'Check';
  container.appendChild(lbl);

  for (const name of names) {
    const isActive = [...filters.quickTerms].some(t => t.toLowerCase() === name.toLowerCase());
    const chip = document.createElement('button');
    chip.className = 'qf-chip' + (isActive ? ' active' : '');
    chip.textContent = name;
    chip.title = `${name} — click to filter`;
    chip.addEventListener('click', () => applyQuickFilter(name));
    container.appendChild(chip);
  }
}

function renderCustomColumnFilters() {
  const container = document.getElementById('filter-custom');
  if (!container) return;
  container.innerHTML = '';

  for (const colDef of customColumnDefs) {
    if (colDef.showQuickFilter === false) continue;
    const values = [...new Set(allIssues.map(i => getIssueCustomValue(i, colDef)))].filter(v => v !== '').sort();
    if (values.length === 0) continue;
    if (values.length <= 1 && colDef.showQuickFilter !== true) continue;

    const bar = document.createElement('div');
    bar.className = 'qf-bar';
    const lbl = document.createElement('span');
    lbl.className = 'toolbar-label';
    lbl.textContent = colDef.name;
    bar.appendChild(lbl);

    const activeSet = filters.custom[colDef.name] ?? null;
    for (const val of values) {
      const isActive = activeSet !== null && activeSet.has(val);
      const chip = document.createElement('button');
      chip.className = 'qf-chip' + (isActive ? ' active' : '');
      chip.textContent = val;
      chip.title = `${val} — click to filter`;
      chip.addEventListener('click', () => toggleCustomColumnFilter(colDef.name, val));
      bar.appendChild(chip);
    }
    container.appendChild(bar);
  }
}

function renderActiveFilters() {
  const container = document.getElementById('active-filters');
  if (!container) return;
  container.innerHTML = '';
  if (filters.categories !== null) {
    for (const cat of filters.categories) {
      container.appendChild(makeChip('cat: ' + cat, () => toggleCategoryFilter(cat)));
    }
  }
  for (const [colName, activeSet] of Object.entries(filters.custom)) {
    if (!activeSet) continue;
    for (const val of activeSet) {
      container.appendChild(makeChip(`${colName}: ${val}`, () => toggleCustomColumnFilter(colName, val)));
    }
  }
  for (const term of filters.quickTerms) {
    container.appendChild(makeChip(term, () => applyQuickFilter(term)));
  }
}

function makeChip(text, onRemove) {
  const chip = document.createElement('span');
  chip.className = 'active-filter-chip';
  const lbl = document.createElement('span');
  lbl.textContent = text;
  const btn = document.createElement('button');
  btn.className = 'chip-remove';
  btn.title = 'Remove filter';
  btn.textContent = '×';
  btn.addEventListener('click', onRemove);
  chip.appendChild(lbl);
  chip.appendChild(btn);
  return chip;
}

// ── Table ─────────────────────────────────────────────────────────────────────

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

function colCssKey(key) { return key.replace(/[^a-zA-Z0-9_-]/g, '_'); }

function renderTable() {
  const filtered = getSorted(getFiltered());
  const tbody = document.getElementById('issues-tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  const activeCols = getActiveColumns();

  const countBar = document.getElementById('issues-count-bar');
  if (countBar) {
    countBar.textContent = filtered.length === allIssues.length
      ? `${filtered.length} issue${filtered.length !== 1 ? 's' : ''}`
      : `${filtered.length} of ${allIssues.length}`;
  }

  for (const issue of filtered) {
    const line     = getBeginLine(issue);
    const sev      = issue.severity ?? 'info';
    const isExpanded = expandedIds.has(issue.id);
    const filePath = issue.location?.path ?? '';
    const fname    = basename(filePath);

    const tr = document.createElement('tr');
    tr.className = `row-sev-${sev}${isExpanded ? ' row-expanded' : ''}`;
    tr.dataset.issueId = issue.id;
    tr.title = 'Click to expand';

    for (const col of activeCols) {
      let td;
      switch (col.key) {
        case 'severity': {
          td = document.createElement('td');
          td.className = 'col-severity';
          const badge = document.createElement('span');
          badge.className = `sev-badge ${sev}`;
          badge.textContent = sev;
          badge.title = `${sev} — click to isolate`;
          badge.addEventListener('click', (e) => {
            e.stopPropagation();
            const isIsolated = filters.severities.size === 1 && filters.severities.has(sev);
            filters.severities = isIsolated ? new Set(SEVERITY_ORDER) : new Set([sev]);
            renderSeverityFilter(); renderTable();
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
            b.className = 'cat-badge' + (isCatActive ? ' cat-active' : '');
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
            const colDef = customColumnDefs.find(c => c.name === col.name);
            const val = colDef ? getIssueCustomValue(issue, colDef) : '';
            td = makeFilterCell(val, 'cell-mono col-custom', () => { if (val && col.name) toggleCustomColumnFilter(col.name, val); });
          } else {
            td = document.createElement('td');
          }
        }
      }
      tr.appendChild(td);
    }

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

  const footer = document.getElementById('table-footer');
  if (footer) {
    footer.textContent = `${filtered.length} issue${filtered.length !== 1 ? 's' : ''} shown  (${allIssues.length} total)`;
  }
}

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

  if (issue.description) {
    const descEl = document.createElement('div');
    descEl.className = 'detail-desc';
    descEl.textContent = issue.description;
    wrap.appendChild(descEl);
  }

  wrap.appendChild(makeSnippetContainer(issue.id));

  if (issue.content?.body) {
    const bodyEl = document.createElement('div');
    bodyEl.className = 'detail-body';
    bodyEl.textContent = issue.content.body;
    wrap.appendChild(bodyEl);
  }

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

  if (issue.sourceFile) {
    const srcEl = document.createElement('div');
    srcEl.className = 'detail-source';
    srcEl.textContent = issue.sourceFile;
    wrap.appendChild(srcEl);
  }

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
    if (highlighted !== null) { textEl.innerHTML = highlighted; }
    else { textEl.textContent = text ?? ''; }
    lineEl.appendChild(numEl);
    lineEl.appendChild(textEl);
    pre.appendChild(lineEl);
  }
  container.appendChild(pre);
}

// ── Util ──────────────────────────────────────────────────────────────────────

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

function otherLocId(issueId, idx) { return `${issueId}::ol::${idx}`; }
function snippetContainerId(id) { return 'snip-' + id.replace(/[^a-zA-Z0-9]/g, '_'); }

function isActiveFilter(value) {
  if (!value || filters.quickTerms.size === 0) return false;
  const lv = value.toLowerCase();
  for (const t of filters.quickTerms) { if (lv.includes(t.toLowerCase())) return true; }
  return false;
}

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
