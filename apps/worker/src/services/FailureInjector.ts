/**
 * FailureInjector — controlled chaos for the worker process.
 *
 * Centralises every non-business failure decision behind one injectable
 * interface so that:
 *   • Production behaviour is driven entirely by env vars (no code changes).
 *   • Tests receive a deterministic instance with a stubbed `random` source.
 *   • The scheduler / metrics tier never has to know about failure modes.
 *
 * Modes (set via FAILURE_MODE env var):
 *   none   — no injected failures (default, safe for production)
 *   random — each job fails with probability FAILURE_RATE (default 0.10)
 *   spike  — quiet period (2% baseline) followed by burst at FAILURE_SPIKE_RATE
 *            (default 0.80) every FAILURE_SPIKE_INTERVAL_MS for FAILURE_SPIKE_DURATION_MS
 *   crash  — same as random PLUS a low-probability process.exit to simulate
 *            worker crash mid-job (FAILURE_CRASH_RATE, default 0.02)
 */

export type FailureMode = 'none' | 'random' | 'spike' | 'crash';

export interface FailureConfig {
  mode: FailureMode;
  /** Probability a job throws in 'random' / baseline in 'spike' mode. 0..1 */
  failureRate: number;
  /** Probability a job throws DURING a spike burst. 0..1 */
  spikeRate: number;
  /** Quiet milliseconds between spike bursts. */
  spikeIntervalMs: number;
  /** Milliseconds each spike burst lasts. */
  spikeDurationMs: number;
  /** Probability of process.exit(1) mid-job in 'crash' mode. 0..1 */
  crashRate: number;
  /** Minimum simulated execution time in ms. */
  execMinMs: number;
  /** Maximum simulated execution time in ms. */
  execMaxMs: number;
}

const DEFAULTS: FailureConfig = {
  mode:             'none',
  failureRate:      0.10,
  spikeRate:        0.80,
  spikeIntervalMs:  30_000,
  spikeDurationMs:  10_000,
  crashRate:        0.02,
  execMinMs:        500,
  execMaxMs:        2_500,
};

export class FailureInjector {
  readonly config: FailureConfig;
  private _spikeActive = false;
  private spikeTimer?: NodeJS.Timeout;
  /** Injectable random source — replace in tests for determinism. */
  private readonly rand: () => number;

  constructor(config: Partial<FailureConfig> = {}, rand: () => number = Math.random) {
    this.config = { ...DEFAULTS, ...config };
    this.rand   = rand;

    if (this.config.mode === 'spike') {
      this.scheduleSpikeOff();
    }
  }

  /** Build an injector from process env vars. Called once at startup. */
  static fromEnv(): FailureInjector {
    const mode = (process.env.FAILURE_MODE ?? 'none') as FailureMode;
    const injector = new FailureInjector({
      mode,
      failureRate:     Number(process.env.FAILURE_RATE            ?? DEFAULTS.failureRate),
      spikeRate:       Number(process.env.FAILURE_SPIKE_RATE      ?? DEFAULTS.spikeRate),
      spikeIntervalMs: Number(process.env.FAILURE_SPIKE_INTERVAL_MS ?? DEFAULTS.spikeIntervalMs),
      spikeDurationMs: Number(process.env.FAILURE_SPIKE_DURATION_MS ?? DEFAULTS.spikeDurationMs),
      crashRate:       Number(process.env.FAILURE_CRASH_RATE      ?? DEFAULTS.crashRate),
      execMinMs:       Number(process.env.EXECUTION_MIN_MS        ?? DEFAULTS.execMinMs),
      execMaxMs:       Number(process.env.EXECUTION_MAX_MS        ?? DEFAULTS.execMaxMs),
    });
    if (mode !== 'none') {
      console.log(`[FailureInjector] mode=${mode}`, injector.config);
    }
    return injector;
  }

  // ── Predicates ──────────────────────────────────────────────────────────────

  /** Returns true if the current job should throw a recoverable execution error. */
  shouldFail(): boolean {
    switch (this.config.mode) {
      case 'none':   return false;
      case 'random': return this.rand() < this.config.failureRate;
      case 'spike':  return this._spikeActive
        ? this.rand() < this.config.spikeRate
        : this.rand() < 0.02;                   // 2% baseline outside spikes
      case 'crash':  return this.rand() < this.config.failureRate;
      default:       return false;
    }
  }

  /**
   * Returns true if the worker should call process.exit(1) to simulate an
   * abrupt crash mid-job.  Only possible in 'crash' mode.
   *
   * After a crash the lease expires, the reaper routes the job to aura:delayed,
   * and it is retried after exponential backoff — proving the recovery path.
   */
  shouldCrash(): boolean {
    return this.config.mode === 'crash' && this.rand() < this.config.crashRate;
  }

  /** Simulated job execution latency. */
  async simulateExecution(): Promise<void> {
    const { execMinMs, execMaxMs } = this.config;
    const delay = execMinMs + this.rand() * (execMaxMs - execMinMs);
    await new Promise<void>(r => setTimeout(r, delay));
  }

  // ── Spike bookkeeping ───────────────────────────────────────────────────────

  get spikeActive(): boolean { return this._spikeActive; }

  private scheduleSpikeOff(): void {
    // Quiet period first, then turn spike on
    this.spikeTimer = setTimeout(() => this.activateSpike(), this.config.spikeIntervalMs);
  }

  private activateSpike(): void {
    this._spikeActive = true;
    this.spikeTimer = setTimeout(() => this.deactivateSpike(), this.config.spikeDurationMs);
  }

  private deactivateSpike(): void {
    this._spikeActive = false;
    this.scheduleSpikeOff();   // queue the next cycle
  }

  /** Stop all timers — call on graceful shutdown. */
  stop(): void {
    if (this.spikeTimer) {
      clearTimeout(this.spikeTimer);
      this.spikeTimer = undefined;
    }
  }
}
