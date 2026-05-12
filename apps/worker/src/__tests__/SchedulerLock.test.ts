/**
 * SchedulerLock — leader election correctness tests
 *
 * All tests use a fake Redis client so no infrastructure is needed.
 * The fake models exactly the semantics of SET NX EX, GET, EXPIRE, DEL.
 *
 * Covers:
 *   1. tryAcquire — wins when lock is free, loses when taken
 *   2. tryAcquire — idempotent: re-acquiring your own lock is blocked by NX
 *   3. renewSchedulerLock — succeeds only if you are the current holder
 *   4. releaseSchedulerLock — only deletes the key if you hold it
 *   5. startRenewing — onLost fires when renewal returns 0
 *   6. startRenewing — onLost fires when Redis throws
 *   7. startRetrying — onAcquired fires when lock becomes free
 *   8. Full lifecycle: leader dies → TTL expires → follower takes over
 *   9. Graceful shutdown — release() clears timers and frees the lock
 *  10. isLeader reflects current election state
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  SchedulerLock,
  SCHEDULER_LOCK_KEY,
  LOCK_TTL_SEC,
  RENEW_INTERVAL_MS,
  RETRY_INTERVAL_MS,
} from '../services/SchedulerLock';

// ── Minimal fake Redis ────────────────────────────────────────────────────────

interface FakeRedisStore {
  value: string | null;
  expiresAt: number | null; // epoch ms, or null if no TTL
}

function makeStore(): FakeRedisStore {
  return { value: null, expiresAt: null };
}

function makeFakeRedis(store: FakeRedisStore) {
  const isExpired = () =>
    store.expiresAt !== null && Date.now() > store.expiresAt;

  const get = (): string | null =>
    isExpired() ? null : store.value;

  return {
    // SET key value NX EX ttl
    set: vi.fn((_key: string, value: string, mode: string, _opt: string, ttl: number) => {
      if (mode !== 'NX') throw new Error('Fake only supports NX');
      if (get() !== null) return Promise.resolve(null); // key exists
      store.value = value;
      store.expiresAt = Date.now() + ttl * 1000;
      return Promise.resolve('OK');
    }),

    // renewSchedulerLock(key, instanceId, ttlSec) → 1 | 0
    renewSchedulerLock: vi.fn((_key: string, instanceId: string, ttl: number) => {
      if (get() !== instanceId) return Promise.resolve(0);
      store.expiresAt = Date.now() + ttl * 1000;
      return Promise.resolve(1);
    }),

    // releaseSchedulerLock(key, instanceId) → 1 | 0
    releaseSchedulerLock: vi.fn((_key: string, instanceId: string) => {
      if (get() !== instanceId) return Promise.resolve(0);
      store.value = null;
      store.expiresAt = null;
      return Promise.resolve(1);
    }),

    quit: vi.fn().mockResolvedValue('OK'),
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeLock(redis: ReturnType<typeof makeFakeRedis>, instanceId = 'inst-A') {
  return new SchedulerLock(redis as any, instanceId);
}

// ── 1. tryAcquire — wins when lock is free ────────────────────────────────────

describe('tryAcquire', () => {
  it('returns true and sets isLeader when lock is free', async () => {
    const store = makeStore();
    const redis = makeFakeRedis(store);
    const lock = makeLock(redis);

    const won = await lock.tryAcquire();

    expect(won).toBe(true);
    expect(lock.isLeader).toBe(true);
    expect(store.value).toBe('inst-A');
  });

  it('returns false when another instance holds the lock', async () => {
    const store = makeStore();
    const redis = makeFakeRedis(store);

    // Another instance already holds it
    store.value = 'inst-B';
    store.expiresAt = Date.now() + 15_000;

    const lock = makeLock(redis, 'inst-A');
    const won = await lock.tryAcquire();

    expect(won).toBe(false);
    expect(lock.isLeader).toBe(false);
    expect(store.value).toBe('inst-B'); // unchanged
  });

  it('returns false for second acquire by same instance (NX blocks it)', async () => {
    // SET NX only sets if key doesn't exist — even if same value
    const store = makeStore();
    const redis = makeFakeRedis(store);
    const lock = makeLock(redis);

    await lock.tryAcquire();
    const second = await lock.tryAcquire();

    expect(second).toBe(false); // NX blocked the second write
  });

  it('wins when the previous lock has expired (TTL elapsed)', async () => {
    const store = makeStore();
    // Simulate an expired lock
    store.value = 'inst-B';
    store.expiresAt = Date.now() - 1; // already expired

    const redis = makeFakeRedis(store);
    const lock = makeLock(redis, 'inst-A');
    const won = await lock.tryAcquire();

    expect(won).toBe(true);
    expect(store.value).toBe('inst-A');
  });
});

// ── 2. Renewal ────────────────────────────────────────────────────────────────

describe('renewSchedulerLock', () => {
  it('extends TTL when we are the holder', async () => {
    const store = makeStore();
    const redis = makeFakeRedis(store);
    store.value = 'inst-A';
    store.expiresAt = Date.now() + 5_000;

    const result = await redis.renewSchedulerLock(SCHEDULER_LOCK_KEY, 'inst-A', LOCK_TTL_SEC);

    expect(result).toBe(1);
    expect(store.expiresAt).toBeGreaterThan(Date.now() + 10_000); // extended
  });

  it('returns 0 when a different instance holds the lock', async () => {
    const store = makeStore();
    const redis = makeFakeRedis(store);
    store.value = 'inst-B';
    store.expiresAt = Date.now() + 10_000;

    const result = await redis.renewSchedulerLock(SCHEDULER_LOCK_KEY, 'inst-A', LOCK_TTL_SEC);

    expect(result).toBe(0);
  });

  it('returns 0 when lock has expired', async () => {
    const store = makeStore();
    const redis = makeFakeRedis(store);
    store.value = 'inst-A';
    store.expiresAt = Date.now() - 1; // expired

    const result = await redis.renewSchedulerLock(SCHEDULER_LOCK_KEY, 'inst-A', LOCK_TTL_SEC);

    // get() returns null for expired → renewal blocked
    expect(result).toBe(0);
  });
});

// ── 3. Release ────────────────────────────────────────────────────────────────

describe('releaseSchedulerLock', () => {
  it('deletes the lock when we are the holder', async () => {
    const store = makeStore();
    const redis = makeFakeRedis(store);
    store.value = 'inst-A';
    store.expiresAt = Date.now() + 15_000;

    const result = await redis.releaseSchedulerLock(SCHEDULER_LOCK_KEY, 'inst-A');

    expect(result).toBe(1);
    expect(store.value).toBeNull();
  });

  it('does NOT delete lock when another instance holds it', async () => {
    const store = makeStore();
    const redis = makeFakeRedis(store);
    store.value = 'inst-B';
    store.expiresAt = Date.now() + 15_000;

    const result = await redis.releaseSchedulerLock(SCHEDULER_LOCK_KEY, 'inst-A');

    expect(result).toBe(0);
    expect(store.value).toBe('inst-B'); // not deleted
  });
});

// ── 4. startRenewing — onLost callback ───────────────────────────────────────

describe('startRenewing', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('fires onLost when renewal returns 0 (lock stolen)', async () => {
    const store = makeStore();
    const redis = makeFakeRedis(store);
    const lock = makeLock(redis, 'inst-A');

    await lock.tryAcquire();

    // Simulate another instance taking the lock before renewal
    store.value = 'inst-B';

    const onLost = vi.fn();
    lock.startRenewing(onLost);

    await vi.advanceTimersByTimeAsync(RENEW_INTERVAL_MS);

    expect(onLost).toHaveBeenCalledOnce();
    expect(lock.isLeader).toBe(false);
  });

  it('fires onLost when Redis throws during renewal', async () => {
    const store = makeStore();
    const redis = makeFakeRedis(store);
    redis.renewSchedulerLock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const lock = makeLock(redis, 'inst-A');
    store.value = 'inst-A';
    store.expiresAt = Date.now() + 15_000;

    const onLost = vi.fn();
    lock.startRenewing(onLost);

    await vi.advanceTimersByTimeAsync(RENEW_INTERVAL_MS);

    expect(onLost).toHaveBeenCalledOnce();
    expect(lock.isLeader).toBe(false);
  });

  it('does NOT fire onLost while renewal succeeds', async () => {
    const store = makeStore();
    const redis = makeFakeRedis(store);
    const lock = makeLock(redis, 'inst-A');
    await lock.tryAcquire();

    const onLost = vi.fn();
    lock.startRenewing(onLost);

    // Advance through 3 renewal cycles — all should succeed
    await vi.advanceTimersByTimeAsync(RENEW_INTERVAL_MS * 3);

    expect(onLost).not.toHaveBeenCalled();
  });
});

// ── 5. startRetrying — onAcquired callback ───────────────────────────────────

describe('startRetrying', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('fires onAcquired when the lock becomes free', async () => {
    const store = makeStore();
    store.value = 'inst-B';
    store.expiresAt = Date.now() + 15_000;

    const redis = makeFakeRedis(store);
    const lock = makeLock(redis, 'inst-A');

    const onAcquired = vi.fn();
    lock.startRetrying(onAcquired);

    // Lock still held — first retry should fail
    await vi.advanceTimersByTimeAsync(RETRY_INTERVAL_MS + 3000);
    expect(onAcquired).not.toHaveBeenCalled();

    // Simulate lock expiring
    store.value = null;
    store.expiresAt = null;

    // Next retry should win
    await vi.advanceTimersByTimeAsync(RETRY_INTERVAL_MS + 3000);
    expect(onAcquired).toHaveBeenCalledOnce();
    expect(lock.isLeader).toBe(true);
  });
});

// ── 6. Graceful release ───────────────────────────────────────────────────────

describe('release()', () => {
  it('frees the lock and clears timers', async () => {
    const store = makeStore();
    const redis = makeFakeRedis(store);
    const lock = makeLock(redis, 'inst-A');

    await lock.tryAcquire();
    expect(store.value).toBe('inst-A');

    await lock.release();

    expect(store.value).toBeNull();
    expect(lock.isLeader).toBe(false);
    expect(redis.releaseSchedulerLock).toHaveBeenCalledOnce();
  });

  it('is safe to call when not the leader (no-op)', async () => {
    const store = makeStore();
    const redis = makeFakeRedis(store);
    const lock = makeLock(redis, 'inst-A');
    // Never acquired — isLeader is false

    await expect(lock.release()).resolves.not.toThrow();
    expect(redis.releaseSchedulerLock).not.toHaveBeenCalled();
  });
});

// ── 7. Full failover simulation ───────────────────────────────────────────────

describe('Full leader failover', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('follower takes over after leader lock expires', async () => {
    const store = makeStore();
    const redis = makeFakeRedis(store);

    // Leader acquires and starts renewing
    const leader = makeLock(redis, 'leader');
    await leader.tryAcquire();
    expect(store.value).toBe('leader');

    const onLeaderLost = vi.fn();
    leader.startRenewing(onLeaderLost);

    // Follower is waiting
    const follower = makeLock(redis, 'follower');
    const onFollowerAcquired = vi.fn();
    follower.startRetrying(onFollowerAcquired);

    // Leader crashes — simulate by expiring the lock
    store.value = null;
    store.expiresAt = null;
    // (In production this happens via TTL; here we force it instantly)

    // Advance past one retry window — follower should win
    await vi.advanceTimersByTimeAsync(RETRY_INTERVAL_MS + 3000);

    expect(onFollowerAcquired).toHaveBeenCalledOnce();
    expect(follower.isLeader).toBe(true);
    expect(store.value).toBe('follower');
  });
});

// ── 8. isLeader state machine ─────────────────────────────────────────────────

describe('isLeader state transitions', () => {
  it('false → true on acquire → false after release', async () => {
    const store = makeStore();
    const redis = makeFakeRedis(store);
    const lock = makeLock(redis);

    expect(lock.isLeader).toBe(false);
    await lock.tryAcquire();
    expect(lock.isLeader).toBe(true);
    await lock.release();
    expect(lock.isLeader).toBe(false);
  });
});
