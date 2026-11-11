// Boot: configuration, theme, role from a link, first screen.
(async function () {
  'use strict';
  const U = window.U;
  const { $ } = U;

  U.cfg = await U.api('/api/config').catch(() => ({ integrations: {} }));
  if (U.cfg.agGridLicenseKey) agGrid.LicenseManager.setLicenseKey(U.cfg.agGridLicenseKey);
  agGrid.ModuleRegistry.registerModules([agGrid.AllEnterpriseModule.with(agCharts.AgChartsEnterpriseModule)]);
  U.applyTheme();

  const env = $('envNote');
  env.append(U.el('span', { className: 'st warn', textContent: `PayPal ${U.cfg.paypalEnvironment || 'sandbox'}` }), U.el('span', { className: 'long', textContent: ' · simulated hold history' }));

  // A link can carry the role it is meant for, e.g. the Slack approval message opens /?role=owner#approvals.
  const linkRole = new URLSearchParams(location.search).get('role');
  if (U.ROLE[linkRole]) {
    U.setRole(linkRole);
    history.replaceState(null, '', location.pathname + location.hash);
  }
  U.refreshCounts();
  setInterval(() => { if (!document.hidden) U.refreshCounts(); }, 20000);
  await U.showTab(U.role ? location.hash.slice(1) || 'home' : 'start', { push: false });
})().catch((e) => {
  console.error(e);
  const box = document.createElement('p');
  box.style.cssText = 'color:#c0262d;padding:16px;margin:0';
  box.textContent = `The cockpit could not start. Reload the page to try again. (${e.message})`;
  document.body.prepend(box);
});
