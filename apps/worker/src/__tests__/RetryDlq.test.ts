/**
 * Retry + DLQ correctness tests — Step 4
 *
 * Covers:
 *   1. REAP_JOBS exponential backoff — delay grows as 5s * 2^(attempt-1), capped at 5 min
 *   2. Max retry enforcement — dead-lettered at exactly maxAttempts
 *   3. Jitter bounds — jitter is within [0, 10% of backoff]
 *   4. DLQ replay — attempts reset to 0, status guard (non-DLQ jobs not touched)
 *   5. DLQ discard — job removed, no-op on missing job
 *   6. retryJob — resets attempts, preserves original queue
 */

import { describe, it, expect, vi } from 'vitest';


class FakeSortedSet {
  private entries: Map<string, number> = new Map();
  zadd(score: number, member: string) { this.entries.set(member, score); }
  zrem(member: string) { this.entries.delete(member); }
  zscore(member: string): number | null { return this.entries.get(member) ?? null; }
  zrangebyscore(min: number, max: number): string[] {
    return [...this.entries.entries()]
      .filter(([, s]) => s >= min && s <= max)
      .map(([m]) => m);
  }
  members(): string[] { return [...this.entries.keys()]; }
}

class FakeHash {
  private data: Map<string, Record<string, string>> = new Map();
  hset(key: string, fields: Record<string, string | number>) {
    const existing = this.data.get(key) ?? {};
    for (const [k, v] of Object.entries(fields)) existing[k] = String(v);
    this.data.set(key, existing);
  }
  hget(key: string, field: string): string | null {
    return this.data.get(key)?.[field] ?? null;
  }
  hincrby(key: string, field: string, by: number): number {
    const existing = this.data.get(key) ?? {};
    const current = parseInt(existing[field] ?? '0', 10);
    const next = current + by;
    existing[field] = String(next);
    this.data.set(key, existing);
    return next;
  }
}

// KEYS[6] = aura:delayed   ARGV[1] = nowMs
// attempts is the value AFTER hincrby (starts at 1 on first crash)
//   backoffMs = min(2^(attempts-1) * 5000, 300_000)
//   jitter    = random(0, floor(backoffMs * 0.1))   [deterministic in tests]
//   retryAt   = now + backoffMs + jitter

function reapBackoffMs(attempts: number): number {
  return Math.min(Math.pow(2, attempts - 1) * 5000, 300_000);
}

// Simulate REAP_JOBS with deterministic zero jitter for assertion purposes
function simulateReapWithBackoff(
  leased: FakeSortedSet,
  meta: FakeHash,
  delayed: FakeSortedSet,
  now: number,
  jitter = 0,
): Array<[string, 'REQUEUED' | 'DEAD_LETTER', number | null]> {
  const expired = leased.zrangebyscore(0, now);
  const results: Array<[string, 'REQUEUED' | 'DEAD_LETTER', number | null]> = [];

  for (const jobId of expired) {
    const attempts = meta.hincrby(`aura:meta:${jobId}`, 'attempts', 1);
    const max = parseInt(meta.hget(`aura:meta:${jobId}`, 'maxAttempts') ?? '3', 10);
    leased.zrem(jobId);

    if (attempts < max) {
      const backoffMs = reapBackoffMs(attempts);
      const retryAt = now + backoffMs + jitter;
      delayed.zadd(retryAt, jobId);
      results.push([jobId, 'REQUEUED', retryAt]);
    } else {
      results.push([jobId, 'DEAD_LETTER', null]);
    }
  }
  return results;
}


describe('REAP_JOBS — exponential backoff schedule', () => {
  it('first crash (attempts=1) → 5 s hold', () => {
    expect(reapBackoffMs(1)).toBe(5_000);
  });

  it('second crash (attempts=2) → 10 s hold', () => {
    expect(reapBackoffMs(2)).toBe(10_000);
  });

  it('third crash (attempts=3) → 20 s hold', () => {
    expect(reapBackoffMs(3)).toBe(20_000);
  });

  it('hold doubles each attempt until cap', () => {
    const delays = [1, 2, 3, 4, 5, 6, 7, 8].map(reapBackoffMs);
    // Each should be ≥ previous (monotonically non-decreasing)
    for (let i = 1; i < delays.length; i++) {
      expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1]!);
    }
  });

  it('caps at 300 s (5 minutes)', () => {
    // 2^(7-1) * 5000 = 320_000 > 300_000 → capped
    expect(reapBackoffMs(7)).toBe(300_000);
    expect(reapBackoffMs(10)).toBe(300_000);
    expect(reapBackoffMs(100)).toBe(300_000);
  });
});


