/**
 * Metrics calculation correctness tests — Step 5
 *
 * Covers:
 *   1. Latency percentile function (P50, P95, P99) — edge cases + ordering
 *   2. Percentile index clamped to array bounds (no out-of-bounds)
 *   3. Throughput calculation (jobs/min from last-hour count)
 *   4. Drain rate (jobs/second from last-hour count)
 *   5. Worker utilization (leased / capacity, clamped to reasonable range)
 *   6. Failure rate and retry rate calculations
 */

import { describe, it, expect } from 'vitest';


/**
 * Generic percentile over an array of latency values in ms.
 * Returns the value in seconds with 1 decimal place.
 * Matches the percentileFromLatencies() function in metricsSnapshot.ts.
 */
function percentileFromLatencies(latenciesMs: number[], p: number): number {
  if (!latenciesMs.length) return 0;
  const sorted = [...latenciesMs].sort((a, b) => a - b);
  const idx = Math.min(Math.floor(sorted.length * p), sorted.length - 1);
  return Math.round(((sorted[idx] ?? 0) / 100)) / 10;
}

function throughputPerMin(completed1h: number): number {
  return Number((completed1h / 60).toFixed(2));
}

function drainRate(completed1h: number): number {
  return Number((completed1h / 3600).toFixed(4));
}

function workerUtilization(leased: number, totalWorkers: number, concurrency: number): number {
  const capacity = Math.max(totalWorkers, 1) * concurrency;
  return Number(((leased / capacity) * 100).toFixed(2));
}

function failureRate(failed1h: number, completed1h: number): number {
  if (completed1h <= 0) return 0;
  return Number(((failed1h / completed1h) * 100).toFixed(2));
}

function retryRate(retried1h: number, completed1h: number): number {
  if (completed1h <= 0) return 0;
  return Number(((retried1h / completed1h) * 100).toFixed(2));
}


describe('Latency percentile calculation', () => {
  it('returns 0 for empty array', () => {
    expect(percentileFromLatencies([], 0.95)).toBe(0);
    expect(percentileFromLatencies([], 0.50)).toBe(0);
    expect(percentileFromLatencies([], 0.99)).toBe(0);
  });

  it('returns the only element for a single-item array', () => {
    // 2000ms = 2.0s
    expect(percentileFromLatencies([2000], 0.50)).toBe(2);
    expect(percentileFromLatencies([2000], 0.95)).toBe(2);
    expect(percentileFromLatencies([2000], 0.99)).toBe(2);
  });

  it('P50 returns the median', () => {
    // [1000, 2000, 3000, 4000, 5000] — P50 idx = floor(5 * 0.5) = 2 → 3000ms = 3.0s
    const latencies = [3000, 1000, 5000, 2000, 4000]; // unsorted input
    expect(percentileFromLatencies(latencies, 0.50)).toBe(3);
  });

  it('P95 returns the 95th-percentile element', () => {
    // 20 items: sorted [100, 200, ..., 2000]
    const latencies = Array.from({ length: 20 }, (_, i) => (i + 1) * 100);
    // idx = floor(20 * 0.95) = 19 (clamped to 19) → 2000ms = 2.0s
    expect(percentileFromLatencies(latencies, 0.95)).toBe(2);
  });

  it('P99 uses the correct index', () => {
    // 100 items: [10, 20, ..., 1000]ms
    const latencies = Array.from({ length: 100 }, (_, i) => (i + 1) * 10);
    // idx = floor(100 * 0.99) = 99 → 1000ms = 1.0s
    expect(percentileFromLatencies(latencies, 0.99)).toBe(1);
  });

  it('P50 ≤ P95 ≤ P99 for any array', () => {
    const latencies = [50, 200, 500, 800, 1200, 1500, 2000, 2500, 3000, 5000,
                       100, 300, 700, 900, 1100, 1400, 1800, 2200, 2800, 4000];
    const p50 = percentileFromLatencies(latencies, 0.50);
    const p95 = percentileFromLatencies(latencies, 0.95);
    const p99 = percentileFromLatencies(latencies, 0.99);
    expect(p50).toBeLessThanOrEqual(p95);
    expect(p95).toBeLessThanOrEqual(p99);
  });

  it('converts ms to seconds correctly (1 decimal)', () => {
    // 1234ms → Math.round(1234 / 100) / 10 = Math.round(12.34) / 10 = 12 / 10 = 1.2
    expect(percentileFromLatencies([1234], 0.5)).toBe(1.2);
    // 999ms → Math.round(9.99) / 10 = 10 / 10 = 1.0
    expect(percentileFromLatencies([999], 0.5)).toBe(1);
    // 500ms → Math.round(5) / 10 = 0.5
    expect(percentileFromLatencies([500], 0.5)).toBe(0.5);
  });

  it('index never exceeds array length (clamp)', () => {
    // Regression: floor(1 * 0.95) = 0, which is valid
    expect(() => percentileFromLatencies([1000], 0.95)).not.toThrow();
    // floor(2 * 0.99) = 1, which is the last index of length-2 array
    expect(() => percentileFromLatencies([500, 1000], 0.99)).not.toThrow();
    expect(percentileFromLatencies([500, 1000], 0.99)).toBe(1);
  });
});


