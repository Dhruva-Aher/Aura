import { prisma, Prisma } from '@aura/database';
import { createRedisClient } from '@aura/redis';
import { createLogger } from './Logger';
import { evaluateSlos, breaches, SloMetrics } from './SloEvaluator';

const redis = createRedisClient();
const EVENT_CHANNEL  = 'aura:events';
const ALERT_CHANNEL  = 'aura:alerts';
const log = createLogger('Scheduler');

// A job stuck in PROCESSING with no Redis lease entry and a stale heartbeat means
// the worker crashed AND Redis lost state. The reaper can't see it (not in aura:leased).
// This threshold must exceed LEASE_MS (30s) to avoid racing with live renewals.
const STALE_PROCESSING_THRESHOLD_MS = 45_000;

export class Scheduler {
  private isRunning: boolean = false;
  private lastOrphanSweep = 0;
  private lastStaleProcessingSweep = 0;
  private lastSloSweep = 0;

  async start() {
    if (this.isRunning) {
      log.warn('start() called while already running — ignored');
      return;
    }
    this.isRunning = true;
    log.info('Started');
    await this.reconcilePendingJobs();
    this.watchdog();
  }

  // Wraps loop() so a crash restarts it instead of silently killing scheduling.
  private async watchdog() {
    while (this.isRunning) {
      try {
        await this.loop();
      } catch (err: unknown) {
        log.error('Loop crashed unexpectedly — restarting in 5s', { err: (err instanceof Error ? err.message : String(err)) });
        await new Promise(r => setTimeout(r, 5000));
      }
    }
    // Clear heartbeat so dashboard shows "offline" immediately after graceful stop.
    await redis.del('aura:health:scheduler:last_loop').catch(() => {});
  }

