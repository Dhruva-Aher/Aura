/**
 * SchedulerLock — Redis-based leader election for the scheduler.
 *
 * Every worker process races to acquire a single Redis key with a short TTL.
 * The winner runs the scheduler and renews the lock every RENEW_INTERVAL_MS.
 * If the winner crashes, the lock expires within LOCK_TTL_SEC and another
 * worker acquires it automatically — no manual intervention needed.
 *
 * Guarantees:
 *   • Exactly one scheduler runs across any number of worker replicas.
 *   • Failover happens within LOCK_TTL_SEC (15s) of the leader crashing.
 *   • Graceful shutdown releases the lock immediately so the next instance
 *     can start scheduling without waiting for TTL expiry.
 */

import { randomUUID } from 'crypto';
import { createRedisClient } from '@aura/redis';

export const SCHEDULER_LOCK_KEY = 'aura:scheduler:lock';
export const LOCK_TTL_SEC = 15;        // Lock expires 15s after last renewal
export const RENEW_INTERVAL_MS = 5_000; // Renew every 5s (well inside TTL)
export const RETRY_INTERVAL_MS = 10_000; // Non-leaders retry acquisition every 10s

export class SchedulerLock {
  /** Unique value stored in the lock key — proves we hold it. */
  readonly instanceId: string;
  private redis: ReturnType<typeof createRedisClient>;
  private renewTimer?: NodeJS.Timeout;
  private retryTimer?: NodeJS.Timeout;
  private _isLeader = false;

  constructor(redis: ReturnType<typeof createRedisClient>, instanceId?: string) {
    this.redis = redis;
    this.instanceId = instanceId ?? randomUUID();
  }

  get isLeader(): boolean {
    return this._isLeader;
  }

  /**
   * Try to acquire the lock once.
   * Uses SET NX EX — atomic, no race condition.
   * Returns true if this instance is now the leader.
   */
  async tryAcquire(): Promise<boolean> {
    const result = await this.redis.set(
      SCHEDULER_LOCK_KEY,
      this.instanceId,
      'NX',
      'EX',
      LOCK_TTL_SEC,
    );
    this._isLeader = result === 'OK';
    return this._isLeader;
  }

  /**
   * Start the lock-renewal heartbeat.
   * Must be called only after a successful tryAcquire().
   * If renewal fails (lock lost or Redis error), onLost() is called once.
   */
  startRenewing(onLost: () => void): void {
    this.stopRenewing(); // clear any existing timer
    this.renewTimer = setInterval(async () => {
      try {
        const renewed = await this.redis.renewSchedulerLock(
          SCHEDULER_LOCK_KEY,
          this.instanceId,
          LOCK_TTL_SEC,
        );
        if (!renewed) {
          // Another instance raced in (shouldn't happen normally).
          this._isLeader = false;
          this.stopRenewing();
          onLost();
        }
      } catch (err) {
        // Redis temporarily unavailable — stop renewing to be safe.
        console.error('[SchedulerLock] Renewal failed:', err);
        this._isLeader = false;
        this.stopRenewing();
        onLost();
      }
    }, RENEW_INTERVAL_MS);
  }

  stopRenewing(): void {
    if (this.renewTimer) {
      clearInterval(this.renewTimer);
      this.renewTimer = undefined;
    }
  }

  /**
   * Start polling for lock acquisition (for non-leaders).
   * Calls onAcquired() when this instance wins the election.
   * onAcquired() should start the scheduler and then call startRenewing().
   */
  startRetrying(onAcquired: () => void): void {
    this.stopRetrying();
    // Jitter: spread out retry attempts across instances so they don't all
    // hammer Redis at the same millisecond when the lock expires.
    const jitter = Math.floor(Math.random() * 3000);
    this.retryTimer = setTimeout(async () => {
      const won = await this.tryAcquire().catch(() => false);
      if (won) {
        this.stopRetrying();
        onAcquired();
      } else {
        // Not yet — keep polling
        this.startRetrying(onAcquired);
      }
    }, RETRY_INTERVAL_MS + jitter);
  }

  stopRetrying(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
  }

  /**
   * Gracefully release the lock on shutdown.
   * Only deletes the key if we are still the holder (Lua guard prevents
   * accidentally deleting a lock already held by a new leader).
   */
  async release(): Promise<void> {
    this.stopRenewing();
    this.stopRetrying();
    if (this._isLeader) {
      await this.redis.releaseSchedulerLock(SCHEDULER_LOCK_KEY, this.instanceId).catch(() => {});
      this._isLeader = false;
    }
  }
}