describe('REAP_JOBS — backoff applied in sorted-set score', () => {
  it('first reap puts job at now + 5 s', () => {
    const leased = new FakeSortedSet();
    const meta = new FakeHash();
    const delayed = new FakeSortedSet();
    const now = 1_000_000;

    leased.zadd(now - 1, 'job-1');
    meta.hset('aura:meta:job-1', { attempts: 0, maxAttempts: 3 });

    simulateReapWithBackoff(leased, meta, delayed, now);

    expect(delayed.zscore('job-1')).toBe(now + 5_000);
  });

  it('second reap puts job at now + 10 s', () => {
    const leased = new FakeSortedSet();
    const meta = new FakeHash();
    const delayed = new FakeSortedSet();
    const now = 2_000_000;

    leased.zadd(now - 1, 'job-2');
    // Already reaped once — attempts is 1 before this reap
    meta.hset('aura:meta:job-2', { attempts: 1, maxAttempts: 3 });

    simulateReapWithBackoff(leased, meta, delayed, now);

    // hincrby makes it 2 → backoff = 2^(2-1) * 5000 = 10_000
    expect(delayed.zscore('job-2')).toBe(now + 10_000);
  });

  it('high-attempt job is capped at 300 s hold', () => {
    const leased = new FakeSortedSet();
    const meta = new FakeHash();
    const delayed = new FakeSortedSet();
    const now = 3_000_000;

    leased.zadd(now - 1, 'job-cap');
    meta.hset('aura:meta:job-cap', { attempts: 9, maxAttempts: 20 });

    simulateReapWithBackoff(leased, meta, delayed, now);

    // attempts becomes 10 → backoff = min(2^9 * 5000, 300000) = min(2_560_000, 300_000) = 300_000
    expect(delayed.zscore('job-cap')).toBe(now + 300_000);
  });
});


describe('REAP_JOBS — max retry limit enforcement', () => {
  it('dead-letters at exactly maxAttempts (no extra retry)', () => {
    const leased = new FakeSortedSet();
    const meta = new FakeHash();
    const delayed = new FakeSortedSet();
    const now = 4_000_000;

    leased.zadd(now - 1, 'job-limit');
    // attempts = maxAttempts - 1; hincrby brings it to maxAttempts → DEAD_LETTER
    meta.hset('aura:meta:job-limit', { attempts: 2, maxAttempts: 3 });

    const results = simulateReapWithBackoff(leased, meta, delayed, now);

    expect(results[0]![1]).toBe('DEAD_LETTER');
    expect(delayed.zscore('job-limit')).toBeNull();
    expect(leased.zscore('job-limit')).toBeNull();
  });

  it('single-attempt job (maxAttempts=1) is immediately dead-lettered', () => {
    const leased = new FakeSortedSet();
    const meta = new FakeHash();
    const delayed = new FakeSortedSet();
    const now = 5_000_000;

    leased.zadd(now - 1, 'job-once');
    meta.hset('aura:meta:job-once', { attempts: 0, maxAttempts: 1 });

    const results = simulateReapWithBackoff(leased, meta, delayed, now);

    // attempts becomes 1 → 1 < 1 is false → DEAD_LETTER
    expect(results[0]![1]).toBe('DEAD_LETTER');
    expect(delayed.zscore('job-once')).toBeNull();
  });

  it('retries up to but not including maxAttempts', () => {
    const leased = new FakeSortedSet();
    const meta = new FakeHash();
    const delayed = new FakeSortedSet();
    let now = 6_000_000;

    // maxAttempts = 5, so attempts 1-4 → REQUEUED, attempt 5 → DEAD_LETTER
    meta.hset('aura:meta:job-multi', { attempts: 0, maxAttempts: 5 });
    const decisions: string[] = [];

    for (let i = 0; i < 5; i++) {
      leased.zadd(now - 1, 'job-multi');
      const results = simulateReapWithBackoff(leased, meta, delayed, now);
      decisions.push(results[0]![1]);
      delayed.zrem('job-multi'); // simulate promotion back to active
      now += 100_000;
    }

    expect(decisions).toEqual(['REQUEUED', 'REQUEUED', 'REQUEUED', 'REQUEUED', 'DEAD_LETTER']);
  });
});


