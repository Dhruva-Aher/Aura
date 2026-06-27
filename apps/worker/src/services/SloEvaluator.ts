/**
 * SloEvaluator — Service Level Objective tracking (Phase 8)
 *
 * Defines the production SLOs for Aura and evaluates them against a metrics
 * snapshot.  Deliberately pure: no Redis, no Prisma, no side-effects — the
 * caller decides what to do with the results (publish alerts, write to Redis,
 * surface on the health endpoint).
 *
 * SLOs defined:
 *   P95_LATENCY    — P95 queue latency ≤ 5 s         (critical if > 10 s)
 *   DEAD_LETTER_RATE — < 5% of completed jobs DLQ'd  (critical if > 15%)
 *   DRAIN_RATE     — drain rate ≥ 1 job/s             (critical if = 0)
 *   WORKER_ONLINE  — ≥ 1 worker online               (critical always)
 *   SCHEDULER_LAG  — scheduler loop < 5 s stale       (critical if offline)
 *
 * Each SloResult carries:
 *   id          — stable string key
 *   name        — human-readable label
 *   target      — description of the objective
 *   current     — measured value (number or string)
 *   ok          — true = within SLO
 *   severity    — 'ok' | 'warning' | 'critical'
 *   message     — human-readable status line
 *
 * Env vars for threshold overrides:
 *   SLO_P95_LATENCY_WARN_MS    default 5 000
 *   SLO_P95_LATENCY_CRIT_MS    default 10 000
 *   SLO_DLQ_RATE_WARN_PCT      default 5
 *   SLO_DLQ_RATE_CRIT_PCT      default 15
 *   SLO_DRAIN_RATE_WARN        default 1.0
 *   SLO_SCHEDULER_LAG_WARN_MS  default 5 000
 *   SLO_SCHEDULER_LAG_CRIT_MS  default 15 000
 */

export type SloSeverity = 'ok' | 'warning' | 'critical';

export interface SloResult {
  id: string;
  name: string;
  target: string;
  /** Numeric value for comparison/display. */
  current: number;
  unit: string;
  ok: boolean;
  severity: SloSeverity;
  message: string;
}

export interface SloMetrics {
  /** P95 queue latency in milliseconds (PENDING → started). */
  p95LatencyMs: number;
  /** Jobs dead-lettered in the last hour. */
  dlqCount1h: number;
  /** Jobs completed in the last hour (includes DLQ'd). */
  completed1h: number;
  /** Current drain rate (jobs/second). */
  drainRatePerSec: number;
  /** Number of online workers. */
  onlineWorkers: number;
  /**
   * Age of the most recent scheduler heartbeat in milliseconds.
   * -1 means no heartbeat has ever been recorded (scheduler never started or
   * Redis key missing).
   */
  schedulerHeartbeatAgeMs: number;
}

export interface SloThresholds {
  p95LatencyWarnMs: number;
  p95LatencyCritMs: number;
  dlqRateWarnPct: number;
  dlqRateCritPct: number;
  drainRateWarn: number;
  schedulerLagWarnMs: number;
  schedulerLagCritMs: number;
}

export const DEFAULT_THRESHOLDS: SloThresholds = {
  p95LatencyWarnMs:    Number(process.env.SLO_P95_LATENCY_WARN_MS   ??  5_000),
  p95LatencyCritMs:    Number(process.env.SLO_P95_LATENCY_CRIT_MS   ?? 10_000),
  dlqRateWarnPct:      Number(process.env.SLO_DLQ_RATE_WARN_PCT     ??      5),
  dlqRateCritPct:      Number(process.env.SLO_DLQ_RATE_CRIT_PCT     ??     15),
  drainRateWarn:       Number(process.env.SLO_DRAIN_RATE_WARN        ??    1.0),
  schedulerLagWarnMs:  Number(process.env.SLO_SCHEDULER_LAG_WARN_MS ??  5_000),
  schedulerLagCritMs:  Number(process.env.SLO_SCHEDULER_LAG_CRIT_MS ?? 15_000),
};


