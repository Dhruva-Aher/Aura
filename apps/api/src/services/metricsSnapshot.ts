import { redis } from './QueueService';
import { prisma } from '@aura/database';

type Trend = 'up' | 'down' | 'flat';
const LATENCY_WINDOW_MINUTES = Number(process.env.LATENCY_WINDOW_MINUTES || 10);
const LATENCY_WINDOW_MS = LATENCY_WINDOW_MINUTES * 60_000;

function pctChange(current: number, previous: number): number {
  if (previous <= 0) return current > 0 ? 100 : 0;
  return Number((((current - previous) / previous) * 100).toFixed(1));
}

function trendFromChange(change: number): Trend {
  if (change > 0) return 'up';
  if (change < 0) return 'down';
  return 'flat';
}

export async function buildMetricsOverview() {
  const now = Date.now();
  const oneHourAgo = now - 3600000;
  const twoHoursAgo = now - 7200000;
  const latencyWindowStart = now - LATENCY_WINDOW_MS;
  const prevLatencyWindowStart = latencyWindowStart - LATENCY_WINDOW_MS;

  // Cleanup old metrics to prevent memory leaks (do this async, don't wait)
  redis.zremrangebyscore('aura:metrics:throughput', 0, twoHoursAgo).catch(() => {});
  redis.zremrangebyscore('aura:metrics:latency', 0, twoHoursAgo).catch(() => {});

  const [queueHigh, queueDefault, queueLow, processing, delayed, stateMetrics, completed1h, completedPrev1h, failed1h, retried1h, processingSamples1h, startedJobsRecent, startedJobsPrevRecent, activeWorkers, allWorkers, bpAccepted, bpRejected] = await Promise.all([
    redis.zcard('aura:queue:high'),
    redis.zcard('aura:queue:default'),
    redis.zcard('aura:queue:low'),
    redis.zcard('aura:leased'),
    redis.zcard('aura:delayed'),
    redis.hgetall('aura:metrics:state'),
    redis.zcount('aura:metrics:throughput', oneHourAgo, now),
    redis.zcount('aura:metrics:throughput', twoHoursAgo, oneHourAgo - 1),
    redis.zcount('aura:metrics:failed', oneHourAgo, now),
    redis.zcount('aura:metrics:retried', oneHourAgo, now),
    redis.zrangebyscore('aura:metrics:processing_time', oneHourAgo, now),
    prisma.job.findMany({
      where: {
        completedAt: { not: null, gte: new Date(latencyWindowStart), lte: new Date(now) },
        startedAt: { not: null },
      },
      select: { startedAt: true, scheduledFor: true },
    }),
    prisma.job.findMany({
      where: {
        completedAt: { not: null, gte: new Date(prevLatencyWindowStart), lt: new Date(latencyWindowStart) },
        startedAt: { not: null },
      },
      select: { startedAt: true, scheduledFor: true },
    }),
    redis.scard('aura:workers:active'),
    redis.scard('aura:workers:all'),
    redis.get('aura:metrics:bp:accepted'),
    redis.get('aura:metrics:bp:rejected'),
  ]);

  const active = queueHigh + queueDefault + queueLow;
  const completed = parseInt(stateMetrics.COMPLETED || '0', 10);
  const failed = parseInt(stateMetrics.FAILED || '0', 10) + parseInt(stateMetrics.DEAD_LETTER || '0', 10);

  const toQueueLatenciesMs = (jobs: { startedAt: Date | null; scheduledFor: Date }[]) =>
    jobs
      .filter((j) => j.startedAt !== null)
      .map((j) => j.startedAt!.getTime() - j.scheduledFor.getTime())
      .filter((ms) => ms >= 0);

  // Generic percentile helper — returns value in seconds (1 decimal).
  // p is a fraction 0–1 (e.g. 0.95 for P95).
  const percentileFromLatencies = (latenciesMs: number[], p: number): number => {
    if (!latenciesMs.length) return 0;
    const sorted = [...latenciesMs].sort((a, b) => a - b);
    const idx = Math.min(Math.floor(sorted.length * p), sorted.length - 1);
    return Math.round(((sorted[idx] ?? 0) / 100)) / 10;
  };
  const p95FromEncodedDurations = (rows: string[]) => {
    if (!rows.length) return 0;
    const durations = rows.map((r) => parseInt(r.split(':')[0] || '0', 10)).filter((d) => d >= 0).sort((a, b) => a - b);
    if (!durations.length) return 0;
    const idx = Math.min(Math.floor(durations.length * 0.95), durations.length - 1);
    return Math.round(((durations[idx] ?? 0) / 100)) / 10;
  };

  const currentQueueLatencies = toQueueLatenciesMs(startedJobsRecent);
  const previousQueueLatencies = toQueueLatenciesMs(startedJobsPrevRecent);
  const p50Latency = percentileFromLatencies(currentQueueLatencies, 0.50);
  const p95Latency = percentileFromLatencies(currentQueueLatencies, 0.95);
  const p99Latency = percentileFromLatencies(currentQueueLatencies, 0.99);
  const prevP95Latency = percentileFromLatencies(previousQueueLatencies, 0.95);

  const throughput = Number((completed1h / 60).toFixed(2));
  const prevThroughput = Number((completedPrev1h / 60).toFixed(2));
  const drainRate = Number((completed1h / 3600).toFixed(4));
  const retryRate = completed1h > 0 ? Number(((retried1h / completed1h) * 100).toFixed(2)) : 0;
  const failureRate = completed1h > 0 ? Number(((failed1h / completed1h) * 100).toFixed(2)) : 0;
  const bpAcceptedTotal = parseInt(bpAccepted ?? '0', 10);
  const bpRejectedTotal = parseInt(bpRejected ?? '0', 10);
  const rejectionRate = bpAcceptedTotal + bpRejectedTotal > 0
    ? Number(((bpRejectedTotal / (bpAcceptedTotal + bpRejectedTotal)) * 100).toFixed(2))
    : 0;
  const workerCapacity = Math.max(activeWorkers, allWorkers, 1) * Number(process.env.WORKER_CONCURRENCY || 20);
  const workerUtilization = Number(((processing / workerCapacity) * 100).toFixed(2));
  const processingTimeP95 = p95FromEncodedDurations(processingSamples1h);

  const throughputChange = pctChange(throughput, prevThroughput);
  const latencyChange = pctChange(p95Latency, prevP95Latency);

  return {
    active: { value: active, trend: 'flat' as const },
    processing: { value: processing, trend: 'flat' as const },
    completed: { value: completed, change: 0, trend: 'up' as const },
    failed: { value: failed, change: 0, trend: 'flat' as const },
    delayed: { value: delayed, trend: 'flat' as const },
    p50Latency,
    p95Latency,
    p99Latency,
    latencyChange,
    throughput,
    throughputChange,
    completed1h,
    failed1h: Number(failed1h),
    workerUtilization,
    drainRate,
    retryRate,
    failureRate,
    processingTimeP95,
    backpressure: {
      accepted: bpAcceptedTotal,
      rejected: bpRejectedTotal,
      rejectionRate,
    },
    totalWorkers: Number(allWorkers),
    activeWorkers: Number(activeWorkers),
    queueDepth: {
      high: Number(queueHigh),
      default: Number(queueDefault),
      low: Number(queueLow),
    },
  };
}