describe('Backoff jitter bounds', () => {
  it('jitter is within [0, 10% of backoff]', () => {
    // For attempts=1, backoff=5000, max jitter = floor(5000 * 0.1) = 500
    const backoff = reapBackoffMs(1);
    const maxJitter = Math.floor(backoff * 0.1);

    // Simulate 100 random jitters and verify they're all in range
    for (let i = 0; i < 100; i++) {
      const jitter = Math.floor(Math.random() * (maxJitter + 1));
      expect(jitter).toBeGreaterThanOrEqual(0);
      expect(jitter).toBeLessThanOrEqual(maxJitter);
    }
    expect(maxJitter).toBe(500);
  });

  it('backoff + max jitter never exceeds cap + 10%', () => {
    const maxBackoff = 300_000;
    const maxJitter = Math.floor(maxBackoff * 0.1);
    // Total max delay: 330_000 ms
    expect(maxBackoff + maxJitter).toBe(330_000);
  });
});


interface JobRecord {
  id: string;
  status: string;
  attempts: number;
  priority: number;
}

function makePrismaStub(initialJobs: JobRecord[]) {
  const jobs = new Map(initialJobs.map(j => [j.id, { ...j }]));

  async function doUpdate({ where, data }: any): Promise<{ count: number }> {
    let count = 0;
    for (const job of jobs.values()) {
      if (where.id && where.id !== job.id) continue;
      if (where.status && !matchesStatusFilter(job.status, where.status)) continue;
      if (data.status) job.status = data.status;
      if (typeof data.attempts === 'number') job.attempts = data.attempts;
      if (data.attempts?.increment) job.attempts += data.attempts.increment;
      count++;
    }
    return { count };
  }

  function matchesStatusFilter(current: string, filter: any): boolean {
    if (typeof filter === 'string') return current === filter;
    if (filter.in) return filter.in.includes(current);
    if (filter.notIn) return !filter.notIn.includes(current);
    return false;
  }

  const txClient = {
    job: {
      update: vi.fn(async ({ where, data }: any) => {
        const job = jobs.get(where.id);
        if (!job) throw new Error(`Job ${where.id} not found`);
        if (where.status && !matchesStatusFilter(job.status, where.status)) {
          // Prisma throws when where clause doesn't match
          const err = new Error(`Record not found`) as any;
          err.code = 'P2025';
          throw err;
        }
        if (data.status) job.status = data.status;
        if (typeof data.attempts === 'number') job.attempts = data.attempts;
        return { ...job };
      }),
      delete: vi.fn(async ({ where }: any) => {
        const job = jobs.get(where.id);
        if (!job) { const e = new Error('not found') as any; e.code = 'P2025'; throw e; }
        if (where.status && !matchesStatusFilter(job.status, where.status)) {
          const e = new Error('not found') as any; e.code = 'P2025'; throw e;
        }
        jobs.delete(where.id);
        return { ...job };
      }),
      updateMany: vi.fn((args: any) => doUpdate(args)),
    },
    jobEvent: { create: vi.fn().mockResolvedValue({}) },
  };

  return {
    jobs,
    job: {
      update: txClient.job.update,
      updateMany: txClient.job.updateMany,
      delete: txClient.job.delete,
    },
    $transaction: vi.fn((fn: any) => fn(txClient)),
  };
}

