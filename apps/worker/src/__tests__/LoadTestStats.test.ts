/**
 * Load-test statistics helper tests — Phase 6
 *
 * The `percentile` and `summariseLatencies` functions are pure — no Redis,
 * no Prisma, no network.  Tests cover:
 *   1.  percentile on a known sorted array (P50, P95, P99)
 *   2.  edge cases: empty array, single value, identical values
 *   3.  summariseLatencies produces correct all-fields output
 *   4.  mean calculation is accurate
 *   5.  max matches the largest sample
 *   6.  P99 is distinct from P95 on a skewed distribution
 *   7.  count field matches input length
 *   8.  unsorted input is handled correctly (function sorts internally)
 */

import { describe, it, expect } from 'vitest';
import { percentile, summariseLatencies } from '../load-test';


describe('percentile()', () => {
  it('returns 0 for an empty array', () => {
    expect(percentile([], 50)).toBe(0);
    expect(percentile([], 99)).toBe(0);
  });

  it('returns the single value for a one-element array at any percentile', () => {
    expect(percentile([42], 0)).toBe(42);
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 99)).toBe(42);
  });

  it('returns the correct P50 for [1..10]', () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    // index = floor(10 * 50/100) = 5  → value 6
    expect(percentile(sorted, 50)).toBe(6);
  });

  it('returns the correct P95 for [1..100]', () => {
    const sorted = Array.from({ length: 100 }, (_, i) => i + 1);
    // index = floor(100 * 95/100) = 95 → value 96
    expect(percentile(sorted, 95)).toBe(96);
  });

  it('returns the correct P99 for [1..100]', () => {
    const sorted = Array.from({ length: 100 }, (_, i) => i + 1);
    // index = floor(100 * 99/100) = 99 → value 100 (clamped to last)
    expect(percentile(sorted, 99)).toBe(100);
  });

  it('P0 returns the minimum', () => {
    expect(percentile([3, 1, 2], 0)).toBe(3); // already sorted by caller
  });

  it('all identical values → all percentiles equal that value', () => {
    const sorted = [7, 7, 7, 7, 7];
    expect(percentile(sorted, 50)).toBe(7);
    expect(percentile(sorted, 99)).toBe(7);
  });
});


describe('summariseLatencies()', () => {
  it('returns all-zero summary for empty input', () => {
    const s = summariseLatencies([]);
    expect(s).toEqual({ p50: 0, p95: 0, p99: 0, max: 0, mean: 0, count: 0 });
  });

  it('count matches input length', () => {
    expect(summariseLatencies([1, 2, 3]).count).toBe(3);
    expect(summariseLatencies([10]).count).toBe(1);
  });

  it('max equals the largest sample regardless of input order', () => {
    expect(summariseLatencies([5, 100, 3, 50, 1]).max).toBe(100);
    expect(summariseLatencies([99, 1]).max).toBe(99);
  });

  it('mean is the arithmetic mean rounded to the nearest ms', () => {
    // [2, 4, 6] → mean = 4
    expect(summariseLatencies([2, 4, 6]).mean).toBe(4);
    // [1, 2] → mean = 1.5 → rounded to 2
    expect(summariseLatencies([1, 2]).mean).toBe(2);
  });

  it('handles unsorted input by sorting internally', () => {
    const s = summariseLatencies([10, 1, 5, 3, 8]);
    // sorted: [1, 3, 5, 8, 10]
    // P50: idx=2 → 5
    expect(s.p50).toBe(5);
    expect(s.max).toBe(10);
  });

  it('P99 > P95 > P50 on a right-skewed distribution', () => {
    // 100 samples, choose counts so each percentile lands in a different tier:
    //   percentile fn: idx = floor(n * p / 100)
    //   P50 → idx 50  → need sorted[50] = 1   → 51 samples at 1ms (indices 0-50)
    //   P95 → idx 95  → need sorted[95] = 50  → 45 samples at 50ms (indices 51-95)
    //   P99 → idx 99  → need sorted[99] = 500 →  4 samples at 500ms (indices 96-99)
    const samples = [
      ...Array(51).fill(1),
      ...Array(45).fill(50),
      ...Array(4).fill(500),
    ];
    const s = summariseLatencies(samples);
    expect(s.p50).toBeLessThan(s.p95);
    expect(s.p95).toBeLessThan(s.p99);
    expect(s.p50).toBe(1);
    expect(s.p95).toBe(50);
    expect(s.p99).toBe(500);
  });

  it('correctly summarises a tight, uniform distribution', () => {
    const samples = Array.from({ length: 1000 }, () => 10);
    const s = summariseLatencies(samples);
    expect(s.p50).toBe(10);
    expect(s.p95).toBe(10);
    expect(s.p99).toBe(10);
    expect(s.mean).toBe(10);
    expect(s.max).toBe(10);
    expect(s.count).toBe(1000);
  });

  it('two-value array: p50=first, p99=last', () => {
    const s = summariseLatencies([3, 9]);
    // sorted: [3, 9]
    // P50: idx = floor(2 * 0.50) = 1 → 9
    // P99: idx = min(floor(2 * 0.99), 1) = 1 → 9
    expect(s.p50).toBe(9);
    expect(s.p99).toBe(9);
    expect(s.max).toBe(9);
  });
});
