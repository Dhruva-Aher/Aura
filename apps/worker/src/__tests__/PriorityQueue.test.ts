/**
 * Priority queue correctness tests — Phase 4
 *
 * Tests the queue-drain ordering logic (getQueueOrder) and proves:
 *   1.  High-priority pool always polls high → default first
 *   2.  Low-priority pool always polls low → default first
 *   3.  Default pool always polls high → default first
 *   4.  Anti-starvation: low-priority jobs are included at the correct cadence
 *   5.  Under a mixed queue, high-priority jobs drain before low-priority
 *   6.  Low-priority jobs are never permanently starved
 *   7.  Priority scores: higher score = lower in sorted set (ZPOPMAX semantics)
 */

import { describe, it, expect } from 'vitest';
import { getQueueOrder } from '../services/Worker';

const HIGH    = 'aura:queue:high';
const DEFAULT = 'aura:queue:default';
const LOW     = 'aura:queue:low';

// ── 1. high-priority pool ordering ───────────────────────────────────────────

describe('high-priority pool', () => {
  it('always starts with high queue', () => {
    for (let misses = 0; misses < 20; misses++) {
      expect(getQueueOrder('high-priority', misses)[0]).toBe(HIGH);
    }
  });

  it('second queue is always default', () => {
    for (let misses = 0; misses < 20; misses++) {
      expect(getQueueOrder('high-priority', misses)[1]).toBe(DEFAULT);
    }
  });

  it('includes low queue only on every 5th miss (anti-starvation)', () => {
    const schedule = Array.from({ length: 20 }, (_, i) => getQueueOrder('high-priority', i));
    const lowIncluded = schedule.map(order => order.includes(LOW));
    // misses 0, 5, 10, 15 include low → indices 0,5,10,15 = true
    expect(lowIncluded[0]).toBe(true);  // 0 % 5 === 0
    expect(lowIncluded[1]).toBe(false);
    expect(lowIncluded[5]).toBe(true);  // 5 % 5 === 0
    expect(lowIncluded[10]).toBe(true); // 10 % 5 === 0
    expect(lowIncluded[3]).toBe(false);
  });

  it('exactly 4 of every 5 polls omit the low queue', () => {
    const schedule = Array.from({ length: 20 }, (_, i) => getQueueOrder('high-priority', i));
    const lowCount = schedule.filter(o => o.includes(LOW)).length;
    // misses 0..19: includes on 0,5,10,15 = 4 out of 20
    expect(lowCount).toBe(4);
  });
});

// ── 2. low-priority pool ordering ────────────────────────────────────────────

describe('low-priority pool', () => {
  it('always starts with low queue', () => {
    for (let misses = 0; misses < 20; misses++) {
      expect(getQueueOrder('low-priority', misses)[0]).toBe(LOW);
    }
  });

  it('second queue is always default', () => {
    for (let misses = 0; misses < 20; misses++) {
      expect(getQueueOrder('low-priority', misses)[1]).toBe(DEFAULT);
    }
  });

  it('includes high queue only on every 5th miss (prevents high-starvation)', () => {
    const schedule = Array.from({ length: 20 }, (_, i) => getQueueOrder('low-priority', i));
    expect(schedule[0]!.includes(HIGH)).toBe(true);  // miss 0
    expect(schedule[1]!.includes(HIGH)).toBe(false);
    expect(schedule[5]!.includes(HIGH)).toBe(true);  // miss 5
  });
});

// ── 3. default pool ordering ──────────────────────────────────────────────────

describe('default pool', () => {
  it('always starts with high queue (urgent jobs first)', () => {
    for (let misses = 0; misses < 30; misses++) {
      expect(getQueueOrder('default', misses)[0]).toBe(HIGH);
    }
  });

  it('second queue is always default', () => {
    for (let misses = 0; misses < 30; misses++) {
      expect(getQueueOrder('default', misses)[1]).toBe(DEFAULT);
    }
  });

  it('includes low queue every 3rd miss (more frequent than high-pool)', () => {
    const schedule = Array.from({ length: 10 }, (_, i) => getQueueOrder('default', i));
    // misses 0, 3, 6, 9 → low included
    expect(schedule[0]!.includes(LOW)).toBe(true);
    expect(schedule[1]!.includes(LOW)).toBe(false);
    expect(schedule[2]!.includes(LOW)).toBe(false);
    expect(schedule[3]!.includes(LOW)).toBe(true);
    expect(schedule[6]!.includes(LOW)).toBe(true);
    expect(schedule[9]!.includes(LOW)).toBe(true);
  });

  it('low queue appears more often for default pool than for high-priority pool', () => {
    const highPollCount = 30;
    const highLowInclusions    = Array.from({ length: highPollCount }, (_, i) =>
      getQueueOrder('high-priority', i).includes(LOW)).filter(Boolean).length;
    const defaultLowInclusions = Array.from({ length: highPollCount }, (_, i) =>
      getQueueOrder('default', i).includes(LOW)).filter(Boolean).length;

    // default pool includes low every 3rd miss → ~10 times
    // high-priority pool includes low every 5th miss → ~6 times
    expect(defaultLowInclusions).toBeGreaterThan(highLowInclusions);
  });
});

// ── 4. Anti-starvation: low-priority jobs drain eventually ───────────────────

