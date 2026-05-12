/**
 * Worker process entry point.
 *
 * Every instance of this process:
 *   1. Starts N job-worker loops (concurrency controlled by env vars).
 *   2. Competes for the scheduler leadership lock via Redis.
 *      — The winner starts the Scheduler (promote + reap loops).
 *      — Losers retry acquisition every ~10s.
 *      — If the leader crashes, the lock expires in 15s and a loser takes over.
 *
 * This means:
 *   • Exactly one scheduler runs across all replicas at any time.
 *   • No SCHEDULER_ENABLED env var to forget or misconfigure.
 *   • Automatic failover without manual intervention.
 */

import { Worker } from './services/Worker';
import { Scheduler } from './services/Scheduler';
import { SchedulerLock } from './services/SchedulerLock';
import { JobGenerator } from './jobGenerator';
import { createRedisClient } from '@aura/redis';

const redis = createRedisClient();

async function bootstrap() {
  const defaultWorkers = Math.max(Number(process.env.DEFAULT_WORKERS  || 2), 0);
  const highWorkers    = Math.max(Number(process.env.HIGH_WORKERS     || 1), 0);
  const lowWorkers     = Math.max(Number(process.env.LOW_WORKERS      || 1), 0);
  const concurrency    = Math.max(Number(process.env.WORKER_CONCURRENCY || 20), 1);

  // ── Start job-worker pool ─────────────────────────────────────────────────
  const workers: Worker[] = [];
  for (let i = 0; i < defaultWorkers;  i++) workers.push(new Worker('default',       concurrency));
  for (let i = 0; i < highWorkers;     i++) workers.push(new Worker('high-priority', concurrency));
  for (let i = 0; i < lowWorkers;      i++) workers.push(new Worker('low-priority',  concurrency));
  for (const w of workers) await w.start();

  // ── Scheduler leader election ─────────────────────────────────────────────
  // All instances race for the lock.  The winner runs the Scheduler.
  // startElection() is recursive: if the lock is lost it re-enters the race.
  const scheduler = new Scheduler();
  const lock      = new SchedulerLock(redis);

  const startElection = async () => {
    const won = await lock.tryAcquire().catch(() => false);

    if (won) {
      console.log(`[Bootstrap] Scheduler election won (id=${lock.instanceId.slice(0,8)}) — starting scheduler`);
      await scheduler.start();

      lock.startRenewing(() => {
        // Lock lost — stop this scheduler, enter the retry loop so we can
        // win the lock again if the new leader later dies.
        console.warn('[Bootstrap] Scheduler lock lost — stopping scheduler and re-entering election');
        scheduler.stop();
        lock.startRetrying(async () => {
          console.log('[Bootstrap] Re-acquired scheduler lock — restarting scheduler');
          await scheduler.start();
          lock.startRenewing(() => {
            console.warn('[Bootstrap] Scheduler lock lost again — stopping');
            scheduler.stop();
            lock.startRetrying(startElection);
          });
        });
      });

    } else {
      // Lost this round — keep retrying in the background
      console.log(`[Bootstrap] Scheduler election lost — standing by as replica (id=${lock.instanceId.slice(0,8)})`);
      lock.startRetrying(async () => {
        console.log('[Bootstrap] Acquired scheduler lock — starting scheduler');
        await scheduler.start();
        lock.startRenewing(() => {
          console.warn('[Bootstrap] Scheduler lock lost — stopping scheduler and re-entering election');
          scheduler.stop();
          lock.startRetrying(startElection);
        });
      });
    }
  };

  await startElection();

  // ── Optional job generator (load testing / dev) ───────────────────────────
  const generator = process.env.JOB_GENERATOR_ENABLED === 'true'
    ? new JobGenerator()
    : null;
  if (generator) await generator.start();

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    console.log(`[Bootstrap] Received ${signal} — shutting down gracefully`);
    generator?.stop();
    scheduler.stop();
    await lock.release();        // releases the lock immediately so a peer can take over
    for (const w of workers) await w.stop();
    await redis.quit().catch(() => {});
    process.exit(0);
  };

  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

bootstrap().catch((err) => {
  console.error('[Bootstrap] Fatal startup error:', err);
  process.exit(1);
});
