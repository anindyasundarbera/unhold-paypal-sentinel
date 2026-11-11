// Shell: roles, sidebar navigation, routing, counts, the approval banner and the slide-over drawer.
(function () {
  'use strict';
  const U = window.U;
  const { $, el, plural, money } = U;

  U.screens = {};
  U.store = { holds: [], byOrder: new Map(), summary: null, approvals: [], runs: [], disputes: [] };
  U.counts = {};
  U.currentTab = 'start';
  U.showAll = false;

  U.TABS = {
    home: { label: 'Home', icon: 'house' },
    cockpit: { label: 'Held money', icon: 'wallet' },
    holds: { label: 'Holds', icon: 'package' },
    matcher: { label: 'Match tracking', icon: 'git-compare' },
    approvals: { label: 'Approvals', icon: 'badge-check' },
    agents: { label: 'Agent runs', icon: 'bot' },
    timeline: { label: 'Release timeline', icon: 'calendar-range' },
    forecast: { label: 'Cash goal', icon: 'target' },
    guard: { label: 'Payment guard', icon: 'mail-check' },
    disputes: { label: 'Disputes', icon: 'scale' },
    audit: { label: 'Audit', icon: 'shield-check' },
    logs: { label: 'Logs', icon: 'scroll-text' },
    connections: { label: 'Connections', icon: 'plug' }
  };
  U.ALL_TABS = Object.keys(U.TABS);
  const GROUPS = [['Work', ['home', 'holds', 'matcher', 'approvals', 'disputes']], ['Insight', ['cockpit', 'forecast', 'timeline', 'guard']], ['System', ['agents', 'audit', 'logs', 'connections']]];

  // A role is a view of the same product: a home queue plus the screens that job uses. Not a permission.
  U.ROLE = {
    owner: { name: 'Owner', who: 'I run the shop and decide what gets sent to PayPal.', tabs: ['home', 'approvals', 'cockpit', 'forecast', 'timeline'],
      lede: 'What is held, what can release sooner, and the plans waiting for your decision.', empty: 'Nothing needs you right now.' },
    fulfilment: { name: 'Fulfilment', who: 'I ship orders and handle carrier tracking.', tabs: ['home', 'matcher', 'holds'],
      lede: 'Parcels whose tracking PayPal has not seen, and paid orders that still need to ship.', empty: 'No parcels are waiting. New ones appear when a carrier export arrives.' },
    support: { name: 'Support', who: 'I answer disputes and check payments before we ship.', tabs: ['home', 'disputes', 'guard'],
      lede: 'Disputes by reply date, and payments PayPal is still reviewing.', empty: 'No open disputes. Paste a “payment received” email into Payment guard before you ship.' },
    admin: { name: 'Admin', who: 'I keep the agents and connections running.', tabs: ['home', 'agents', 'audit', 'logs', 'connections'],
      lede: 'Failed runs, errors, disconnected services and the state of the audit chain.', empty: 'Nothing needs attention.' },
    tour: { name: 'Guided tour', who: 'I want to see the whole loop once, start to finish.', tabs: U.ALL_TABS,
      lede: 'Seven steps from held money to a verified upload. Each step says what is real and what is simulated.', empty: '' }
  };
  U.role = U.ROLE[U.recall('unhold.role')] ? U.recall('unhold.role') : '';
  U.userName = U.recall('unhold.name');
  U.actor = () => (U.userName ? `${U.userName} (cockpit)` : 'cockpit');
  U.setRole = (next) => { U.role = next; U.showAll = false; U.remember('unhold.role', next); };

  // ---------- navigation ----------
  const pageTitle = (tab) => (tab === 'start' ? 'Unhold' : tab === 'home' ? (U.role === 'tour' ? 'Guided tour' : `${U.ROLE[U.role].name} home`) : U.TABS[tab].label);

  function navItem(tab) {
    const t = U.TABS[tab];
    const c = U.counts[tab];
    const b = el('button', { className: 'navitem' });
    b.insertAdjacentHTML('afterbegin', U.icon(t.icon, 16));
    b.append(el('span', { className: 'label', textContent: t.label }));
    if (c && c.n) b.append(el('span', { className: 'count' + (c.attn ? ' attn' : ''), textContent: String(c.n) }));
    if (tab === U.currentTab) b.setAttribute('aria-current', 'page');
    b.addEventListener('click', () => { closeMenu(); U.showTab(tab); });
    return b;
  }
  U.buildNav = function buildNav() {
    const entry = !U.role || U.currentTab === 'start';
    document.querySelector('.shell').classList.toggle('entry', entry);
    $('btnRole').hidden = entry;
    $('whoAmI').textContent = U.userName ? `Signed in as ${U.userName}` : '';
    if (entry) { $('nav').replaceChildren(); return; }
    $('roleName').textContent = U.ROLE[U.role].name;
    $('roleIcon').innerHTML = U.icon('chevrons-up-down', 16);
    const mine = U.ROLE[U.role].tabs;
    const nav = $('nav');
    if (U.showAll) {
      nav.replaceChildren(...GROUPS.flatMap(([name, tabs]) => [el('div', { className: 'group', textContent: name }), ...tabs.map(navItem)]));
    } else {
      const tabs = mine.includes(U.currentTab) ? mine : [...mine, U.currentTab];
      nav.replaceChildren(...tabs.map(navItem));
    }
    if (mine.length < U.ALL_TABS.length) {
      const more = el('button', { className: 'navitem', textContent: U.showAll ? 'Show only my screens' : 'Show all screens' });
      more.style.marginTop = '8px';
      more.setAttribute('aria-pressed', String(U.showAll));
      more.addEventListener('click', () => { U.showAll = !U.showAll; U.buildNav(); });
      nav.append(more);
    }
  };
  U.setCount = (tab, n, attn) => { U.counts[tab] = { n, attn: Boolean(attn) }; U.buildNav(); };

  U.runView = async function runView(tab) {
    const view = $('view-' + tab);
    const box = view.querySelector('.view-error');
    if (box) box.classList.remove('show');
    try {
      await U.screens[tab]();
      $('updatedAt').textContent = 'Updated ' + new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    } catch (e) {
      console.error(e);
      if (!box) return U.toast(e.message, 'bad');
      box.querySelector('p').textContent = `This screen could not load. ${e.message}`;
      box.querySelector('button').onclick = () => U.runView(tab);
      box.classList.add('show');
    }
  };
  U.showTab = function showTab(tab, { push = true } = {}) {
    if (!U.screens[tab]) tab = U.role ? 'home' : 'start';
    if (!U.role) tab = 'start';
    U.currentTab = tab;
    U.closeDrawer();
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + tab));
    $('pageTitle').textContent = pageTitle(tab);
    document.title = tab === 'start' ? 'Unhold — PayPal cash-flow cockpit' : `${pageTitle(tab)} · Unhold`;
    if (push && location.hash !== '#' + tab) history.pushState(null, '', '#' + tab);
    U.buildNav();
    U.renderApprovalAlert();
    return U.runView(tab);
  };
  /** Open a screen from a queue row or a next-step button, optionally with a holds filter applied. */
  U.go = async function go(tab, holdFilter) {
    await U.showTab(tab);
    if (tab === 'holds' && holdFilter && U.setHoldFilter) U.setHoldFilter(holdFilter);
  };

  // ---------- counts, approval banner, next step ----------
  U.pendingApprovals = () => U.store.approvals.filter((a) => a.status === 'pending');
  U.refreshCounts = async function refreshCounts() {
    const [summary, approvals, disputes] = await Promise.allSettled([U.api('/api/summary'), U.api('/api/agent/approvals'), U.api('/api/disputes')]);
    if (summary.status === 'fulfilled') U.store.summary = summary.value;
    if (approvals.status === 'fulfilled') U.store.approvals = approvals.value.approvals || [];
    if (disputes.status === 'fulfilled') U.store.disputes = disputes.value.disputes || [];
    U.counts.holds = { n: U.store.summary ? U.store.summary.speedable_holds_count : 0, attn: false };
    U.counts.approvals = { n: U.pendingApprovals().length, attn: true };
    U.counts.disputes = { n: U.store.disputes.filter((d) => !/RESOLVED/.test(d.status)).length, attn: true };
    U.buildNav();
    U.renderApprovalAlert();
    if (U.renderNextStep) U.renderNextStep();
  };
  U.renderApprovalAlert = function renderApprovalAlert() {
    const p = U.pendingApprovals();
    const show = p.length > 0 && !['approvals', 'start'].includes(U.currentTab) && Boolean(U.role);
    $('approvalAlert').classList.toggle('show', show);
    if (show) $('approvalAlertText').textContent = `${p[0].title} is waiting for your decision (${money(p[0].total_usd)}).`;
  };

  // ---------- slide-over drawer ----------
  let drawerOpener = null;
  U.openDrawer = function openDrawer({ title, sub, render, footer }) {
    drawerOpener = document.activeElement;
    $('drawerTitle').textContent = title;
    $('drawerSub').textContent = sub || '';
    const body = $('drawerBody');
    body.replaceChildren();
    $('drawerFoot').replaceChildren();
    render(body);
    if (footer) footer($('drawerFoot'));
    $('drawerFoot').hidden = !$('drawerFoot').childElementCount;
    $('drawerScrim').classList.add('open');
    $('drawer').classList.add('open');
    $('drawerClose').focus();
  };
  U.closeDrawer = function closeDrawer() {
    if (!$('drawer').classList.contains('open')) return;
    $('drawer').classList.remove('open');
    $('drawerScrim').classList.remove('open');
    if (U.onDrawerClose) { U.onDrawerClose(); U.onDrawerClose = null; }
    if (drawerOpener && drawerOpener.focus && document.contains(drawerOpener)) drawerOpener.focus();
  };
  $('drawerScrim').addEventListener('click', U.closeDrawer);
  $('drawerClose').addEventListener('click', U.closeDrawer);
  $('drawer').addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const f = [...$('drawer').querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((x) => !x.disabled && x.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  // ---------- mobile menu ----------
  function closeMenu() { $('sidebar').classList.remove('open'); $('btnMenu').setAttribute('aria-expanded', 'false'); }
  $('btnMenu').addEventListener('click', () => {
    const open = $('sidebar').classList.toggle('open');
    $('btnMenu').setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if ($('drawer').classList.contains('open')) U.closeDrawer(); else closeMenu();
  });

  // ---------- header and sidebar controls ----------
  $('btnMenu').innerHTML = U.icon('menu', 18);
  $('btnRefresh').innerHTML = U.icon('refresh-cw', 14) + ' Refresh';
  $('drawerClose').innerHTML = U.icon('x', 16);
  $('btnExportHolds').innerHTML = U.icon('download', 14) + ' Export CSV';
  $('btnExportAudit').innerHTML = U.icon('download', 14) + ' Export CSV';
  $('btnTheme').addEventListener('click', U.cycleTheme);
  $('btnRole').addEventListener('click', () => U.showTab('start'));
  $('btnAlertReview').addEventListener('click', () => U.showTab('approvals'));
  $('btnRefresh').addEventListener('click', async () => {
    $('btnRefresh').disabled = true;
    await Promise.allSettled([U.refreshCounts(), U.runView(U.currentTab)]);
    $('btnRefresh').disabled = false;
  });
  window.addEventListener('popstate', () => U.showTab(location.hash.slice(1), { push: false }));
})();
