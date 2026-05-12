/**
 * SloEvaluator tests — Phase 8
 *
 * Pure unit tests — no Redis, no Prisma, no network.
 * The evaluateSlos() function takes metrics + thresholds and returns SloResult[].
 *
 * Covers:
 *   1.  All SLOs return 'ok' when metrics are within bounds
 *   2.  P95 latency: ok / warning / critical transitions
 *   3.  Dead-letter rate: ok / warning / critical transitions (zero denominator edge case)
 *   4.  Drain rate: ok / warning / critical (stalled queue = 0 jobs/s)
 *   5.  Worker availability: ok with workers / critical with zero workers
 *   6.  Scheduler heartbeat: ok / warning / critical / offline (-1)
 *   7.  hasBreaches() returns false when all SLOs ok
 *   8.  hasBreaches() returns true when any SLO is breached at minSeverity
 *   9.  breaches() returns only non-ok SLOs, sorted critical-first
 *  10.  Custom thresholds override defaults
 *  11.  result.ok is false for warning and critical
 *  12.  result.message is a non-empty string for all states
 */

import { describe, it, expect } from 'vitest';
import {
  evaluateSlos,
  hasBreaches,
  breaches,
  SloMetrics,
  SloThresholds,
} from '../services/SloEvaluator';

// ── Test helpers ──────────────────────────────────────────────────────────────

const THRESHOLDS: SloThresholds = {
  p95LatencyWarnMs:   5_000,
  p95LatencyCritMs:  10_000,
  dlqRateWarnPct:         5,
  dlqRateCritPct:        15,
  drainRateWarn:        1.0,
  schedulerLagWarnMs:  5_000,
  schedulerLagCritMs: 15_000,
};

function healthyMetrics(): SloMetrics {
  return {
    p95LatencyMs:            1_000,  // 1s — well under 5s warn
    dlqCount1h:                  2,
    completed1h:               100,  // 2% DLQ rate — under 5% warn
    drainRatePerSec:           5.0,  // well above 1.0 warn
    onlineWorkers:               3,
    schedulerHeartbeatAgeMs: 1_000,  // 1s — well under 5s warn
  };
}

function findSlo(results: ReturnType<typeof evaluateSlos>, id: string) {
  const r = results.find(s => s.id === id);
  if (!r) throw new Error(`SLO ${id} not found in results`);
  return r;
}

// ── 1. All SLOs ok ────────────────────────────────────────────────────────────

describe('evaluateSlos — all within bounds', () => {
  it('returns 5 results', () => {
    expect(evaluateSlos(healthyMetrics(), THRESHOLDS)).toHaveLength(5);
  });

  it('all severity = ok when metrics are healthy', () => {
    const results = evaluateSlos(healthyMetrics(), THRESHOLDS);
    expect(results.every(r => r.severity === 'ok')).toBe(true);
  });

  it('all ok = true when metrics are healthy', () => {
    const results = evaluateSlos(healthyMetrics(), THRESHOLDS);
    expect(results.every(r => r.ok)).toBe(true);
  });

  it('message is a non-empty string for each result', () => {
    const results = evaluateSlos(healthyMetrics(), THRESHOLDS);
    results.forEach(r => expect(r.message.length).toBeGreaterThan(0));
  });
});

// ── 2. P95 latency ────────────────────────────────────────────────────────────

describe('P95 latency SLO', () => {
  const base = healthyMetrics();

  it('ok when latency < warn threshold', () => {
    const r = findSlo(evaluateSlos({ ...base, p95LatencyMs: 3_000 }, THRESHOLDS), 'P95_LATENCY');
    expect(r.severity).toBe('ok');
    expect(r.ok).toBe(true);
  });

  it('warning when latency ≥ warn threshold and < crit threshold', () => {
    const r = findSlo(evaluateSlos({ ...base, p95LatencyMs: 7_000 }, THRESHOLDS), 'P95_LATENCY');
    expect(r.severity).toBe('warning');
    expect(r.ok).toBe(false);
  });

  it('critical when latency ≥ crit threshold', () => {
    const r = findSlo(evaluateSlos({ ...base, p95LatencyMs: 12_000 }, THRESHOLDS), 'P95_LATENCY');
    expect(r.severity).toBe('critical');
    expect(r.ok).toBe(false);
  });

  it('current value matches the input p95LatencyMs', () => {
    const r = findSlo(evaluateSlos({ ...base, p95LatencyMs: 8_500 }, THRESHOLDS), 'P95_LATENCY');
    expect(r.current).toBe(8_500);
    expect(r.unit).toBe('ms');
  });
});

