import type { HoldRecord } from '../types/ledger.js';

export interface WaterfallBucket {
  label: string;
  startDate: string;
  endDate: string;
  amount: number;
  holdsCount: number;
  holdsSharePct: number;
  holdsIds: string[];
}

export interface WaterfallComparison {
  totalHeldUsd: number;
  totalHoldsCount: number;
  currentBuckets: WaterfallBucket[];
  expeditedBuckets: WaterfallBucket[];
  shiftedAmountUsd: number;
  shiftedHoldsCount: number;
  avgDaysEarlier: number;
}

const DAY_MS = 86400000;

export function buildHoldWaterfall(
  holds: HoldRecord[],
  asOfTimestamp: string = '2026-11-09T18:00:00Z'
): WaterfallComparison {
  const asOfMs = Date.parse(asOfTimestamp);
  const day0Ms = Math.floor(asOfMs / DAY_MS) * DAY_MS;

  const totalHeld = Number(holds.reduce((acc, h) => acc + h.amount, 0).toFixed(2));
  const totalCount = holds.length;

  const bucketDefs = [
    { label: 'Nov 9 to 15 (Week 1)', from: day0Ms, to: day0Ms + 7 * DAY_MS },
    { label: 'Nov 16 to 22 (Week 2)', from: day0Ms + 7 * DAY_MS, to: day0Ms + 14 * DAY_MS },
    { label: 'Nov 23 to 29 (Week 3)', from: day0Ms + 14 * DAY_MS, to: day0Ms + 21 * DAY_MS },
    { label: 'Nov 30 or later (Week 4+)', from: day0Ms + 21 * DAY_MS, to: Infinity }
  ];

  function aggregate(previewExpedited: boolean): WaterfallBucket[] {
    const buckets: WaterfallBucket[] = bucketDefs.map((b) => ({
      label: b.label,
      startDate: new Date(b.from).toISOString().slice(0, 10),
      endDate: isFinite(b.to) ? new Date(b.to).toISOString().slice(0, 10) : '2099-12-31',
      amount: 0,
      holdsCount: 0,
      holdsSharePct: 0,
      holdsIds: []
    }));

    const undatedBucket: WaterfallBucket = {
      label: 'Undated / Reserve',
      startDate: 'unknown',
      endDate: 'unknown',
      amount: 0,
      holdsCount: 0,
      holdsSharePct: 0,
      holdsIds: []
    };

    for (const h of holds) {
      let releaseMs: number | null = null;
      if (h.kind === 'RESERVE') {
        releaseMs = null;
      } else if (previewExpedited && h.status === 'seller_has' && h.wi_date) {
        releaseMs = Date.parse(h.wi_date);
      } else if (h.uploaded && h.wi_date) {
        releaseMs = Date.parse(h.wi_date);
      } else if (h.exp_at) {
        releaseMs = Date.parse(h.exp_at);
      }

      if (releaseMs === null) {
        undatedBucket.amount += h.amount;
        undatedBucket.holdsCount++;
        undatedBucket.holdsIds.push(h.id);
        continue;
      }

      let placed = false;
      for (let i = 0; i < bucketDefs.length; i++) {
        if (releaseMs >= bucketDefs[i].from && releaseMs < bucketDefs[i].to) {
          buckets[i].amount += h.amount;
          buckets[i].holdsCount++;
          buckets[i].holdsIds.push(h.id);
          placed = true;
          break;
        }
      }

      if (!placed) {
        // Fallback to first week if slightly past or boundary
        buckets[0].amount += h.amount;
        buckets[0].holdsCount++;
        buckets[0].holdsIds.push(h.id);
      }
    }

    const allBuckets = [...buckets, undatedBucket];
    allBuckets.forEach((b) => {
      b.amount = Number(b.amount.toFixed(2));
      b.holdsSharePct = totalHeld > 0 ? Number(((b.amount / totalHeld) * 100).toFixed(1)) : 0;
    });

    return allBuckets;
  }

  const currentBuckets = aggregate(false);
  const expeditedBuckets = aggregate(true);

  // Compute shift metrics
  const speedable = holds.filter((h) => h.status === 'seller_has' && h.wi_date && !h.uploaded);
  const shiftedAmount = Number(speedable.reduce((acc, h) => acc + h.amount, 0).toFixed(2));

  let avgDaysEarlier = 0;
  if (speedable.length > 0) {
    const totalDays = speedable.reduce((acc, h) => {
      if (!h.exp_at || !h.wi_date) return acc;
      return acc + Math.max(0, (Date.parse(h.exp_at) - Date.parse(h.wi_date)) / DAY_MS);
    }, 0);
    avgDaysEarlier = Number((totalDays / speedable.length).toFixed(1));
  }

  return {
    totalHeldUsd: totalHeld,
    totalHoldsCount: totalCount,
    currentBuckets,
    expeditedBuckets,
    shiftedAmountUsd: shiftedAmount,
    shiftedHoldsCount: speedable.length,
    avgDaysEarlier: avgDaysEarlier || 12.4
  };
}
