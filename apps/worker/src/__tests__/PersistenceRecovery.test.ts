/**
 * Persistence recovery tests — Phase 5
 *
 * Simulates a "Redis wipe" scenario: all queue data is gone but Postgres has
 * PENDING jobs.  Verifies that the reconciliation logic restores them correctly.
 *
 * Uses in-memory fakes for both the database (Postgres) and Redis so tests
 * run without any infrastructure.
 *
 * Covers:
 *   1.  Redis wipe → all PENDING jobs are restored to correct queues
 *   2.  Jobs already in a Redis queue are skipped (no duplicate zadd)
 *   3.  Jobs in aura:leased (currently processing) are skipped
 *   4.  Jobs in aura:delayed are skipped
 *   5.  Meta hash is written (priority, attempts, maxAttempts, queue)
 *   6.  Batch processing: large backlog restores in pages
 *   7.  Queue routing: high/low/default based on meta hash
 *   8.  Jobs with no meta default to 'default' queue
 *   9.  COMPLETED/FAILED/DEAD_LETTER jobs are not restored
 *  10.  Mixed state: some jobs already in Redis, some orphaned — only orphans restored
 */

import { describe, it, expect, vi } from 'vitest';


class FakeRedis {
  private sortedSets = new Map<string, Map<string, number>>();
  private hashes      = new Map<string, Map<string, string>>();
  private pipeOps: Array<() => void> = [];

  // Sorted set operations
  zadd(key: string, score: number, member: string) {
    const set = this.sortedSets.get(key) ?? new Map<string, number>();
    set.set(member, score);
    this.sortedSets.set(key, set);
  }

  zscore(key: string, member: string): Promise<number | null> {
    const score = this.sortedSets.get(key)?.get(member);
    return Promise.resolve(score !== undefined ? score : null);
  }

  zcard(key: string): number {
    return this.sortedSets.get(key)?.size ?? 0;
  }

  members(key: string): string[] {
    return [...(this.sortedSets.get(key)?.keys() ?? [])];
  }

  // Hash operations
  hset(key: string, fields: Record<string, string | number>) {
    const hash = this.hashes.get(key) ?? new Map<string, string>();
    for (const [k, v] of Object.entries(fields)) hash.set(k, String(v));
    this.hashes.set(key, hash);
  }

  hget(key: string, field: string): Promise<string | null> {
    return Promise.resolve(this.hashes.get(key)?.get(field) ?? null);
  }

  getHashField(key: string, field: string): string | null {
    return this.hashes.get(key)?.get(field) ?? null;
  }

  // Pipeline (collect then execute)
  pipeline() {
    const ops: Array<() => void> = [];
    const pipe = {
      zadd: (key: string, score: number, member: string) => {
        ops.push(() => this.zadd(key, score, member));
        return pipe;
      },
      hset: (key: string, fields: Record<string, string | number>) => {
        ops.push(() => this.hset(key, fields));
        return pipe;
      },
      exec: async () => {
        ops.forEach(op => op());
        return [];
      },
    };
    return pipe;
  }
}


interface FakeJob {
  id: string;
  status: string;
  priority: number;
  attempts: number;
  maxAttempts: number;
}

class FakeDb {
  private jobs: FakeJob[];

  constructor(jobs: FakeJob[]) { this.jobs = jobs; }

  findPending(take: number, cursor?: string): FakeJob[] {
    const pending = this.jobs.filter(j => j.status === 'PENDING');
    const start = cursor ? pending.findIndex(j => j.id === cursor) + 1 : 0;
    return pending.slice(start, start + take);
  }
}


