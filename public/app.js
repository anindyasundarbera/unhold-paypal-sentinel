// Unhold cockpit — every screen is an AG Grid (Enterprise). Controls (buttons, inputs) are plain HTML.
(async function () {
  'use strict';

  const money = (v) => '$' + Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const day = (iso) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—');
  const $ = (id) => document.getElementById(id);
  const api = async (path, opts) => {
    const res = await fetch(path, opts);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || body.message || `HTTP ${res.status}`);
    return body;
  };
  const post = (path, payload) =>
    api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}) });
  const setStatus = (id, text, kind) => {
    const el = $(id);
    el.textContent = text || '';
    el.className = 'status' + (kind ? ' ' + kind : '');
  };

  // ---------- AG Grid Enterprise setup ----------
  const cfg = await api('/api/config').catch(() => ({ integrations: {} }));
  if (cfg.agGridLicenseKey) agGrid.LicenseManager.setLicenseKey(cfg.agGridLicenseKey);
  agGrid.ModuleRegistry.registerModules([agGrid.AllEnterpriseModule.with(agCharts.AgChartsEnterpriseModule)]);

  const theme = agGrid.themeQuartz.withParams({
    backgroundColor: '#0d1117',
    foregroundColor: '#e6edf3',
    headerBackgroundColor: '#161b22',
    oddRowBackgroundColor: '#10151c',
    borderColor: '#30363d',
    accentColor: '#58a6ff',
    chromeBackgroundColor: '#161b22',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif',
    fontSize: 13
  });

  const grids = {};
  function makeGrid(key, el, options) {
    if (grids[key]) return grids[key];
    grids[key] = agGrid.createGrid(el, { theme, animateRows: true, ...options });
    return grids[key];
  }
  const chip = (text, kind) => {
    const colors = { good: '#3fb950', warn: '#d29922', bad: '#f85149', info: '#58a6ff', mute: '#8b949e' };
    const c = colors[kind] || colors.mute;
    return `<span style="color:${c};border:1px solid ${c}55;border-radius:999px;padding:1px 9px;font-size:11px">${text}</span>`;
  };

  // ---------- Header badges ----------
  (function renderBadges() {
    const i = cfg.integrations || {};
    const items = [
      ['PayPal ' + (cfg.paypalEnvironment || 'sandbox'), 'live'],
      ['Simulated seller history', 'sim'],
      cfg.simulateUploads ? ['Uploads simulated', 'sim'] : ['Uploads hit PayPal', 'on'],
      ...Object.entries({ Zapier: i.zapier, Astropods: i.astropods, Elastic: i.elastic, KERNEL: i.kernel, Channel3: i.channel3 }).map(
        ([name, on]) => [name + (on ? ' connected' : ' off'), on ? 'on' : '']
      )
    ];
    $('badges').innerHTML = items.map(([t, k]) => `<span class="badge ${k}">${t}</span>`).join('');
  })();

  // ---------- Tabs (grids are created lazily so they size correctly) ----------
  const loaders = {
    cockpit: loadCockpit,
    holds: loadHolds,
    matcher: loadMatcher,
    timeline: loadTimeline,
    forecast: () => (grids.outcome ? null : initForecastGrids()),
    guard: initGuardGrid,
    disputes: loadDisputes,
    audit: loadAudit
  };
  document.querySelectorAll('#tabs button').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + btn.dataset.tab));
      Promise.resolve(loaders[btn.dataset.tab]?.()).catch((e) => console.error(e));
    });
  });

  // ================= Cockpit =================
  let waterfall = null;
  let waterfallMode = 'now';

  async function loadCockpit() {
    const [summary, wf, why] = await Promise.all([api('/api/summary'), api('/api/waterfall'), api('/api/why-held')]);
    waterfall = wf;

    const series = (b) => b.filter((x) => x.startDate !== 'unknown').map((x) => x.amount);
    const kpiRow = [
      {
        held: summary.total_withheld_usd, holds: summary.open_holds_count,
        speed: summary.speedable_amount_usd, orders: summary.speedable_holds_count, days: summary.avg_days_sooner,
        health: summary.health_score, band: summary.health_band,
        heldSeries: series(wf.currentBuckets), speedSeries: series(wf.expeditedBuckets)
      }
    ];
    const spark = (field) => ({
      field, headerName: '', cellRenderer: 'agSparklineCellRenderer',
      cellRendererParams: { sparklineOptions: { type: 'area', fill: 'rgba(88,166,255,.25)', stroke: '#58a6ff', axis: { stroke: 'transparent' } } }
    });
    const kpi = makeGrid('kpi', $('gridKpi'), {
      columnDefs: [
        { headerName: 'Held by PayPal', field: 'held', valueFormatter: (p) => money(p.value), cellStyle: { fontSize: '22px', fontWeight: 700 }, flex: 1.1 },
        { ...spark('heldSeries'), headerName: 'Releases by week', flex: 1 },
        { headerName: 'Can speed up now', field: 'speed', valueFormatter: (p) => money(p.value), cellStyle: { fontSize: '22px', fontWeight: 700, color: '#3fb950' }, flex: 1.1 },
        { headerName: 'Orders · days sooner', valueGetter: (p) => `${p.data.orders} orders · ${p.data.days} days`, flex: 1 },
        { ...spark('speedSeries'), headerName: 'After tracking', flex: 1 },
        {
          headerName: 'Account health', field: 'health', flex: 0.9,
          cellRenderer: (p) => `<span style="font-size:22px;font-weight:700">${p.value}</span><span style="color:#8b949e">/100</span> ${chip(p.data.band, p.value >= 70 ? 'good' : 'warn')}`
        }
      ],
      rowData: kpiRow, rowHeight: 64, headerHeight: 34, suppressMovableColumns: true, suppressCellFocus: true
    });
    kpi.setGridOption('rowData', kpiRow);

    // Waterfall: bucket grid + integrated chart built from it
    const buckets = bucketRows(wf);
    const bg = makeGrid('buckets', $('gridBuckets'), {
      columnDefs: [
        { headerName: 'Release week', field: 'label', flex: 1.4 },
        { headerName: 'Releases now', field: 'now', valueFormatter: (p) => money(p.value), chartDataType: 'series', flex: 1 },
        { headerName: 'If tracking uploaded', field: 'after', valueFormatter: (p) => money(p.value), chartDataType: 'series', flex: 1 },
        { headerName: 'Holds', field: 'holds', flex: 0.5 }
      ],
      rowData: buckets, enableCharts: true, cellSelection: true, suppressCellFocus: false
    });
    bg.setGridOption('rowData', buckets);
    renderWaterfallChart();
    $('waterfallNote').textContent = `${wf.shiftedHoldsCount} holds move ~${wf.avgDaysEarlier} days earlier (${money(wf.shiftedAmountUsd)}).`;

    // Why held
    const drivers = (why.drivers || []).map((d) => ({
      title: d.title, severity: d.severity, detail: d.detail, rule: d.paypal_reason, evidence: (d.evidence_ids || []).length
    }));
    const wg = makeGrid('why', $('gridWhy'), {
      columnDefs: [
        { headerName: 'Driver', field: 'title', flex: 1, minWidth: 130, wrapText: true, autoHeight: true, tooltipField: 'rule' },
        { headerName: 'Severity', field: 'severity', width: 100, cellRenderer: (p) => chip(p.value, p.value === 'HIGH' ? 'bad' : 'warn') },
        { headerName: 'What we found', field: 'detail', flex: 2, minWidth: 200, wrapText: true, autoHeight: true, tooltipField: 'rule' }
      ],
      rowData: drivers, tooltipShowDelay: 300
    });
    wg.setGridOption('rowData', drivers);
    $('whyNote').textContent = why.plain_english_explanation || '';
  }

  function bucketRows(wf) {
    return wf.currentBuckets
      .map((b, i) => ({ label: b.label, now: b.amount, after: (wf.expeditedBuckets[i] || {}).amount || 0, holds: b.holdsCount }))
      .filter((r) => !/undated/i.test(r.label) || r.now > 0);
  }

  function renderWaterfallChart() {
    const grid = grids.buckets;
    if (!grid) return;
    if (grids.waterfallChart) grids.waterfallChart.destroyChart();
    const rows = grid.getDisplayedRowCount();
    const cols = waterfallMode === 'now' ? ['now'] : ['now', 'after'];
    grids.waterfallChart = grid.createRangeChart({
      chartContainer: $('waterfallChart'),
      cellRange: { rowStartIndex: 0, rowEndIndex: rows - 1, columns: ['label', ...cols] },
      chartType: 'groupedColumn',
      suppressChartRanges: true,
      chartThemeName: 'ag-vivid-dark',
      chartThemeOverrides: {
        common: {
          background: { fill: '#161b22' },
          padding: { top: 12, right: 16, bottom: 8, left: 8 },
          legend: { item: { label: { color: '#e6edf3' } } },
          axes: {
            category: { label: { color: '#8b949e' }, line: { stroke: '#30363d' } },
            number: {
              label: { color: '#8b949e', formatter: (p) => '$' + Number(p.value).toLocaleString('en-US') },
              gridLine: { style: [{ stroke: '#30363d' }] }
            }
          }
        }
      }
    });
  }

  $('btnWaterfallMode').addEventListener('click', () => {
    waterfallMode = waterfallMode === 'now' ? 'after' : 'now';
    $('btnWaterfallMode').textContent = waterfallMode === 'now' ? 'Show if all tracking is uploaded' : 'Show releases as PayPal has them now';
    renderWaterfallChart();
  });

  // ================= Holds =================
  const holdColumns = [
    { field: 'id', headerName: 'Hold', width: 150, pinned: 'left', checkboxSelection: true, headerCheckboxSelection: true, rowGroup: false },
    { field: 'order_id', headerName: 'Order', width: 170 },
    { field: 'buyer', headerName: 'Buyer', width: 130, filter: 'agTextColumnFilter' },
    { field: 'item', headerName: 'Item', width: 170, filter: 'agTextColumnFilter' },
    { field: 'amount', headerName: 'Amount', width: 120, type: 'rightAligned', filter: 'agNumberColumnFilter', aggFunc: 'sum', valueFormatter: (p) => money(p.value) },
    { field: 'code', headerName: 'PayPal code', width: 120, filter: 'agSetColumnFilter', enableRowGroup: true },
    {
      field: 'status', headerName: 'State', width: 150, filter: 'agSetColumnFilter', enableRowGroup: true,
      valueFormatter: (p) => ({ in_paypal: 'Tracking in PayPal', seller_has: 'Ready to upload', not_shipped: 'Not shipped', reserve: 'Reserve', unapproved: 'Needs approval' }[p.value] || p.value)
    },
    { field: 'carrier', headerName: 'Carrier', width: 100, filter: 'agSetColumnFilter', enableRowGroup: true },
    { field: 'tracking_number', headerName: 'Tracking', width: 160 },
    { field: 'delivered_at', headerName: 'Delivered', width: 120, filter: 'agDateColumnFilter', valueFormatter: (p) => day(p.value), filterValueGetter: (p) => (p.data.delivered_at || '').slice(0, 10) },
    { field: 'exp_at', headerName: 'PayPal releases', width: 140, filter: 'agDateColumnFilter', valueFormatter: (p) => day(p.value), filterValueGetter: (p) => (p.data.exp_at || '').slice(0, 10) },
    { field: 'wi_date', headerName: 'If tracking uploaded', width: 160, valueFormatter: (p) => day(p.value), cellStyle: { color: '#3fb950', fontWeight: 600 } },
    { field: 'conf', headerName: 'Confidence', width: 110, filter: 'agSetColumnFilter' }
  ];

  async function loadHolds() {
    const { holds } = await api('/api/holds');
    const g = makeGrid('holds', $('gridHolds'), {
      columnDefs: holdColumns,
      defaultColDef: { sortable: true, resizable: true, filter: true, floatingFilter: false },
      rowData: holds, rowSelection: { mode: 'multiRow', checkboxes: false, headerCheckbox: false },
      sideBar: { toolPanels: ['columns', 'filters'], defaultToolPanel: '' },
      rowGroupPanelShow: 'always', groupDisplayType: 'multipleColumns', suppressAggFuncInHeader: true,
      statusBar: { statusPanels: [
        { statusPanel: 'agTotalAndFilteredRowCountComponent', align: 'left' },
        { statusPanel: 'agSelectedRowCountComponent' },
        { statusPanel: 'agAggregationComponent', statusPanelParams: { aggFuncs: ['sum', 'avg'] } }
      ] },
      masterDetail: true, detailRowAutoHeight: true,
      isRowMaster: () => true,
      detailCellRendererParams: {
        detailGridOptions: {
          theme,
          columnDefs: [{ field: 'field', headerName: 'Detail', width: 190 }, { field: 'value', headerName: '', flex: 1, wrapText: true, autoHeight: true }],
          domLayout: 'autoHeight'
        },
        getDetailRowData: (params) => {
          const h = params.data;
          params.successCallback([
            { field: 'Why held', value: h.reason },
            { field: 'Release rule', value: h.rule },
            { field: 'PayPal transaction', value: h.txn_id },
            { field: 'Held since', value: h.held_at },
            { field: 'Shipped', value: h.shipped_at || '—' },
            { field: 'Delivered', value: h.delivered_at || '—' },
            { field: 'Tracking uploaded', value: h.uploaded ? 'yes' : 'no' }
          ]);
        }
      },
      onGridReady: () => {}
    });
    g.setGridOption('rowData', holds);
    setStatus('holdsStatus', `${holds.length} holds · ${money(holds.reduce((a, h) => a + h.amount, 0))} held`);
  }

  async function holdsAsk() {
    const q = $('askInput').value.trim();
    if (!q) return;
    const g = grids.holds;
    if (!g) return;
    $('btnAsk').disabled = true;
    setStatus('holdsStatus', 'Asking…');
    try {
      const values = (field) => [...new Set(g.getGridOption('rowData').map((r) => r[field]).filter(Boolean))].slice(0, 12);
      const columns = [
        { field: 'id', headerName: 'Hold', type: 'text' },
        { field: 'order_id', headerName: 'Order', type: 'text' },
        { field: 'buyer', headerName: 'Buyer', type: 'text' },
        { field: 'item', headerName: 'Item', type: 'text' },
        { field: 'amount', headerName: 'Amount (USD)', type: 'number' },
        { field: 'code', headerName: 'PayPal code', type: 'set', values: values('code') },
        { field: 'status', headerName: 'State (in_paypal=tracking in PayPal, seller_has=ready to upload, not_shipped, reserve, unapproved)', type: 'set', values: values('status') },
        { field: 'carrier', headerName: 'Carrier', type: 'set', values: values('carrier') },
        { field: 'delivered_at', headerName: 'Delivered date', type: 'date' },
        { field: 'exp_at', headerName: 'PayPal release date', type: 'date' },
        { field: 'conf', headerName: 'Confidence', type: 'set', values: values('conf') }
      ];
      const r = await post('/api/ai/grid-query', { question: q, columns });
      g.setFilterModel(Object.keys(r.filterModel).length ? r.filterModel : null);
      g.setRowGroupColumns(r.rowGroup);
      g.applyColumnState({ defaultState: { sort: null }, state: r.sort.map((s, i) => ({ colId: s.colId, sort: s.sort, sortIndex: i })) });
      setStatus('holdsStatus', `${r.explanation} (${r.model}, ${r.ms} ms)`, 'good');
    } catch (e) {
      setStatus('holdsStatus', e.message, 'bad');
    } finally {
      $('btnAsk').disabled = false;
    }
  }
  $('btnAsk').addEventListener('click', holdsAsk);
  $('askInput').addEventListener('keydown', (e) => e.key === 'Enter' && holdsAsk());
  $('btnClearFilters').addEventListener('click', () => {
    const g = grids.holds;
    if (!g) return;
    g.setFilterModel(null);
    g.setRowGroupColumns([]);
    g.applyColumnState({ defaultState: { sort: null } });
    setStatus('holdsStatus', '');
  });

  async function uploadOrders(orderIds, statusId) {
    if (!orderIds.length) return setStatus(statusId, 'Select at least one order first.', 'bad');
    setStatus(statusId, `Uploading ${orderIds.length} tracking numbers to PayPal…`);
    try {
      const r = await post('/api/manifests/upload', { orderIds, autoOnly: false, dryRun: false });
      const failed = r.total_failed ? ` · ${r.total_failed} failed (${(r.items.find((i) => i.status === 'FAILED') || {}).error || 'see audit'})` : '';
      setStatus(statusId, `${r.total_uploaded} uploaded · ${money(r.total_usd_accelerated)} released ~${r.avg_days_saved} days sooner · health ${r.health_score_before} → ${r.health_score_after}${failed}`, r.total_failed ? 'bad' : 'good');
      await Promise.all([loadCockpit(), refreshHolds(), refreshAudit()]);
    } catch (e) {
      setStatus(statusId, e.message, 'bad');
    }
  }
  async function refreshHolds() {
    if (!grids.holds) return;
    const { holds } = await api('/api/holds');
    grids.holds.setGridOption('rowData', holds);
  }
  $('btnUploadSelected').addEventListener('click', () => {
    const rows = grids.holds ? grids.holds.getSelectedRows() : [];
    uploadOrders(rows.filter((r) => r.status === 'seller_has').map((r) => r.order_id), 'holdsStatus');
  });

  // ================= Tracking matcher =================
  async function loadMatcher() {
    setStatus('matcherStatus', 'Matching carrier manifests to PayPal orders…');
    const data = await post('/api/manifests/match', {});
    const rows = data.matches || [];
    const g = makeGrid('matcher', $('gridMatcher'), {
      columnDefs: [
        { headerName: '', width: 52, checkboxSelection: true, headerCheckboxSelection: true, pinned: 'left' },
        { field: 'tracking_number', headerName: 'Tracking', width: 160 },
        { field: 'carrier', headerName: 'Carrier', width: 100, filter: 'agSetColumnFilter' },
        { field: 'matched_order_id', headerName: 'PayPal order', width: 170 },
        { field: 'hold_amount', headerName: 'Amount', width: 110, valueFormatter: (p) => money(p.value), aggFunc: 'sum' },
        {
          field: 'match_method', headerName: 'How matched', width: 130, filter: 'agSetColumnFilter',
          valueFormatter: (p) => ({ id: 'Order ID', rule: 'Rule', ai: 'AI', ask: 'Ask you' }[p.value] || p.value)
        },
        {
          field: 'confidence', headerName: 'Confidence', width: 130, sort: 'asc',
          valueFormatter: (p) => `${Math.round((p.value || 0) * 100)}%`,
          cellRenderer: (p) => chip(`${Math.round((p.value || 0) * 100)}%`, p.value >= 0.9 ? 'good' : p.value >= 0.8 ? 'info' : 'warn')
        },
        { field: 'match_reason', headerName: 'Why', flex: 1, minWidth: 260, wrapText: true, autoHeight: true },
        { field: 'days_sooner', headerName: 'Days sooner', width: 120, valueFormatter: (p) => `+${p.value}` },
        { field: 'decision', headerName: 'Decision', width: 120, editable: true, cellEditor: 'agSelectCellEditor', cellEditorParams: { values: ['auto', 'you', 'ask', 'none'] } }
      ],
      defaultColDef: { sortable: true, resizable: true, filter: true },
      rowData: rows, rowSelection: { mode: 'multiRow', checkboxes: false, headerCheckbox: false },
      statusBar: { statusPanels: [{ statusPanel: 'agTotalAndFilteredRowCountComponent' }, { statusPanel: 'agSelectedRowCountComponent' }, { statusPanel: 'agAggregationComponent', statusPanelParams: { aggFuncs: ['sum'] } }] }
    });
    g.setGridOption('rowData', rows);
    g.forEachNode((n) => n.setSelected(n.data.decision === 'auto' && n.data.confidence >= 0.8));
    setStatus('matcherStatus', `${data.matched_count} of ${data.total_manifests} matched · ${data.auto_count} auto-approved · ${data.review_count} need review · ${money(data.total_potential_acceleration_usd)} can be released sooner`);
  }
  $('btnRunMatcher').addEventListener('click', loadMatcher);
  $('btnUploadApproved').addEventListener('click', () => {
    const rows = grids.matcher ? grids.matcher.getSelectedRows() : [];
    uploadOrders(rows.map((r) => r.matched_order_id), 'matcherStatus').then(loadMatcher);
  });

  // ================= Release timeline (Bryntum) =================
  async function loadTimeline() {
    if (window.unholdTimeline) {
      const { holds } = await api('/api/holds');
      await window.unholdTimeline.render($('timelineHost'), holds);
    } else {
      $('timelineHost').innerHTML = '<div class="note">The Bryntum timeline is not loaded yet.</div>';
    }
  }

  // ================= Cash goal =================
  function initForecastGrids() {
    makeGrid('outcome', $('gridOutcome'), {
      columnDefs: [{ field: 'metric', headerName: 'Measure', flex: 1 }, { field: 'value', headerName: '', flex: 1, cellStyle: { fontWeight: 600 } }],
      rowData: [], overlayNoRowsTemplate: 'Press “Plan it”'
    });
    makeGrid('plan', $('gridPlan'), {
      columnDefs: [{ field: 'title', headerName: 'Action', flex: 1, wrapText: true, autoHeight: true }, { field: 'impactDescription', headerName: 'Effect', flex: 1.2, wrapText: true, autoHeight: true }],
      rowData: [], overlayNoRowsTemplate: 'Press “Plan it”'
    });
  }
  $('btnSimulateGoal').addEventListener('click', async () => {
    initForecastGrids();
    setStatus('forecastStatus', 'Running 2,000 simulated release paths…');
    try {
      const d = await post('/api/cash-goal/plan', {
        goalAmount: Number($('goalAmount').value), goalDay: Number($('goalDays').value), confidence: Number($('goalConfidence').value)
      });
      const pct = (x) => `${Math.round((x || 0) * 100)}%`;
      grids.outcome.setGridOption('rowData', [
        { metric: 'Goal', value: `${money(d.goalAmount)} by day ${d.goalDay}` },
        { metric: 'Chance as things stand', value: pct(d.baselineProb) },
        { metric: 'Chance with the plan', value: pct(d.plannedProb) },
        { metric: d.shortfallOrSurplus >= 0 ? 'Cushion' : 'Shortfall', value: money(Math.abs(d.shortfallOrSurplus)) }
      ]);
      grids.plan.setGridOption('rowData', d.selectedActions || []);
      setStatus('forecastStatus', d.recommendedText, 'good');
    } catch (e) {
      setStatus('forecastStatus', e.message, 'bad');
    }
  });

  // ================= Payment guard =================
  const scamEmail = `From: service@paypa1-security-alert.com
Subject: URGENT: Payment Received - Action Required
Date: Mon, 9 Nov 2026 15:30:00 -0800

Dear Merchant,
You have received a payment of $820.00 USD from customer M. Rossi for Order #ORD-DEMO-001.
Transaction ID: CAP-FAKE-PHISHING-001

STATUS: FUNDS ON TEMPORARY HOLD
To release these funds you MUST ship the item within 12 hours via express courier and reply with the tracking number. Do not check your account dashboard.

PayPal Security Protection Division`;
  const realEmail = `From: service@paypal.com
Subject: Notification of payment received
Date: Mon, 9 Nov 2026 14:02:11 +0000

Hello Apex Home Goods,
You received a payment of $820.00 USD from buyer M. Rossi.
Transaction ID: 7HY29438EP0613028

Shipping Address:
18 Market Street, Suite 400
San Francisco, CA 94105
United States

Seller Protection: Eligible`;
  function initGuardGrid() {
    return makeGrid('guard', $('gridGuard'), {
      columnDefs: [
        { field: 'at', headerName: 'Checked', width: 110 },
        { field: 'verdict', headerName: 'Verdict', width: 190, cellRenderer: (p) => chip(p.value, /BLOCK|SCAM|DO NOT/i.test(p.value) ? 'bad' : 'good') },
        { field: 'txn', headerName: 'Transaction', width: 210 },
        { field: 'amount', headerName: 'Amount', width: 110 },
        { field: 'summary', headerName: 'What we found', flex: 1, minWidth: 260, wrapText: true, autoHeight: true },
        { field: 'flags', headerName: 'Red flags', flex: 1, minWidth: 240, wrapText: true, autoHeight: true }
      ],
      rowData: [], overlayNoRowsTemplate: 'No emails checked yet'
    });
  }
  $('btnLoadScam').addEventListener('click', () => { $('emailInput').value = scamEmail; });
  $('btnLoadReal').addEventListener('click', () => { $('emailInput').value = realEmail; });
  $('btnVerifyEmail').addEventListener('click', async () => {
    const rawEmail = $('emailInput').value.trim();
    if (!rawEmail) return setStatus('guardStatus', 'Paste an email first.', 'bad');
    initGuardGrid();
    setStatus('guardStatus', 'Reading the email and checking the payment with PayPal…');
    try {
      const d = await post('/api/payment-guard/verify-email', { rawEmail });
      const blocked = d.verification_status === 'PHISHING_SCAM_BLOCKED' || d.can_ship === false;
      grids.guard.applyTransaction({
        add: [{
          at: new Date().toLocaleTimeString(),
          verdict: blocked ? 'DO NOT SHIP' : 'Verified payment',
          txn: d.transaction_id || '—',
          amount: d.actual_amount != null ? money(d.actual_amount) : d.claimed_amount != null ? money(d.claimed_amount) : '—',
          summary: d.summary || '',
          flags: (d.red_flags || []).join(' · ')
        }],
        addIndex: 0
      });
      setStatus('guardStatus', blocked ? 'Blocked: do not ship against this email.' : 'This payment is real in PayPal.', blocked ? 'bad' : 'good');
      refreshAudit();
    } catch (e) {
      setStatus('guardStatus', e.message, 'bad');
    }
  });

  // ================= Disputes =================
  async function loadDisputes() {
    const { disputes } = await api('/api/disputes');
    const g = makeGrid('disputes', $('gridDisputes'), {
      columnDefs: [
        { field: 'dispute_id', headerName: 'Dispute', width: 160, cellRenderer: 'agGroupCellRenderer' },
        { field: 'order_id', headerName: 'Order', width: 140 },
        { field: 'amount', headerName: 'Amount', width: 110, valueFormatter: (p) => money(p.value) },
        { field: 'reason', headerName: 'Reason', width: 190 },
        { field: 'status', headerName: 'Status', width: 240, cellRenderer: (p) => chip(p.value, /RESOLVED/.test(p.value) ? 'good' : /REVIEW/.test(p.value) ? 'bad' : 'warn') },
        { field: 'buyer_message', headerName: 'Buyer said', flex: 1, minWidth: 240, wrapText: true, autoHeight: true },
        { field: 'respond_by', headerName: 'Respond by', width: 130, valueFormatter: (p) => day(p.value) }
      ],
      rowData: disputes, masterDetail: true, detailRowAutoHeight: true,
      isRowMaster: (d) => Boolean(d && d.transcript && d.transcript.length),
      detailCellRendererParams: {
        detailGridOptions: {
          theme,
          columnDefs: [
            { field: 'turn_number', headerName: 'Turn', width: 80 },
            { field: 'who', headerName: 'From', width: 170 },
            { field: 'message', headerName: 'Message', flex: 1, wrapText: true, autoHeight: true },
            { field: 'attached', headerName: 'Attached', width: 280 }
          ],
          domLayout: 'autoHeight'
        },
        getDetailRowData: (p) => p.successCallback(p.data.transcript)
      }
    });
    g.setGridOption('rowData', disputes);
    setStatus('disputeStatus', `${disputes.length} open dispute${disputes.length === 1 ? '' : 's'}`);
  }
  $('btnRunA2A').addEventListener('click', async () => {
    const g = grids.disputes;
    const target = (g && g.getSelectedRows()[0]) || (g && g.getDisplayedRowAtIndex(0)?.data);
    if (!target) return setStatus('disputeStatus', 'No dispute to settle.', 'bad');
    setStatus('disputeStatus', 'Buyer agent and Unhold agent are negotiating…');
    try {
      const d = await post(`/api/disputes/${encodeURIComponent(target.dispute_id)}/negotiate`, { options: { maxTurns: 4, autoOfferCoupon: true } });
      const transcript = (d.turns || []).map((t) => ({
        turn_number: t.turn_number,
        who: t.sender === 'BUYER_AGENT' ? 'Buyer agent' : 'Unhold merchant agent',
        message: t.message,
        attached: t.evidence_attached ? `SD-JWT proof (${t.evidence_attached.type})` : t.offer ? `Store credit $${t.offer.amount_usd} (${t.offer.coupon_code})` : ''
      }));
      const { disputes } = await api('/api/disputes');
      g.setGridOption('rowData', disputes.map((x) => (x.dispute_id === target.dispute_id ? { ...x, transcript } : x)));
      g.forEachNode((n) => n.data.dispute_id === target.dispute_id && n.setExpanded(true));
      setStatus('disputeStatus', `Settlement ${d.final_status || d.status || 'finished'} after ${transcript.length} turns.`, 'good');
      refreshAudit();
    } catch (e) {
      setStatus('disputeStatus', e.message, 'bad');
    }
  });
  $('btnCheckInjection').addEventListener('click', async () => {
    setStatus('disputeStatus', 'Scanning…');
    try {
      const d = await post('/api/prompt-guard/check', { message: $('injectionInput').value });
      const score = d.riskScore ?? d.risk_score ?? 0;
      const hit = d.isInjected || d.is_injection || score > 0.4;
      setStatus('disputeStatus', hit ? `Blocked: prompt injection (risk ${Math.round(score * 100)}%). Payout commands neutralised.` : 'Clean buyer message.', hit ? 'bad' : 'good');
    } catch (e) {
      setStatus('disputeStatus', e.message, 'bad');
    }
  });

  // ================= Audit chain =================
  async function loadAudit() {
    const { chain } = await api('/api/audit');
    const rows = (chain || []).slice().reverse();
    const g = makeGrid('audit', $('gridAudit'), {
      columnDefs: [
        { field: 'block_id', headerName: '#', width: 80 },
        { field: 'timestamp', headerName: 'When', width: 170, valueFormatter: (p) => new Date(p.value).toLocaleString() },
        { field: 'actor', headerName: 'Who', width: 210, filter: 'agSetColumnFilter' },
        { field: 'action', headerName: 'Action', width: 260, filter: 'agSetColumnFilter' },
        { field: 'target', headerName: 'On', width: 180 },
        { field: 'result', headerName: 'Result', width: 110, cellRenderer: (p) => chip(p.value, /error|fail/i.test(p.value) ? 'bad' : /simulated/i.test(p.value) ? 'warn' : 'good') },
        { field: 'detail', headerName: 'Detail', flex: 1, minWidth: 260, wrapText: true, autoHeight: true },
        { field: 'hash', headerName: 'Hash', width: 190, valueFormatter: (p) => p.value.slice(0, 20) + '…', tooltipField: 'hash' }
      ],
      defaultColDef: { sortable: true, resizable: true, filter: true },
      rowData: rows, tooltipShowDelay: 300
    });
    g.setGridOption('rowData', rows);
  }
  async function refreshAudit() {
    if (!grids.audit) return;
    const { chain } = await api('/api/audit');
    grids.audit.setGridOption('rowData', (chain || []).slice().reverse());
  }
  $('btnVerifyAudit').addEventListener('click', async () => {
    setStatus('auditStatus', 'Re-hashing every block from genesis…');
    try {
      const d = await post('/api/audit/verify');
      setStatus('auditStatus', d.valid ? `Chain intact${d.blocks_verified ? ` — ${d.blocks_verified} blocks` : ''}. No tampering.` : `Chain broken: ${d.error || d.message || 'hash mismatch'}`, d.valid ? 'good' : 'bad');
    } catch (e) {
      setStatus('auditStatus', e.message, 'bad');
    }
  });

  // ---------- boot ----------
  await loadCockpit();
})().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML('afterbegin', `<pre style="color:#f85149;padding:12px">Cockpit failed to start: ${e.message}</pre>`);
});
