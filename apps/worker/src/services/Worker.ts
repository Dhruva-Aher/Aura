import { prisma, Prisma } from '@aura/database';
import { createRedisClient } from '@aura/redis';
import { randomUUID } from 'crypto';
import os from 'os';

const redis = createRedisClient();
const WORKER_ID = randomUUID();
const LEASE_MS = 30000;
const EVENT_CHANNEL = 'aura:events';

const QUEUE_KEYS = {
  high: 'aura:queue:high',
  default: 'aura:queue:default',
  low: 'aura:queue:low',
} as const;

function formatMemoryMb(bytes: number) {
  return `${Math.round(bytes / 1024 / 1024)}MB`;
}

export class Worker {
  private id: string;
  private pool: string;
  private isRunning: boolean = false;
  private concurrency: number;
  private activeJobs: number = 0;
  private claimMisses = 0;

  constructor(pool: string = 'default', concurrency: number = 20) {
    this.id = `worker-${WORKER_ID.substring(0, 8)}`;
    this.pool = pool;
    this.concurrency = concurrency;
  }

  async start() {
    this.isRunning = true;
    
    // Register worker
    await prisma.worker.upsert({
      where: { id: this.id },
      update: { status: 'ONLINE', lastHeartbeat: new Date() },
      create: { id: this.id, pool: this.pool, status: 'ONLINE' }
    });
    await redis.sadd('aura:workers:all', this.id);
    await redis.sadd('aura:workers:active', this.id);
    await redis.hset(`aura:worker:${this.id}`, {
      pool: this.pool,
      concurrency: this.concurrency,
      startedAt: Date.now(),
    });

    console.log(`[${this.id}] Started in pool: ${this.pool}`);
    
    this.startHeartbeat();
    for (let i = 0; i < this.concurrency; i++) {
      this.loop(i);
    }
  }

  private async startHeartbeat() {
    while (this.isRunning) {
      await new Promise(r => setTimeout(r, 10000));
      try {
        const cpus = os.cpus().length || 1;
        const oneMinuteLoad = os.loadavg()[0] ?? 0;
        const cpuPct = Number(Math.min(100, (oneMinuteLoad / cpus) * 100).toFixed(1));
        const mem = formatMemoryMb(process.memoryUsage().rss);

        await prisma.worker.update({
          where: { id: this.id },
          data: { 
            lastHeartbeat: new Date(),
            cpu: cpuPct,
            memory: mem,
            currentJobId: this.activeJobs > 0 ? `${this.activeJobs}/${this.concurrency} active` : null
          }
        });
        const utilPct = this.concurrency > 0
          ? Math.round((this.activeJobs / this.concurrency) * 100)
          : 0;

        await redis.hset(`aura:worker:${this.id}`, {
          lastHeartbeat: Date.now(),
          activeJobs: this.activeJobs,
          concurrency: this.concurrency,
          utilPct,
        });
        await redis.zadd('aura:metrics:worker_util', Date.now(), `${utilPct}:${this.id}`);
        await redis.publish(EVENT_CHANNEL, JSON.stringify({
          type: 'worker_heartbeat',
          workerId: this.id,
          pool: this.pool,
          activeJobs: this.activeJobs,
          concurrency: this.concurrency,
          utilPct,
          cpu: cpuPct,
          memory: mem,
          at: Date.now(),
        }));
      } catch (err) {
        console.error(`[${this.id}] Heartbeat failed:`, err);
      }
    }
  }

  private getQueueOrder() {
    if (this.pool === 'high-priority') {
      return [QUEUE_KEYS.high, QUEUE_KEYS.default, ...(this.claimMisses % 5 === 0 ? [QUEUE_KEYS.low] : [])];
    }
    if (this.pool === 'low-priority') {
      return [QUEUE_KEYS.low, QUEUE_KEYS.default, ...(this.claimMisses % 5 === 0 ? [QUEUE_KEYS.high] : [])];
    }
    const includeLow = this.claimMisses % 3 === 0;
    return [QUEUE_KEYS.high, QUEUE_KEYS.default, ...(includeLow ? [QUEUE_KEYS.low] : [])];
  }

