/**
 * Channel3 product graph lookup. Turns a held order's item name into catalog evidence
 * (brand, category, typical price, product page) for "is this item real and priced like this?"
 * checks in Safe-to-ship and dispute packs.
 */

export interface ProductEvidence {
  query: string;
  found: boolean;
  title?: string;
  brand?: string;
  category?: string;
  price?: number;
  currency?: string;
  retailer?: string;
  url?: string;
  image?: string;
  priceCheck?: { orderAmount: number; verdict: 'consistent' | 'below_catalog' | 'above_catalog' | 'unknown'; note: string };
}

const cache = new Map<string, ProductEvidence>();

export function channel3Configured(): boolean {
  return Boolean(process.env.CHANNEL3_API_KEY);
}

export async function lookupProduct(item: string, orderAmount?: number): Promise<ProductEvidence> {
  const key = item.toLowerCase().trim();
  let evidence = cache.get(key);
  if (!evidence) {
    const res = await fetch('https://api.trychannel3.com/v1/search', {
      method: 'POST',
      headers: { 'x-api-key': process.env.CHANNEL3_API_KEY || '', 'content-type': 'application/json' },
      body: JSON.stringify({ query: item, limit: 1 }),
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) throw new Error(`Channel3 HTTP ${res.status}`);
    const body = (await res.json()) as { products?: Array<Record<string, any>> };
    const p = body.products?.[0];
    if (!p) {
      evidence = { query: item, found: false };
    } else {
      const offer = p.offers?.[0];
      evidence = {
        query: item,
        found: true,
        title: p.title,
        brand: p.brands?.[0]?.name,
        category: p.category?.title,
        price: offer?.price?.price !== undefined ? Number(offer.price.price) : undefined,
        currency: offer?.price?.currency,
        retailer: offer?.domain,
        url: offer?.url,
        image: p.images?.find((i: any) => i.is_main_image)?.url || p.images?.[0]?.url
      };
    }
    cache.set(key, evidence);
  }
  if (evidence.found && evidence.price && orderAmount !== undefined) {
    const ratio = orderAmount / evidence.price;
    evidence = {
      ...evidence,
      priceCheck: {
        orderAmount,
        verdict: ratio < 0.5 ? 'below_catalog' : ratio > 1.6 ? 'above_catalog' : 'consistent',
        note: `Order $${orderAmount.toFixed(2)} vs catalog $${evidence.price.toFixed(2)} at ${evidence.retailer}`
      }
    };
  }
  return evidence;
}