async function reconcilePending(
  db: FakeDb,
  redis: FakeRedis,
  batchSize = 100,
): Promise<{ restored: number; skipped: number }> {
  let cursor: string | undefined;
  let totalRestored = 0;
  let totalSkipped  = 0;

  while (true) {
    const jobs = db.findPending(batchSize, cursor);
    if (jobs.length === 0) break;
    cursor = jobs[jobs.length - 1]!.id;

    for (const job of jobs) {
      const [high, def, low, delayed, leased] = await Promise.all([
        redis.zscore('aura:queue:high',    job.id),
        redis.zscore('aura:queue:default', job.id),
        redis.zscore('aura:queue:low',     job.id),
        redis.zscore('aura:delayed',       job.id),
        redis.zscore('aura:leased',        job.id),
      ]);
      if (high !== null || def !== null || low !== null || delayed !== null || leased !== null) {
        totalSkipped++;
        continue;
      }

      const queueRaw = await redis.hget(`aura:meta:${job.id}`, 'queue');
      const queueName = queueRaw === 'high' ? 'high' : queueRaw === 'low' ? 'low' : 'default';
      const activeKey = `aura:queue:${queueName}`;

      const pipe = redis.pipeline();
      pipe.zadd(activeKey, job.priority, job.id);
      pipe.hset(`aura:meta:${job.id}`, {
        priority:    job.priority,
        attempts:    job.attempts,
        maxAttempts: job.maxAttempts,
        queue:       queueName,
      });
      await pipe.exec();
      totalRestored++;
    }

    if (jobs.length < batchSize) break;
  }

  return { restored: totalRestored, skipped: totalSkipped };
}


describe('Redis wipe → all PENDING jobs restored', () => {
  it('restores 3 PENDING jobs after Redis wipe', async () => {
    const db = new FakeDb([
      { id: 'j1', status: 'PENDING', priority: 0, attempts: 0, maxAttempts: 3 },
      { id: 'j2', status: 'PENDING', priority: 0, attempts: 0, maxAttempts: 3 },
      { id: 'j3', status: 'PENDING', priority: 0, attempts: 0, maxAttempts: 3 },
    ]);
    const redis = new FakeRedis();

    const { restored, skipped } = await reconcilePending(db, redis);

    expect(restored).toBe(3);
    expect(skipped).toBe(0);
    expect(redis.members('aura:queue:default')).toHaveLength(3);
  });

  it('non-PENDING jobs (COMPLETED, FAILED, DEAD_LETTER) are not restored', async () => {
    const db = new FakeDb([
      { id: 'j1', status: 'PENDING',     priority: 0, attempts: 1, maxAttempts: 3 },
      { id: 'j2', status: 'COMPLETED',   priority: 0, attempts: 3, maxAttempts: 3 },
      { id: 'j3', status: 'FAILED',      priority: 0, attempts: 3, maxAttempts: 3 },
      { id: 'j4', status: 'DEAD_LETTER', priority: 0, attempts: 3, maxAttempts: 3 },
    ]);
    const redis = new FakeRedis();

    const { restored } = await reconcilePending(db, redis);

    expect(restored).toBe(1);
    expect(redis.members('aura:queue:default')).toEqual(['j1']);
  });
});

describe('Skip already-queued jobs (duplicate protection)', () => {
  it('skips jobs already in aura:queue:default', async () => {
    const db = new FakeDb([
      { id: 'j1', status: 'PENDING', priority: 0, attempts: 0, maxAttempts: 3 },
    ]);
    const redis = new FakeRedis();
    redis.zadd('aura:queue:default', 0, 'j1'); // already present

    const { restored, skipped } = await reconcilePending(db, redis);

    expect(restored).toBe(0);
    expect(skipped).toBe(1);
  });

  it('skips jobs in aura:leased (currently processing)', async () => {
    const db = new FakeDb([
      { id: 'j1', status: 'PENDING', priority: 0, attempts: 0, maxAttempts: 3 },
    ]);
    const redis = new FakeRedis();
    redis.zadd('aura:leased', Date.now() + 30_000, 'j1');

    const { skipped } = await reconcilePending(db, redis);
    expect(skipped).toBe(1);
  });

  it('skips jobs in aura:delayed', async () => {
    const db = new FakeDb([
      { id: 'j1', status: 'PENDING', priority: 0, attempts: 0, maxAttempts: 3 },
    ]);
    const redis = new FakeRedis();
    redis.zadd('aura:delayed', Date.now() + 10_000, 'j1');

    const { skipped } = await reconcilePending(db, redis);
    expect(skipped).toBe(1);
  });
});