  private async hasQueueMembership(jobId: string) {
    const [high, def, low, delayed, leased] = await Promise.all([
      redis.zscore(QUEUE_KEYS.high, jobId),
      redis.zscore(QUEUE_KEYS.default, jobId),
      redis.zscore(QUEUE_KEYS.low, jobId),
      redis.zscore('aura:delayed', jobId),
      redis.zscore('aura:leased', jobId),
    ]);
    return high !== null || def !== null || low !== null || delayed !== null || leased !== null;
  }

  private async loop(loopIndex: number) {
    while (this.isRunning) {
      try {
        const now = Date.now();
        const leaseExpiry = now + LEASE_MS;
        let claimed: [string, string] | null = null;
        for (const queueKey of this.getQueueOrder()) {
          claimed = await redis.claimJob(queueKey, 'aura:leased', leaseExpiry);
          if (claimed) break;
        }
        
        if (claimed) {
          this.claimMisses = 0;
          const [jobId] = claimed;
          this.activeJobs++;
          await this.processJob(jobId);
          this.activeJobs--;
        } else {
          this.claimMisses++;
          await new Promise(r => setTimeout(r, 1000)); // Sleep if no jobs
        }
      } catch (err) {
        console.error(`[${this.id}] Loop error:`, err);
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }

  private async processJob(jobId: string) {
    let leaseInterval: NodeJS.Timeout;
    
    try {
      const job = await prisma.job.findUnique({ where: { id: jobId } });
      if (!job) {
        await redis.completeJob('aura:leased', 'aura:meta:', jobId);
        return;
      }

      // Guard: only transition PENDING → PROCESSING. If another worker already claimed
      // this job (e.g. after lease expiry + requeue), updateMany returns count=0 and we abort.
      const claimed = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const result = await tx.job.updateMany({
          where: { id: jobId, status: 'PENDING' },
          data: { status: 'PROCESSING', workerId: this.id, startedAt: new Date() }
        });
        if (result.count === 0) return false;
        await tx.jobEvent.create({
          data: { jobId, type: 'CLAIMED', message: `Claimed by ${this.id}` }
        });
        return true;
      });
      if (!claimed) {
        // Job is no longer PENDING — already claimed by another worker or completed.
        // Clean up our Redis lease entry and abandon without executing.
        await redis.completeJob('aura:leased', 'aura:meta:', jobId);
        return;
      }
      await redis.publish(EVENT_CHANNEL, JSON.stringify({
        type: 'job_started',
        jobId,
        workerId: this.id,
        at: Date.now(),
      }));

      const scheduledTime = job.scheduledFor ? job.scheduledFor.getTime() : job.createdAt.getTime();
      const latency = Math.max(0, Date.now() - scheduledTime);
      await redis.zadd('aura:metrics:latency', Date.now(), `${latency}:${jobId}`);

      // Lease extension loop — conditional: only renew if the reaper hasn't evicted this job.
      leaseInterval = setInterval(async () => {
        const renewed = await redis.renewLease('aura:leased', jobId, Date.now() + LEASE_MS);
        if (!renewed) {
          // Reaper already removed this job from leased. Stop renewing — do not resurrect it.
          clearInterval(leaseInterval);
          return;
        }
        await prisma.job.update({ where: { id: jobId }, data: { lastHeartbeat: new Date() } });
      }, 10000);

      // --- EXECUTE TASK ---
      console.log(`[${this.id}] Executing job: ${job.name} (${jobId})`);
      await new Promise(r => setTimeout(r, Math.random() * 2000 + 500));

      // Deterministic failure: generator (or any caller) can set shouldFail=true in payload.
      const payload = job.payload as Record<string, unknown> | null;
      if (payload?.shouldFail === true) {
        throw new Error('Injected failure (shouldFail=true in payload)');
      }
      if (Math.random() < 0.1) {
        throw new Error('Simulated random failure');
      }
      // --- END EXECUTE ---

      // Success
      await redis.completeJob('aura:leased', 'aura:meta:', jobId);
      const now = Date.now();
      // Idempotent completion: only first PROCESSING -> COMPLETED transition wins.
      const updated = await prisma.job.updateMany({
        where: { id: jobId, status: 'PROCESSING' },
        data: { status: 'COMPLETED', completedAt: new Date() }
      });
      if (updated.count > 0) {
        await prisma.jobEvent.create({
          data: { jobId, type: 'COMPLETED', message: 'Execution successful' }
        });

        await redis.zadd('aura:metrics:throughput', now, jobId);
        await redis.hincrby('aura:metrics:state', 'COMPLETED', 1);

        const processingTime = Math.max(0, now - (job.startedAt ? job.startedAt.getTime() : now));
        await redis.zadd('aura:metrics:processing_time', now, `${processingTime}:${jobId}`);

        const bucket = Math.floor(now / 10000) * 10000;
        await redis.hincrby('aura:pulse:completed', bucket.toString(), 1);

        await redis.publish(EVENT_CHANNEL, JSON.stringify({
          type: 'job_completed',
          jobId,
          workerId: this.id,
          at: Date.now(),
        }));
        console.log(`[${this.id}] Completed job: ${jobId}`);
      }

    } catch (err: any) {
      console.error(`[${this.id}] Failed job ${jobId}:`, err.message);
      
      const result = await redis.failJob(
        'aura:leased',
        QUEUE_KEYS.default,
        'aura:meta:',
        QUEUE_KEYS.high,
        QUEUE_KEYS.low,
        'aura:delayed',
        jobId,
        Date.now()
      );
      let newStatus: 'PENDING' | 'DEAD_LETTER' = result === 'DEAD_LETTER' ? 'DEAD_LETTER' : 'PENDING';
      if (result === 'REQUEUED') {
        const verified = await this.hasQueueMembership(jobId);
        if (!verified) {
          // Never persist retryable PENDING without Redis queue membership.
          newStatus = 'DEAD_LETTER';
        }
      }
      
      const now = Date.now();
      if (newStatus === 'DEAD_LETTER') {
        await redis.hincrby('aura:metrics:state', 'DEAD_LETTER', 1);
      } else {
        await redis.hincrby('aura:metrics:state', 'FAILED', 1);
      }
      await redis.zadd('aura:metrics:failed', now, jobId);

      const bucket = Math.floor(now / 10000) * 10000;
      await redis.hincrby('aura:pulse:failed', bucket.toString(), 1);

      await prisma.$transaction([
        prisma.job.update({
          where: { id: jobId },
          data: { 
            status: newStatus,
            errorLog: { message: err.message, stack: err.stack },
            attempts: { increment: 1 }
          }
        }),
        prisma.jobEvent.create({
          data: { jobId, type: 'FAILED', message: `Failed: ${err.message}. Result: ${newStatus}${result === 'REQUEUED' && newStatus === 'DEAD_LETTER' ? ' (requeue verification failed)' : ''}` }
        })
      ]);
      await redis.publish(EVENT_CHANNEL, JSON.stringify({
        type: result === 'REQUEUED' ? 'job_requeued' : 'job_failed',
        jobId,
        workerId: this.id,
        status: newStatus,
        at: Date.now(),
      }));

    } finally {
      if (leaseInterval!) clearInterval(leaseInterval);
    }
  }

  async stop() {
    this.isRunning = false;
    await redis.srem('aura:workers:active', this.id);
    await prisma.worker.update({
      where: { id: this.id },
      data: { status: 'OFFLINE' }
    });
  }
}
