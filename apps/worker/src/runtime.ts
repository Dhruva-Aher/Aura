/**
 * Shared worker runtime — used by the worker process and by the API
 * when EMBEDDED_WORKER=true (free single-service deploy).
 */

import { Worker } from './services/Worker';
import { Scheduler } from './services/Scheduler';
import { SchedulerLock } from './services/SchedulerLock';
import { JobGenerator } from './jobGenerator';
import { createRedisClient } from '@aura/redis';

function freeTierDefaults() {
  const free = process.env.FREE_TIER === 'true' || process.env.EMBEDDED_WORKER === 'true';
  return {
    defaultWorkers: Math.max(Number(process.env.DEFAULT_WORKERS ?? (free ? 1 : 2)), 0),
    highWorkers: Math.max(Number(process.env.HIGH_WORKERS ?? (free ? 0 : 1)), 0),
    lowWorkers: Math.max(Number(process.env.LOW_WORKERS ?? (free ? 0 : 1)), 0),
    concurrency: Math.max(Number(process.env.WORKER_CONCURRENCY ?? (free ? 5 : 20)), 1),
  };
}

export async function startWorkerRuntime(): Promise<void> {
  const redis = createRedisClient();
  const { defaultWorkers, highWorkers, lowWorkers, concurrency } = freeTierDefaults();

  const workers: Worker[] = [];
  for (let i = 0; i < defaultWorkers; i++) workers.push(new Worker('default', concurrency));
  for (let i = 0; i < highWorkers; i++) workers.push(new Worker('high-priority', concurrency));
  for (let i = 0; i < lowWorkers; i++) workers.push(new Worker('low-priority', concurrency));
  for (const w of workers) await w.start();

  const scheduler = new Scheduler();
  const lock = new SchedulerLock(redis);

  (async () => {
    let won = await lock.tryAcquire().catch(() => false);

    while (true) {
      if (won) {
        console.log(`[Bootstrap] Scheduler election won (id=${lock.instanceId.slice(0, 8)}) — starting scheduler`);
        await scheduler.start();

        await new Promise<void>((resolve) => {
          lock.startRenewing(() => {
            console.warn('[Bootstrap] Scheduler lock lost — stopping scheduler');
            scheduler.stop();
            resolve();
          });
        });
        won = false;
      } else {
        console.log(`[Bootstrap] Scheduler election lost — standing by as replica (id=${lock.instanceId.slice(0, 8)})`);

        await new Promise<void>((resolve) => {
          lock.startRetrying(() => resolve());
        });
        won = true;
      }
    }
  })();

  // Off by default on free tier to avoid load spikes.
  const generator =
    process.env.JOB_GENERATOR_ENABLED === 'true' ? new JobGenerator() : null;
  if (generator) await generator.start();

  const shutdown = async (signal: string) => {
    console.log(`[Bootstrap] Received ${signal} — shutting down gracefully`);
    generator?.stop();
    scheduler.stop();
    await lock.release();
    for (const w of workers) await w.stop();
    await redis.quit().catch(() => {});
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
