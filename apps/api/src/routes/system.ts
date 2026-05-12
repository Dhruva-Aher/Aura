import { Router } from 'express';
import { prisma } from '@aura/database';
import { redis } from '../services/QueueService';

const router = Router();

router.get('/health', async (req, res) => {
  try {
    const apiStart = Date.now();
    const pgStart = Date.now();
    await prisma.$queryRaw`SELECT 1`;
    const pgMs = Date.now() - pgStart;

    const redisStart = Date.now();
    await redis.ping();
    const redisMs = Date.now() - redisStart;

    const heartbeatThreshold = new Date(Date.now() - 30000);
    const [onlineWorkers, totalWorkers, staleWorkers, lastLoopRaw, highBacklog, defaultBacklog, lowBacklog, delayedBacklog, completed1h] = await Promise.all([
      prisma.worker.count({ where: { status: 'ONLINE' } }),
      prisma.worker.count(),
      prisma.worker.count({ where: { status: 'ONLINE', lastHeartbeat: { lt: heartbeatThreshold } } }),
      redis.get('aura:health:scheduler:last_loop'),
      redis.zcard('aura:queue:high'),
      redis.zcard('aura:queue:default'),
      redis.zcard('aura:queue:low'),
      redis.zcard('aura:delayed'),
      redis.zcount('aura:metrics:throughput', Date.now() - 3600000, Date.now()),
    ]);
    const backlogSize = highBacklog + defaultBacklog + lowBacklog + delayedBacklog;

    const sloSnapshotRaw = await redis.get('aura:health:slo:snapshot').catch(() => null);

    const lagQuery = await prisma.$queryRaw`
      SELECT 
        COALESCE(AVG(EXTRACT(EPOCH FROM (NOW() - "scheduledFor"))), 0) as avg_lag,
        COALESCE(MAX(EXTRACT(EPOCH FROM (NOW() - "scheduledFor"))), 0) as max_lag
      FROM "Job"
      WHERE status = 'PENDING'
    ` as any[];
    const avgLagMs = Math.round(Math.max(0, Number(lagQuery[0]?.avg_lag || 0)) * 1000);
    const maxLagMs = Math.round(Math.max(0, Number(lagQuery[0]?.max_lag || 0)) * 1000);
    const drainRate = Number((Number(completed1h) / 3600).toFixed(4));
    // Utilization = active leased slots / total concurrent slots (0–100%).
    // Do NOT divide backlog by capacity — that gives meaningless 4000%+ values
    // when the queue is large. Backlog depth is reported separately.
    const leasedJobs = await redis.zcard('aura:leased');
    const workerCapacity = Math.max(totalWorkers, 1) * Number(process.env.WORKER_CONCURRENCY || 20);
    const utilization = Number(((leasedJobs / workerCapacity) * 100).toFixed(2));

    const apiMs = Date.now() - apiStart;
    const workerState = staleWorkers > 0 ? 'degraded' : 'ok';
    const schedulerDelay = lastLoopRaw ? Date.now() - parseInt(lastLoopRaw, 10) : -1;
    const schedulerState = schedulerDelay >= 0 && schedulerDelay < 5000 ? 'ok' : 'degraded';
    const sloSnapshot = sloSnapshotRaw ? JSON.parse(sloSnapshotRaw) : null;
    const sloBreachCount = sloSnapshot
      ? (sloSnapshot.results as any[]).filter((r: any) => r.severity !== 'ok').length
      : 0;
    const hasCriticalSlo = sloSnapshot
      ? (sloSnapshot.results as any[]).some((r: any) => r.severity === 'critical')
      : false;

    const overallState =
      backlogSize > 10000 || utilization > 95 || hasCriticalSlo ? 'overloaded'
      : backlogSize > 3000 || staleWorkers > 0 || avgLagMs > 10000 || sloBreachCount > 0 ? 'degraded'
      : 'ok';

    res.json([
      { name: 'API Gateway', status: apiMs < 300 ? 'Healthy' : 'Degraded', ms: `${apiMs}ms`, state: apiMs < 300 ? 'ok' : 'degraded' },
      { name: `Worker Pool (${onlineWorkers}/${totalWorkers})`, status: staleWorkers > 0 ? `${staleWorkers} stale workers` : 'Healthy', ms: `${utilization}% saturated`, state: workerState },
      { name: 'Queue Backlog', status: backlogSize > 1000 ? 'Heavy Load' : 'Healthy', ms: `${backlogSize} jobs`, state: backlogSize > 5000 ? 'degraded' : 'ok' },
      { name: 'Queue Lag (Avg)', status: avgLagMs < 5000 ? 'Healthy' : 'Delayed', ms: `${avgLagMs}ms`, state: avgLagMs < 5000 ? 'ok' : 'degraded' },
      { name: 'Queue Lag (Max)', status: maxLagMs < 10000 ? 'Healthy' : 'Delayed', ms: `${maxLagMs}ms`, state: maxLagMs < 10000 ? 'ok' : 'degraded' },
      { name: 'Queue Drain Rate', status: drainRate > 0 ? 'Healthy' : 'Stalled', ms: `${drainRate} jobs/s`, state: drainRate > 0 ? 'ok' : 'degraded' },
      { name: 'Scheduler Loop', status: schedulerState === 'ok' ? 'Healthy' : 'Delayed', ms: schedulerDelay >= 0 ? `${schedulerDelay}ms` : 'offline', state: schedulerState },
      { name: 'SLO Status', status: sloBreachCount === 0 ? 'All SLOs Met' : `${sloBreachCount} breach${sloBreachCount !== 1 ? 'es' : ''}`, ms: sloSnapshot ? `${(sloSnapshot.results as any[]).filter((r: any) => r.ok).length}/${(sloSnapshot.results as any[]).length} passing` : 'pending', state: hasCriticalSlo ? 'degraded' : sloBreachCount > 0 ? 'degraded' : 'ok', slos: sloSnapshot?.results ?? [] },
      { name: 'Redis', status: redisMs < 100 ? 'Healthy' : 'Degraded', ms: `${redisMs}ms`, state: redisMs < 100 ? 'ok' : 'degraded' },
      { name: 'PostgreSQL', status: pgMs < 200 ? 'Healthy' : 'Degraded', ms: `${pgMs}ms`, state: pgMs < 200 ? 'ok' : 'degraded' },
      { name: 'System Status', status: overallState === 'ok' ? 'Healthy' : overallState === 'degraded' ? 'Degraded' : 'Overloaded', ms: `${backlogSize} queued`, state: overallState },
    ]);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/workers/summary', async (_req, res) => {
  try {
    const [totalWorkers, activeWorkers] = await Promise.all([
      redis.scard('aura:workers:all'),
      redis.scard('aura:workers:active'),
    ]);
    res.json({ totalWorkers, activeWorkers });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/workers', async (req, res) => {
  try {
    const workers = await prisma.worker.findMany({
      orderBy: { lastHeartbeat: 'desc' }
    });
    res.json(workers);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
