// Core of the cockpit: helpers, API client, theme (page, AG Grid, AG Charts), dialogs, toasts and the grid factory.
// Every screen file adds itself to the shared namespace `U`.
(function () {
  'use strict';
  const U = (window.U = window.U || {});
  U.DAY = 86400000;

  // ---------- formatting and DOM ----------
  U.money = (v) => '$' + Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  U.day = (iso) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—');
  U.when = (iso) => (iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');
  U.plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + 's'}`;
  U.$ = (id) => document.getElementById(id);
  U.icon = (name, size) => window.icon(name, size);
  /** Create an element. Text goes in as text, so ledger content can never be read as HTML. */
  U.el = (tag, props, ...kids) => {
    const node = Object.assign(document.createElement(tag), props || {});
    for (const k of kids) if (k != null && k !== false) node.append(k);
    return node;
  };
  U.html = (node, name, size) => { node.insertAdjacentHTML('afterbegin', U.icon(name, size)); return node; };
  /** Status as a coloured dot and text. Reserved for state that changes (ready, waiting, failed, healthy). */
  U.status = (text, kind) => U.el('span', { className: 'st' + (kind ? ' ' + kind : ''), textContent: String(text ?? '') });
  U.btn = (label, onClick, cls = 'btn small') => {
    const b = U.el('button', { className: cls, textContent: label });
    b.addEventListener('click', onClick);
    return b;
  };
  /** A row action: accent text and an arrow, no box at rest. */
  U.linkBtn = (label, onClick) => {
    const b = U.el('button', { className: 'btn ghost small' }, label);
    b.insertAdjacentHTML('beforeend', U.icon('chevron-right', 14));
    b.addEventListener('click', onClick);
    return b;
  };
  U.setStatus = (id, text, kind) => {
    const node = U.$(id);
    node.textContent = text || '';
    node.className = 'status' + (kind ? ' ' + kind : '');
  };
  U.toast = (text, kind) => {
    const t = U.el('div', { className: 'toast' + (kind ? ' ' + kind : '') });
    t.insertAdjacentHTML('beforeend', U.icon(kind === 'bad' ? 'circle-alert' : 'circle-check', 18));
    t.append(U.el('span', { textContent: text }));
    U.$('toasts').append(t);
    setTimeout(() => t.remove(), kind === 'bad' ? 10000 : 6000);
  };
  U.remember = (key, value) => { try { value == null ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch { /* storage blocked: keep it for this page only */ } };
  U.recall = (key) => { try { return localStorage.getItem(key) || ''; } catch { return ''; } };

  // ---------- dialog (confirmations and the access code) ----------
  // Each call settles exactly once, from its own button clicks, Escape or Enter. It never reads the dialog's close
  // event, so a late event from an earlier dialog can never confirm a later one.
  let settleOpen = null;
  U.askDialog = function askDialog({ title, lines = [], list = [], confirmLabel, danger = false, check, input }) {
    const dlg = U.$('confirmDialog');
    if (settleOpen) settleOpen(false); // a dialog still showing is cancelled before the next one opens
    U.$('confirmTitle').textContent = title;
    const body = U.$('confirmBody');
    body.replaceChildren(...lines.map((t) => U.el('p', { textContent: t })));
    if (list.length) body.append(U.el('ul', null, ...list.map((item) => U.el('li', null, ...(Array.isArray(item) ? item : [item])))));
    U.$('confirmCheckWrap').hidden = !check;
    U.$('confirmCheck').checked = Boolean(check && check.checked);
    U.$('confirmCheckText').textContent = check ? check.label : '';
    U.$('confirmInputWrap').hidden = !input;
    U.$('confirmInputLabel').textContent = input || '';
    U.$('confirmInput').value = '';
    const ok = U.$('confirmOk');
    const cancel = U.$('confirmCancel');
    ok.textContent = confirmLabel;
    ok.className = 'btn ' + (danger ? 'danger' : 'primary');
    const opener = document.activeElement;
    return new Promise((resolve) => {
      let done = false;
      const finish = (accepted) => {
        if (done) return;
        done = true;
        settleOpen = null;
        ok.removeEventListener('click', onOk);
        cancel.removeEventListener('click', onCancel);
        dlg.removeEventListener('cancel', onEsc);
        dlg.removeEventListener('keydown', onKey);
        const result = { ok: accepted, checked: U.$('confirmCheck').checked, value: U.$('confirmInput').value.trim() };
        if (dlg.open) dlg.close(accepted ? 'ok' : 'cancel');
        resolve(result);
        if (opener && opener.focus && document.contains(opener)) opener.focus();
      };
      const onOk = (e) => { e.preventDefault(); finish(true); };
      const onCancel = (e) => { e.preventDefault(); finish(false); };
      const onEsc = (e) => { e.preventDefault(); finish(false); };
      const onKey = (e) => { if (e.key === 'Enter' && e.target === U.$('confirmInput')) { e.preventDefault(); finish(true); } };
      ok.addEventListener('click', onOk);
      cancel.addEventListener('click', onCancel);
      dlg.addEventListener('cancel', onEsc);
      dlg.addEventListener('keydown', onKey);
      settleOpen = finish;
      dlg.showModal();
      (input ? U.$('confirmInput') : cancel).focus();
    });
  };

  // ---------- API ----------
  let accessCode = '';
  try { accessCode = sessionStorage.getItem('unhold.access') || ''; } catch { /* storage blocked: ask each time */ }
  U.api = async function api(path, opts = {}, retried = false) {
    const headers = { ...(opts.headers || {}) };
    if (accessCode) headers['x-unhold-access'] = accessCode;
    let res;
    try { res = await fetch(path, { ...opts, headers }); } catch { throw new Error('The server could not be reached. Check the connection, then try again.'); }
    const body = await res.json().catch(() => ({}));
    if (res.status === 401 && body.error === 'access_code_required') {
      accessCode = '';
      if (retried) throw new Error('That access code was not accepted. Try the action again to re-enter it.');
      const r = await U.askDialog({ title: 'Enter the access code', lines: ['Changes on this deployment need the cockpit access code. Viewing stays open to everyone.'], input: 'Access code', confirmLabel: 'Continue' });
      if (!r.ok || !r.value) throw new Error('Nothing was changed: the access code is needed for this action.');
      accessCode = r.value;
      try { sessionStorage.setItem('unhold.access', accessCode); } catch { /* keep it in memory only */ }
      return U.api(path, opts, true);
    }
    if (!res.ok) throw new Error(body.message || body.error || `The server answered with an error (${res.status}).`);
    return body;
  };
  U.post = (path, payload) => U.api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}) });

  // ---------- theme: page, AG Grid and AG Charts follow one setting (system, light or dark) ----------
  U.themeMode = ['light', 'dark'].includes(U.recall('unhold.theme')) ? U.recall('unhold.theme') : 'system';
  U.isDark = () => (U.themeMode === 'system' ? matchMedia('(prefers-color-scheme: dark)').matches : U.themeMode === 'dark');
  const FONT = '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  const PALETTE = {
    light: { card: '#ffffff', fg: '#1a2433', muted: '#566578', line: '#e3e8ef', head: '#f6f8fb', hover: '#f6f7fd', sel: 'rgba(91,82,240,.09)', accent: '#5b52f0', second: '#0e9f6e', chrome: '#f6f8fb' },
    dark: { card: '#111a2c', fg: '#e6ecf5', muted: '#9aa8be', line: '#24324c', head: '#0e1626', hover: '#15213a', sel: 'rgba(138,130,255,.16)', accent: '#6a62ff', second: '#46c47a', chrome: '#0e1626' }
  };
  const gridParams = (p) => ({
    backgroundColor: p.card, foregroundColor: p.fg, borderColor: p.line, headerBackgroundColor: p.head, headerTextColor: p.muted, headerFontSize: 12, headerFontWeight: 500,
    oddRowBackgroundColor: p.card, rowHoverColor: p.hover, selectedRowBackgroundColor: p.sel, accentColor: p.accent, chromeBackgroundColor: p.chrome,
    fontFamily: FONT, fontSize: 13, spacing: 7, wrapperBorderRadius: 8, columnBorder: false, iconSize: 14
  });
  U.gridTheme = () => agGrid.themeQuartz.withParams(gridParams(PALETTE.light), 'light').withParams(gridParams(PALETTE.dark), 'dark');
  const chartTheme = (name, p, base) => ({
    baseTheme: base,
    palette: { fills: [p.accent, p.second, '#e0a23a', '#2a62d4'], strokes: [p.accent, p.second, '#e0a23a', '#2a62d4'] },
    overrides: {
      common: {
        background: { fill: p.card }, padding: { top: 12, right: 16, bottom: 8, left: 8 },
        legend: { item: { label: { color: p.fg, fontFamily: FONT, fontSize: 12 } } },
        axes: {
          category: { label: { color: p.muted, fontFamily: FONT, fontSize: 12 }, line: { stroke: p.line } },
          number: { label: { color: p.muted, fontFamily: FONT, fontSize: 12, formatter: (a) => '$' + Number(a.value).toLocaleString('en-US') }, gridLine: { style: [{ stroke: p.line }] } }
        }
      }
    }
  });
  U.customChartThemes = { unholdLight: chartTheme('light', PALETTE.light, 'ag-default'), unholdDark: chartTheme('dark', PALETTE.dark, 'ag-default-dark') };
  U.chartThemeName = () => (U.isDark() ? 'unholdDark' : 'unholdLight');

  U.applyTheme = function applyTheme() {
    const root = document.documentElement;
    if (U.themeMode === 'system') root.removeAttribute('data-theme'); else root.dataset.theme = U.themeMode;
    document.body.dataset.agThemeMode = U.isDark() ? 'dark' : 'light';
    const label = { system: 'System theme', light: 'Light theme', dark: 'Dark theme' }[U.themeMode];
    const b = U.$('btnTheme');
    b.replaceChildren();
    U.html(b, U.themeMode === 'dark' ? 'moon' : 'sun-medium');
    b.append(' ' + label);
    document.dispatchEvent(new CustomEvent('unhold:theme'));
  };
  U.cycleTheme = () => {
    U.themeMode = { system: 'light', light: 'dark', dark: 'system' }[U.themeMode];
    U.remember('unhold.theme', U.themeMode === 'system' ? null : U.themeMode);
    U.applyTheme();
  };
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (U.themeMode === 'system') U.applyTheme(); });

  // ---------- grids ----------
  U.grids = {};
  /** Static tables are not sorted or resized by hand, and carry no header menus. */
  U.PLAIN = { sortable: false, resizable: false, suppressHeaderMenuButton: true, suppressHeaderFilterButton: true };
  U.makeGrid = function makeGrid(key, host, options) {
    if (U.grids[key]) return U.grids[key];
    // responsive: [{ cols: [colId], min: px }] hides those columns while the grid is narrower than min.
    const { responsive = [], quiet = options.defaultColDef === U.PLAIN, ...rest } = options;
    if (quiet) host.classList.add('quiet');
    const fit = (e) => { const w = e.clientWidth || (e.api.getDisplayedCenterColumns && 0) || 0; if (w) for (const r of responsive) e.api.setColumnsVisible(r.cols, w >= r.min); };
    // Wrapped rows are measured before flex columns settle; measure again once the layout is final.
    let timer = null;
    const settle = (e) => { clearTimeout(timer); timer = setTimeout(() => { if (!e.api.isDestroyed()) e.api.resetRowHeights(); }, 80); };
    U.grids[key] = agGrid.createGrid(host, {
      theme: U.gridTheme(), animateRows: true, tooltipShowDelay: 300, headerHeight: 38,
      onFirstDataRendered: (e) => { fit({ api: e.api, clientWidth: host.clientWidth }); settle(e); },
      onGridSizeChanged: (e) => { fit(e); settle(e); },
      customChartThemes: U.customChartThemes, chartThemes: ['unholdLight', 'unholdDark'], ...rest
    });
    return U.grids[key];
  };
  U.busy = (key, on) => U.grids[key] && U.grids[key].setGridOption('loading', on);
  /** A small, throwaway grid inside a drawer or detail pane (destroyed and rebuilt each time). */
  U.miniGrid = (host, options) => {
    host.replaceChildren();
    host.classList.add('quiet');
    return agGrid.createGrid(host, { theme: U.gridTheme(), domLayout: 'autoHeight', suppressCellFocus: true, defaultColDef: U.PLAIN, tooltipShowDelay: 300, ...options });
  };
  U.twoLine = (title, detail) => {
    const box = U.el('div', { className: 'two-line' }, U.el('span', { className: 't', textContent: title, title }));
    if (detail) box.append(U.el('span', { className: 'd', textContent: detail }));
    return box;
  };
})();
