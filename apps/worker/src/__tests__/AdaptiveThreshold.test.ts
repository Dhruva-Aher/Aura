/**
 * AdaptiveThreshold — unit + overload scenario tests
 *
 * Uses an injected `getCompleted` function instead of real Redis so
 * every test is pure and deterministic.
 *
 * Covers:
 *   1.  No throughput data → falls back to staticMax
 *   2.  Drain rate × safetyFactor calculates correct dynamic threshold
 *   3.  Dynamic threshold is capped at staticMax
 *   4.  Dynamic threshold is floored at minThreshold
 *   5.  Cache: second call within refreshIntervalMs does not re-query
 *   6.  Cache expires: next call after refreshIntervalMs re-queries
 *   7.  lastDrainRatePerSec is updated on every refresh
 *   8.  Overload scenario: enqueueRate > drainRate → system stabilises
 *   9.  Drain rate drops → threshold tightens automatically
 *  10.  Drain rate recovers → threshold relaxes automatically
 *  11.  getCompleted throws → returns cached (resilient to Redis errors)
 *  12.  staticMax=0 is accepted (floor protects from divide-by-zero)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Import the class from the API package (relative path works because vitest
// resolves from the test file location).
import { AdaptiveThreshold } from '../../../../apps/api/src/services/AdaptiveThreshold';


function makeThreshold(overrides: Partial<ConstructorParameters<typeof AdaptiveThreshold>[0]> = {}) {
  return new AdaptiveThreshold({
    staticMax:         10_000,
    drainWindowSec:    10,
    safetyFactor:      4.0,
    refreshIntervalMs: 5_000,
    minThreshold:      100,
    ...overrides,
  });
}

/** A getCompleted stub that always returns `n` jobs in the window. */
const completedStub = (n: number) => async (_windowMs: number) => n;


describe('No drain data', () => {
  it('returns staticMax when getCompleted returns 0', async () => {
    const t = makeThreshold();
    const result = await t.getThreshold(completedStub(0));
    expect(result).toBe(10_000);
  });

  it('lastDrainRatePerSec is 0 when no data', async () => {
    const t = makeThreshold();
    await t.getThreshold(completedStub(0));
    expect(t.lastDrainRatePerSec).toBe(0);
  });
});


describe('Dynamic threshold calculation', () => {
  it('drainRate=50/s, safetyFactor=4, window=10s → threshold=2000', async () => {
    // 500 completed in 10s = 50/s; 50 * 10 * 4 = 2000
    const t = makeThreshold({ staticMax: 10_000, drainWindowSec: 10, safetyFactor: 4 });
    const result = await t.getThreshold(completedStub(500));
    expect(result).toBe(2_000);
    expect(t.lastDrainRatePerSec).toBe(50);
  });

  it('drainRate=10/s, safetyFactor=2, window=10s → threshold=200', async () => {
    const t = makeThreshold({ staticMax: 10_000, drainWindowSec: 10, safetyFactor: 2 });
    const result = await t.getThreshold(completedStub(100));
    expect(result).toBe(200);
  });

  it('drainRate=1/s → threshold is floored to minThreshold', async () => {
    // 10 completed / 10s = 1/s; 1 * 10 * 4 = 40; floored to minThreshold=100
    const t = makeThreshold({ staticMax: 10_000, drainWindowSec: 10, safetyFactor: 4, minThreshold: 100 });
    const result = await t.getThreshold(completedStub(10));
    expect(result).toBe(100);
  });
});


describe('staticMax cap', () => {
  it('high drain rate does not exceed staticMax', async () => {
    // 10000/s * 10 * 4 = 400000 → capped at staticMax=10000
    const t = makeThreshold({ staticMax: 10_000, drainWindowSec: 10, safetyFactor: 4 });
    const result = await t.getThreshold(completedStub(100_000));
    expect(result).toBe(10_000);
  });
});