export function evaluateSlos(
  metrics: SloMetrics,
  thresholds: SloThresholds = DEFAULT_THRESHOLDS,
): SloResult[] {
  const results: SloResult[] = [];

  {
    const v = metrics.p95LatencyMs;
    const severity: SloSeverity =
      v >= thresholds.p95LatencyCritMs ? 'critical'
      : v >= thresholds.p95LatencyWarnMs ? 'warning'
      : 'ok';
    results.push({
      id: 'P95_LATENCY',
      name: 'P95 Queue Latency',
      target: `≤ ${thresholds.p95LatencyWarnMs / 1000}s`,
      current: v,
      unit: 'ms',
      ok: severity === 'ok',
      severity,
      message: severity === 'ok'
        ? `P95 latency ${(v / 1000).toFixed(2)}s — within SLO`
        : `P95 latency ${(v / 1000).toFixed(2)}s exceeds ${severity} threshold (${thresholds[severity === 'critical' ? 'p95LatencyCritMs' : 'p95LatencyWarnMs'] / 1000}s)`,
    });
  }

  {
    const total = metrics.completed1h + metrics.dlqCount1h;
    const dlqPct = total > 0 ? (metrics.dlqCount1h / total) * 100 : 0;
    const severity: SloSeverity =
      dlqPct >= thresholds.dlqRateCritPct ? 'critical'
      : dlqPct >= thresholds.dlqRateWarnPct ? 'warning'
      : 'ok';
    results.push({
      id: 'DEAD_LETTER_RATE',
      name: 'Dead-Letter Rate',
      target: `< ${thresholds.dlqRateWarnPct}% of jobs DLQ'd per hour`,
      current: Number(dlqPct.toFixed(2)),
      unit: '%',
      ok: severity === 'ok',
      severity,
      message: severity === 'ok'
        ? `DLQ rate ${dlqPct.toFixed(1)}% — within SLO`
        : `DLQ rate ${dlqPct.toFixed(1)}% exceeds ${severity} threshold (${thresholds[severity === 'critical' ? 'dlqRateCritPct' : 'dlqRateWarnPct']}%)`,
    });
  }

  {
    const v = metrics.drainRatePerSec;
    const severity: SloSeverity =
      v === 0 ? 'critical'
      : v < thresholds.drainRateWarn ? 'warning'
      : 'ok';
    results.push({
      id: 'DRAIN_RATE',
      name: 'Queue Drain Rate',
      target: `≥ ${thresholds.drainRateWarn} jobs/s`,
      current: v,
      unit: 'jobs/s',
      ok: severity === 'ok',
      severity,
      message: severity === 'ok'
        ? `Drain rate ${v.toFixed(2)} jobs/s — within SLO`
        : severity === 'critical'
        ? 'Queue is stalled — no jobs completing'
        : `Drain rate ${v.toFixed(2)} jobs/s below target (${thresholds.drainRateWarn} jobs/s)`,
    });
  }

  {
    const v = metrics.onlineWorkers;
    const severity: SloSeverity = v === 0 ? 'critical' : 'ok';
    results.push({
      id: 'WORKER_ONLINE',
      name: 'Worker Availability',
      target: '≥ 1 worker online',
      current: v,
      unit: 'workers',
      ok: v > 0,
      severity,
      message: v > 0
        ? `${v} worker${v !== 1 ? 's' : ''} online — within SLO`
        : 'No workers online — queue will not drain',
    });
  }

  {
    const v = metrics.schedulerHeartbeatAgeMs;
    const isOffline = v < 0;
    const severity: SloSeverity =
      isOffline || v >= thresholds.schedulerLagCritMs ? 'critical'
      : v >= thresholds.schedulerLagWarnMs ? 'warning'
      : 'ok';
    results.push({
      id: 'SCHEDULER_LAG',
      name: 'Scheduler Heartbeat',
      target: `< ${thresholds.schedulerLagWarnMs / 1000}s stale`,
      current: isOffline ? -1 : v,
      unit: 'ms',
      ok: severity === 'ok',
      severity,
      message: isOffline
        ? 'Scheduler offline — no heartbeat recorded'
        : severity === 'ok'
        ? `Scheduler heartbeat ${(v / 1000).toFixed(1)}s ago — within SLO`
        : `Scheduler heartbeat ${(v / 1000).toFixed(1)}s ago — ${severity}`,
    });
  }

  return results;
}

/** Convenience: returns true when any SLO is breached at or above minSeverity. */
export function hasBreaches(
  results: SloResult[],
  minSeverity: SloSeverity = 'warning',
): boolean {
  const ORDER: Record<SloSeverity, number> = { ok: 0, warning: 1, critical: 2 };
  return results.some(r => ORDER[r.severity] >= ORDER[minSeverity]);
}

/** Returns only the breached SLOs, sorted critical-first. */
export function breaches(results: SloResult[]): SloResult[] {
  const ORDER: Record<SloSeverity, number> = { ok: 0, warning: 1, critical: 2 };
  return results
    .filter(r => r.severity !== 'ok')
    .sort((a, b) => ORDER[b.severity] - ORDER[a.severity]);
}