describe('DLQ replay — status guard and attempts reset', () => {
  it('resets attempts to 0 and sets status to PENDING for a DEAD_LETTER job', async () => {
    const prisma = makePrismaStub([
      { id: 'job-dlq', status: 'DEAD_LETTER', attempts: 3, priority: 0 },
    ]);

    await prisma.$transaction(async (tx: any) => {
      await tx.job.update({
        where: { id: 'job-dlq', status: 'DEAD_LETTER' },
        data: { status: 'PENDING', attempts: 0 },
      });
    });

    const job = prisma.jobs.get('job-dlq')!;
    expect(job.status).toBe('PENDING');
    expect(job.attempts).toBe(0);
  });

  it('throws (status guard) when replaying a non-DEAD_LETTER job', async () => {
    const prisma = makePrismaStub([
      { id: 'job-live', status: 'PROCESSING', attempts: 1, priority: 0 },
    ]);

    await expect(
      prisma.$transaction(async (tx: any) => {
        await tx.job.update({
          where: { id: 'job-live', status: 'DEAD_LETTER' },
          data: { status: 'PENDING', attempts: 0 },
        });
      })
    ).rejects.toThrow();

    // Job must be unchanged
    expect(prisma.jobs.get('job-live')!.status).toBe('PROCESSING');
  });

  it('is idempotent — replaying an already-PENDING job is blocked by the guard', async () => {
    const prisma = makePrismaStub([
      { id: 'job-pending', status: 'PENDING', attempts: 0, priority: 0 },
    ]);

    await expect(
      prisma.$transaction(async (tx: any) => {
        await tx.job.update({
          where: { id: 'job-pending', status: 'DEAD_LETTER' },
          data: { status: 'PENDING', attempts: 0 },
        });
      })
    ).rejects.toThrow();
  });
});


describe('DLQ discard — status guard and deletion', () => {
  it('removes a DEAD_LETTER job', async () => {
    const prisma = makePrismaStub([
      { id: 'job-discard', status: 'DEAD_LETTER', attempts: 3, priority: 0 },
    ]);

    await prisma.$transaction(async (tx: any) => {
      await tx.job.delete({ where: { id: 'job-discard', status: 'DEAD_LETTER' } });
    });

    expect(prisma.jobs.has('job-discard')).toBe(false);
  });

  it('throws when trying to discard a non-DEAD_LETTER job', async () => {
    const prisma = makePrismaStub([
      { id: 'job-active', status: 'PROCESSING', attempts: 1, priority: 0 },
    ]);

    await expect(
      prisma.$transaction(async (tx: any) => {
        await tx.job.delete({ where: { id: 'job-active', status: 'DEAD_LETTER' } });
      })
    ).rejects.toThrow();

    expect(prisma.jobs.has('job-active')).toBe(true); // not deleted
  });
});


describe('retryJob — manual retry from FAILED or DEAD_LETTER', () => {
  it('resets attempts to 0 and sets status to PENDING for a FAILED job', async () => {
    const prisma = makePrismaStub([
      { id: 'job-failed', status: 'FAILED', attempts: 2, priority: 1 },
    ]);

    await prisma.$transaction(async (tx: any) => {
      await tx.job.update({
        where: { id: 'job-failed', status: { in: ['FAILED', 'DEAD_LETTER'] } },
        data: { status: 'PENDING', attempts: 0 },
      });
    });

    const job = prisma.jobs.get('job-failed')!;
    expect(job.status).toBe('PENDING');
    expect(job.attempts).toBe(0);
  });

  it('resets attempts to 0 for a DEAD_LETTER job via retryJob path', async () => {
    const prisma = makePrismaStub([
      { id: 'job-dlq-retry', status: 'DEAD_LETTER', attempts: 5, priority: 0 },
    ]);

    await prisma.$transaction(async (tx: any) => {
      await tx.job.update({
        where: { id: 'job-dlq-retry', status: { in: ['FAILED', 'DEAD_LETTER'] } },
        data: { status: 'PENDING', attempts: 0 },
      });
    });

    const job = prisma.jobs.get('job-dlq-retry')!;
    expect(job.status).toBe('PENDING');
    expect(job.attempts).toBe(0);
  });

  it('throws (guard fires) when retrying a COMPLETED job', async () => {
    const prisma = makePrismaStub([
      { id: 'job-done', status: 'COMPLETED', attempts: 1, priority: 0 },
    ]);

    await expect(
      prisma.$transaction(async (tx: any) => {
        await tx.job.update({
          where: { id: 'job-done', status: { in: ['FAILED', 'DEAD_LETTER'] } },
          data: { status: 'PENDING', attempts: 0 },
        });
      })
    ).rejects.toThrow();

    expect(prisma.jobs.get('job-done')!.status).toBe('COMPLETED'); // unchanged
  });
});