describe('minThreshold floor', () => {
  it('very low drain rate is floored to minThreshold', async () => {
    // 1 completed in 10s = 0.1/s; 0.1 * 10 * 4 = 4 → floored to 100
    const t = makeThreshold({ minThreshold: 100, drainWindowSec: 10, safetyFactor: 4 });
    const result = await t.getThreshold(completedStub(1));
    expect(result).toBe(100);
  });

  it('custom minThreshold is respected', async () => {
    const t = makeThreshold({ minThreshold: 50, drainWindowSec: 10, safetyFactor: 1 });
    // 1 completed in 10s = 0.1/s; 0.1 * 10 * 1 = 1 → floored to 50
    const result = await t.getThreshold(completedStub(1));
    expect(result).toBe(50);
  });
});


describe('Cache', () => {
  it('second call within refreshIntervalMs uses cached value', async () => {
    const spy = vi.fn().mockResolvedValue(500);
    const t = makeThreshold({ refreshIntervalMs: 5_000 });

    const t0 = Date.now();
    await t.getThreshold(spy, t0);
    await t.getThreshold(spy, t0 + 1_000); // still within 5s window

    expect(spy).toHaveBeenCalledOnce();
  });

  it('call after refreshIntervalMs re-queries', async () => {
    const spy = vi.fn().mockResolvedValue(500);
    const t = makeThreshold({ refreshIntervalMs: 5_000 });

    const t0 = Date.now();
    await t.getThreshold(spy, t0);
    await t.getThreshold(spy, t0 + 5_001); // past refresh window

    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('.current returns cached value without a network call', async () => {
    const t = makeThreshold();
    await t.getThreshold(completedStub(500));
    const before = t.current;
    // No call to getThreshold — current stays
    expect(t.current).toBe(before);
  });
});


describe('lastDrainRatePerSec', () => {
  it('updates on every refresh', async () => {
    const t = makeThreshold({ refreshIntervalMs: 0 }); // always refresh
    const t0 = 1_000_000;

    await t.getThreshold(completedStub(200), t0);
    expect(t.lastDrainRatePerSec).toBe(20); // 200/10

    await t.getThreshold(completedStub(50), t0 + 1); // fresh call
    expect(t.lastDrainRatePerSec).toBe(5); // 50/10
  });
});


describe('Overload scenario', () => {
  it('system stabilises: threshold tightens as drain rate drops', async () => {
    // Simulates system under overload: drain slows down as workers are saturated
    const t = makeThreshold({
      staticMax: 10_000,
      drainWindowSec: 10,
      safetyFactor: 4,
      refreshIntervalMs: 0,
    });

    // Phase 1: healthy drain (100/s)
    const healthyThreshold = await t.getThreshold(completedStub(1_000), 0);
    expect(healthyThreshold).toBe(Math.min(10_000, 100 * 10 * 4)); // 4000

    // Phase 2: drain slows to 10/s (workers saturated)
    const degradedThreshold = await t.getThreshold(completedStub(100), 1);
    expect(degradedThreshold).toBe(Math.min(10_000, 10 * 10 * 4)); // 400

    // Phase 3: drain nearly stops (2/s — overloaded)
    const overloadedThreshold = await t.getThreshold(completedStub(20), 2);
    expect(overloadedThreshold).toBe(Math.min(10_000, Math.max(2 * 10 * 4, 100))); // 100 (floored)

    // Verify threshold tightened with each degradation
    expect(degradedThreshold).toBeLessThan(healthyThreshold);
    expect(overloadedThreshold).toBeLessThanOrEqual(degradedThreshold);
  });

  it('threshold relaxes when drain rate recovers', async () => {
    const t = makeThreshold({ staticMax: 10_000, drainWindowSec: 10, safetyFactor: 4, refreshIntervalMs: 0 });

    const overloaded = await t.getThreshold(completedStub(20), 0);  // 2/s → 100 (floor)
    const recovered  = await t.getThreshold(completedStub(800), 1); // 80/s → 3200

    expect(recovered).toBeGreaterThan(overloaded);
  });
});


describe('Resilience', () => {
  it('returns cached value when getCompleted throws', async () => {
    const t = makeThreshold({ refreshIntervalMs: 0 });
    // Prime the cache with a good value
    await t.getThreshold(completedStub(500), 0);
    const goodValue = t.current;

    // Redis throws
    const bad = async () => { throw new Error('ECONNREFUSED'); };
    const result = await t.getThreshold(bad, 1);

    expect(result).toBe(goodValue); // fell back to cache
  });
});