// ── 3. Dead-letter rate ───────────────────────────────────────────────────────

describe('Dead-letter rate SLO', () => {
  const base = healthyMetrics();

  it('ok when DLQ rate < warn threshold', () => {
    // 3/100 = 3% < 5%
    const r = findSlo(evaluateSlos({ ...base, dlqCount1h: 3, completed1h: 100 }, THRESHOLDS), 'DEAD_LETTER_RATE');
    expect(r.severity).toBe('ok');
  });

  it('warning when DLQ rate ≥ warn and < crit', () => {
    // 8/100 = 8%, between 5% and 15%
    const r = findSlo(evaluateSlos({ ...base, dlqCount1h: 8, completed1h: 100 }, THRESHOLDS), 'DEAD_LETTER_RATE');
    expect(r.severity).toBe('warning');
  });

  it('critical when DLQ rate ≥ crit threshold', () => {
    // 20/100 = 20% > 15%
    const r = findSlo(evaluateSlos({ ...base, dlqCount1h: 20, completed1h: 100 }, THRESHOLDS), 'DEAD_LETTER_RATE');
    expect(r.severity).toBe('critical');
  });

  it('ok when no jobs completed and no DLQ (zero denominator)', () => {
    const r = findSlo(evaluateSlos({ ...base, dlqCount1h: 0, completed1h: 0 }, THRESHOLDS), 'DEAD_LETTER_RATE');
    expect(r.severity).toBe('ok');
    expect(r.current).toBe(0);
  });
});

// ── 4. Drain rate ─────────────────────────────────────────────────────────────

describe('Drain rate SLO', () => {
  const base = healthyMetrics();

  it('ok when drain rate ≥ warn threshold', () => {
    const r = findSlo(evaluateSlos({ ...base, drainRatePerSec: 2.5 }, THRESHOLDS), 'DRAIN_RATE');
    expect(r.severity).toBe('ok');
  });

  it('warning when drain rate > 0 and < warn threshold', () => {
    const r = findSlo(evaluateSlos({ ...base, drainRatePerSec: 0.5 }, THRESHOLDS), 'DRAIN_RATE');
    expect(r.severity).toBe('warning');
  });

  it('critical when drain rate = 0 (stalled queue)', () => {
    const r = findSlo(evaluateSlos({ ...base, drainRatePerSec: 0 }, THRESHOLDS), 'DRAIN_RATE');
    expect(r.severity).toBe('critical');
    expect(r.message).toContain('stalled');
  });
});

// ── 5. Worker availability ────────────────────────────────────────────────────

describe('Worker availability SLO', () => {
  const base = healthyMetrics();

  it('ok with ≥ 1 worker', () => {
    const r = findSlo(evaluateSlos({ ...base, onlineWorkers: 1 }, THRESHOLDS), 'WORKER_ONLINE');
    expect(r.severity).toBe('ok');
    expect(r.ok).toBe(true);
  });

  it('critical with 0 workers', () => {
    const r = findSlo(evaluateSlos({ ...base, onlineWorkers: 0 }, THRESHOLDS), 'WORKER_ONLINE');
    expect(r.severity).toBe('critical');
    expect(r.ok).toBe(false);
  });

  it('current reflects actual worker count', () => {
    const r = findSlo(evaluateSlos({ ...base, onlineWorkers: 5 }, THRESHOLDS), 'WORKER_ONLINE');
    expect(r.current).toBe(5);
    expect(r.unit).toBe('workers');
  });
});

// ── 6. Scheduler heartbeat ────────────────────────────────────────────────────

