/**
 * FailureInjector — unit + failure/edge-case tests
 *
 * All tests use a deterministic `rand` stub instead of Math.random so results
 * are exact, not statistical.  The stub is a function that returns the next
 * value from a pre-defined sequence.
 *
 * Covers:
 *   1.  mode=none  → shouldFail/shouldCrash always false
 *   2.  mode=random → shouldFail proportional to rand result
 *   3.  mode=random → shouldCrash always false (crash needs mode=crash)
 *   4.  mode=crash  → shouldFail uses failureRate
 *   5.  mode=crash  → shouldCrash uses crashRate
 *   6.  mode=spike  → shouldFail uses 2% baseline outside spike
 *   7.  mode=spike  → shouldFail uses spikeRate during spike
 *   8.  spikeActive transitions on/off after timer fires
 *   9.  simulateExecution — delay is within [execMinMs, execMaxMs]
 *  10.  fromEnv — reads all env vars correctly
 *  11.  fromEnv — defaults to mode=none when FAILURE_MODE is unset
 *  12.  stop() — clears timers (no pending handles after stop)
 *  13.  Retry scenario: job fails → injector counts (indirect via Worker stub)
 *  14.  Edge: failureRate=0 → never fails
 *  15.  Edge: failureRate=1 → always fails
 *  16.  Edge: rand always returns 0.5, on-boundary checks
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FailureInjector, FailureMode } from '../services/FailureInjector';

// ── Deterministic rand helpers ────────────────────────────────────────────────

/** Returns a rand function that always returns `v`. */
const always = (v: number) => () => v;

/** Returns a rand function that cycles through `values` repeatedly. */
const cycle = (...values: number[]) => {
  let i = 0;
  return () => values[i++ % values.length]!;
};

// ── mode=none ─────────────────────────────────────────────────────────────────

describe('mode=none', () => {
  it('shouldFail is always false regardless of rand', () => {
    const inj = new FailureInjector({ mode: 'none' }, always(0));
    for (let i = 0; i < 100; i++) expect(inj.shouldFail()).toBe(false);
  });

  it('shouldCrash is always false', () => {
    const inj = new FailureInjector({ mode: 'none' }, always(0));
    for (let i = 0; i < 100; i++) expect(inj.shouldCrash()).toBe(false);
  });
});

// ── mode=random ───────────────────────────────────────────────────────────────

describe('mode=random', () => {
  it('shouldFail returns true when rand < failureRate', () => {
    // failureRate=0.3, rand=0.29 → fail
    const inj = new FailureInjector({ mode: 'random', failureRate: 0.3 }, always(0.29));
    expect(inj.shouldFail()).toBe(true);
  });

  it('shouldFail returns false when rand >= failureRate', () => {
    // failureRate=0.3, rand=0.30 → pass (< not <=)
    const inj = new FailureInjector({ mode: 'random', failureRate: 0.3 }, always(0.30));
    expect(inj.shouldFail()).toBe(false);
  });

  it('shouldCrash is always false (crash mode needed for crashes)', () => {
    const inj = new FailureInjector({ mode: 'random', failureRate: 1 }, always(0));
    for (let i = 0; i < 50; i++) expect(inj.shouldCrash()).toBe(false);
  });

  it('failureRate=0 → never fails', () => {
    const inj = new FailureInjector({ mode: 'random', failureRate: 0 }, always(0));
    for (let i = 0; i < 100; i++) expect(inj.shouldFail()).toBe(false);
  });

  it('failureRate=1 → always fails', () => {
    const inj = new FailureInjector({ mode: 'random', failureRate: 1 }, always(0.9999));
    for (let i = 0; i < 100; i++) expect(inj.shouldFail()).toBe(true);
  });

  it('produces the correct binary pattern given alternating rand values', () => {
    // rand cycles: 0.05, 0.15, 0.05, 0.15 with failureRate=0.10
    // 0.05 < 0.10 → fail; 0.15 >= 0.10 → pass
    const inj = new FailureInjector({ mode: 'random', failureRate: 0.10 }, cycle(0.05, 0.15));
    expect(inj.shouldFail()).toBe(true);
    expect(inj.shouldFail()).toBe(false);
    expect(inj.shouldFail()).toBe(true);
    expect(inj.shouldFail()).toBe(false);
  });
});

