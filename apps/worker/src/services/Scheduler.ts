import { prisma, Prisma } from '@aura/database';
import { createRedisClient } from '@aura/redis';

const redis = createRedisClient();
const EVENT_CHANNEL = 'aura:events';

// A job stuck in PROCESSING with no Redis lease entry and a stale heartbeat means
// the worker crashed AND Redis lost state. The reaper can't see it (not in aura:leased).
// This threshold must exceed LEASE_MS (30s) to avoid racing with live renewals.
const STALE_PROCESSING_THRESHOLD_MS = 45_000;

export class Scheduler {
  private isRunning: boolean = false;
  private lastOrphanSweep = 0;
  private lastStaleProcessingSweep = 0;

  async start() {
    if (this.isRunning) {
      console.warn('[Scheduler] start() called while already running — ignored');
      return;
    }
    this.isRunning = true;
    console.log('[Scheduler] Started');
    await this.reconcilePendingJobs();
    this.watchdog();
  }

  // Wraps loop() so a crash restarts it instead of silently killing scheduling.
  private async watchdog() {
    while (this.isRunning) {
      try {
        await this.loop();
      } catch (err) {
        console.error('[Scheduler] Loop crashed unexpectedly — restarting in 5s:', err);
        await new Promise(r => setTimeout(r, 5000));
      }
    }
    // Clear heartbeat so dashboard shows "offline" immediately after graceful stop.
    await redis.del('aura:health:scheduler:last_loop').catch(() => {});
  }

  private async reconcilePendingJobs() {
    // Batch size prevents overwhelming Redis when the backlog is large.
    const BATCH = Number(process.env.RECONCILE_BATCH_SIZE ?? 1_000);
    console.log(`[Scheduler] Reconciling PENDING jobs (batch=${BATCH})…`);
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

      console.log(`[Scheduler] Reconciliation complete: restored=${totalRestored} skipped=${totalSkipped}`);
    } catch (err) {
      console.error('[Scheduler] Failed to reconcile jobs:', err);
    }
  }

  private async reconcileOrphanedPendingJobs(limit = 500) {
    const pendingJobs = await prisma.job.findMany({
      where: { status: 'PENDING' },
      select: { id: true, priority: true },
      take: limit,
      orderBy: { updatedAt: 'desc' }
    });
    let recovered = 0;
    for (const job of pendingJobs) {
      const [high, def, low, delayed, leased] = await Promise.all([
        redis.zscore('aura:queue:high', job.id),
        redis.zscore('aura:queue:default', job.id),
        redis.zscore('aura:queue:low', job.id),
        redis.zscore('aura:delayed', job.id),
        redis.zscore('aura:leased', job.id),
      ]);
      if (high !== null || def !== null || low !== null || delayed !== null || leased !== null) continue;

      const queueRaw = await redis.hget(`aura:meta:${job.id}`, 'queue');
      const activeKey = queueRaw === 'high' ? 'aura:queue:high' : queueRaw === 'low' ? 'aura:queue:low' : 'aura:queue:default';
      await redis.zadd(activeKey, job.priority, job.id);
      recovered++;
    }
    if (recovered > 0) {
      console.log(`[Scheduler] Recovered ${recovered} orphaned PENDING jobs`);
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
        console.log(`[Scheduler] Recovered stale PROCESSING job ${job.id}`);
        await redis.publish(EVENT_CHANNEL, JSON.stringify({
          type: 'job_requeued',
          jobId: job.id,
          source: 'stale-recovery',
          at: Date.now(),
        }));
      }
    }
    if (recovered > 0) {
      console.log(`[Scheduler] Recovered ${recovered} stale PROCESSING jobs`);
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
          console.log(`[Scheduler] Promoted ${promotedCount} delayed jobs`);
        }

        // Heavy cleanup operations (every 5 seconds)
        if (now - lastReap > 5000) {
          lastReap = now;
          
          const reaped = await (redis as any).reapJobs(
            'aura:leased', 'aura:queue:default', 'aura:meta:',
            'aura:queue:high', 'aura:queue:low', 'aura:delayed', now
          );
          for (const [jobId, action] of reaped) {
            console.log(`[Scheduler] Reaped job ${jobId} -> ${action}`);
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

      } catch (err) {
        console.error('[Scheduler] Error:', err);
      }
      
      await new Promise(r => setTimeout(r, 100));
    }
  }

  stop() {
    this.isRunning = false;
  }
}
