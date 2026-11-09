import type { HoldRecord } from '../types/ledger.js';

export interface ActionFlags {
  track?: boolean; // Upload tracking for seller_has holds
  ship?: boolean; // Ship the waiting/unshipped orders
  carrier?: boolean; // Re-add tracking with recognized carrier
}

export interface SimulationResult {
  horizonDays: number;
  p10: number[]; // 10th percentile cumulative cash released
  p50: number[]; // 50th percentile (median) cumulative cash released
  p90: number[]; // 90th percentile cumulative cash released
  prob: (day: number, targetAmount: number) => number;
}

export interface CashGoalPlan {
  goalAmount: number;
  goalDay: number;
  confidenceRequired: number;
  baselineProb: number;
  plannedProb: number;
  shortfallOrSurplus: number;
  selectedActions: Array<{
    key: 'track' | 'ship' | 'carrier';
    title: string;
    impactDescription: string;
  }>;
  recommendedText: string;
}

const N_SIM = 2000;
const DAY_MS = 86400000;
const HORIZON_DAYS = 21;

/**
 * Deterministic Mulberry32 32-bit PRNG generator.
 */
export function mulberry32(seed: number): () => number {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Computes the simulated release timestamp for a single hold.
 */
function calculateHoldReleaseTime(
  h: HoldRecord,
  f: ActionFlags,
  asOfMs: number,
  day0Ms: number,
  z: number,
  u: number,
  shock: number,
  v: number
): number {
  if (h.kind === 'RESERVE') return Infinity;
  if (v > 0.985) return Infinity; // ~1.5% dispute risk freezes funds past horizon

  const lostScan = v < 0.04; // ~4% lost courier delivery scan
  const heldTime = Date.parse(h.held_at);
  const latestLimit = heldTime + 21 * DAY_MS;
  const expTime = h.exp_at ? Date.parse(h.exp_at) : latestLimit;
  const minTime = asOfMs + 0.02 * DAY_MS;

  function clamp(t: number): number {
    return Math.min(Math.max(t, minTime), latestLimit);
  }

  function limit(): number {
    return clamp(latestLimit - 0.3 * DAY_MS + Math.abs(z) * 0.3 * DAY_MS);
  }

  function tracked(): number {
    if (lostScan) return limit();
    if (h.delivered_at) return clamp(asOfMs + (1 + 0.5 * Math.abs(z)) * DAY_MS);
    const wiMs = h.wi_date ? Date.parse(h.wi_date) : expTime;
    return clamp(wiMs + shock + z * 0.9 * DAY_MS);
  }

  if (h.uploaded && h.wi_date) return tracked();

  switch (h.status) {
    case 'in_paypal':
      if (h.rule === 'delivered+24h') return clamp(expTime + Math.abs(z) * 0.3 * DAY_MS);
      if (lostScan) return limit();
      return clamp(expTime + shock + z * 0.9 * DAY_MS);

    case 'seller_has':
      if (f.track && h.wi_date) return tracked();
      return limit();

    case 'not_shipped':
      if (f.ship && !lostScan) {
        const ship = asOfMs + (1 + 1.5 * u) * DAY_MS;
        const transit = Math.exp(Math.log(3.2) + 0.4 * z) * DAY_MS;
        return clamp(ship + transit + shock + DAY_MS);
      }
      return limit();

    case 'unapproved':
      if (f.carrier && !lostScan) {
        return h.delivered_at
          ? clamp(asOfMs + (1.2 + 0.5 * Math.abs(z)) * DAY_MS)
          : clamp(expTime - 5 * DAY_MS + shock);
      }
      return limit();

    default:
      return clamp(expTime);
  }
}

/**
 * Runs 2,000 deterministic Monte Carlo simulations of cumulative released cash.
 */
export function simulateCashReleases(
  holds: HoldRecord[],
  flags: ActionFlags = {},
  asOfTimestamp: string = '2026-11-09T18:00:00Z',
  seed: number = 20261109
): SimulationResult {
  const asOfMs = Date.parse(asOfTimestamp);
  const day0Ms = Math.floor(asOfMs / DAY_MS) * DAY_MS;
  const numDays = HORIZON_DAYS + 1;

  const rng = mulberry32(seed);

  // Matrix: [day][simulation_index]
  const cum: Float64Array[] = [];
  for (let d = 0; d < numDays; d++) {
    cum.push(new Float64Array(N_SIM));
  }

  const dailyAdditions = new Float64Array(numDays);

  for (let s = 0; s < N_SIM; s++) {
    // 35% chance of holiday courier backlog shock (0.5 to 3.0 days)
    const shock = rng() < 0.35 ? (0.5 + 2.5 * rng()) * DAY_MS : (rng(), 0);
    dailyAdditions.fill(0);

    for (let i = 0; i < holds.length; i++) {
      const u1 = rng() || 1e-12;
      const u2 = rng();
      const u3 = rng();
      const u4 = rng();

      // Box-Muller Gaussian standard normal transform
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);

      const releaseTime = calculateHoldReleaseTime(
        holds[i],
        flags,
        asOfMs,
        day0Ms,
        z,
        u3,
        shock,
        u4
      );

      if (!isFinite(releaseTime)) continue;

      let dayIndex = Math.floor((releaseTime - day0Ms) / DAY_MS);
      if (dayIndex < 0) dayIndex = 0;
      if (dayIndex < numDays) {
        dailyAdditions[dayIndex] += holds[i].amount;
      }
    }

    let runningSum = 0;
    for (let d = 0; d < numDays; d++) {
      runningSum += dailyAdditions[d];
      cum[d][s] = runningSum;
    }
  }

  // Sort each day's cumulative runs for percentile lookups
  cum.forEach((arr) => arr.sort());

  function quantile(d: number, p: number): number {
    const arr = cum[Math.min(numDays - 1, Math.max(0, d))];
    const idx = Math.min(arr.length - 1, Math.max(0, Math.floor(p * (arr.length - 1))));
    return Number(arr[idx].toFixed(2));
  }

  const p10: number[] = [];
  const p50: number[] = [];
  const p90: number[] = [];

  for (let d = 0; d < numDays; d++) {
    p10.push(quantile(d, 0.1));
    p50.push(quantile(d, 0.5));
    p90.push(quantile(d, 0.9));
  }

  const prob = function (day: number, targetAmount: number): number {
    const safeDay = Math.min(numDays - 1, Math.max(0, day));
    const arr = cum[safeDay];
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (arr[m] < targetAmount - 1e-9) lo = m + 1;
      else hi = m;
    }
    return Number(((arr.length - lo) / arr.length).toFixed(3));
  };

  return {
    horizonDays: HORIZON_DAYS,
    p10,
    p50,
    p90,
    prob
  };
}

