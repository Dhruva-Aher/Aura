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
    console.log('[Scheduler] Reconciling PENDING jobs from Postgres to Redis...');
    try {
      const pendingJobs = await prisma.job.findMany({ where: { status: 'PENDING' } });
      for (const job of pendingJobs) {
        const queueRaw = await redis.hget(`aura:meta:${job.id}`, 'queue');
        const activeKey = queueRaw === 'high' ? 'aura:queue:high' : queueRaw === 'low' ? 'aura:queue:low' : 'aura:queue:default';
        await redis.zadd(activeKey, job.priority, job.id);
        await redis.hset(`aura:meta:${job.id}`, {
          priority: job.priority,
          attempts: job.attempts,
          maxAttempts: job.maxAttempts,
          queue: queueRaw === 'high' || queueRaw === 'low' ? queueRaw : 'default'
        });
      }
      console.log(`[Scheduler] Reconciled ${pendingJobs.length} PENDING jobs`);
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
          
          const reaped = await (redis as any).reapJobs('aura:leased', 'aura:queue:default', 'aura:meta:', 'aura:queue:high', 'aura:queue:low', now);
          for (const [jobId, action] of reaped) {
            console.log(`[Scheduler] Reaped job ${jobId} -> ${action}`);
            await redis.publish(EVENT_CHANNEL, JSON.stringify({
              type: action === 'REQUEUED' ? 'job_requeued' : 'job_failed',
              jobId,
              source: 'scheduler',
              at: Date.now(),
            }));
            
            let targetStatus: 'PENDING' | 'DEAD_LETTER' = action === 'DEAD_LETTER' ? 'DEAD_LETTER' : 'PENDING';
            if (action === 'REQUEUED') {
              const [high, def, low, delayed, leased] = await Promise.all([
                redis.zscore('aura:queue:high', jobId),
                redis.zscore('aura:queue:default', jobId),
                redis.zscore('aura:queue:low', jobId),
                redis.zscore('aura:delayed', jobId),
                redis.zscore('aura:leased', jobId),
              ]);
              const verified = high !== null || def !== null || low !== null || delayed !== null || leased !== null;
              if (!verified) targetStatus = 'DEAD_LETTER';
            }

            await prisma.$transaction([
              prisma.job.update({
                where: { id: jobId },
                data: { status: targetStatus }
              }),
              prisma.jobEvent.create({
                data: { jobId, type: 'REAPED', message: `Lease expired. Action: ${action}${action === 'REQUEUED' && targetStatus === 'DEAD_LETTER' ? ' (requeue verification failed)' : ''}` }
              })
            ]);
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