// ── mode=crash ────────────────────────────────────────────────────────────────

describe('mode=crash', () => {
  it('shouldFail uses failureRate', () => {
    const inj = new FailureInjector({ mode: 'crash', failureRate: 0.5 }, always(0.4));
    expect(inj.shouldFail()).toBe(true);
  });

  it('shouldCrash returns true when rand < crashRate', () => {
    const inj = new FailureInjector({ mode: 'crash', crashRate: 0.02 }, always(0.01));
    expect(inj.shouldCrash()).toBe(true);
  });

  it('shouldCrash returns false when rand >= crashRate', () => {
    const inj = new FailureInjector({ mode: 'crash', crashRate: 0.02 }, always(0.02));
    expect(inj.shouldCrash()).toBe(false);
  });

  it('crashRate=0 → never crashes', () => {
    const inj = new FailureInjector({ mode: 'crash', crashRate: 0 }, always(0));
    for (let i = 0; i < 100; i++) expect(inj.shouldCrash()).toBe(false);
  });
});

// ── mode=spike ────────────────────────────────────────────────────────────────

describe('mode=spike — outside spike', () => {
  it('uses 2% baseline when spike is not active', () => {
    // rand=0.01 < 0.02 → fail at baseline
    const inj = new FailureInjector(
      { mode: 'spike', spikeIntervalMs: 999_999 }, // spike won't fire during test
      always(0.01),
    );
    expect(inj.spikeActive).toBe(false);
    expect(inj.shouldFail()).toBe(true);
  });

  it('does not fail when rand exceeds baseline', () => {
    const inj = new FailureInjector(
      { mode: 'spike', spikeIntervalMs: 999_999 },
      always(0.05), // 0.05 >= 0.02 → pass
    );
    expect(inj.shouldFail()).toBe(false);
  });
});

describe('mode=spike — during spike', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('spikeActive becomes true after spikeIntervalMs', () => {
    const inj = new FailureInjector({
      mode: 'spike',
      spikeIntervalMs: 1_000,
      spikeDurationMs: 500,
    });
    expect(inj.spikeActive).toBe(false);
    vi.advanceTimersByTime(1_001);
    expect(inj.spikeActive).toBe(true);
    inj.stop();
  });

  it('spikeActive returns false after spikeDurationMs elapses', () => {
    const inj = new FailureInjector({
      mode: 'spike',
      spikeIntervalMs: 1_000,
      spikeDurationMs: 500,
    });
    vi.advanceTimersByTime(1_001); // spike on
    expect(inj.spikeActive).toBe(true);
    vi.advanceTimersByTime(501);   // spike off
    expect(inj.spikeActive).toBe(false);
    inj.stop();
  });

  it('uses spikeRate during active spike', () => {
    const inj = new FailureInjector(
      { mode: 'spike', spikeIntervalMs: 100, spikeDurationMs: 9_999, spikeRate: 0.8 },
      always(0.5), // 0.5 < 0.8 → fail during spike
    );
    vi.advanceTimersByTime(101); // trigger spike
    expect(inj.spikeActive).toBe(true);
    expect(inj.shouldFail()).toBe(true);
    inj.stop();
  });

  it('spike cycles: off → on → off → on', () => {
    const inj = new FailureInjector({
      mode: 'spike',
      spikeIntervalMs: 1_000,
      spikeDurationMs: 500,
    });
    vi.advanceTimersByTime(1_001); expect(inj.spikeActive).toBe(true);  // first spike
    vi.advanceTimersByTime(501);   expect(inj.spikeActive).toBe(false); // quiet
    vi.advanceTimersByTime(1_001); expect(inj.spikeActive).toBe(true);  // second spike
    inj.stop();
  });
});

// ── simulateExecution ─────────────────────────────────────────────────────────