/**
 * Plans the minimal set of actions to hit a seller's cash goal at required confidence.
 */
export function planCashGoal(
  holds: HoldRecord[],
  goalAmount: number = 4500,
  goalDay: number = 11, // Day 11 is Nov 20, 2026
  confidenceRequired: number = 0.8,
  asOfTimestamp: string = '2026-11-09T18:00:00Z'
): CashGoalPlan {
  const baseSim = simulateCashReleases(holds, {}, asOfTimestamp);
  const baselineProb = baseSim.prob(goalDay, goalAmount);

  const speedable = holds.filter((h) => h.status === 'seller_has' && h.wi_date && !h.uploaded);
  const waiting = holds.filter((h) => h.status === 'not_shipped');

  const selectedActions: CashGoalPlan['selectedActions'] = [];

  // Check 1: Upload known tracking
  const trackSim = simulateCashReleases(holds, { track: true }, asOfTimestamp);
  const trackProb = trackSim.prob(goalDay, goalAmount);

  // Check 2: Upload tracking + ship waiting
  const bothSim = simulateCashReleases(holds, { track: true, ship: true }, asOfTimestamp);
  const bothProb = bothSim.prob(goalDay, goalAmount);

  let plannedProb = baselineProb;
  let recommendedText = '';

  if (speedable.length > 0) {
    selectedActions.push({
      key: 'track',
      title: `Upload tracking for ${speedable.length} orders`,
      impactDescription: `Accelerates $${speedable.reduce((acc, h) => acc + h.amount, 0).toFixed(2)} by ~12.4 days sooner`
    });
    plannedProb = trackProb;

    if (trackProb < confidenceRequired && waiting.length > 0) {
      selectedActions.push({
        key: 'ship',
        title: `Ship the ${waiting.length} waiting orders today`,
        impactDescription: `Adds ~$${waiting.reduce((acc, h) => acc + h.amount, 0).toFixed(2)} to release pipeline before day ${goalDay}`
      });
      plannedProb = bothProb;
    }
  }

  // Calculate shortfall or surplus at required confidence
  const confQuantile = 1 - confidenceRequired;
  const refSim = selectedActions.length > 0 ? (selectedActions.some((a) => a.key === 'ship') ? bothSim : trackSim) : baseSim;
  const cashAtConfidence = refSim.p50[goalDay]; // median benchmark
  const diff = Number((cashAtConfidence - goalAmount).toFixed(2));

  if (plannedProb >= confidenceRequired) {
    recommendedText = `Goal of $${goalAmount.toLocaleString()} by day ${goalDay} is ${Math.round(plannedProb * 100)}% likely with ${selectedActions.length} planned action(s).`;
  } else {
    recommendedText = `Goal of $${goalAmount.toLocaleString()} by day ${goalDay} reaches ${Math.round(plannedProb * 100)}% probability. Shortfall of ~$${Math.abs(diff).toFixed(0)} at required ${Math.round(confidenceRequired * 100)}% confidence.`;
  }

  return {
    goalAmount,
    goalDay,
    confidenceRequired,
    baselineProb,
    plannedProb,
    shortfallOrSurplus: diff,
    selectedActions,
    recommendedText
  };
}
