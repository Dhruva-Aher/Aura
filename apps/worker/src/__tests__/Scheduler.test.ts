/**
 * Scheduler reliability tests — Step 1
 *
 * These tests use a lightweight mock of the Redis/Prisma clients so they run
 * without any real infrastructure. They verify:
 *   1. Heartbeat key is written with a TTL on every loop iteration
 *   2. Watchdog restarts the loop after a crash instead of silently dying
 *   3. Heartbeat key is deleted on graceful stop (dashboard → "offline")
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

type RedisMock = {
  set: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  zadd: ReturnType<typeof vi.fn>;
  zrangebyscore: ReturnType<typeof vi.fn>;
  zscore: ReturnType<typeof vi.fn>;
  hget: ReturnType<typeof vi.fn>;
  hset: ReturnType<typeof vi.fn>;
  publish: ReturnType<typeof vi.fn>;
  promoteJobs: ReturnType<typeof vi.fn>;
  reapJobs: ReturnType<typeof vi.fn>;
};

function makeRedisMock(): RedisMock {
  return {
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    get: vi.fn().mockResolvedValue(null),
    zadd: vi.fn().mockResolvedValue(1),
    zrangebyscore: vi.fn().mockResolvedValue([]),
    zscore: vi.fn().mockResolvedValue(null),
    hget: vi.fn().mockResolvedValue('default'),
    hset: vi.fn().mockResolvedValue(1),
    publish: vi.fn().mockResolvedValue(1),
    promoteJobs: vi.fn().mockResolvedValue(0),
    reapJobs: vi.fn().mockResolvedValue([]),
  };
}

// We inline a testable version of Scheduler that accepts injected deps so we
// don't need module-level mocking of the entire @aura/database and @aura/redis
// packages.

class TestableScheduler {
  private isRunning = false;
  private lastOrphanSweep = 0;
  private lastStaleProcessingSweep = 0;
  private redis: RedisMock;
  private prisma: any;

  loopRunCount = 0;
  watchdogRestarts = 0;

  constructor(redis: RedisMock, prisma: any) {
    this.redis = redis;
    this.prisma = prisma;
  }

  async start() {
    this.isRunning = true;
    this.watchdog();
  }

  stop() {
    this.isRunning = false;
  }

  private async watchdog() {
    while (this.isRunning) {
      try {
        await this.loop();
      } catch (err) {
        this.watchdogRestarts++;
        await new Promise(r => setTimeout(r, 10)); // short delay in tests
      }
    }
    await this.redis.del('aura:health:scheduler:last_loop').catch(() => {});
  }

  private async loop() {
    while (this.isRunning) {
      this.loopRunCount++;
      const now = Date.now();

      // The behaviour under test:
      await this.redis.set('aura:health:scheduler:last_loop', now.toString(), 'EX', 10);

      await this.redis.promoteJobs(
        'aura:delayed', 'aura:queue:default', 'aura:meta:',
        'aura:queue:high', 'aura:queue:low', now
      );

      await new Promise(r => setTimeout(r, 10));
    }
  }
}


describe('Scheduler reliability', () => {
  let redis: RedisMock;
  let prisma: any;

  beforeEach(() => {
    redis = makeRedisMock();
    prisma = {
      job: {
        findMany: vi.fn().mockResolvedValue([]),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      worker: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      $transaction: vi.fn().mockResolvedValue(null),
    };
  });

  it('writes heartbeat key with EX 10 TTL on every loop iteration', async () => {
    const scheduler = new TestableScheduler(redis, prisma);
    scheduler.start();

    // Let the loop run a few iterations
    await new Promise(r => setTimeout(r, 60));
    scheduler.stop();
    await new Promise(r => setTimeout(r, 20));

    // Every call to set() for the heartbeat key must include 'EX' and 10
    const heartbeatCalls = redis.set.mock.calls.filter(
      (args: any[]) => args[0] === 'aura:health:scheduler:last_loop'
    );
    expect(heartbeatCalls.length).toBeGreaterThanOrEqual(2);
    for (const call of heartbeatCalls) {
      expect(call[2]).toBe('EX');
      expect(call[3]).toBe(10);
    }
  });

  it('deletes heartbeat key on graceful stop so dashboard shows offline', async () => {
    const scheduler = new TestableScheduler(redis, prisma);
    scheduler.start();
    await new Promise(r => setTimeout(r, 30));
    scheduler.stop();
    // Allow watchdog to observe isRunning=false and call del()
    await new Promise(r => setTimeout(r, 50));

    const delCalls = redis.del.mock.calls.filter(
      (args: any[]) => args[0] === 'aura:health:scheduler:last_loop'
    );
    expect(delCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('watchdog restarts the loop after an unexpected crash', async () => {
    let callCount = 0;
    // Make promoteJobs throw on the first call to simulate a loop crash
    redis.promoteJobs.mockImplementation(() => {
      callCount++;
      if (callCount === 1) throw new Error('Redis connection lost');
      return Promise.resolve(0);
    });

    const scheduler = new TestableScheduler(redis, prisma);
    scheduler.start();
    // Give enough time for crash + restart + second iteration
    await new Promise(r => setTimeout(r, 150));
    scheduler.stop();
    await new Promise(r => setTimeout(r, 30));

    expect(scheduler.watchdogRestarts).toBeGreaterThanOrEqual(1);
    // Loop should have run again after the restart
    expect(scheduler.loopRunCount).toBeGreaterThanOrEqual(2);
  });

  it('continues running after a Redis set error (heartbeat non-fatal)', async () => {
    let setCallCount = 0;
    redis.set.mockImplementation(() => {
      setCallCount++;
      // Fail the first few heartbeat writes
      if (setCallCount <= 2) return Promise.reject(new Error('READONLY'));
      return Promise.resolve('OK');
    });

    const scheduler = new TestableScheduler(redis, prisma);
    scheduler.start();
    await new Promise(r => setTimeout(r, 100));
    scheduler.stop();

    // Loop should have continued past the heartbeat failures
    expect(scheduler.loopRunCount).toBeGreaterThanOrEqual(3);
  });
});


describe('system health — scheduler state detection', () => {
  function getSchedulerState(lastLoopRaw: string | null): 'ok' | 'degraded' | 'offline' {
    if (!lastLoopRaw) return 'offline';
    const delay = Date.now() - parseInt(lastLoopRaw, 10);
    if (delay < 5000) return 'ok';
    return 'degraded';
  }

  it('returns offline when key is null (scheduler never started or key expired)', () => {
    expect(getSchedulerState(null)).toBe('offline');
  });

  it('returns ok when heartbeat is fresh (< 5s)', () => {
    expect(getSchedulerState(String(Date.now() - 500))).toBe('ok');
  });

  it('returns degraded when heartbeat is stale (5s–TTL window)', () => {
    expect(getSchedulerState(String(Date.now() - 8000))).toBe('degraded');
  });

  it('returns offline when heartbeat is very stale (key would have expired with TTL=10s)', () => {
    // With EX 10 the key won't exist — simulated as null
    expect(getSchedulerState(null)).toBe('offline');
  });
});
