import { Router } from 'express';
import { prisma } from '@aura/database';
import { buildMetricsOverview } from '../services/metricsSnapshot';
import { redis } from '../services/QueueService';

const router = Router();
const LATENCY_WINDOW_MINUTES = Number(process.env.LATENCY_WINDOW_MINUTES || 10);
const LATENCY_WINDOW_MS = LATENCY_WINDOW_MINUTES * 60_000;

router.get('/overview', async (req, res) => {
  try {
    const overview = await buildMetricsOverview();
    res.json(overview);
  } catch (err: unknown) {
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

router.get('/pulse', async (req, res) => {
  try {
    const now = Date.now();
    const currentBucket = Math.floor(now / 10000) * 10000;
    const points = [];
    const oldestBucket = currentBucket - (29 * 10000);
    const latencyWindowStart = now - LATENCY_WINDOW_MS;

    const [completedBuckets, failedBuckets, scheduledBuckets, startedJobs] = await Promise.all([
      redis.hgetall('aura:pulse:completed'),
      redis.hgetall('aura:pulse:failed'),
      redis.hgetall('aura:pulse:scheduled'),
      prisma.job.findMany({
        where: {
          completedAt: { not: null, gte: new Date(Math.max(oldestBucket, latencyWindowStart)), lte: new Date(currentBucket + 9999) },
          startedAt: { not: null },
        },
        select: { startedAt: true, scheduledFor: true, completedAt: true },
      }),
    ]);

    const latencyByBucket = new Map<number, number[]>();
    for (const job of startedJobs) {
      if (!job.startedAt || !job.completedAt) continue;
      const queueLatencyMs = job.startedAt.getTime() - job.scheduledFor.getTime();
      if (queueLatencyMs < 0) continue;
      const bucket = Math.floor(job.completedAt.getTime() / 10000) * 10000;
      const existing = latencyByBucket.get(bucket);
      if (existing) existing.push(queueLatencyMs);
      else latencyByBucket.set(bucket, [queueLatencyMs]);
    }

    for (let i = 29; i >= 0; i--) {
      const bucketTime = currentBucket - (i * 10000);
      const bStr = bucketTime.toString();
      
      const completed = parseInt(completedBuckets[bStr] || '0', 10);
      const failed = parseInt(failedBuckets[bStr] || '0', 10);
      const scheduled = parseInt(scheduledBuckets[bStr] || '0', 10);

      const durations = [...(latencyByBucket.get(bucketTime) ?? [])].sort((a, b) => a - b);
      const idx = Math.floor(durations.length * 0.95);
      const p95 = Math.round(((durations[idx] ?? 0) / 100)) / 10;

      points.push({
        time: new Date(bucketTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }),
        completed,
        failed,
        scheduled,
        throughput: completed * 6, // multiply by 6 for jobs per minute (10s window)
        latency: p95.toFixed(2)
      });
    }

    // Cleanup old buckets periodically
    if (Math.random() < 0.1) {
      const oldKeys = Object.keys(completedBuckets).filter(k => parseInt(k, 10) < currentBucket - 600000);
      if (oldKeys.length) redis.hdel('aura:pulse:completed', ...oldKeys).catch(() => {});
      const oldFailedKeys = Object.keys(failedBuckets).filter(k => parseInt(k, 10) < currentBucket - 600000);
      if (oldFailedKeys.length) redis.hdel('aura:pulse:failed', ...oldFailedKeys).catch(() => {});
      const oldScheduledKeys = Object.keys(scheduledBuckets).filter(k => parseInt(k, 10) < currentBucket - 600000);
      if (oldScheduledKeys.length) redis.hdel('aura:pulse:scheduled', ...oldScheduledKeys).catch(() => {});
    }

    res.json(points);
  } catch (err: unknown) {
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

export default router;