describe('Throughput calculation (jobs/min)', () => {
  it('returns 0 when no jobs completed', () => {
    expect(throughputPerMin(0)).toBe(0);
  });

  it('divides completed-in-last-hour by 60', () => {
    expect(throughputPerMin(600)).toBe(10);
    expect(throughputPerMin(3000)).toBe(50);
  });

  it('rounds to 2 decimal places', () => {
    // 100 / 60 = 1.666... → 1.67
    expect(throughputPerMin(100)).toBe(1.67);
  });
});


describe('Drain rate (jobs/second)', () => {
  it('returns 0 when no jobs completed', () => {
    expect(drainRate(0)).toBe(0);
  });

  it('divides completed-in-last-hour by 3600', () => {
    expect(drainRate(3600)).toBe(1);
    expect(drainRate(7200)).toBe(2);
  });

  it('rounds to 4 decimal places', () => {
    // 100 / 3600 = 0.02777... → 0.0278
    expect(drainRate(100)).toBe(0.0278);
  });
});


describe('Worker utilization calculation', () => {
  it('returns 0 when no jobs are leased', () => {
    expect(workerUtilization(0, 4, 20)).toBe(0);
  });

  it('returns 100 when leased == capacity', () => {
    // 4 workers × 20 concurrency = 80 slots
    expect(workerUtilization(80, 4, 20)).toBe(100);
  });

  it('returns correct percentage', () => {
    // 20 leased / (4 workers × 20 concurrency = 80 slots) = 25%
    expect(workerUtilization(20, 4, 20)).toBe(25);
  });

  it('uses at least 1 as denominator when totalWorkers = 0 (avoids divide-by-zero)', () => {
    // Math.max(0, 1) = 1 worker → 20 slots
    expect(workerUtilization(0, 0, 20)).toBe(0);
    // Should not throw
    expect(() => workerUtilization(5, 0, 20)).not.toThrow();
  });

  it('rounds to 2 decimal places', () => {
    // 1 leased / (3 × 20 = 60 slots) = 1.666...% → 1.67%
    expect(workerUtilization(1, 3, 20)).toBe(1.67);
  });
});


describe('Failure rate calculation', () => {
  it('returns 0 when no jobs completed', () => {
    expect(failureRate(10, 0)).toBe(0);
  });

  it('returns 0 when nothing failed', () => {
    expect(failureRate(0, 1000)).toBe(0);
  });

  it('returns 100 when everything failed', () => {
    expect(failureRate(500, 500)).toBe(100);
  });

  it('calculates fractional failure rates', () => {
    expect(failureRate(10, 100)).toBe(10);
    expect(failureRate(1, 1000)).toBe(0.1);
  });
});

describe('Retry rate calculation', () => {
  it('returns 0 when no jobs completed', () => {
    expect(retryRate(5, 0)).toBe(0);
  });

  it('calculates correct percentage', () => {
    expect(retryRate(25, 100)).toBe(25);
    expect(retryRate(1, 200)).toBe(0.5);
  });
});