describe('Scheduler heartbeat SLO', () => {
  const base = healthyMetrics();

  it('ok when heartbeat is recent', () => {
    const r = findSlo(evaluateSlos({ ...base, schedulerHeartbeatAgeMs: 2_000 }, THRESHOLDS), 'SCHEDULER_LAG');
    expect(r.severity).toBe('ok');
  });

  it('warning when heartbeat age ≥ warn and < crit', () => {
    const r = findSlo(evaluateSlos({ ...base, schedulerHeartbeatAgeMs: 8_000 }, THRESHOLDS), 'SCHEDULER_LAG');
    expect(r.severity).toBe('warning');
  });

  it('critical when heartbeat age ≥ crit threshold', () => {
    const r = findSlo(evaluateSlos({ ...base, schedulerHeartbeatAgeMs: 20_000 }, THRESHOLDS), 'SCHEDULER_LAG');
    expect(r.severity).toBe('critical');
  });

  it('critical when heartbeat age = -1 (offline)', () => {
    const r = findSlo(evaluateSlos({ ...base, schedulerHeartbeatAgeMs: -1 }, THRESHOLDS), 'SCHEDULER_LAG');
    expect(r.severity).toBe('critical');
    expect(r.message).toContain('offline');
  });
});

// ── 7-8. hasBreaches() ────────────────────────────────────────────────────────

describe('hasBreaches()', () => {
  it('returns false when all SLOs are ok', () => {
    const results = evaluateSlos(healthyMetrics(), THRESHOLDS);
    expect(hasBreaches(results)).toBe(false);
  });

  it('returns true when any SLO is warning (default minSeverity=warning)', () => {
    const m = { ...healthyMetrics(), p95LatencyMs: 7_000 };
    const results = evaluateSlos(m, THRESHOLDS);
    expect(hasBreaches(results)).toBe(true);
  });

  it('returns false for warnings when minSeverity=critical', () => {
    const m = { ...healthyMetrics(), p95LatencyMs: 7_000 }; // only warning
    const results = evaluateSlos(m, THRESHOLDS);
    expect(hasBreaches(results, 'critical')).toBe(false);
  });

  it('returns true for critical when minSeverity=critical', () => {
    const m = { ...healthyMetrics(), p95LatencyMs: 12_000 }; // critical
    const results = evaluateSlos(m, THRESHOLDS);
    expect(hasBreaches(results, 'critical')).toBe(true);
  });
});

// ── 9. breaches() ────────────────────────────────────────────────────────────

describe('breaches()', () => {
  it('returns empty array when all SLOs ok', () => {
    const results = evaluateSlos(healthyMetrics(), THRESHOLDS);
    expect(breaches(results)).toHaveLength(0);
  });

  it('returns only breached SLOs', () => {
    const m = { ...healthyMetrics(), p95LatencyMs: 7_000, onlineWorkers: 0 };
    const b = breaches(evaluateSlos(m, THRESHOLDS));
    expect(b.length).toBe(2);
    expect(b.map(r => r.id)).toContain('P95_LATENCY');
    expect(b.map(r => r.id)).toContain('WORKER_ONLINE');
  });

  it('sorts critical before warning', () => {
    // WORKER_ONLINE (critical=0 workers) and P95 (warning=7s)
    const m = { ...healthyMetrics(), p95LatencyMs: 7_000, onlineWorkers: 0 };
    const b = breaches(evaluateSlos(m, THRESHOLDS));
    expect(b[0]!.severity).toBe('critical');
    expect(b[1]!.severity).toBe('warning');
  });
});

// ── 10. Custom thresholds ─────────────────────────────────────────────────────

describe('Custom thresholds', () => {
  it('tighter warn threshold triggers warning at lower latency', () => {
    const tight: SloThresholds = { ...THRESHOLDS, p95LatencyWarnMs: 500 };
    const m = { ...healthyMetrics(), p95LatencyMs: 800 }; // ok under default, warn under tight
    const r = findSlo(evaluateSlos(m, tight), 'P95_LATENCY');
    expect(r.severity).toBe('warning');
  });

  it('looser warn threshold keeps SLO ok at higher latency', () => {
    const loose: SloThresholds = { ...THRESHOLDS, p95LatencyWarnMs: 20_000, p95LatencyCritMs: 30_000 };
    const m = { ...healthyMetrics(), p95LatencyMs: 12_000 }; // crit under default, ok under loose
    const r = findSlo(evaluateSlos(m, loose), 'P95_LATENCY');
    expect(r.severity).toBe('ok');
  });
});
