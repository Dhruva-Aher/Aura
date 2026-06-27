/**
 * Idempotency + Deduplication tests — Phase 2
 *
 * Tests the execution fence (aura:executing:<jobId>) that prevents two workers
 * from executing the same job simultaneously.  Uses a fake Redis store modelled
 * on the CLAIM_EXECUTION SET NX EX Lua script semantics.
 *
 * Covers:
 *   1.  First worker claims the fence → returns 'OK'
 *   2.  Second worker cannot claim the same fence → returns null
 *   3.  Fence expires after TTL → a new worker can claim it
 *   4.  Fence is released on successful completion (DEL)
 *   5.  Fence is NOT released on failure (allows retry to claim fresh)
 *   6.  Concurrent claims: exactly one winner among N workers
 *   7.  Different jobs have independent fences
 *   8.  TTL is applied correctly
 *   9.  QueueService.enqueue idempotency: same idempotencyKey → same job record
 *  10.  Worker skips execution when fence is held (simulated via fake redis)
 */

import { describe, it, expect, vi } from 'vitest';

// Models exactly the semantics of: SET key value NX EX ttl

interface FenceEntry {
  owner: string;
  expiresAt: number; // ms epoch
}

class FencedRedisStore {
  private store = new Map<string, FenceEntry>();

  /** SET key value NX EX ttlSec — returns 'OK' or null */
  claimExecution(key: string, workerId: string, ttlSec: number): 'OK' | null {
    const existing = this.store.get(key);
    if (existing && Date.now() < existing.expiresAt) {
      return null; // already held and not expired
    }
    this.store.set(key, { owner: workerId, expiresAt: Date.now() + ttlSec * 1000 });
    return 'OK';
  }

  /** DEL key */
  del(key: string): void {
    this.store.delete(key);
  }

  /** GET key → owner or null */
  getOwner(key: string): string | null {
    const e = this.store.get(key);
    if (!e || Date.now() >= e.expiresAt) return null;
    return e.owner;
  }

  /** Simulate time passing (expire entries) */
  advanceTime(ms: number): void {
    // This doesn't actually advance Date.now() — use vi.setSystemTime() for that.
    // This helper is for direct store inspection after vi.setSystemTime.
  }

  size(): number {
    return [...this.store.values()].filter(e => Date.now() < e.expiresAt).length;
  }
}


describe('Execution fence — SET NX EX semantics', () => {
  it('first claim returns OK', () => {
    const store = new FencedRedisStore();
    const result = store.claimExecution('aura:executing:job-1', 'worker-A', 300);
    expect(result).toBe('OK');
  });

  it('second claim by a different worker returns null', () => {
    const store = new FencedRedisStore();
    store.claimExecution('aura:executing:job-1', 'worker-A', 300);
    const result = store.claimExecution('aura:executing:job-1', 'worker-B', 300);
    expect(result).toBeNull();
  });

  it('second claim by the SAME worker also returns null (NX)', () => {
    // NX means set-if-not-exists — even if same value, blocked while key exists
    const store = new FencedRedisStore();
    store.claimExecution('aura:executing:job-1', 'worker-A', 300);
    const result = store.claimExecution('aura:executing:job-1', 'worker-A', 300);
    expect(result).toBeNull();
  });

  it('claim succeeds after TTL expires', () => {
    vi.useFakeTimers();
    const store = new FencedRedisStore();
    store.claimExecution('aura:executing:job-1', 'worker-A', 1); // 1 second TTL
    vi.advanceTimersByTime(1001); // past TTL
    const result = store.claimExecution('aura:executing:job-1', 'worker-B', 300);
    expect(result).toBe('OK');
    vi.useRealTimers();
  });
});


describe('Fence lifecycle', () => {
  it('fence is cleared after successful completion', () => {
    const store = new FencedRedisStore();
    const fenceKey = 'aura:executing:job-2';

    store.claimExecution(fenceKey, 'worker-A', 300);
    expect(store.getOwner(fenceKey)).toBe('worker-A');

    // Simulate successful completion — worker calls redis.del(fenceKey)
    store.del(fenceKey);

    expect(store.getOwner(fenceKey)).toBeNull();
  });

  it('fence persists when job fails (retry can claim a fresh fence after TTL)', () => {
    const store = new FencedRedisStore();
    const fenceKey = 'aura:executing:job-3';

    store.claimExecution(fenceKey, 'worker-A', 300);

    // Simulate failure — fence is NOT deleted
    // (Worker throws → fence remains until TTL)

    // Second worker cannot claim during TTL
    const result = store.claimExecution(fenceKey, 'worker-B', 300);
    expect(result).toBeNull();
  });

  it('retry succeeds after fence TTL expires following a failure', () => {
    vi.useFakeTimers();
    const store = new FencedRedisStore();
    const fenceKey = 'aura:executing:job-3';

    store.claimExecution(fenceKey, 'worker-A', 1); // 1s TTL
    // worker-A crashes — fence NOT released

    vi.advanceTimersByTime(1001); // TTL expires

    // Retry worker can now claim
    const retryResult = store.claimExecution(fenceKey, 'worker-B', 300);
    expect(retryResult).toBe('OK');
    vi.useRealTimers();
  });
});


