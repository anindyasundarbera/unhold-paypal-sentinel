/**
 * UI parity check. Starts the server on an in-memory ledger with no credentials, drives the cockpit in real Chrome,
 * and walks every screen and feature. Anything that would change real data is cancelled; the ledger here is throwaway anyway.
 *
 *   npm run test:ui          (needs Google Chrome; set CHROME_PATH to use another browser)
 *
 * Features that need a sponsor key (Elastic search, Kernel carrier check, Channel3 catalog, the language model) are
 * not switched on here, so they are checked by hand against a deployment that has the keys.
 */
import './helpers/test_env.js';
import { existsSync } from 'node:fs';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { memoryLedger } from './helpers/memory_ledger.js';
import { seedLedger } from '../src/seed/seeder.js';
import { createServer } from '../src/server.js';
import type { PayPalClient } from '../src/paypal/client.js';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const fakePayPal = { getOrder: async () => { throw new Error('404 RESOURCE_NOT_FOUND'); }, addTracking: async () => ({}) } as unknown as PayPalClient;

const results: Array<{ name: string; ok: boolean; note?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); console.log(`  ok    ${name}`); }
  catch (e) { const note = (e as Error).message.split('\n')[0]; results.push({ name, ok: false, note }); console.log(`  FAIL  ${name}\n        ${note}`); }
}
function expect(cond: unknown, message: string) { if (!cond) throw new Error(message); }