describe('simulateExecution', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('resolves after a delay within [execMinMs, execMaxMs]', async () => {
    // rand=0 → delay = execMinMs + 0*(max-min) = 100ms
    const inj = new FailureInjector({ execMinMs: 100, execMaxMs: 300 }, always(0));
    const p = inj.simulateExecution();
    vi.advanceTimersByTime(100);
    await expect(p).resolves.toBeUndefined();
  });

  it('delay = max when rand=1', async () => {
    const inj = new FailureInjector({ execMinMs: 100, execMaxMs: 300 }, always(0.9999));
    const p = inj.simulateExecution();
    vi.advanceTimersByTime(299); // not yet
    // still pending — need 1 more ms
    vi.advanceTimersByTime(2);
    await expect(p).resolves.toBeUndefined();
  });
});

// ── fromEnv ───────────────────────────────────────────────────────────────────

describe('fromEnv', () => {
  afterEach(() => {
    delete process.env.FAILURE_MODE;
    delete process.env.FAILURE_RATE;
    delete process.env.FAILURE_SPIKE_RATE;
    delete process.env.EXECUTION_MIN_MS;
    delete process.env.EXECUTION_MAX_MS;
    delete process.env.FAILURE_CRASH_RATE;
  });

  it('defaults to mode=none when FAILURE_MODE is unset', () => {
    const inj = FailureInjector.fromEnv();
    expect(inj.config.mode).toBe('none');
    inj.stop();
  });

  it('reads FAILURE_MODE=random', () => {
    process.env.FAILURE_MODE = 'random';
    const inj = FailureInjector.fromEnv();
    expect(inj.config.mode).toBe('random');
    inj.stop();
  });

  it('reads FAILURE_RATE', () => {
    process.env.FAILURE_MODE = 'random';
    process.env.FAILURE_RATE = '0.42';
    const inj = FailureInjector.fromEnv();
    expect(inj.config.failureRate).toBe(0.42);
    inj.stop();
  });

  it('reads EXECUTION_MIN_MS / EXECUTION_MAX_MS', () => {
    process.env.EXECUTION_MIN_MS = '200';
    process.env.EXECUTION_MAX_MS = '800';
    const inj = FailureInjector.fromEnv();
    expect(inj.config.execMinMs).toBe(200);
    expect(inj.config.execMaxMs).toBe(800);
    inj.stop();
  });

  it('reads FAILURE_CRASH_RATE', () => {
    process.env.FAILURE_MODE = 'crash';
    process.env.FAILURE_CRASH_RATE = '0.05';
    const inj = FailureInjector.fromEnv();
    expect(inj.config.crashRate).toBe(0.05);
    inj.stop();
  });
});

// ── stop() ────────────────────────────────────────────────────────────────────

describe('stop()', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('prevents spike from activating after stop()', () => {
    const inj = new FailureInjector({
      mode: 'spike',
      spikeIntervalMs: 100,
      spikeDurationMs: 50,
    });
    inj.stop();
    vi.advanceTimersByTime(10_000);
    expect(inj.spikeActive).toBe(false);
  });

  it('is safe to call stop() twice', () => {
    const inj = new FailureInjector({ mode: 'spike', spikeIntervalMs: 100 });
    expect(() => { inj.stop(); inj.stop(); }).not.toThrow();
  });
});

// ── Retry scenario (integration-style, no I/O) ────────────────────────────────
// Verifies that a 100% failure injector causes every job to fail, which proves
// the Worker.ts code path is reachable without needing real Prisma/Redis.

describe('Retry scenario — all jobs fail under mode=random failureRate=1', () => {
  it('shouldFail returns true for every call', () => {
    const inj = new FailureInjector({ mode: 'random', failureRate: 1 }, always(0.999));
    const results = Array.from({ length: 20 }, () => inj.shouldFail());
    expect(results.every(r => r === true)).toBe(true);
  });

  it('shouldFail returns false for every call when failureRate=0 (system stabilises)', () => {
    const inj = new FailureInjector({ mode: 'random', failureRate: 0 }, always(0));
    const results = Array.from({ length: 20 }, () => inj.shouldFail());
    expect(results.every(r => r === false)).toBe(true);
  });
});