describe('Concurrent claims — at most one winner', () => {
  it('among N simultaneous claims, exactly one returns OK', () => {
    const store = new FencedRedisStore();
    const fenceKey = 'aura:executing:job-concurrent';

    // Simulate 10 workers racing simultaneously
    const results = Array.from({ length: 10 }, (_, i) =>
      store.claimExecution(fenceKey, `worker-${i}`, 300)
    );

    const winners = results.filter(r => r === 'OK');
    const losers  = results.filter(r => r === null);

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(9);
  });

  it('winner identity is deterministic — first claim wins', () => {
    const store = new FencedRedisStore();
    const fenceKey = 'aura:executing:job-first';

    store.claimExecution(fenceKey, 'worker-first', 300);
    store.claimExecution(fenceKey, 'worker-second', 300);

    expect(store.getOwner(fenceKey)).toBe('worker-first');
  });
});


describe('Fence isolation across jobs', () => {
  it('different jobs have independent fences', () => {
    const store = new FencedRedisStore();

    const r1 = store.claimExecution('aura:executing:job-A', 'worker-1', 300);
    const r2 = store.claimExecution('aura:executing:job-B', 'worker-1', 300);

    expect(r1).toBe('OK');
    expect(r2).toBe('OK'); // different key → not blocked
  });

  it('clearing one fence does not affect another', () => {
    const store = new FencedRedisStore();

    store.claimExecution('aura:executing:job-A', 'worker-1', 300);
    store.claimExecution('aura:executing:job-B', 'worker-2', 300);

    store.del('aura:executing:job-A');

    expect(store.getOwner('aura:executing:job-A')).toBeNull();
    expect(store.getOwner('aura:executing:job-B')).toBe('worker-2');
  });
});


describe('TTL enforcement', () => {
  it('fence is inaccessible exactly at TTL boundary', () => {
    vi.useFakeTimers();
    const store = new FencedRedisStore();
    store.claimExecution('aura:executing:job-ttl', 'worker-X', 5); // 5s

    vi.advanceTimersByTime(4999); // just before expiry
    expect(store.getOwner('aura:executing:job-ttl')).toBe('worker-X');

    vi.advanceTimersByTime(2); // past expiry
    expect(store.getOwner('aura:executing:job-ttl')).toBeNull();

    vi.useRealTimers();
  });
});

// The upsert in QueueService.enqueue() ensures the same idempotencyKey never
// creates two separate rows.  We test the logic in isolation here.

describe('QueueService idempotency — upsert semantics', () => {
  function fakeUpsert(
    db: Map<string, { id: string; name: string; createdAt: number }>,
    idempotencyKey: string,
    name: string,
  ) {
    if (db.has(idempotencyKey)) return db.get(idempotencyKey)!;
    const record = { id: `job-${db.size + 1}`, name, createdAt: Date.now() };
    db.set(idempotencyKey, record);
    return record;
  }

  it('same idempotencyKey returns the same job record', () => {
    const db = new Map();
    const key = 'idempotent-key-001';
    const first  = fakeUpsert(db, key, 'image.resize');
    const second = fakeUpsert(db, key, 'image.resize');
    expect(first.id).toBe(second.id);
    expect(db.size).toBe(1);
  });

  it('different idempotencyKeys create separate records', () => {
    const db = new Map();
    fakeUpsert(db, 'key-A', 'email.send');
    fakeUpsert(db, 'key-B', 'email.send');
    expect(db.size).toBe(2);
  });

  it('second call with same key does NOT overwrite the original', () => {
    const db = new Map();
    const first = fakeUpsert(db, 'key-dup', 'original.name');
    fakeUpsert(db, 'key-dup', 'overwrite.attempt');
    expect(db.get('key-dup')!.name).toBe('original.name');
    expect(db.get('key-dup')!.id).toBe(first.id);
  });
});


describe('Worker skips execution when fence is already held', () => {
  it('tracks skip correctly via side-effect counter', async () => {
    const store = new FencedRedisStore();
    const fenceKey = 'aura:executing:job-skip';
    let executionCount = 0;

    async function processWithFence(workerId: string): Promise<'executed' | 'skipped'> {
      const result = store.claimExecution(fenceKey, workerId, 300);
      if (result !== 'OK') return 'skipped';
      executionCount++;
      // ... do work ...
      store.del(fenceKey);
      return 'executed';
    }

    const r1 = await processWithFence('worker-A');
    const r2 = await processWithFence('worker-B'); // fence cleared by A already
    const r3 = await processWithFence('worker-C'); // fence cleared by B already

    expect(r1).toBe('executed');
    expect(r2).toBe('executed'); // A released the fence
    expect(r3).toBe('executed'); // B released the fence
    expect(executionCount).toBe(3);
  });

  it('exactly one execution when two workers race on the same uncompleted fence', async () => {
    const store = new FencedRedisStore();
    const fenceKey = 'aura:executing:job-race';
    let executionCount = 0;

    // worker-A holds the fence but has NOT released it (still processing)
    store.claimExecution(fenceKey, 'worker-A', 300);
    executionCount++;

    // worker-B tries to execute the same job (e.g. after requeue)
    async function workerBProcess(): Promise<void> {
      const result = store.claimExecution(fenceKey, 'worker-B', 300);
      if (result !== 'OK') return; // skip
      executionCount++;
    }

    await workerBProcess();

    expect(executionCount).toBe(1); // worker-B was blocked
  });
});
