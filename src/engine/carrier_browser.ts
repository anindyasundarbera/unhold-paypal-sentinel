/**
 * Delivery verification with a KERNEL cloud browser. A real browser opens the carrier tracking page for a
 * parcel and reads the status the way a person would. The synthetic tracking numbers in this demo are not
 * known to UPS/USPS/FedEx/DHL, so the page it opens is our own labelled "demo carrier" page, which is
 * reachable from Kernel's cloud only on the public deployment (PUBLIC_BASE_URL).
 */

const KERNEL = 'https://api.onkernel.com';

export function kernelConfigured(): boolean {
  return Boolean(process.env.KERNEL_API_KEY);
}

export interface CarrierCheck {
  tracking_number: string;
  url: string;
  status: string | null;
  delivered_at: string | null;
  page_title: string;
  session_id: string;
  ms: number;
}

async function kernel<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${KERNEL}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${process.env.KERNEL_API_KEY}`, 'content-type': 'application/json', ...(init.headers || {}) },
    signal: AbortSignal.timeout(90000)
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`Kernel ${res.status}: ${(json.error || json.message || text).toString().slice(0, 200)}`);
  return json as T;
}

export async function checkCarrierStatus(trackingNumber: string, baseUrl: string): Promise<CarrierCheck> {
  const started = Date.now();
  const url = `${baseUrl.replace(/\/+$/, '')}/carrier/${encodeURIComponent(trackingNumber)}`;
  const browser = await kernel<{ session_id: string }>('/browsers', {
    method: 'POST',
    body: JSON.stringify({ headless: true, timeout_seconds: 120 })
  });
  try {
    const code = `
      await page.goto(${JSON.stringify(url)}, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const el = await page.waitForSelector('[data-carrier-status]', { timeout: 15000 });
      return {
        status: await el.getAttribute('data-carrier-status'),
        delivered_at: await el.getAttribute('data-delivered-at'),
        page_title: await page.title()
      };`;
    const out = await kernel<{ success: boolean; result?: { status: string; delivered_at: string; page_title: string }; error?: string }>(
      `/browsers/${browser.session_id}/playwright/execute`,
      { method: 'POST', body: JSON.stringify({ code, timeout_sec: 60 }) }
    );
    if (!out.success || !out.result) throw new Error(out.error || 'Kernel browser could not read the carrier page.');
    return {
      tracking_number: trackingNumber,
      url,
      status: out.result.status || null,
      delivered_at: out.result.delivered_at || null,
      page_title: out.result.page_title,
      session_id: browser.session_id,
      ms: Date.now() - started
    };
  } finally {
    await kernel(`/browsers/${browser.session_id}`, { method: 'DELETE' }).catch(() => undefined);
  }
}