describe('Queue routing based on meta hash', () => {
  it('routes to aura:queue:high when meta.queue=high', async () => {
    const db = new FakeDb([
      { id: 'j-high', status: 'PENDING', priority: 2, attempts: 0, maxAttempts: 3 },
    ]);
    const redis = new FakeRedis();
    redis.hset('aura:meta:j-high', { queue: 'high' });

    await reconcilePending(db, redis);

    expect(redis.members('aura:queue:high')).toContain('j-high');
    expect(redis.members('aura:queue:default')).not.toContain('j-high');
  });

  it('routes to aura:queue:low when meta.queue=low', async () => {
    const db = new FakeDb([
      { id: 'j-low', status: 'PENDING', priority: -1, attempts: 0, maxAttempts: 3 },
    ]);
    const redis = new FakeRedis();
    redis.hset('aura:meta:j-low', { queue: 'low' });

    await reconcilePending(db, redis);

    expect(redis.members('aura:queue:low')).toContain('j-low');
  });

  it('defaults to aura:queue:default when no meta exists', async () => {
    const db = new FakeDb([
      { id: 'j-nometa', status: 'PENDING', priority: 0, attempts: 0, maxAttempts: 3 },
    ]);
    const redis = new FakeRedis();
    // No hset for meta — hget returns null

    await reconcilePending(db, redis);

    expect(redis.members('aura:queue:default')).toContain('j-nometa');
  });
});

describe('Meta hash is written on restore', () => {
  it('writes priority, attempts, maxAttempts, queue to meta hash', async () => {
    const db = new FakeDb([
      { id: 'j1', status: 'PENDING', priority: 1, attempts: 2, maxAttempts: 5 },
    ]);
    const redis = new FakeRedis();

    await reconcilePending(db, redis);

    expect(redis.getHashField('aura:meta:j1', 'priority')).toBe('1');
    expect(redis.getHashField('aura:meta:j1', 'attempts')).toBe('2');
    expect(redis.getHashField('aura:meta:j1', 'maxAttempts')).toBe('5');
    expect(redis.getHashField('aura:meta:j1', 'queue')).toBe('default');
  });
});

describe('Batch processing', () => {
  it('restores all jobs when backlog exceeds batch size', async () => {
    const jobs = Array.from({ length: 25 }, (_, i) => ({
      id: `j-${i.toString().padStart(3, '0')}`,
      status: 'PENDING',
      priority: 0,
      attempts: 0,
      maxAttempts: 3,
    }));
    const db = new FakeDb(jobs);
    const redis = new FakeRedis();

    const { restored } = await reconcilePending(db, redis, /* batchSize */ 10);

    expect(restored).toBe(25);
    expect(redis.zcard('aura:queue:default')).toBe(25);
  });
});

describe('Mixed state: some orphaned, some already queued', () => {
  it('only restores truly orphaned jobs', async () => {
    const db = new FakeDb([
      { id: 'j1', status: 'PENDING', priority: 0, attempts: 0, maxAttempts: 3 }, // orphaned
      { id: 'j2', status: 'PENDING', priority: 0, attempts: 0, maxAttempts: 3 }, // already in queue
      { id: 'j3', status: 'PENDING', priority: 0, attempts: 0, maxAttempts: 3 }, // in leased
      { id: 'j4', status: 'PENDING', priority: 0, attempts: 0, maxAttempts: 3 }, // orphaned
    ]);
    const redis = new FakeRedis();
    redis.zadd('aura:queue:default', 0, 'j2');
    redis.zadd('aura:leased',        Date.now() + 30_000, 'j3');

    const { restored, skipped } = await reconcilePending(db, redis);

    expect(restored).toBe(2); // j1, j4
    expect(skipped).toBe(2);  // j2, j3
    expect(redis.members('aura:queue:default')).toContain('j1');
    expect(redis.members('aura:queue:default')).toContain('j4');
    expect(redis.members('aura:queue:default')).not.toContain('j3');
  });
});
