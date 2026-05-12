/**
 * AdaptiveThreshold — dynamic backpressure ceiling.
 *
 * Instead of rejecting at a fixed queue size, compute a ceiling that reflects
 * how fast the system can actually drain.  Formula:
 *
 *   effectiveThreshold = min(staticMax, drainRatePerSec * drainWindowSec * safetyFactor)
 *
 * If drain rate is 50 jobs/s and safetyFactor=4, the effective threshold is
 * 50 * 10 * 4 = 2000 — enough backlog to keep workers busy for ~40s.
 * If drain rate drops to 5 jobs/s the threshold drops to 200 automatically.
 *
 * The calculation is cached for `refreshIntervalMs` to avoid a Redis round-trip
 * on every enqueue.  Falls back to `staticMax` when no throughput data exists.
 *
 * Env vars:
 *   MAX_QUEUE_THRESHOLD        — hard upper bound (default 10000)
 *   BP_DRAIN_WINDOW_SEC        — sampling window in seconds (default 10)
 *   BP_SAFETY_FACTOR           — backlog headroom multiplier (default 4.0)
 *   BP_THRESHOLD_REFRESH_MS    — recalculation interval ms (default 5000)
 *   BP_MIN_THRESHOLD           — floor so we never reject everything (default 100)
 */

export interface ThresholdConfig {
  /** Hard upper bound — never exceeded regardless of drain rate. */
  staticMax: number;
  /** Seconds of throughput history to measure drain rate from. */
  drainWindowSec: number;
  /**
   * How many drain-window-equivalents of backlog we tolerate.
   * Higher = more permissive under load; lower = tighter admission.
   */
  safetyFactor: number;
  /** How often (ms) to recalculate from Redis. Reduces round-trips. */
  refreshIntervalMs: number;
  /** Absolute minimum threshold — prevents starvation when drain rate is near-zero. */
  minThreshold: number;
}

const ENV_DEFAULTS: ThresholdConfig = {
  staticMax:         Number(process.env.MAX_QUEUE_THRESHOLD     ?? 10_000),
  drainWindowSec:    Number(process.env.BP_DRAIN_WINDOW_SEC     ?? 10),
  safetyFactor:      Number(process.env.BP_SAFETY_FACTOR        ?? 4.0),
  refreshIntervalMs: Number(process.env.BP_THRESHOLD_REFRESH_MS ?? 5_000),
  minThreshold:      Number(process.env.BP_MIN_THRESHOLD        ?? 100),
};

export class AdaptiveThreshold {
  readonly config: ThresholdConfig;
  private cached: number;
  private lastRefreshAt = 0;
  /** Exposed for metrics/dashboard. */
  lastDrainRatePerSec = 0;

  constructor(config: Partial<ThresholdConfig> = {}) {
    this.config = { ...ENV_DEFAULTS, ...config };
    this.cached = this.config.staticMax; // safe starting value
  }

  static fromEnv(): AdaptiveThreshold {
    return new AdaptiveThreshold();
  }

  /**
   * Return the effective threshold.  Refreshes from Redis when the cache
   * has expired; otherwise returns the cached value immediately.
   *
   * `getCompleted(windowMs)` is injected so the class is testable without Redis.
   */
  async getThreshold(
    getCompleted: (windowMs: number) => Promise<number>,
    nowMs: number = Date.now(),
  ): Promise<number> {
    if (nowMs - this.lastRefreshAt < this.config.refreshIntervalMs) {
      return this.cached;
    }
    this.lastRefreshAt = nowMs;

    const windowMs = this.config.drainWindowSec * 1_000;

    let completed: number;
    try {
      completed = await getCompleted(windowMs);
    } catch {
      // Redis temporarily unavailable — return last known good threshold rather
      // than tightening to staticMax (which could cause unnecessary rejections).
      return this.cached;
    }

    if (completed <= 0) {
      // No drain data yet (cold start or genuinely empty window).
      this.lastDrainRatePerSec = 0;
      this.cached = this.config.staticMax;
      return this.cached;
    }

    const drainRatePerSec = completed / this.config.drainWindowSec;
    this.lastDrainRatePerSec = drainRatePerSec;

    const dynamic = Math.ceil(drainRatePerSec * this.config.drainWindowSec * this.config.safetyFactor);
    this.cached = Math.min(
      this.config.staticMax,
      Math.max(dynamic, this.config.minThreshold),
    );

    return this.cached;
  }

  /** Current cached threshold — no Redis call. */
  get current(): number { return this.cached; }
}
