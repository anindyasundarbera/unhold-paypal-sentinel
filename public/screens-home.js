// Screens: role entry (Form), Home (Inbox), Guided tour, Held money (Dashboard).
(function () {
  'use strict';
  const U = window.U;
  const { $, el, money, day, plural } = U;

  // ================= Role entry =================
  U.screens.start = async function loadStart() {
    $('nameInput').value = U.userName;
    const cards = $('roleCards');
    const render = (inbox) => {
      cards.replaceChildren(
        ...Object.entries(U.ROLE).map(([key, r]) => {
          const live = inbox && inbox.roles[key];
          const top = el('span', { className: 'top' }, el('span', { className: 'name', textContent: r.name }));
          if (live && live.todo) top.append(el('span', { className: 'badge', textContent: `${live.todo} to do` }));
          else if (key === 'tour') top.append(el('span', { className: 'badge', textContent: 'New here? Start here' }));
          const b = el('button', { className: 'role' }, top,
            el('span', { className: 'who', textContent: r.who }),
            el('span', { className: 'live', textContent: key === 'tour' ? 'Seven steps through the whole loop' : live ? live.headline : 'Loading…' }),
            el('span', { className: 'sub', textContent: key === 'tour' ? 'Each step is marked real or simulated' : live ? live.sub : '' }));
          if (key === U.role) b.setAttribute('aria-current', 'true');
          b.addEventListener('click', () => { U.setRole(key); U.showTab('home'); });
          return b;
        })
      );
    };
    render(null);
    render(await U.api('/api/inbox'));
  };
  $('nameInput').addEventListener('input', () => {
    U.userName = $('nameInput').value.trim().slice(0, 40);
    U.remember('unhold.name', U.userName || null);
  });

  // ================= Home: the role's work queue =================
  const KIND_ORDER = ['decision', 'opportunity', 'health', 'result', 'review', 'ready', 'unmatched', 'not_shipped', 'failed_upload', 'dispute', 'payment_review',
    'failed_run', 'stale', 'chain', 'error', 'connection', 'check'];
  const WHEN_LABEL = { ready: 'Releases', review: 'Releases', not_shipped: 'Releases', payment_review: 'Releases', dispute: 'Reply by',
    decision: 'Asked', stale: 'Asked', result: 'Finished', failed_run: 'Started', error: 'Logged', failed_upload: 'Logged' };
  const DOT = { todo: 'warn', info: 'info', ok: 'good' };
  const queueGroupSize = {};
  function whenText(item) {
    if (!item.due) return '';
    const days = Math.round((Date.parse(item.due) - Date.now()) / U.DAY);
    const rel = days > 0 ? `in ${plural(days, 'day')}` : days === 0 ? 'today' : `${plural(-days, 'day')} ago`;
    return `${WHEN_LABEL[item.kind] || ''} ${day(item.due)} · ${rel}`.trim();
  }

  const TOUR = [
    { n: 1, title: 'See what PayPal is holding and why', detail: 'The held total, when it releases, and the causes PayPal reacts to. The PayPal sandbox cannot create seller holds, so the hold history is seeded.', truth: ['Simulated history', 'warn'], tab: 'cockpit' },
    { n: 2, title: 'Match carrier parcels to PayPal orders', detail: 'Each parcel from the carrier export is matched to an order, with a confidence and a reason.', truth: ['Real logic, demo parcels', 'info'], tab: 'matcher' },
    { n: 3, title: 'Let the agent team propose a plan', detail: 'Choose “Demo data”, then run the agent. Four agents look up orders, check prices, scan disputes and build an upload plan, using real PayPal lookups, catalog checks and language model calls.', truth: ['Real run', 'good'], tab: 'approvals' },
    { n: 4, title: 'Read the plan, then approve or reject it', detail: 'Select the waiting plan to see every parcel. Nothing is uploaded until a person decides, here or from the Slack message. Real sandbox orders are uploaded to PayPal; demo parcels are recorded as a simulation.', truth: ['Real for real orders', 'good'], tab: 'approvals' },
    { n: 5, title: 'Verify what happened', detail: 'Every step is written to a hash chain that is re-verified when you open the screen.', truth: ['Real', 'good'], tab: 'audit' },
    { n: 6, title: 'Extra: check a “payment received” email', detail: 'Paste the example fake notice. Unhold looks the payment up in PayPal before you ship.', truth: ['Real PayPal lookup', 'good'], tab: 'guard' },
    { n: 7, title: 'Extra: ask the holds table a question', detail: 'Type a question in plain English, or search the whole ledger. Language model for filters, Elastic for search.', truth: ['Real', 'good'], tab: 'holds' }
  ];

  U.screens.home = async function loadHome() {
    const r = U.ROLE[U.role];
    const isTour = U.role === 'tour';
    $('gridQueue').hidden = isTour;
    $('gridTour').hidden = !isTour;
    $('homeSummary').hidden = isTour;
    $('gridHomeKpi').hidden = U.role !== 'owner';
    $('homeQueueTitle').textContent = isTour ? 'The loop, step by step' : 'What needs you';

    if (isTour) {
      U.makeGrid('tour', $('gridTour'), {
        defaultColDef: U.PLAIN, domLayout: 'autoHeight',
        columnDefs: [
          { field: 'n', headerName: 'Step', width: 80 },
          { field: 'title', headerName: 'What to do', flex: 1.2, minWidth: 240, wrapText: true, autoHeight: true, cellStyle: { fontWeight: 550 } },
          { field: 'detail', headerName: 'What you will see', flex: 2.2, minWidth: 320, wrapText: true, autoHeight: true },
          { field: 'truth', headerName: 'Real or simulated', width: 200, cellRenderer: (p) => U.status(p.value[0], p.value[1]) },
          { headerName: '', colId: 'open', width: 130, cellRenderer: (p) => U.linkBtn(`Open step ${p.data.n}`, () => U.go(p.data.tab)) }
        ],
        rowData: TOUR, getRowId: (p) => String(p.data.n), suppressCellFocus: true
      });
      return;
    }

    U.busy('queue', true);
    const inbox = await U.api('/api/inbox');
    const card = inbox.roles[U.role];
    $('homeSummary').classList.toggle('attn', card.todo > 0 && U.role === 'owner' && card.primary && card.primary.tab === 'approvals' && /waiting/.test(card.headline));
    $('homeNextTitle').textContent = card.headline;
    $('homeNextBody').textContent = card.sub;
    const primary = $('btnHomePrimary');
    primary.hidden = !card.primary;
    if (card.primary) { primary.textContent = card.primary.label; primary.onclick = () => U.go(card.primary.tab, card.primary.hold_filter); }

    if (U.role === 'owner') {
      const s = U.store.summary || (await U.api('/api/summary'));
      U.store.summary = s;
      const row = [{ held: s.total_withheld_usd, holds: s.open_holds_count, speed: s.speedable_amount_usd, parcels: s.speedable_holds_count, days: s.avg_days_sooner, health: s.health_score, band: s.health_band }];
      const g = U.makeGrid('homeKpi', $('gridHomeKpi'), { responsive: [{ cols: ['pd'], min: 760 }], defaultColDef: U.PLAIN, columnDefs: kpiColumns(), rowData: row, rowHeight: 56, headerHeight: 28, suppressCellFocus: true });
      g.setGridOption('rowData', row);
    }

    const rows = inbox.items.filter((i) => i.role === U.role).sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
    // Long groups (dozens of parcels) start closed so every kind of work is visible at once.
    for (const k of Object.keys(queueGroupSize)) delete queueGroupSize[k];
    for (const item of rows) queueGroupSize[item.kind_label] = (queueGroupSize[item.kind_label] || 0) + 1;
    const g = U.makeGrid('queue', $('gridQueue'), {
      domLayout: 'autoHeight',
      responsive: [{ cols: ['due'], min: 760 }],
      columnDefs: [
        { field: 'kind_label', rowGroup: true, hide: true },
        { field: 'amount', headerName: 'Money', width: 110, type: 'rightAligned', aggFunc: 'sum', cellStyle: { fontWeight: 550, fontVariantNumeric: 'tabular-nums' }, valueFormatter: (p) => (p.value ? money(p.value) : '') },
        { colId: 'due', field: 'due', headerName: 'Date', width: 240, valueFormatter: (p) => (p.data ? whenText(p.data) : ''), cellStyle: { color: 'var(--muted)' } },
        { headerName: '', colId: 'action', width: 190, sortable: false, cellRenderer: (p) => (p.data && p.data.tab ? U.linkBtn(p.data.action, () => U.go(p.data.tab, p.data.hold_filter)) : '') }
      ],
      quiet: true,
      defaultColDef: { sortable: true, resizable: false, suppressHeaderMenuButton: true },
      autoGroupColumnDef: {
        headerName: 'Item', field: 'title', flex: 1, minWidth: 320, sortable: false, autoHeight: true,
        cellRendererParams: {
          innerRenderer: (p) => {
            if (p.node.group || !p.data) return p.value;
            const box = U.twoLine(p.data.title, p.data.detail);
            box.firstChild.prepend(el('span', { className: 'dot ' + DOT[p.data.state] }), ' ');
            return box;
          }
        }
      },
      rowData: rows, getRowId: (p) => p.data.id, suppressAggFuncInHeader: true, groupDisplayType: 'singleColumn',
      isGroupOpenByDefault: (p) => (queueGroupSize[p.key] || 0) <= 12,
      overlayNoRowsTemplate: r.empty || 'Nothing needs you right now'
    });
    g.setGridOption('rowData', rows);
    g.setGridOption('overlayNoRowsTemplate', r.empty);
    U.busy('queue', false);
  };

  // ================= Held money (dashboard) =================
  const SPARK = { type: 'area', fill: 'rgba(123,115,255,.18)', stroke: '#7b73ff', axis: { stroke: 'transparent' } };
  function kpiColumns(withSparks = false, series = {}) {
    const spark = (field, headerName) => ({ field, headerName, minWidth: 120, flex: 1, cellRenderer: 'agSparklineCellRenderer', cellRendererParams: { sparklineOptions: SPARK } });
    return [
      { headerName: 'Held by PayPal', field: 'held', valueFormatter: (p) => money(p.value), minWidth: 150, flex: 1.1 },
      { headerName: 'Payments on hold', field: 'holds', minWidth: 160, flex: 0.8 },
      ...(withSparks ? [spark('heldSeries', 'Releases by week')] : []),
      { headerName: 'Can release sooner', field: 'speed', valueFormatter: (p) => money(p.value), cellStyle: { color: 'var(--good)' }, minWidth: 160, flex: 1.1 },
      ...(withSparks && series ? [spark('speedSeries', 'After tracking')] : []),
      { colId: 'pd', headerName: 'Parcels · days sooner', valueGetter: (p) => `${p.data.parcels} parcels · ${p.data.days} days`, cellStyle: { fontSize: '14px', fontWeight: 500, letterSpacing: 0 }, minWidth: 190, flex: 1 },
      {
        headerName: 'Account health', field: 'health', minWidth: 190, flex: 1,
        cellRenderer: (p) => el('span', null, el('span', { textContent: p.value }), el('span', { className: 'note', textContent: '/100 ', style: 'font-size:13px;font-weight:400' }), U.status(p.data.band, p.value >= 70 ? 'good' : 'warn'))
      }
    ];
  }

  let waterfallMode = 'now';
  let waterfallData = null;
  U.screens.cockpit = async function loadCockpit() {
    const [summary, wf, why] = await Promise.all([U.api('/api/summary'), U.api('/api/waterfall'), U.api('/api/why-held')]);
    U.store.summary = summary;
    waterfallData = wf;
    U.renderNextStep();

    const series = (b) => b.filter((x) => x.startDate !== 'unknown').map((x) => x.amount);
    const row = [{
      held: summary.total_withheld_usd, holds: summary.open_holds_count, speed: summary.speedable_amount_usd, parcels: summary.speedable_holds_count, days: summary.avg_days_sooner,
      health: summary.health_score, band: summary.health_band, heldSeries: series(wf.currentBuckets), speedSeries: series(wf.expeditedBuckets)
    }];
    const kpi = U.makeGrid('kpi', $('gridKpi'), { responsive: [{ cols: ['heldSeries', 'speedSeries'], min: 1000 }, { cols: ['pd'], min: 760 }], defaultColDef: U.PLAIN, columnDefs: kpiColumns(true, true), rowData: row, rowHeight: 56, headerHeight: 28, suppressMovableColumns: true, suppressCellFocus: true });
    kpi.setGridOption('rowData', row);

    const buckets = wf.currentBuckets
      .map((b, i) => ({ raw: b.label, label: shortWeek(b.label), now: b.amount, after: (wf.expeditedBuckets[i] || {}).amount || 0, holds: b.holdsCount }))
      .filter((r) => !/undated/i.test(r.raw) || r.now > 0);
    const bg = U.makeGrid('buckets', $('gridBuckets'), {
      defaultColDef: U.PLAIN,
      columnDefs: [
        { headerName: 'Release week', field: 'label', flex: 1.2, minWidth: 130 },
        { headerName: 'Releases now', field: 'now', valueFormatter: (p) => money(p.value), chartDataType: 'series', flex: 1, minWidth: 120, type: 'rightAligned' },
        { headerName: 'With tracking uploaded', field: 'after', valueFormatter: (p) => money(p.value), chartDataType: 'series', flex: 1, minWidth: 160, type: 'rightAligned' },
        { headerName: 'Holds', field: 'holds', flex: 0.5, minWidth: 80, type: 'rightAligned' }
      ],
      rowData: buckets, enableCharts: true, cellSelection: true
    });
    bg.setGridOption('rowData', buckets);
    renderWaterfallChart();
    $('waterfallNote').textContent = `${plural(wf.shiftedHoldsCount, 'hold')} would move about ${wf.avgDaysEarlier} days earlier (${money(wf.shiftedAmountUsd)}).`;

    const drivers = (why.drivers || []).map((d) => ({ title: d.title, severity: d.severity, detail: d.detail, rule: d.paypal_reason }));
    const wg = U.makeGrid('why', $('gridWhy'), {
      defaultColDef: U.PLAIN, domLayout: 'autoHeight',
      columnDefs: [
        { headerName: 'Cause', field: 'title', flex: 1, minWidth: 130, wrapText: true, autoHeight: true, tooltipField: 'rule', cellStyle: { fontWeight: 550 } },
        { headerName: 'Weight', field: 'severity', width: 110, cellRenderer: (p) => U.status(p.value === 'HIGH' ? 'High' : p.value === 'MEDIUM' ? 'Medium' : p.value, p.value === 'HIGH' ? 'bad' : 'warn') },
        { headerName: 'What we found', field: 'detail', flex: 2, minWidth: 200, wrapText: true, autoHeight: true, tooltipField: 'rule' }
      ],
      rowData: drivers, overlayNoRowsTemplate: 'No hold causes found'
    });
    wg.setGridOption('rowData', drivers);
    const note = (why.plain_english_explanation || '').replace(/\s*\[[A-Z0-9]{10,}\]/g, '');
    $('whyNote').textContent = note;
    $('whyNote').hidden = !note;
  };
  /** "Nov 9 to 15 (Week 1)" is too long for an axis label; "Nov 9–15" says the same. */
  function shortWeek(label) {
    const m = /^([A-Za-z]+) (\d+) to (?:([A-Za-z]+) )?(\d+)/.exec(label);
    if (m) return m[3] ? `${m[1]} ${m[2]}–${m[3]} ${m[4]}` : `${m[1]} ${m[2]}–${m[4]}`;
    if (/30 or later/i.test(label)) return 'Nov 30+';
    if (/undated/i.test(label)) return 'Reserve';
    return label;
  }
  function renderWaterfallChart() {
    const grid = U.grids.buckets;
    if (!grid) return;
    if (U.grids.waterfallChart) U.grids.waterfallChart.destroyChart();
    const rows = grid.getDisplayedRowCount();
    if (!rows) return;
    U.grids.waterfallChart = grid.createRangeChart({
      chartContainer: $('waterfallChart'),
      cellRange: { rowStartIndex: 0, rowEndIndex: rows - 1, columns: ['label', ...(waterfallMode === 'now' ? ['now'] : ['now', 'after'])] },
      chartType: 'groupedColumn', suppressChartRanges: true, chartThemeName: U.chartThemeName()
    });
  }
  $('btnWaterfallMode').addEventListener('click', () => {
    waterfallMode = waterfallMode === 'now' ? 'after' : 'now';
    $('btnWaterfallMode').setAttribute('aria-pressed', String(waterfallMode === 'after'));
    renderWaterfallChart();
  });
  document.addEventListener('unhold:theme', () => { if (U.grids.buckets) renderWaterfallChart(); });

  // The summary card at the top of Held money.
  U.renderNextStep = function renderNextStep() {
    const s = U.store.summary;
    if (!s) return;
    const box = $('nextStep');
    const primary = $('btnNextPrimary');
    const secondary = $('btnNextSecondary');
    const set = (attn, title, body, a, b) => {
      box.classList.toggle('attn', attn);
      $('nextTitle').textContent = title;
      $('nextBody').textContent = body;
      for (const [btn, def] of [[primary, a], [secondary, b]]) {
        btn.hidden = !def;
        if (def) { btn.textContent = def[0]; btn.onclick = def[1]; }
      }
    };
    const p = U.pendingApprovals();
    if (p.length) set(true, 'A plan is waiting for your decision', `${p[0].title} · ${money(p[0].total_usd)}. Nothing is uploaded until you approve.`, ['Review plan', () => U.go('approvals')]);
    else if (s.speedable_holds_count > 0) set(false, `Release ${money(s.speedable_amount_usd)} about ${s.avg_days_sooner} days sooner`, `${plural(s.speedable_holds_count, 'shipped parcel')} have tracking that PayPal has not seen yet.`, ['Review parcels', () => U.go('matcher')], ['Let the agent plan it', () => U.go('approvals')]);
    else set(false, 'Nothing to upload right now', 'Every shipped parcel already has its tracking in PayPal.', null, ['See all holds', () => U.go('holds')]);
  };
})();