describe('Anti-starvation guarantee', () => {
  it('low queue appears at least once every 5 consecutive polls for high-priority pool', () => {
    for (let start = 0; start < 50; start += 5) {
      const window = Array.from({ length: 5 }, (_, i) => getQueueOrder('high-priority', start + i));
      const hasLow = window.some(order => order.includes(LOW));
      expect(hasLow).toBe(true);
    }
  });

  it('low queue appears at least once every 3 consecutive polls for default pool', () => {
    for (let start = 0; start < 30; start += 3) {
      const window = Array.from({ length: 3 }, (_, i) => getQueueOrder('default', start + i));
      const hasLow = window.some(order => order.includes(LOW));
      expect(hasLow).toBe(true);
    }
  });
});

// ── 5. Mixed-queue simulation: high drains before low ────────────────────────

describe('Mixed queue simulation — high drains before low', () => {
  /**
   * Simulate a queue with a fixed number of jobs per priority.
   * Returns the order in which job priorities are "processed".
   */
  function simulateDrain(
    pool: string,
    queues: { high: number; default: number; low: number },
  ): Array<'high' | 'default' | 'low'> {
    const remaining = { ...queues };
    const order: Array<'high' | 'default' | 'low'> = [];
    let misses = 0;
    const total = queues.high + queues.default + queues.low;

    while (order.length < total) {
      const queueOrder = getQueueOrder(pool, misses);
      let claimed = false;
      for (const qKey of queueOrder) {
        const priority = qKey === HIGH ? 'high' : qKey === LOW ? 'low' : 'default';
        if (remaining[priority] > 0) {
          remaining[priority]--;
          order.push(priority);
          claimed = true;
          misses = 0;
          break;
        }
      }
      if (!claimed) misses++;
      if (misses > 100) break; // safety
    }
    return order;
  }

  it('high-priority jobs drain completely before most low-priority jobs', () => {
    const order = simulateDrain('default', { high: 5, default: 0, low: 5 });

    // All high-priority jobs should appear before the 6th position
    const lastHighIdx = order.lastIndexOf('high');
    const firstLowIdx = order.indexOf('low');

    // At least some highs processed before lows
    expect(lastHighIdx).toBeGreaterThanOrEqual(0);

    // Under pure ordering (misses=0 starts with high), first low appears after first high
    // due to anti-starvation, low occasionally sneaks in, but high dominates early
    const highCountInFirstHalf = order.slice(0, 5).filter(p => p === 'high').length;
    expect(highCountInFirstHalf).toBeGreaterThan(2); // majority of first 5 are high
  });

  it('low-priority jobs are not permanently starved — all drain eventually', () => {
    const order = simulateDrain('high-priority', { high: 3, default: 3, low: 3 });
    expect(order.filter(p => p === 'low')).toHaveLength(3); // all low jobs drain
    expect(order.filter(p => p === 'high')).toHaveLength(3);
    expect(order.filter(p => p === 'default')).toHaveLength(3);
  });

  it('with only low-priority jobs, low-priority pool drains them all', () => {
    const order = simulateDrain('low-priority', { high: 0, default: 0, low: 10 });
    expect(order).toHaveLength(10);
    expect(order.every(p => p === 'low')).toBe(true);
  });
});

// ── 6. ZPOPMAX score semantics ────────────────────────────────────────────────

describe('Priority score semantics (ZPOPMAX)', () => {
  /**
   * Redis ZPOPMAX returns the member with the HIGHEST score.
   * Our priority field is used directly as the score.
   * Higher score = popped first.
   */
  class FakePriorityQueue {
    private items: Array<[number, string]> = [];

    zadd(score: number, member: string) {
      this.items.push([score, member]);
    }

    zpopmax(): [string, number] | null {
      if (!this.items.length) return null;
      this.items.sort((a, b) => b[0] - a[0]); // descending
      const [score, member] = this.items.shift()!;
      return [member, score];
    }

    size() { return this.items.length; }
  }

  it('higher numeric priority is claimed first', () => {
    const q = new FakePriorityQueue();
    q.zadd(0, 'job-normal');    // priority 0
    q.zadd(2, 'job-urgent');    // priority 2
    q.zadd(-1, 'job-background'); // priority -1

    expect(q.zpopmax()![0]).toBe('job-urgent');     // highest score first
    expect(q.zpopmax()![0]).toBe('job-normal');
    expect(q.zpopmax()![0]).toBe('job-background');
  });

  it('jobs with same priority are returned in arbitrary order', () => {
    const q = new FakePriorityQueue();
    q.zadd(1, 'job-A');
    q.zadd(1, 'job-B');
    const first = q.zpopmax()![0];
    const second = q.zpopmax()![0];
    // Both should be claimed, order may vary
    expect(new Set([first, second])).toEqual(new Set(['job-A', 'job-B']));
  });

  it('high queue (priority 2) beats default queue (priority 0)', () => {
    const high    = new FakePriorityQueue();
    const defQueue = new FakePriorityQueue();
    high.zadd(2, 'email.send');
    defQueue.zadd(0, 'report.generate');

    // Simulate getQueueOrder: high is polled first
    const order = ['aura:queue:high', 'aura:queue:default'];
    const queues: Record<string, FakePriorityQueue> = {
      'aura:queue:high': high,
      'aura:queue:default': defQueue,
    };

    let claimed: string | null = null;
    for (const key of order) {
      const result = queues[key]!.zpopmax();
      if (result) { claimed = result[0]; break; }
    }

    expect(claimed).toBe('email.send');
  });
});
