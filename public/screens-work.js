// Screens: Holds (List), Match tracking (List), Approvals (Split pane), Agent runs (List), and the upload flow they share.
(function () {
  'use strict';
  const U = window.U;
  const { $, el, money, day, when, plural } = U;

  const STATE_LABEL = { in_paypal: 'Tracking in PayPal', seller_has: 'Ready to upload', not_shipped: 'Not shipped', reserve: 'Reserve', unapproved: 'Needs approval', no_record: 'No carrier record yet' };
  const STATE_KIND = { in_paypal: 'good', seller_has: 'info', not_shipped: '', reserve: '', unapproved: 'warn', no_record: '' };
  const ORDER_LABEL = { real: 'Real order', demo: 'Demo data', unknown: '' };

  // ================= Shared data =================
  let orderRecheck = null;
  let orderRecheckLeft = 3;
  U.fetchHolds = async function fetchHolds() {
    const { holds } = await U.api('/api/holds');
    U.store.holds = holds.map((h) => ({
      ...h,
      // "Ready" means a carrier record is matched to it and uploading brings the release forward.
      ready: h.status === 'seller_has' && Boolean(h.tracking_number) && Boolean(h.wi_date) && !h.uploaded,
      state: h.status === 'seller_has' && !h.wi_date ? 'no_record' : h.status,
      releases_in: h.exp_at ? Math.ceil((Date.parse(h.exp_at) - Date.now()) / U.DAY) : null,
      days_sooner: h.exp_at && h.wi_date ? Math.max(0, Math.round(((Date.parse(h.exp_at) - Date.parse(h.wi_date)) / U.DAY) * 10) / 10) : 0
    }));
    U.store.byOrder = new Map(U.store.holds.map((h) => [h.order_id, h]));
    // PayPal lookups for a few orders can still be in flight on the first load: pick them up shortly after.
    if (!orderRecheck && orderRecheckLeft > 0 && U.store.holds.some((h) => h.ready && h.paypal_order === 'unknown')) {
      orderRecheckLeft -= 1;
      orderRecheck = setTimeout(async () => { await U.refreshHolds().catch(() => undefined); orderRecheck = null; }, 5000);
    }
    return U.store.holds;
  };
  U.refreshHolds = async function refreshHolds() {
    if (!U.grids.holds) return;
    U.grids.holds.setGridOption('rowData', await U.fetchHolds());
    updateHoldBar();
  };

  // ================= Uploading tracking (shared by Holds, Match tracking) =================
  /** rows: [{ order_id, amount, paypal_order, confidence? }]. Always asks first and says exactly what will happen. */
  U.confirmAndUpload = async function confirmAndUpload(rows, statusId) {
    if (!rows.length) return false;
    const sum = (list) => money(list.reduce((a, r) => a + Number(r.amount || 0), 0));
    const simAll = Boolean(U.cfg.simulateUploads);
    const demo = simAll ? rows : rows.filter((r) => r.paypal_order === 'demo');
    const real = simAll ? [] : rows.filter((r) => r.paypal_order !== 'demo');
    const lowConf = rows.filter((r) => r.confidence != null && r.confidence < 0.8);
    const onlyDemo = real.length === 0;
    const list = [];
    if (real.length) list.push([el('b', { textContent: `${plural(real.length, 'parcel')} (${sum(real)})` }), ' will be sent to PayPal now. An upload cannot be withdrawn from here.']);
    if (onlyDemo) {
      list.push([el('b', { textContent: `${plural(demo.length, 'parcel')} (${sum(demo)})` }), simAll ? ' will be recorded as uploaded. This deployment does not call PayPal.' : ` ${demo.length === 1 ? 'is' : 'are'} demo data with no PayPal order, so nothing is sent to PayPal.`]);
      list.push('The ledger, forecast and audit will show this as uploaded, marked as simulated.');
    } else if (demo.length) {
      list.push([el('b', { textContent: `${plural(demo.length, 'parcel')} (${sum(demo)})` }), ` ${demo.length === 1 ? 'is' : 'are'} demo data with no PayPal order, so PayPal would refuse ${demo.length === 1 ? 'it' : 'them'}.`]);
    }
    if (lowConf.length) list.push([el('b', { textContent: plural(lowConf.length, 'parcel') }), ' matched below 80% confidence. Check the order before you continue.']);
    const answer = await U.askDialog({
      title: onlyDemo ? `Record ${plural(rows.length, 'demo parcel')} as uploaded?` : `Upload tracking for ${plural(real.length, 'parcel')}?`,
      list,
      check: !onlyDemo && demo.length ? { label: `Also record the ${plural(demo.length, 'demo parcel')} as uploaded in the ledger (simulation, no PayPal call)`, checked: false } : null,
      confirmLabel: onlyDemo ? 'Record as uploaded' : `Upload ${plural(real.length, 'parcel')}`
    });
    if (!answer.ok) return false;
    const jobs = [];
    if (real.length) jobs.push({ orderIds: real.map((r) => r.order_id), autoOnly: false });
    if (demo.length && (onlyDemo || answer.checked)) jobs.push({ orderIds: demo.map((r) => r.order_id), autoOnly: false, simulate: true });

    U.setStatus(statusId, 'Uploading…');
    let uploaded = 0, failed = 0, usd = 0, simulated = 0, firstError = '';
    try {
      for (const job of jobs) {
        const r = await U.post('/api/manifests/upload', job);
        uploaded += r.total_uploaded || 0;
        failed += r.total_failed || 0;
        usd += r.total_usd_accelerated || 0;
        if (job.simulate) simulated += r.total_uploaded || 0;
        firstError = firstError || ((r.items || []).find((i) => i.status === 'FAILED') || {}).error || '';
      }
      const parts = [`${plural(uploaded, 'parcel')} uploaded`, `${money(usd)} releases sooner`];
      if (simulated) parts.push(`${simulated} recorded as simulation`);
      if (failed) parts.push(`${failed} could not be uploaded${firstError ? ': ' + firstError : ''}`);
      U.setStatus(statusId, parts.join(' · '), failed ? 'bad' : 'good');
      U.toast(failed ? `${failed} of ${uploaded + failed} uploads did not go through. Details are in Audit.` : `Tracking uploaded for ${plural(uploaded, 'parcel')}.`, failed ? 'bad' : 'good');
    } catch (e) {
      U.setStatus(statusId, `The upload stopped. ${e.message}`, 'bad');
      U.toast(`The upload stopped. ${e.message}`, 'bad');
    }
    await Promise.allSettled([U.refreshCounts(), U.refreshHolds(), U.refreshAudit && U.refreshAudit()]);
    return true;
  };

  // ================= Holds =================
  const releaseText = (h) => (h.releases_in == null ? '—' : h.releases_in <= 0 ? `${day(h.exp_at)} · due` : `${day(h.exp_at)} · in ${plural(h.releases_in, 'day')}`);
  const holdColumns = [
    {
      colId: 'status', field: 'state', headerName: 'State', width: 200, filter: 'agSetColumnFilter', enableRowGroup: true,
      cellRenderer: 'agGroupCellRenderer',
      cellRendererParams: { suppressCount: true, innerRenderer: (p) => (p.node.group ? (STATE_LABEL[p.value] || p.value) : U.status(STATE_LABEL[p.value] || p.value, STATE_KIND[p.value])) },
      valueFormatter: (p) => STATE_LABEL[p.value] || p.value, filterParams: { valueFormatter: (p) => STATE_LABEL[p.value] || p.value }
    },
    { field: 'buyer', headerName: 'Buyer', width: 130, filter: 'agTextColumnFilter' },
    { field: 'item', headerName: 'Item', width: 180, filter: 'agTextColumnFilter' },
    { field: 'amount', headerName: 'Amount', width: 115, type: 'rightAligned', filter: 'agNumberColumnFilter', aggFunc: 'sum', valueFormatter: (p) => money(p.value), cellClass: 'tnum' },
    { field: 'exp_at', headerName: 'PayPal releases', width: 170, filter: 'agDateColumnFilter', valueFormatter: (p) => (p.data ? releaseText(p.data) : ''), filterValueGetter: (p) => (p.data.exp_at || '').slice(0, 10) },
    {
      field: 'wi_date', headerName: 'With tracking', width: 180,
      valueFormatter: (p) => (p.value ? `${day(p.value)}${p.data.days_sooner ? ` · ${p.data.days_sooner} days sooner` : ''}` : '—'),
      cellStyle: (p) => (p.value && p.data.ready ? { color: 'var(--good)', fontWeight: 550 } : null)
    },
    { field: 'carrier', headerName: 'Carrier', width: 105, filter: 'agSetColumnFilter', enableRowGroup: true },
    { field: 'tracking_number', headerName: 'Tracking number', width: 165 },
    { field: 'delivered_at', headerName: 'Delivered', width: 115, filter: 'agDateColumnFilter', valueFormatter: (p) => day(p.value), filterValueGetter: (p) => (p.data.delivered_at || '').slice(0, 10) },
    {
      field: 'paypal_order', headerName: 'PayPal order', width: 130, filter: 'agSetColumnFilter', enableRowGroup: true,
      headerTooltip: 'Real order: exists in your PayPal sandbox account. Demo data: seeded history with no PayPal order behind it.',
      valueFormatter: (p) => ORDER_LABEL[p.value] || '', filterParams: { valueFormatter: (p) => ORDER_LABEL[p.value] || p.value },
      cellRenderer: (p) => (p.node.group || !ORDER_LABEL[p.value] ? p.valueFormatted || '' : U.status(ORDER_LABEL[p.value], p.value === 'real' ? 'good' : ''))
    },
    { field: 'order_id', headerName: 'Order ID', width: 175 },
    { field: 'id', headerName: 'Hold ID', width: 175 },
    { field: 'code', headerName: 'PayPal code', width: 115, filter: 'agSetColumnFilter', enableRowGroup: true },
    { field: 'conf', headerName: 'Release confidence', width: 150, filter: 'agSetColumnFilter' },
    {
      colId: 'open', headerName: '', width: 52, pinned: 'right', sortable: false, filter: false, resizable: false, suppressHeaderMenuButton: true, suppressMovable: true,
      cellRenderer: (p) => { if (p.node.group) return ''; const c = U.el('span', { className: 'chev', title: 'Open the full story' }); c.innerHTML = U.icon('chevron-right', 16); return c; }
    }
  ];

  /** Every fact about a hold, plus the catalog check when Channel3 is connected. Used by the row detail and the drawer. */
  async function holdFacts(h) {
    const rows = [
      { field: 'Why it is held', value: h.reason },
      { field: 'Release rule', value: h.rule },
      { field: 'PayPal transaction', value: h.txn_id },
      { field: 'Order ID', value: h.order_id },
      { field: 'Held since', value: when(h.held_at) },
      { field: 'Shipped', value: h.shipped_at ? when(h.shipped_at) : 'Not yet' },
      { field: 'Delivered', value: h.delivered_at ? when(h.delivered_at) : 'Not yet' },
      { field: 'Tracking in PayPal', value: h.uploaded ? 'Yes, uploaded by Unhold' : h.status === 'in_paypal' ? 'Yes' : 'No' }
    ];
    if (h.tracking_number) rows.splice(3, 0, { field: 'Tracking number', value: `${h.carrier || ''} ${h.tracking_number}`.trim() });
    return rows;
  }
  async function catalogFacts(h) {
    const rows = [];
    if (!U.cfg.integrations?.channel3) return rows;
    try {
      const p = await U.api(`/api/holds/${encodeURIComponent(h.id)}/product`);
      if (p.found) {
        rows.push({ field: 'Catalog match', value: `${p.title} · ${p.brand || 'unknown brand'}${p.category ? ' · ' + p.category : ''}` });
        if (p.price) rows.push({ field: 'Catalog price', value: `${money(p.price)} at ${p.retailer}` });
        if (p.priceCheck) rows.push({ field: 'Price check', value: `${p.priceCheck.verdict.replace('_', ' ')}: ${p.priceCheck.note}` });
      } else rows.push({ field: 'Catalog match', value: 'No catalog product matches this item name.' });
    } catch (e) {
      rows.push({ field: 'Catalog match', value: `The catalog lookup did not answer. ${e.message}` });
    }
    return rows;
  }
  const factColumns = [{ field: 'field', headerName: 'Detail', width: 190, cellStyle: { color: 'var(--muted)' } }, { field: 'value', headerName: '', flex: 1, wrapText: true, autoHeight: true }];

  function openHold(h) {
    let g = null;
    U.onDrawerClose = () => { if (g && !g.isDestroyed()) g.destroy(); };
    U.openDrawer({
      title: `${h.buyer} · ${h.item}`,
      sub: `${money(h.amount)} · ${h.id}`,
      render: (body) => {
        const state = h.state === 'no_record' ? 'no_record' : h.status;
        body.append(el('div', { className: 'bar' }, U.status(STATE_LABEL[state] || state, STATE_KIND[state]), ORDER_LABEL[h.paypal_order] ? U.status(ORDER_LABEL[h.paypal_order], h.paypal_order === 'real' ? 'good' : '') : ''));
        const host = el('div');
        body.append(host);
        g = U.miniGrid(host, { columnDefs: factColumns, headerHeight: 0, rowData: [] });
        holdFacts(h).then((rows) => { if (!g.isDestroyed()) g.setGridOption('rowData', rows); catalogFacts(h).then((extra) => { if (extra.length && !g.isDestroyed()) g.setGridOption('rowData', [...rows, ...extra]); }); });
      },
      footer: (foot) => {
        if (h.tracking_number && U.cfg.integrations?.kernel) foot.append(U.btn('Check the carrier page', (e) => checkCarrier(h, e.currentTarget), 'btn'));
        if (h.ready) foot.append(U.btn('Upload tracking…', async () => { U.closeDrawer(); await U.confirmAndUpload([h], 'holdsStatus'); }, 'btn primary'));
      }
    });
  }

  U.screens.holds = async function loadHolds() {
    U.busy('holds', true);
    const holds = await U.fetchHolds();
    const g = U.makeGrid('holds', $('gridHolds'), {
      columnDefs: holdColumns,
      defaultColDef: { sortable: true, resizable: true, filter: true },
      rowData: holds, getRowId: (p) => p.data.id,
      rowSelection: { mode: 'multiRow', isRowSelectable: (n) => Boolean(n.data && n.data.ready), hideDisabledCheckboxes: true, selectAll: 'filtered', enableClickSelection: false },
      selectionColumnDef: { pinned: 'left', width: 48 },
      onSelectionChanged: updateHoldBar,
      onRowClicked: (e) => {
        if (!e.data || e.node.group) return;
        if (e.event && e.event.target.closest('button, .ag-selection-checkbox, .ag-group-expanded, .ag-group-contracted, .ag-checkbox, a')) return;
        openHold(e.data);
      },
      sideBar: { toolPanels: ['columns', 'filters'], defaultToolPanel: '' },
      rowGroupPanelShow: 'onlyWhenGrouping', suppressAggFuncInHeader: true,
      statusBar: { statusPanels: [{ statusPanel: 'agTotalAndFilteredRowCountComponent', align: 'left' }, { statusPanel: 'agSelectedRowCountComponent' }, { statusPanel: 'agAggregationComponent', statusPanelParams: { aggFuncs: ['sum', 'avg'] } }] },
      overlayNoRowsTemplate: 'No holds match. Clear the filters to see every hold.',
      masterDetail: true, detailRowAutoHeight: true,
      detailCellRendererParams: {
        detailGridOptions: { theme: U.gridTheme(), columnDefs: factColumns, headerHeight: 0, domLayout: 'autoHeight', defaultColDef: U.PLAIN },
        getDetailRowData: async (params) => {
          const base = await holdFacts(params.data);
          params.successCallback(base);
          const extra = await catalogFacts(params.data);
          if (extra.length) params.successCallback([...base, ...extra]);
        }
      }
    });
    g.setGridOption('rowData', holds);
    U.busy('holds', false);
    updateHoldBar();
  };

  function updateHoldBar() {
    const rows = U.grids.holds ? U.grids.holds.getSelectedRows() : [];
    const b = $('btnUploadSelected');
    b.disabled = rows.length === 0;
    b.textContent = rows.length ? `Upload tracking for ${plural(rows.length, 'parcel')} · ${money(rows.reduce((a, r) => a + r.amount, 0))}` : 'Upload tracking';
    const hint = 'Tick “Ready to upload” rows to enable the upload.';
    const now = $('holdsStatus').textContent;
    if (!rows.length && !now) U.setStatus('holdsStatus', hint);
    if (rows.length && now === hint) U.setStatus('holdsStatus', '');
    const holds = U.store.holds;
    const ready = holds.filter((h) => h.ready).length;
    $('holdsLede').textContent = `${plural(holds.length, 'hold')} worth ${money(holds.reduce((a, h) => a + h.amount, 0))}. ` +
      (ready ? `${plural(ready, 'parcel')} can be uploaded now: tick them, then upload. Select a row for its full story.` : 'Every shipped parcel already has its tracking in PayPal. Select a row for its full story.');
  }
  $('btnUploadSelected').addEventListener('click', async () => {
    $('btnUploadSelected').disabled = true;
    await U.confirmAndUpload(U.grids.holds.getSelectedRows(), 'holdsStatus');
    updateHoldBar();
  });
  $('btnExportHolds').addEventListener('click', () => U.grids.holds && U.grids.holds.exportDataAsCsv({ fileName: 'unhold-holds.csv' }));

  U.setHoldFilter = function setHoldFilter(kind) {
    document.querySelectorAll('[data-hold-filter]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.holdFilter === kind)));
    const g = U.grids.holds;
    if (!g) return;
    const values = { ready: ['seller_has'], not_shipped: ['not_shipped'], in_paypal: ['in_paypal'] }[kind];
    const model = { ...(g.getFilterModel() || {}) };
    if (values) model.status = { filterType: 'set', values }; else delete model.status;
    g.setFilterModel(Object.keys(model).length ? model : null);
  };
  document.querySelectorAll('[data-hold-filter]').forEach((b) => b.addEventListener('click', () => U.setHoldFilter(b.dataset.holdFilter)));

  async function holdsAsk() {
    const q = $('askInput').value.trim();
    const g = U.grids.holds;
    if (!q || !g) return;
    $('btnAsk').disabled = true;
    U.setStatus('holdsStatus', 'Working out the filters…');
    try {
      const values = (field) => [...new Set(U.store.holds.map((r) => r[field]).filter(Boolean))].slice(0, 12);
      const columns = [
        { field: 'id', headerName: 'Hold', type: 'text' }, { field: 'order_id', headerName: 'Order', type: 'text' }, { field: 'buyer', headerName: 'Buyer', type: 'text' },
        { field: 'item', headerName: 'Item', type: 'text' }, { field: 'amount', headerName: 'Amount (USD)', type: 'number' },
        { field: 'code', headerName: 'PayPal code', type: 'set', values: values('code') },
        { field: 'status', headerName: 'State (in_paypal=tracking in PayPal, seller_has=ready to upload, not_shipped, reserve, unapproved)', type: 'set', values: values('status') },
        { field: 'carrier', headerName: 'Carrier', type: 'set', values: values('carrier') },
        { field: 'delivered_at', headerName: 'Delivered date', type: 'date' }, { field: 'exp_at', headerName: 'PayPal release date', type: 'date' },
        { field: 'conf', headerName: 'Confidence', type: 'set', values: values('conf') }
      ];
      const r = await U.post('/api/ai/grid-query', { question: q, columns });
      g.setFilterModel(Object.keys(r.filterModel).length ? r.filterModel : null);
      g.setRowGroupColumns(r.rowGroup);
      g.applyColumnState({ defaultState: { sort: null }, state: r.sort.map((s, i) => ({ colId: s.colId, sort: s.sort, sortIndex: i })) });
      document.querySelectorAll('[data-hold-filter]').forEach((b) => b.setAttribute('aria-pressed', 'false'));
      U.setStatus('holdsStatus', `${r.explanation} Showing ${g.getDisplayedRowCount()} rows.`, 'good');
    } catch (e) {
      U.setStatus('holdsStatus', `The question could not be turned into filters. ${e.message}`, 'bad');
    } finally { $('btnAsk').disabled = false; }
  }
  $('btnAsk').addEventListener('click', holdsAsk);
  $('askInput').addEventListener('keydown', (e) => e.key === 'Enter' && holdsAsk());
  $('btnClearFilters').addEventListener('click', () => {
    const g = U.grids.holds;
    if (!g) return;
    g.setFilterModel(null); g.setRowGroupColumns([]); g.setGridOption('quickFilterText', ''); g.applyColumnState({ defaultState: { sort: null } });
    $('askInput').value = '';
    U.setHoldFilter('all');
    U.setStatus('holdsStatus', '');
    updateHoldBar();
  });

  async function ledgerSearch() {
    const q = $('searchInput').value.trim();
    if (!q) return;
    $('btnSearch').disabled = true;
    U.setStatus('holdsStatus', 'Searching…');
    try {
      const r = await U.api('/api/search?q=' + encodeURIComponent(q));
      $('searchPanel').hidden = false;
      const g = U.makeGrid('search', $('gridSearch'), {
        columnDefs: [
          { field: 'kind', headerName: 'Type', width: 110, cellRenderer: (p) => U.status(p.value, p.value === 'hold' ? 'info' : '') },
          { field: 'title', headerName: 'Match', flex: 1, minWidth: 260 },
          { field: 'ref', headerName: 'Reference', width: 190 },
          { field: 'status', headerName: 'State', width: 160, valueFormatter: (p) => STATE_LABEL[p.value] || p.value },
          { field: 'amount', headerName: 'Amount', width: 110, type: 'rightAligned', valueFormatter: (p) => (p.value == null ? '' : money(p.value)) },
          { field: 'score', headerName: 'Relevance', width: 110, sort: 'desc', valueFormatter: (p) => (p.value == null ? '' : Number(p.value).toFixed(2)) }
        ],
        defaultColDef: { sortable: true, resizable: true }, rowData: r.hits, overlayNoRowsTemplate: 'Nothing matches. Try other words.',
        onRowClicked: (e) => {
          if (e.data.kind !== 'hold' || !U.grids.holds) return;
          U.grids.holds.setGridOption('quickFilterText', e.data.ref);
          U.setStatus('holdsStatus', `Showing ${e.data.ref} in the table below. “Clear filters” brings every hold back.`, 'good');
        }
      });
      g.setGridOption('rowData', r.hits);
      $('searchTitle').textContent = `${plural(r.total, 'result')} for “${q}” · select a hold to find it in the table`;
      U.setStatus('holdsStatus', '');
    } catch (e) {
      U.setStatus('holdsStatus', `Search did not answer. ${e.message}`, 'bad');
    } finally { $('btnSearch').disabled = false; }
  }
  $('btnSearch').addEventListener('click', ledgerSearch);
  $('searchInput').addEventListener('keydown', (e) => e.key === 'Enter' && ledgerSearch());
  $('btnCloseSearch').addEventListener('click', () => { $('searchPanel').hidden = true; });

  async function checkCarrier(row, button) {
    button.disabled = true;
    const label = button.textContent;
    button.textContent = 'Checking…';
    try {
      const r = await U.post(`/api/holds/${encodeURIComponent(row.id)}/carrier-check`, {});
      const text = `Carrier says ${row.tracking_number} is ${String(r.status).replace(/_/g, ' ')}${r.delivered_at ? ' since ' + day(r.delivered_at) : ''}.`;
      U.setStatus('holdsStatus', text, r.status === 'delivered' ? 'good' : '');
      U.toast(text, r.status === 'delivered' ? 'good' : '');
      if (U.refreshAudit) U.refreshAudit();
    } catch (e) {
      U.toast(`The carrier page could not be read. ${e.message}`, 'bad');
    } finally { button.disabled = false; button.textContent = label; }
  }

  // ================= Match tracking =================
  const MATCH_STATE = { ready: ['Ready', 'info'], review: ['Needs your review', 'warn'], done: ['Already in PayPal', 'good'], none: ['No order found', 'bad'] };
  U.screens.matcher = async function loadMatcher() {
    U.busy('matcher', true);
    U.setStatus('matcherStatus', 'Matching parcels to orders…');
    const [data] = await Promise.all([U.post('/api/manifests/match', {}), U.fetchHolds()]);
    const rows = (data.matches || []).map((m) => {
      const h = U.store.byOrder.get(m.matched_order_id);
      const done = Boolean(h && (h.uploaded || h.status === 'in_paypal'));
      const state = !m.matched_order_id ? 'none' : done ? 'done' : m.confidence < 0.8 || m.decision !== 'auto' ? 'review' : 'ready';
      return { ...m, order_id: m.matched_order_id, amount: m.hold_amount, state, buyer: h ? h.buyer : '', item: h ? h.item : '', paypal_order: h ? h.paypal_order : 'unknown' };
    });
    const g = U.makeGrid('matcher', $('gridMatcher'), {
      columnDefs: [
        { field: 'state', headerName: 'Status', width: 180, filter: 'agSetColumnFilter', valueFormatter: (p) => (MATCH_STATE[p.value] || [p.value])[0], cellRenderer: (p) => U.status(...(MATCH_STATE[p.value] || [p.value])) },
        { field: 'confidence', headerName: 'Confidence', width: 135, type: 'rightAligned', valueFormatter: (p) => `${Math.round((p.value || 0) * 100)}%`, cellClass: 'tnum' },
        { field: 'buyer', headerName: 'Buyer', width: 130 },
        { field: 'item', headerName: 'Item', width: 170 },
        { field: 'amount', headerName: 'Amount', width: 110, type: 'rightAligned', valueFormatter: (p) => money(p.value), aggFunc: 'sum', cellClass: 'tnum' },
        { field: 'days_sooner', headerName: 'Releases sooner', width: 140, valueFormatter: (p) => (p.value ? `${p.value} days` : '—') },
        { field: 'tracking_number', headerName: 'Tracking number', width: 165 },
        { field: 'carrier', headerName: 'Carrier', width: 100, filter: 'agSetColumnFilter' },
        { field: 'match_method', headerName: 'Matched by', width: 150, filter: 'agSetColumnFilter', valueFormatter: (p) => ({ id: 'Order ID', rule: 'Name and address', ai: 'Similar text', ask: 'Not sure' }[p.value] || p.value) },
        { field: 'match_reason', headerName: 'Why this order', flex: 1, minWidth: 260, wrapText: true, autoHeight: true },
        { field: 'paypal_order', headerName: 'PayPal order', width: 130, valueFormatter: (p) => ORDER_LABEL[p.value] || '', cellRenderer: (p) => (ORDER_LABEL[p.value] ? U.status(ORDER_LABEL[p.value], p.value === 'real' ? 'good' : '') : '') },
        { field: 'order_id', headerName: 'Order ID', width: 175 }
      ],
      defaultColDef: { sortable: true, resizable: true, filter: true },
      rowData: rows, getRowId: (p) => p.data.tracking_number,
      rowSelection: { mode: 'multiRow', isRowSelectable: (n) => Boolean(n.data && (n.data.state === 'ready' || n.data.state === 'review')), hideDisabledCheckboxes: true, selectAll: 'filtered', enableClickSelection: false },
      selectionColumnDef: { pinned: 'left', width: 48 },
      onSelectionChanged: updateMatcherBar,
      overlayNoRowsTemplate: 'No carrier parcels yet. Zapier adds them when a carrier export arrives.',
      statusBar: { statusPanels: [{ statusPanel: 'agTotalAndFilteredRowCountComponent' }, { statusPanel: 'agSelectedRowCountComponent' }, { statusPanel: 'agAggregationComponent', statusPanelParams: { aggFuncs: ['sum'] } }] }
    });
    g.setGridOption('rowData', rows);
    g.forEachNode((n) => n.setSelected(n.data.state === 'ready'));
    U.busy('matcher', false);
    const n = (s) => rows.filter((r) => r.state === s).length;
    U.setStatus('matcherStatus', [`${n('ready')} ready`, `${n('review')} need your review`, `${n('done')} already in PayPal`, n('none') ? `${n('none')} with no order` : ''].filter(Boolean).join(' · '));
    U.setCount('matcher', n('review'), true);
    updateMatcherBar();
  };
  function updateMatcherBar() {
    const rows = U.grids.matcher ? U.grids.matcher.getSelectedRows() : [];
    const b = $('btnUploadApproved');
    b.disabled = rows.length === 0;
    b.textContent = rows.length ? `Upload tracking for ${plural(rows.length, 'parcel')} · ${money(rows.reduce((a, r) => a + r.amount, 0))}` : 'Upload tracking';
  }
  $('btnRunMatcher').addEventListener('click', () => U.runView('matcher'));
  $('btnUploadApproved').addEventListener('click', async () => {
    $('btnUploadApproved').disabled = true;
    const did = await U.confirmAndUpload(U.grids.matcher.getSelectedRows(), 'matcherStatus');
    if (did) { const keep = $('matcherStatus').textContent, kind = $('matcherStatus').className; await U.screens.matcher().catch(() => undefined); $('matcherStatus').textContent = keep; $('matcherStatus').className = kind; }
    updateMatcherBar();
  });

  // ================= Running the agent (toolbar shared by Approvals and Agent runs) =================
  const MODE_HINT = {
    live: 'Only parcels whose order exists in your PayPal account are proposed. Most holds here are demo data, so this mode may find nothing to propose.',
    simulated: 'Uses the demo holds. An approved plan is recorded in the ledger and marked simulated. PayPal is not called.'
  };
  U.agentMode = 'live';
  const toolbars = [];
  function buildRunToolbar(host) {
    const select = el('select', { 'aria-label': 'What the agent may touch' }, el('option', { value: 'live', textContent: 'Real PayPal orders only' }), el('option', { value: 'simulated', textContent: 'Demo data (no PayPal call)' }));
    const run = el('button', { className: 'btn primary', textContent: 'Run the agent' });
    const brief = el('button', { className: 'btn', textContent: 'Write morning brief' });
    const status = el('span', { className: 'status', 'aria-live': 'polite' });
    const hint = el('p', { className: 'note', textContent: MODE_HINT[U.agentMode] });
    select.value = U.agentMode;
    const t = { select, run, brief, status, hint };
    select.addEventListener('change', () => { U.agentMode = select.value; toolbars.forEach((x) => { x.select.value = U.agentMode; x.hint.textContent = MODE_HINT[U.agentMode]; }); });
    run.addEventListener('click', () => startAgent('unhold'));
    brief.addEventListener('click', () => startAgent('morning_brief'));
    host.replaceChildren(el('div', { className: 'card card-pad' },
      el('div', { className: 'bar' }, el('label', { className: 'field', style: 'min-width:260px' }, el('span', { textContent: 'What the agent may touch' }), select), run, brief, status), hint));
    toolbars.push(t);
    return t;
  }
  const setToolbars = (fn) => toolbars.forEach(fn);
  async function startAgent(goal) {
    setToolbars((t) => { t.run.disabled = t.brief.disabled = true; t.status.textContent = goal === 'unhold' ? 'The agent team is starting…' : 'Writing the morning brief…'; t.status.className = 'status'; });
    try {
      const r = await U.post('/api/agent/runs', { goal, mode: U.agentMode });
      await refreshAgents();
      U.focusRun = r.run_id;
      U.toast(goal === 'unhold' ? 'The agent is working. A plan appears under Plans when it is ready.' : 'The morning brief is being written.', 'good');
    } catch (e) {
      setToolbars((t) => { t.run.disabled = t.brief.disabled = false; t.status.textContent = `The run did not start. ${e.message}`; t.status.className = 'status bad'; });
    }
  }
  function syncToolbars(runs) {
    const active = runs.find((r) => r.status === 'running' || r.status === 'awaiting_approval');
    setToolbars((t) => {
      t.run.disabled = t.brief.disabled = Boolean(active);
      if (active) { t.status.textContent = active.status === 'running' ? 'A run is in progress.' : 'A plan is waiting for your decision. Decide it to start another run.'; t.status.className = 'status'; }
      else if (/in progress|waiting for your decision|starting/.test(t.status.textContent)) t.status.textContent = '';
    });
  }

  // ================= Approvals (split pane) =================
  const PLAN_STATE = { pending: ['Waiting for you', 'warn'], approved: ['Approved', 'good'], rejected: ['Rejected', ''] };
  let selectedPlan = null;
  const planParcelColumns = [
    { field: 'part', headerName: 'In the plan', width: 120, cellRenderer: (p) => U.status(p.value, p.value === 'Upload' ? 'info' : '') },
    { field: 'order_id', headerName: 'Order ID', width: 170 },
    { field: 'tracking_number', headerName: 'Tracking number', width: 150 },
    { field: 'carrier', headerName: 'Carrier', width: 80 },
    { field: 'amount', headerName: 'Amount', width: 100, type: 'rightAligned', valueFormatter: (p) => (p.value == null ? '' : money(p.value)), cellClass: 'tnum' },
    { field: 'confidence', headerName: 'Match', width: 85, type: 'rightAligned', valueFormatter: (p) => (p.value == null ? '' : `${Math.round(p.value * 100)}%`), cellClass: 'tnum' },
    { field: 'days_sooner', headerName: 'Sooner by', width: 100, valueFormatter: (p) => (p.value ? `${p.value} days` : '') },
    { field: 'reason', headerName: 'Note', flex: 1, minWidth: 200, wrapText: true, autoHeight: true }
  ];
  let planParcelGrid = null;

  async function decide(a, decision) {
    const approving = decision === 'approved';
    const answer = await U.askDialog({
      title: approving ? `Approve uploading tracking for ${plural(a.orders, 'parcel')}?` : `Reject the plan for ${plural(a.orders, 'parcel')}?`,
      lines: approving && a.summary ? [a.summary] : [],
      list: approving
        ? [[el('b', { textContent: money(a.total_usd) }), ' of held money is affected.'], a.mode === 'simulated' ? 'Demo data: the upload is recorded in the ledger only. PayPal is not called.' : 'The agent uploads to PayPal straight away, then reads each order back to confirm it.']
        : ['The run ends and nothing is uploaded.', 'You can run the agent again at any time.'],
      confirmLabel: approving ? 'Approve plan' : 'Reject plan', danger: !approving
    });
    if (!answer.ok) return;
    try {
      const r = await U.post(`/api/agent/approvals/${encodeURIComponent(a.id)}/decision`, { decision, by: U.actor() });
      if (r.ok) U.toast(approving ? 'Plan approved. The agent is uploading now.' : 'Plan rejected. Nothing was uploaded.', 'good');
      else U.toast(r.reason || 'That request was already decided.', 'bad');
    } catch (e) { U.toast(`The decision was not saved. ${e.message}`, 'bad'); }
    await Promise.allSettled([refreshApprovals(), U.refreshCounts()]);
  }

  async function showPlan(a) {
    selectedPlan = a ? a.id : null;
    const host = $('planDetail');
    if (planParcelGrid && !planParcelGrid.isDestroyed()) planParcelGrid.destroy();
    planParcelGrid = null;
    if (!a) {
      host.replaceChildren(el('div', { className: 'empty' }, el('div', null, el('b', { textContent: 'Nothing is waiting for you' }), 'Run the agent to get a new plan, or pick a past plan on the left.')));
      return;
    }
    const [label, kind] = PLAN_STATE[a.status] || [a.status, ''];
    const gridHost = el('div', { className: 'grid', style: 'height:340px' });
    const head = el('div', { className: 'detail' },
      el('div', { className: 'bar' }, el('h2', { textContent: a.title }), U.status(label, kind)),
      el('div', { className: 'meta' },
        el('span', null, 'Money affected ', el('b', { textContent: money(a.total_usd) })),
        el('span', null, 'Parcels ', el('b', { textContent: String(a.orders) })),
        el('span', null, 'Data ', el('b', { textContent: a.mode === 'simulated' ? 'Demo' : 'Real orders' })),
        el('span', null, a.status === 'pending' ? `Asked ${when(a.requested_at)}` : `${PLAN_STATE[a.status] ? PLAN_STATE[a.status][0] : a.status} ${when(a.decided_at)}${a.decided_by ? ' by ' + a.decided_by : ''}`)),
      a.summary ? el('p', { textContent: a.summary }) : null,
      el('h3', { className: 'eyebrow', style: 'margin:4px 0 0', textContent: 'Every parcel in the plan, and what was left out' }),
      gridHost);
    const bar = el('div', { className: 'actionbar', style: 'margin:0 var(--s4) var(--s4)' });
    if (a.status === 'pending') {
      bar.append(U.btn('Approve plan', () => decide(a, 'approved'), 'btn primary'), U.btn('Reject plan', () => decide(a, 'rejected'), 'btn'), el('span', { className: 'status', textContent: 'Nothing is uploaded until you decide.' }));
    } else bar.append(el('span', { className: 'status', textContent: `${label}${a.decided_by ? ' by ' + a.decided_by : ''}. This plan can no longer be changed.` }));
    bar.append(U.btn('See the agent’s steps', () => { U.focusRun = a.run_id; U.go('agents'); }, 'btn quiet small'));
    host.replaceChildren(head, bar);
    planParcelGrid = U.miniGrid(gridHost, { columnDefs: planParcelColumns, rowData: [], domLayout: 'normal', overlayNoRowsTemplate: 'The plan has no parcels' });
    try {
      const { run } = await U.api(`/api/agent/runs/${encodeURIComponent(a.run_id)}`);
      const plan = (run.plan && run.plan.plan) || {};
      if (selectedPlan === a.id && planParcelGrid && !planParcelGrid.isDestroyed()) {
        planParcelGrid.setGridOption('rowData', [...(plan.items || []).map((i) => ({ ...i, part: 'Upload' })), ...(plan.excluded || []).map((x) => ({ ...x, part: 'Left out' }))]);
      }
    } catch { /* the plan header is still useful without the parcel list */ }
  }

  async function refreshApprovals() {
    const [runs, approvals] = await Promise.all([U.api('/api/agent/runs'), U.api('/api/agent/approvals')]);
    U.store.runs = runs.runs;
    U.store.approvals = approvals.approvals;
    U.setCount('approvals', U.pendingApprovals().length, true);
    U.renderApprovalAlert();
    const rows = approvals.approvals.slice().sort((a, b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1) || Date.parse(b.requested_at) - Date.parse(a.requested_at));
    const g = U.grids.plans;
    g.setGridOption('rowData', rows);
    syncToolbars(runs.runs);
    // A plan that was not there at the last refresh and is waiting for a decision takes over the detail pane.
    const firstLoad = !U.store.seenPlans;
    const fresh = firstLoad ? null : rows.find((r) => r.status === 'pending' && !U.store.seenPlans.has(r.id));
    U.store.seenPlans = new Set(rows.map((r) => r.id));
    const keep = rows.find((r) => r.id === selectedPlan);
    const target = fresh || keep || rows[0] || null;
    if (target) g.forEachNode((n) => n.data.id === target.id && n.setSelected(true));
    if (fresh || !keep || JSON.stringify(keep) !== JSON.stringify(U.store.shownPlan)) { U.store.shownPlan = target; await showPlan(target); }
  }

  U.screens.approvals = async function loadApprovals() {
    if (!$('runToolbarA').childElementCount) buildRunToolbar($('runToolbarA'));
    U.makeGrid('plans', $('gridPlans'), {
      defaultColDef: U.PLAIN,
      columnDefs: [
        { field: 'title', headerName: 'Plan', flex: 1, minWidth: 200, autoHeight: true, cellRenderer: (p) => U.twoLine(p.value, `${money(p.data.total_usd)} · ${plural(p.data.orders, 'parcel')} · ${p.data.mode === 'simulated' ? 'demo' : 'real'} · ${when(p.data.requested_at)}`) },
        { field: 'status', headerName: 'Status', width: 140, cellRenderer: (p) => U.status(...(PLAN_STATE[p.value] || [p.value])) }
      ],
      getRowId: (p) => p.data.id, rowData: [], rowSelection: { mode: 'singleRow', checkboxes: false, enableClickSelection: true },
      onRowClicked: (e) => { U.store.shownPlan = e.data; showPlan(e.data); },
      overlayNoRowsTemplate: 'No plans yet. Run the agent to create one.'
    });
    await refreshApprovals();
  };

  // ================= Agent runs =================
  const RUN_STATE = { completed: ['Completed', 'good'], running: ['Running', 'info'], awaiting_approval: ['Waiting for you', 'warn'], failed: ['Failed', 'bad'], rejected: ['Rejected', ''] };
  const TEAM = [
    { id: 'supervisor', name: 'Supervisor', job: 'Runs the loop: look, reason, plan, ask a person, act, verify, learn' },
    { id: 'cash_flow', name: 'Cash-flow', job: 'Finds matched parcels, builds the upload plan, uploads tracking' },
    { id: 'payment_guard', name: 'Payment Guard', job: 'Confirms each order is real on PayPal and checks prices against the catalog' },
    { id: 'buyer_assurance', name: 'Buyer Assurance', job: 'Scans disputes and removes instructions hidden in buyer messages' }
  ];
  let teamRunId = null;

  function makeAgentGrids() {
    U.makeGrid('team', $('gridTeam'), {
      defaultColDef: U.PLAIN, domLayout: 'autoHeight', suppressCellFocus: true, getRowId: (p) => p.data.id,
      columnDefs: [
        { field: 'name', headerName: 'Agent', width: 160, cellStyle: { fontWeight: 550 } },
        { field: 'job', headerName: 'Job', flex: 1.4, minWidth: 280, wrapText: true, autoHeight: true },
        { field: 'steps', headerName: 'Steps in last run', width: 150, type: 'rightAligned' },
        { field: 'last', headerName: 'Last thing it did', flex: 1.6, minWidth: 280, wrapText: true, autoHeight: true },
        { field: 'ok', headerName: 'Result', width: 110, cellRenderer: (p) => (p.value == null ? '' : U.status(p.value ? 'OK' : 'Failed', p.value ? 'good' : 'bad')) }
      ],
      rowData: TEAM.map((t) => ({ ...t, steps: 0, last: 'No run yet', ok: null }))
    });
    U.makeGrid('runs', $('gridRuns'), {
      columnDefs: [
        { field: 'started_at', headerName: 'Started', width: 190, cellRenderer: 'agGroupCellRenderer', valueFormatter: (p) => when(p.value), sort: 'desc' },
        { field: 'status', headerName: 'Status', width: 160, cellRenderer: (p) => U.status(...(RUN_STATE[p.value] || [String(p.value).replace(/_/g, ' ')])) },
        { field: 'goal', headerName: 'Task', width: 140, valueFormatter: (p) => ({ unhold: 'Release holds', morning_brief: 'Morning brief' }[p.value] || p.value) },
        { field: 'mode', headerName: 'Data', width: 120, valueFormatter: (p) => (p.value === 'simulated' ? 'Demo data' : 'Real orders') },
        { field: 'trigger', headerName: 'Started by', width: 120 },
        { field: 'summary', headerName: 'Outcome', flex: 1, minWidth: 320, wrapText: true, autoHeight: true, valueGetter: (p) => p.data.error || p.data.summary }
      ],
      defaultColDef: { sortable: true, resizable: true, suppressHeaderMenuButton: true },
      getRowId: (p) => p.data.id, rowData: [], masterDetail: true, detailRowAutoHeight: true, overlayNoRowsTemplate: 'No runs yet. Run the agent to see its work here.',
      detailCellRendererParams: {
        detailGridOptions: {
          theme: U.gridTheme(), domLayout: 'autoHeight', defaultColDef: U.PLAIN,
          columnDefs: [
            { field: 'seq', headerName: '#', width: 60 },
            { field: 'agent', headerName: 'Agent', width: 150, valueFormatter: (p) => (TEAM.find((t) => t.id === p.value) || { name: p.value }).name },
            { field: 'stage', headerName: 'Stage', width: 110, cellRenderer: (p) => U.status(p.value, { perceive: 'info', reason: 'warn', plan: 'info', ask: 'warn', act: 'good', verify: 'good' }[p.value] || '') },
            { field: 'tool', headerName: 'Tool', width: 200 },
            { field: 'ok', headerName: 'Result', width: 100, cellRenderer: (p) => U.status(p.value ? 'OK' : 'Failed', p.value ? 'good' : 'bad') },
            { field: 'ms', headerName: 'Time', width: 90, type: 'rightAligned', valueFormatter: (p) => `${p.value} ms` },
            { field: 'note', headerName: 'What happened', flex: 1, minWidth: 280, wrapText: true, autoHeight: true, tooltipValueGetter: (p) => (p.data.output ? JSON.stringify(p.data.output).slice(0, 600) : '') }
          ]
        },
        getDetailRowData: async (p) => { try { p.successCallback((await U.api(`/api/agent/runs/${encodeURIComponent(p.data.id)}`)).steps); } catch { p.successCallback([]); } }
      }
    });
  }
  async function refreshTeam(run) {
    if (!run) return;
    if (teamRunId === run.id && run.status !== 'running') return;
    teamRunId = run.id;
    const { steps } = await U.api(`/api/agent/runs/${encodeURIComponent(run.id)}`);
    U.grids.team.setGridOption('rowData', TEAM.map((t) => {
      const mine = steps.filter((s) => s.agent === t.id);
      const last = mine[mine.length - 1];
      return { ...t, steps: mine.length, last: last ? last.note || last.tool : 'Not needed in the last run', ok: last ? last.ok : null };
    }));
  }
  async function refreshAgents() {
    const runs = await U.api('/api/agent/runs');
    U.store.runs = runs.runs;
    syncToolbars(runs.runs);
    if (U.grids.runs) {
      U.grids.runs.setGridOption('rowData', runs.runs);
      if (U.focusRun) { const id = U.focusRun; U.grids.runs.forEachNode((n) => n.data.id === id && n.setExpanded(true)); U.focusRun = null; }
      const newest = runs.runs.slice().sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at))[0];
      await refreshTeam(newest).catch(() => undefined);
    }
    const approvals = await U.api('/api/agent/approvals').catch(() => null);
    if (approvals) { U.store.approvals = approvals.approvals; U.refreshCounts(); }
  }
  U.screens.agents = async function loadAgents() {
    if (!$('runToolbarB').childElementCount) buildRunToolbar($('runToolbarB'));
    makeAgentGrids();
    await refreshAgents();
  };

  // One light poll keeps runs and plans current while either screen is open.
  setInterval(() => {
    if (document.hidden) return;
    if (U.currentTab === 'agents') refreshAgents().catch(() => undefined);
    if (U.currentTab === 'approvals' && U.grids.plans) refreshApprovals().catch(() => undefined);
  }, 3000);
})();