async function main() {
  if (!existsSync(CHROME)) { console.log(`Chrome not found at ${CHROME}. Set CHROME_PATH. Skipping the UI parity check.`); return; }
  const db = await memoryLedger();
  await seedLedger(db);
  const server = await createServer(db, fakePayPal);
  await server.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(server.server.address() as { port: number }).port}`;
  const browser: Browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
  const page: Page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`page error: ${(e as Error).message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|^\s*\*|License Key|AG Grid/.test(m.text())) problems.push(`console: ${m.text()}`); });

  const open = async (role: string, tab: string) => {
    await page.goto(`${base}/?role=${role}#${tab}`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { try { localStorage.setItem('unhold.theme', 'light'); } catch { /* ignore */ } });
    try {
      await page.waitForFunction((t) => document.getElementById('view-' + t)?.classList.contains('active') && document.querySelector(`#view-${t} .ag-root`), { timeout: 20000 }, tab);
    } catch {
      const why = await page.evaluate((t) => document.querySelector(`#view-${t} .view-error p`)?.textContent || 'no error box', tab);
      throw new Error(`${tab} did not render for ${role}: ${why} ${problems.slice(-2).join(' | ')}`);
    }
    await new Promise((r) => setTimeout(r, 600));
  };
  const text = (sel: string) => page.$eval(sel, (e) => e.textContent || '');
  const rows = (key: string) => page.evaluate((k) => (window as any).U.grids[k].getDisplayedRowCount(), key);
  const step = async (label: string, run: () => Promise<unknown>) => { try { await run(); } catch (e) { throw new Error(`step ${label}: ${(e as Error).message} :: ${await page.evaluate(() => (document.getElementById('planDetail')?.innerText || '').slice(0, 200).replace(/\n/g, ' | ') + ' || dialog=' + (document.getElementById('confirmDialog') as HTMLDialogElement).open + ' || toasts=' + document.getElementById('toasts')!.innerText)}`); } };
  const waitFor = (fn: string, arg?: unknown, timeout = 20000) => page.waitForFunction(fn, { timeout }, arg as never);
  const click = (sel: string) => page.click(sel);
  const dialogTitle = () => page.evaluate(() => (document.getElementById('confirmDialog') as HTMLDialogElement).open ? document.getElementById('confirmTitle')!.textContent : '');

  // ---------- entry and roles ----------
  await check('entry screen offers five roles with live numbers', async () => {
    await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { try { localStorage.clear(); } catch { /* ignore */ } });
    await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
    await waitFor(`document.querySelectorAll('.role').length === 5 && !document.querySelector('.role .live')?.textContent.includes('Loading')`);
    expect((await text('#startTitle')).includes('What do you do here'), 'start title');
    expect(await page.evaluate(() => document.querySelector('.shell')!.classList.contains('entry')), 'sidebar hidden on entry');
  });
  const NAV: Record<string, string[]> = {
    owner: ['Home', 'Approvals', 'Held money', 'Cash goal', 'Release timeline'],
    fulfilment: ['Home', 'Match tracking', 'Holds'],
    support: ['Home', 'Disputes', 'Payment guard'],
    admin: ['Home', 'Agent runs', 'Audit', 'Logs', 'Connections']
  };
  for (const [role, labels] of Object.entries(NAV)) {
    await check(`${role}: home queue loads with its own screens`, async () => {
      await open(role, 'home');
      const nav = await page.$$eval('#nav .navitem .label', (els) => els.map((e) => e.textContent));
      for (const l of labels) expect(nav.includes(l), `nav has ${l} (got ${nav.join(', ')})`);
      expect(!nav.includes('Logs') || role === 'admin', 'screens of other roles are hidden');
      expect((await text('#homeNextTitle')).length > 0, 'summary headline');
    });
  }
  await check('choosing a role from the entry screen opens its home and remembers it', async () => {
    await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { try { localStorage.clear(); } catch { /* ignore */ } });
    await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
    await waitFor(`document.querySelectorAll('.role').length === 5`);
    await page.evaluate(() => { const n = document.getElementById('nameInput') as HTMLInputElement; n.value = 'Priya'; n.dispatchEvent(new Event('input')); [...document.querySelectorAll('.role')].find((b) => b.textContent!.startsWith('Support'))!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await waitFor(`location.hash === '#home' && document.getElementById('pageTitle').textContent.startsWith('Support home')`);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitFor(`document.getElementById('pageTitle').textContent.startsWith('Support home')`);
    expect((await text('#whoAmI')).includes('Priya'), 'name shown');
    await click('#btnRole');
    await waitFor(`location.hash === '#start'`);
  });
  await check('guided tour lists seven steps and opens a step', async () => {
    await open('tour', 'home');
    await waitFor(`U.grids.tour && U.grids.tour.getDisplayedRowCount() === 7`);
    await page.evaluate(() => (document.querySelector('#gridTour .btn') as HTMLElement).click());
    await waitFor(`location.hash === '#cockpit'`);
  });

  // ---------- held money ----------
  await check('held money: KPI grid with sparklines, chart, compare toggle, data grid, why-held', async () => {
    await open('owner', 'cockpit');
    await waitFor(`document.querySelector('#waterfallChart canvas') && U.grids.buckets.getDisplayedRowCount() > 0`);
    expect(await page.evaluate(() => !!document.querySelector('#gridKpi .ag-sparkline-wrapper, #gridKpi [class*=sparkline]')), 'sparklines');
    await click('#btnWaterfallMode');
    expect(await page.$eval('#btnWaterfallMode', (b) => b.getAttribute('aria-pressed')) === 'true', 'compare toggle');
    expect((await rows('why')) >= 1, 'why-held rows');
  });

  // ---------- holds ----------
  await check('holds: filters, grouping panel, side bar, status bar, row detail expand', async () => {
    await open('fulfilment', 'holds');
    await waitFor(`U.grids.holds.getDisplayedRowCount() > 50`);
    const all = await rows('holds');
    await click('[data-hold-filter=not_shipped]');
    await new Promise((r) => setTimeout(r, 400));
    const ns = await rows('holds');
    expect(ns > 0 && ns < all, `not shipped filter (${ns} of ${all})`);
    await click('[data-hold-filter=ready]');
    await new Promise((r) => setTimeout(r, 400));
    expect((await rows('holds')) > 0, 'ready filter');
    await click('#btnClearFilters');
    await new Promise((r) => setTimeout(r, 400));
    expect((await rows('holds')) === all, 'clear filters restores every hold');
    expect(await page.evaluate(() => !!document.querySelector('#gridHolds .ag-side-bar') && !!document.querySelector('#gridHolds .ag-status-bar')), 'side bar and status bar');
    expect(await page.evaluate(() => !!document.querySelector('#gridHolds .ag-group-contracted')), 'master-detail expand arrows exist');
    await page.evaluate(() => (document.querySelector('#gridHolds .ag-group-contracted') as HTMLElement).click());
    await waitFor(`document.querySelector('#gridHolds .ag-details-row')`);
  });
  await check('holds: row opens the slide-over, Escape closes it', async () => {
    await page.evaluate(() => (document.querySelector('#gridHolds .ag-center-cols-container .ag-row .ag-cell[col-id=buyer]') as HTMLElement).click());
    await waitFor(`document.getElementById('drawer').classList.contains('open') && document.querySelectorAll('#drawerBody .ag-row').length >= 5`);
    await page.keyboard.press('Escape');
    await waitFor(`!document.getElementById('drawer').classList.contains('open')`);
  });
  await check('holds: ticking ready rows enables the upload; the dialog says what happens and Cancel changes nothing', async () => {
    await click('[data-hold-filter=ready]');
    await new Promise((r) => setTimeout(r, 400));
    await page.evaluate(() => (document.querySelector('#gridHolds .ag-pinned-left-cols-container .ag-row input[type=checkbox]') as HTMLElement).click());
    await waitFor(`!document.getElementById('btnUploadSelected').disabled`);
    expect((await text('#btnUploadSelected')).includes('Upload tracking for 1 parcel'), 'button names the count');
    await click('#btnUploadSelected');
    await waitFor(`document.getElementById('confirmDialog').open`);
    expect((await dialogTitle())!.includes('demo parcel'), `demo parcels are called demo (got ${await dialogTitle()})`);
    await click('#confirmCancel');
    await waitFor(`!document.getElementById('confirmDialog').open`);
    expect((await db.getAllHolds()).filter((h) => h.uploaded).length === 0, 'nothing uploaded');
  });

  // ---------- match tracking ----------
  await check('match tracking: ready rows pre-ticked, upload dialog opens and cancels', async () => {
    await open('fulfilment', 'matcher');
    await waitFor(`U.grids.matcher.getSelectedRows().length > 0 && !document.getElementById('btnUploadApproved').disabled`);
    await click('#btnUploadApproved');
    await waitFor(`document.getElementById('confirmDialog').open`);
    await click('#confirmCancel');
    await waitFor(`!document.getElementById('confirmDialog').open`);
    expect((await text('#matcherStatus')).includes('ready'), 'status line');
  });

  // ---------- approvals and agent runs ----------
  await check('approvals: run the agent on demo data, read the plan, cancel approve, then reject', async () => {
    await open('owner', 'approvals');
    await page.select('#runToolbarA select', 'simulated');
    await click('#runToolbarA .btn.primary');
    await step('1', () => waitFor(`[...document.querySelectorAll('#planDetail button')].some(b => b.textContent === 'Approve plan')`, undefined, 40000));
    try { await waitFor(`document.querySelectorAll('#planDetail .ag-center-cols-container .ag-row').length > 3`); }
    catch { throw new Error('plan parcels never rendered: ' + (await page.evaluate(() => `rows=${document.querySelectorAll('#planDetail .ag-row').length} text=${document.getElementById('planDetail')!.innerText.slice(0, 160).replace(/\n/g, ' | ')}`))); }
    expect(await page.evaluate(() => !!document.querySelector('.alert.show')) === false, 'no banner on the approvals screen itself');
    await page.evaluate(() => ([...document.querySelectorAll('#planDetail button')].find((b) => b.textContent === 'Approve plan') as HTMLElement).click());
    await step('2', () => waitFor(`document.getElementById('confirmDialog').open`));
    expect((await dialogTitle())!.startsWith('Approve uploading tracking'), 'approve dialog');
    await click('#confirmCancel');
    await waitFor(`!document.getElementById('confirmDialog').open`);
    expect((await db.getAllHolds()).filter((h) => h.uploaded).length === 0, 'cancel uploads nothing');
    await page.evaluate(() => ([...document.querySelectorAll('#planDetail button')].find((b) => b.textContent === 'Reject plan') as HTMLElement).click());
    await step('3', () => waitFor(`document.getElementById('confirmDialog').open`));
    await click('#confirmOk');
    await step('4', () => waitFor(`document.getElementById('planDetail').textContent.includes('can no longer be changed')`));
    { const up = (await db.getAllHolds()).filter((h) => h.uploaded); expect(up.length === 0, `reject uploads nothing (uploaded: ${up.length}; approvals: ${(await db.listApprovals()).map((a) => a.status).join(',')}; audit: ${(await db.getAuditChain()).slice(-3).map((a) => a.action + ':' + a.result).join(' ')})`); }
  });
  await check('home banner and nav count show a waiting plan from another screen', async () => {
    await open('owner', 'approvals');
    await page.select('#runToolbarA select', 'simulated');
    await waitFor(`!document.querySelector('#runToolbarA .btn.primary').disabled`, undefined, 15000);
    await click('#runToolbarA .btn.primary');
    await waitFor(`[...document.querySelectorAll('#planDetail button')].some(b => b.textContent === 'Approve plan')`, undefined, 40000);
    await page.evaluate(() => (window as any).U.showTab('cockpit'));
    await waitFor(`document.getElementById('approvalAlert').classList.contains('show')`);
    expect((await text('#nav .navitem:nth-child(2) .count')) === '1', 'nav count is 1');
  });
  await check('agent runs: team grid, run history, open a run to see its steps', async () => {
    await open('admin', 'agents');
    await waitFor(`U.grids.team.getDisplayedRowCount() === 4 && U.grids.runs.getDisplayedRowCount() > 0`);
    await page.evaluate(() => (document.querySelector('#gridRuns .ag-group-contracted') as HTMLElement).click());
    await waitFor(`document.querySelectorAll('#gridRuns .ag-details-row .ag-row').length > 3`);
  });

  // ---------- the rest ----------
  await check('disputes: list, detail, negotiate asks first (or is disabled when resolved), injection scan blocks', async () => {
    await open('support', 'disputes');
    await waitFor(`U.grids.disputes.getDisplayedRowCount() >= 1 && document.getElementById('disputeDetail').textContent.includes('Amount')`);
    const resolved = (await text('#disputeDetail')).includes('Resolved');
    const disabled = await page.evaluate(() => (document.querySelector('#disputeDetail .btn.primary') as HTMLButtonElement).disabled);
    expect(disabled === resolved, `negotiate is ${disabled ? 'disabled' : 'enabled'} for a ${resolved ? 'resolved' : 'open'} dispute`);
    if (!resolved) {
      await click('#disputeDetail .btn.primary');
      await waitFor(`document.getElementById('confirmDialog').open`);
      await click('#confirmCancel');
    }
    await click('#btnInjectionExample');
    await click('#btnCheckInjection');
    await waitFor(`document.getElementById('injectionStatus').textContent.startsWith('Blocked')`);
  });
  await check('cash goal: results load, invalid input is explained on blur', async () => {
    await open('owner', 'forecast');
    await waitFor(`U.grids.outcome.getDisplayedRowCount() === 4`);
    await page.$eval('#goalAmount', (i) => { (i as HTMLInputElement).value = '0'; i.dispatchEvent(new Event('blur')); });
    expect((await text('#goalAmountErr')).length > 0, 'error text');
  });
  await check('payment guard: a fake notice is blocked and listed', async () => {
    await open('support', 'guard');
    await click('#btnLoadScam');
    await click('#btnVerifyEmail');
    await waitFor(`U.grids.guard && U.grids.guard.getDisplayedRowCount() === 1 && document.getElementById('guardStatus').textContent.startsWith('Do not ship')`);
  });
  await check('audit: chain verified on open, CSV export present; logs filter; connections listed', async () => {
    await open('admin', 'audit');
    await waitFor(`document.getElementById('auditHead').textContent.startsWith('Chain intact')`);
    expect((await text('#btnExportAudit')).includes('Export CSV'), 'export button');
    await open('admin', 'logs');
    await page.select('#logLevel', 'warn');
    await open('admin', 'connections');
    await waitFor(`U.grids.connections.getDisplayedRowCount() === 7`);
  });
  await check('release timeline renders', async () => {
    await page.goto(`${base}/?role=owner#timeline`, { waitUntil: 'domcontentloaded' });
    await waitFor(`document.querySelector('#timelineHost .b-scheduler')`, undefined, 30000);
  });

  // ---------- theme and phone width ----------
  await check('theme button cycles light, dark and system; grids follow', async () => {
    await open('owner', 'home');
    await page.evaluate(() => localStorage.removeItem('unhold.theme'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitFor(`document.querySelector('#view-home .ag-root')`);
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      await click('#btnTheme');
      seen.push(await page.evaluate(() => `${document.documentElement.dataset.theme || 'system'}/${document.body.dataset.agThemeMode}`));
    }
    expect(seen[0] === 'light/light' && seen[1] === 'dark/dark' && seen[2].startsWith('system/'), `cycle was ${seen.join(', ')}`);
  });
  await check('no screen overflows sideways at 375px and the menu opens', async () => {
    await page.setViewport({ width: 375, height: 812, isMobile: true });
    for (const [role, tab] of [['owner', 'home'], ['owner', 'approvals'], ['owner', 'cockpit'], ['fulfilment', 'holds'], ['fulfilment', 'matcher'], ['support', 'disputes'], ['support', 'guard'], ['admin', 'agents'], ['admin', 'audit']] as const) {
      await open(role, tab);
      const [w, vw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
      expect(w <= vw, `${tab} is ${w}px wide in a ${vw}px window`);
    }
    await click('#btnMenu');
    await waitFor(`document.getElementById('sidebar').classList.contains('open')`);
  });

  await check('no script errors on any screen', async () => { expect(problems.length === 0, problems.slice(0, 3).join(' | ')); });

  await browser.close();
  await server.close();
  await db.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
