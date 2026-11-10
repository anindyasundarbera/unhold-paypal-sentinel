// Release timeline: Bryntum Scheduler — each hold is a row; the long bar is when PayPal would release it,
// the green bar is when it releases once tracking is uploaded.
(function () {
  'use strict';
  let loaded = null;
  let scheduler = null;

  function loadBryntum() {
    if (loaded) return loaded;
    loaded = new Promise((resolve, reject) => {
      const css = (href, id) => {
        const l = document.createElement('link');
        l.rel = 'stylesheet'; l.href = href; if (id) l.id = id;
        document.head.appendChild(l);
      };
      css('/vendor/bryntum/scheduler.css');
      css('/vendor/bryntum/stockholm-dark.css', 'bryntum-theme');
      const s = document.createElement('script');
      s.src = '/vendor/bryntum/scheduler.umd.js';
      s.onload = resolve;
      s.onerror = () => reject(new Error('Could not load the Bryntum Scheduler bundle.'));
      document.head.appendChild(s);
    });
    return loaded;
  }

  const money = (v) => '$' + Number(v || 0).toFixed(2);
  const STATE = { in_paypal: 'Tracking in PayPal', seller_has: 'Ready to upload', not_shipped: 'Not shipped', reserve: 'Reserve', unapproved: 'Needs approval' };

  async function render(host, holds) {
    await loadBryntum();
    const dated = holds.filter((h) => h.held_at && h.exp_at);
    if (!dated.length) { host.textContent = 'No dated holds to show.'; return; }

    const resources = dated
      .slice()
      .sort((a, b) => Date.parse(a.exp_at) - Date.parse(b.exp_at))
      .map((h) => ({ id: h.id, name: `${h.buyer} · ${h.item}`, amount: h.amount, state: STATE[h.status] || h.status }));

    const events = [];
    for (const h of dated) {
      events.push({
        id: 'p-' + h.id, resourceId: h.id, name: 'PayPal releases',
        startDate: new Date(h.held_at), endDate: new Date(h.exp_at), eventColor: 'orange', cls: 'unhold-default'
      });
      if (h.status === 'seller_has' && h.wi_date) {
        events.push({
          id: 'a-' + h.id, resourceId: h.id, name: 'With tracking: ' + money(h.amount),
          startDate: new Date(h.held_at), endDate: new Date(h.wi_date), eventColor: 'green', cls: 'unhold-accelerated'
        });
      }
    }
    const start = new Date(Math.min(...events.map((e) => +e.startDate)) - 86400000);
    const end = new Date(Math.max(...events.map((e) => +e.endDate)) + 3 * 86400000);

    if (scheduler) { scheduler.destroy(); scheduler = null; }
    host.innerHTML = '';
    scheduler = new bryntum.scheduler.Scheduler({
      appendTo: host,
      height: Math.max(420, host.clientHeight || 520),
      startDate: start,
      endDate: end,
      viewPreset: 'dayAndWeek',
      rowHeight: 34,
      barMargin: 6,
      eventLayout: 'none',
      eventStyle: 'filled',
      readOnly: true,
      features: { group: { field: 'state' }, eventTooltip: { template: ({ eventRecord }) => `<b>${eventRecord.name}</b><br>${eventRecord.startDate.toLocaleDateString()} → ${eventRecord.endDate.toLocaleDateString()}` } },
      columns: [
        { text: 'Order', field: 'name', width: 260 },
        { text: 'Amount', field: 'amount', width: 90, renderer: ({ value }) => money(value) }
      ],
      resources,
      events
    });
  }

  window.unholdTimeline = { render };
})();
