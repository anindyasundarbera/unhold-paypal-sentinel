import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { LedgerDB } from '../src/db/ledger_db.js';
import { seedLedger, loadSeedData } from '../src/seed/seeder.js';
import {
  analyzeSalesSurge,
  evaluateAccountHealth,
  generateWhyHeldReport
} from '../src/engine/why_held.js';
import {
  simulateCashReleases,
  planCashGoal
} from '../src/engine/monte_carlo.js';
import { buildHoldWaterfall } from '../src/engine/waterfall.js';

describe('Step 2: Cash-Flow Engine & Monte Carlo Forecaster', () => {
  const db = new LedgerDB(':memory:');
  seedLedger(db);
  const seedData = loadSeedData();
  const holds = db.getAllHolds();
  const evidence = db.getAllEvidence();

  test('calculates sales surge and account health score accurately', () => {
    const surge = analyzeSalesSurge(seedData.sales);
    assert.equal(surge.spikeRatio, 2.85); // 2.9x surge
    assert.equal(surge.last7Gross, 3968.41);

    const health = evaluateAccountHealth(holds, seedData.sales);
    assert.equal(health.score, 53);
    assert.equal(health.band, 'At risk');
    assert.equal(health.components.length, 3);

    const penalties = health.components.map((c) => c.penalty);
    assert.deepEqual(penalties, [15, 20, 12]);
  });

  test('synthesizes grounded Why-Held diagnostic report with citations', () => {
    const report = generateWhyHeldReport(holds, seedData.sales, evidence);

    assert.equal(report.total_held_usd, 5235.24);
    assert.equal(report.open_holds_count, 106);
    assert.equal(report.speedable_count, 38);
    assert.equal(report.speedable_amount_usd, 1869.39);
    assert.equal(report.avg_days_sooner, 12.4);

    assert.ok(report.plain_english_explanation.includes('5,235.24'));
    assert.ok(report.plain_english_explanation.includes('2.85x'));
    assert.ok(report.plain_english_explanation.includes('1,869.39'));
    assert.ok(report.plain_english_explanation.includes('12.4 days sooner'));
    assert.ok(report.cited_evidence_ids.length >= 2);
  });

  test('runs deterministic Monte Carlo simulation and verifies monotonic curves', () => {
    const sim = simulateCashReleases(holds, {}, '2026-11-09T18:00:00Z');

    assert.equal(sim.horizonDays, 21);
    assert.equal(sim.p10.length, 22);
    assert.equal(sim.p50.length, 22);
    assert.equal(sim.p90.length, 22);

    // Verify monotonic property: cumulative cash released never decreases
    for (let d = 1; d <= 21; d++) {
      assert.ok(
        sim.p10[d] >= sim.p10[d - 1],
        `p10 day ${d} (${sim.p10[d]}) should be >= day ${d - 1} (${sim.p10[d - 1]})`
      );
      assert.ok(
        sim.p50[d] >= sim.p50[d - 1],
        `p50 day ${d} (${sim.p50[d]}) should be >= day ${d - 1} (${sim.p50[d - 1]})`
      );
      assert.ok(
        sim.p90[d] >= sim.p90[d - 1],
        `p90 day ${d} (${sim.p90[d]}) should be >= day ${d - 1} (${sim.p90[d - 1]})`
      );

      // Verify quantile ordering: p10 <= p50 <= p90
      assert.ok(sim.p10[d] <= sim.p50[d], `p10 should be <= p50 on day ${d}`);
      assert.ok(sim.p50[d] <= sim.p90[d], `p50 should be <= p90 on day ${d}`);
    }
  });

  test('verifies cash goal planning probability jump with tracking and shipping actions', () => {
    const goalAmount = 4500;
    const goalDay = 11; // Nov 20, 2026

    // Baseline: without uploading tracking
    const baseSim = simulateCashReleases(holds, {}, '2026-11-09T18:00:00Z');
    const baseProb = baseSim.prob(goalDay, goalAmount);
    assert.equal(baseProb, 0, 'Baseline probability for $4,500 should be 0');
    assert.ok(baseSim.p50[goalDay] < 3000, `Baseline median should be < $3000, got ${baseSim.p50[goalDay]}`);

    // With tracking uploaded alone: median jumps from $2891 to $4432 (+ $1540+)
    const trackSim = simulateCashReleases(holds, { track: true }, '2026-11-09T18:00:00Z');
    assert.ok(trackSim.p50[goalDay] > 4400, `Track median should be > $4400, got ${trackSim.p50[goalDay]}`);
    const trackProb = trackSim.prob(goalDay, goalAmount);
    assert.ok(trackProb > baseProb, `Track prob (${trackProb}) should be > baseline (${baseProb})`);

    // With tracking + shipping waiting orders: probability jumps to > 90%
    const bothSim = simulateCashReleases(holds, { track: true, ship: true }, '2026-11-09T18:00:00Z');
    const bothProb = bothSim.prob(goalDay, goalAmount);
    assert.ok(bothProb >= 0.9, `Both actions prob (${bothProb}) should be >= 90%`);

    // Planner recommendation: selects tracking + shipping to exceed 80% confidence
    const plan = planCashGoal(holds, goalAmount, goalDay, 0.8, '2026-11-09T18:00:00Z');
    assert.ok(plan.selectedActions.length >= 1);
    assert.equal(plan.selectedActions[0].key, 'track');
    assert.ok(plan.plannedProb > plan.baselineProb);
  });

  test('aggregates Hold Waterfall and demonstrates cash release acceleration', () => {
    const waterfall = buildHoldWaterfall(holds, '2026-11-09T18:00:00Z');

    assert.equal(waterfall.totalHeldUsd, 5235.24);
    assert.equal(waterfall.totalHoldsCount, 106);
    assert.equal(waterfall.shiftedHoldsCount, 38);
    assert.equal(waterfall.shiftedAmountUsd, 1869.39);
    assert.equal(waterfall.avgDaysEarlier, 12.4);

    // Sum of current buckets should equal total held
    const currentSum = waterfall.currentBuckets.reduce((acc, b) => acc + b.amount, 0);
    assert.equal(Number(currentSum.toFixed(2)), 5235.24);

    // Undated bucket contains reserve hold of 8.44
    const reserveBucket = waterfall.currentBuckets.find((b) => b.label.includes('Reserve'));
    assert.ok(reserveBucket);
    assert.equal(reserveBucket.amount, 8.44);

    // Under expedited plan, Week 1 & 2 cash increases significantly
    const currentWeek1And2 = waterfall.currentBuckets[0].amount + waterfall.currentBuckets[1].amount;
    const expeditedWeek1And2 =
      waterfall.expeditedBuckets[0].amount + waterfall.expeditedBuckets[1].amount;

    assert.ok(
      expeditedWeek1And2 > currentWeek1And2,
      `Expedited Week 1+2 (${expeditedWeek1And2}) should be greater than current (${currentWeek1And2})`
    );
  });
});