  private async reconcilePendingJobs() {
    // Batch size prevents overwhelming Redis when the backlog is large.
    const BATCH = Number(process.env.RECONCILE_BATCH_SIZE ?? 1_000);
    const t0 = Date.now();
    log.info('Reconciling PENDING jobs', { batchSize: BATCH });
    try {
      // Process in pages so memory stays bounded.
      let cursor: string | undefined;
      let totalRestored = 0;
      let totalSkipped  = 0;

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const pendingJobs = await prisma.job.findMany({
          where: { status: 'PENDING' },
          select: { id: true, priority: true, attempts: true, maxAttempts: true },
          take: BATCH,
          ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
          orderBy: { id: 'asc' },
        });

        if (pendingJobs.length === 0) break;
        cursor = pendingJobs[pendingJobs.length - 1]!.id;

        for (const job of pendingJobs) {
          // Skip if already present in any Redis queue (quick restart protection).
          const [high, def, low, delayed, leased] = await Promise.all([
            redis.zscore('aura:queue:high',    job.id),
            redis.zscore('aura:queue:default', job.id),
            redis.zscore('aura:queue:low',     job.id),
            redis.zscore('aura:delayed',       job.id),
            redis.zscore('aura:leased',        job.id),
          ]);
          if (high !== null || def !== null || low !== null || delayed !== null || leased !== null) {
            totalSkipped++;
            continue;
          }

          const queueRaw = await redis.hget(`aura:meta:${job.id}`, 'queue');
          const queueName = queueRaw === 'high' ? 'high' : queueRaw === 'low' ? 'low' : 'default';
          const activeKey = queueName === 'high'
            ? 'aura:queue:high'
            : queueName === 'low'
            ? 'aura:queue:low'
            : 'aura:queue:default';

          // Write both queue entry and meta in a single pipeline (2 RTTs → 1).
          const pipe = redis.pipeline();
          pipe.zadd(activeKey, job.priority, job.id);
          pipe.hset(`aura:meta:${job.id}`, {
            priority:    job.priority,
            attempts:    job.attempts,
            maxAttempts: job.maxAttempts,
            queue:       queueName,
          });
          await pipe.exec();
          totalRestored++;
        }

        if (pendingJobs.length < BATCH) break; // last page
      }

      const durationMs = Date.now() - t0;
      log.info('Reconciliation complete', { restored: totalRestored, skipped: totalSkipped, durationMs });
      // Persist reconcile metrics so the dashboard / health endpoint can surface them.
      await redis.hset('aura:health:scheduler:reconcile', {
        restoredJobs: totalRestored,
        skippedJobs:  totalSkipped,
        durationMs,
        completedAt:  Date.now(),
      }).catch(() => {});
    } catch (err: unknown) {
      log.error('Failed to reconcile jobs', { err: (err instanceof Error ? err.message : String(err)) });
    }
  }

  private async reconcileOrphanedPendingJobs(limit = 500) {
    const pendingJobs = await prisma.job.findMany({
      where: { status: 'PENDING' },
      select: { id: true, priority: true },
      take: limit,
      orderBy: { updatedAt: 'desc' }
    });
    if (pendingJobs.length === 0) return;

    // Pipeline all 5 queue checks for all jobs into a single round-trip.
    const pipe = redis.pipeline();
    for (const job of pendingJobs) {
      pipe.zscore('aura:queue:high', job.id);
      pipe.zscore('aura:queue:default', job.id);
      pipe.zscore('aura:queue:low', job.id);
      pipe.zscore('aura:delayed', job.id);
      pipe.zscore('aura:leased', job.id);
    }
    const results = await pipe.exec();
    if (!results) return;

    let recovered = 0;
    const writePipe = redis.pipeline();
    
    for (let i = 0; i < pendingJobs.length; i++) {
      const baseIdx = i * 5;
      const high    = results[baseIdx][1];
      const def     = results[baseIdx + 1][1];
      const low     = results[baseIdx + 2][1];
      const delayed = results[baseIdx + 3][1];
      const leased  = results[baseIdx + 4][1];

      if (high !== null || def !== null || low !== null || delayed !== null || leased !== null) continue;

      const job = pendingJobs[i];
      const queueRaw = await redis.hget(`aura:meta:${job.id}`, 'queue');
      const activeKey = queueRaw === 'high' ? 'aura:queue:high' : queueRaw === 'low' ? 'aura:queue:low' : 'aura:queue:default';
      writePipe.zadd(activeKey, job.priority, job.id);
      recovered++;
    }

    if (recovered > 0) {
      await writePipe.exec();
      log.info('Recovered orphaned PENDING jobs', { recovered, checked: pendingJobs.length });
    }
  }

  private async recoverStaleProcessingJobs() {
    const staleThreshold = new Date(Date.now() - STALE_PROCESSING_THRESHOLD_MS);

    // Find PROCESSING jobs whose worker heartbeat has gone cold.
    // Use startedAt as a fallback when lastHeartbeat is null (worker crashed before first renewal).
    const staleJobs = await prisma.job.findMany({
      where: {
        status: 'PROCESSING',
        OR: [
          { lastHeartbeat: { lt: staleThreshold } },
          { lastHeartbeat: null, startedAt: { lt: staleThreshold } },
        ],
      },
      select: { id: true, priority: true },
    });
    if (staleJobs.length === 0) return;

    let recovered = 0;
    for (const job of staleJobs) {
      // If a live lease still exists in Redis the worker is fine — skip it.
      const leased = await redis.zscore('aura:leased', job.id);
      if (leased !== null) continue;

      const queueRaw = await redis.hget(`aura:meta:${job.id}`, 'queue');
      const activeKey = queueRaw === 'high'
        ? 'aura:queue:high'
        : queueRaw === 'low'
        ? 'aura:queue:low'
        : 'aura:queue:default';

      // Guard with updateMany so two concurrent Schedulers can't double-recover.
      const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const updated = await tx.job.updateMany({
          where: { id: job.id, status: 'PROCESSING' },
          data: { status: 'PENDING', workerId: null, lastHeartbeat: null },
        });
        if (updated.count === 0) return false;
        await tx.jobEvent.create({
          data: {
            jobId: job.id,
            type: 'RECOVERED',
            message: 'Recovered from stale PROCESSING — worker crash with no Redis lease',
          },
        });
        return true;
      });

      if (result) {
        await redis.zadd(activeKey, job.priority, job.id);
        recovered++;
        log.info('Recovered stale PROCESSING job', { jobId: job.id, queue: activeKey });
        await redis.publish(EVENT_CHANNEL, JSON.stringify({
          type: 'job_requeued',
          jobId: job.id,
          source: 'stale-recovery',
          at: Date.now(),
        }));
      }
    }
    if (recovered > 0) {
      log.info('Recovered stale PROCESSING jobs', { recovered, candidates: staleJobs.length });
    }
  }

  private async loop() {
    let lastReap = 0;
    while (this.isRunning) {
      try {
        const now = Date.now();

        // Heartbeat written every iteration (~100ms cadence) with a 10s TTL.
        // If the scheduler dies, the key expires within 10s and the dashboard
        // correctly transitions from "degraded" → "offline".
        await redis.set('aura:health:scheduler:last_loop', now.toString(), 'EX', 10);
        
        // 1. Promote delayed jobs
        const promotedCount = await (redis as any).promoteJobs('aura:delayed', 'aura:queue:default', 'aura:meta:', 'aura:queue:high', 'aura:queue:low', now);
        if (promotedCount > 0) {
          log.info('Promoted delayed jobs', { count: promotedCount });
        }

        // Heavy cleanup operations (every 5 seconds)
        if (now - lastReap > 5000) {
          lastReap = now;

          const reaped = await (redis as any).reapJobs(
            'aura:leased', 'aura:queue:default', 'aura:meta:',
            'aura:queue:high', 'aura:queue:low', 'aura:delayed', now
          );
          for (const [jobId, action] of reaped) {
            log.info('Reaped job', { jobId, action });
            await redis.publish(EVENT_CHANNEL, JSON.stringify({
              type: action === 'REQUEUED' ? 'job_requeued' : 'job_failed',
              jobId,
              source: 'scheduler',
              at: Date.now(),
            }));

            const targetStatus: 'PENDING' | 'DEAD_LETTER' =
              action === 'DEAD_LETTER' ? 'DEAD_LETTER' : 'PENDING';

            // Use updateMany with a status guard so we never overwrite a job
            // that completed (or was already dead-lettered) between the Redis
            // reap and this Postgres write — a real race during high throughput.
            // Also increment attempts to keep Postgres in sync with the Redis
            // meta counter that REAP_JOBS already incremented.
            await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
              const updated = await tx.job.updateMany({
                where: {
                  id: jobId,
                  status: { notIn: ['COMPLETED', 'DEAD_LETTER'] },
                },
                data: {
                  status: targetStatus,
                  attempts: { increment: 1 },
                  workerId: null,
                  lastHeartbeat: null,
                },
              });
              if (updated.count === 0) return; // already completed — do nothing
              await tx.jobEvent.create({
                data: {
                  jobId,
                  type: 'REAPED',
                  message: `Lease expired — worker crash assumed. Action: ${action}. Retry via delayed queue with exponential backoff.`,
                },
              });
            });
          }

          const offlineThreshold = new Date(Date.now() - 30000);
          await prisma.worker.updateMany({
            where: { lastHeartbeat: { lt: offlineThreshold }, status: 'ONLINE' },
            data: { status: 'OFFLINE', currentJobId: null }
          });

        }

        if (now - this.lastOrphanSweep > 10000) {
          this.lastOrphanSweep = now;
          await this.reconcileOrphanedPendingJobs();
        }

        if (now - this.lastStaleProcessingSweep > 30000) {
          this.lastStaleProcessingSweep = now;
          await this.recoverStaleProcessingJobs();
        }

        if (now - this.lastSloSweep > 30000) {
          this.lastSloSweep = now;
          await this.evaluateAndPublishSlos(now).catch((err: any) =>
            log.warn('SLO evaluation failed', { err: (err instanceof Error ? err.message : String(err)) }),
          );
        }

      } catch (err: unknown) {
        log.error('Loop iteration error', { err: (err instanceof Error ? err.message : String(err)) });
      }
      
      await new Promise(r => setTimeout(r, 100));
    }
  }

  private async evaluateAndPublishSlos(nowMs: number): Promise<void> {
    const oneHourAgo = nowMs - 3_600_000;

    // Collect metrics from Redis + Postgres in parallel.
    const [
      p95Raw,
      dlqCount1h,
      completed1h,
      drainRateRaw,
      onlineWorkers,
      heartbeatRaw,
    ] = await Promise.all([
      // P95 latency: stored as encoded 'latencyMs:jobId' members
      redis.zrangebyscore('aura:metrics:latency', oneHourAgo, nowMs).then(rows => {
        if (!rows.length) return 0;
        const samples = rows
          .map((r: string) => parseInt(r.split(':')[0] ?? '0', 10))
          .filter((n: number) => n >= 0)
          .sort((a: number, b: number) => a - b);
        const idx = Math.min(Math.floor(samples.length * 0.95), samples.length - 1);
        return samples[idx] ?? 0;
      }),
      redis.zcount('aura:metrics:failed', oneHourAgo, nowMs),
      redis.zcount('aura:metrics:throughput', oneHourAgo, nowMs),
      // Drain rate stored in reconcile hash (jobs/sec over last hour)
      redis.hget('aura:metrics:state', 'COMPLETED').then(v => {
        // Approximation: use completed count from all-time divided by uptime — not
        // available here, so use the 1h count / 3600 as in metricsSnapshot.ts
        return null; // resolved separately below
      }),
      prisma.worker.count({ where: { status: 'ONLINE' } }),
      redis.get('aura:health:scheduler:last_loop'),
    ]);

    const drainRatePerSec = Number((Number(completed1h) / 3600).toFixed(4));
    const schedulerHeartbeatAgeMs = heartbeatRaw
      ? nowMs - parseInt(heartbeatRaw, 10)
      : -1;

    const metrics: SloMetrics = {
      p95LatencyMs:            Number(p95Raw),
      dlqCount1h:              Number(dlqCount1h),
      completed1h:             Number(completed1h),
      drainRatePerSec,
      onlineWorkers:           Number(onlineWorkers),
      schedulerHeartbeatAgeMs,
    };

    const results = evaluateSlos(metrics);
    const activeBreaches = breaches(results);

    // Persist latest SLO snapshot to Redis so the health endpoint can serve it
    // without re-computing (a single hset, not one key per SLO).
    const pipe = redis.pipeline();
    pipe.set(
      'aura:health:slo:snapshot',
      JSON.stringify({ evaluatedAt: nowMs, results }),
      'EX', 120, // 2-minute TTL — stale if scheduler dies
    );

    // Publish one alert per breached SLO.
    for (const b of activeBreaches) {
      const alert = {
        type:    'slo_breach',
        sloId:   b.id,
        severity: b.severity,
        message: b.message,
        current: b.current,
        unit:    b.unit,
        at:      nowMs,
      };
      log[b.severity === 'critical' ? 'error' : 'warn'](
        `SLO breach: ${b.name}`,
        { sloId: b.id, severity: b.severity, current: b.current, unit: b.unit },
      );
      pipe.publish(ALERT_CHANNEL, JSON.stringify(alert));
      pipe.publish(EVENT_CHANNEL,  JSON.stringify({ ...alert, type: 'slo_breach' }));
    }
    await pipe.exec();

    if (activeBreaches.length === 0) {
      log.debug('All SLOs within bounds', { evaluated: results.length });
    }
  }

  stop() {
    this.isRunning = false;
  }
}
