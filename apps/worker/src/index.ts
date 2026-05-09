import { Worker } from './services/Worker';
import { Scheduler } from './services/Scheduler';
import { JobGenerator } from './jobGenerator';

async function bootstrap() {
  const schedulerEnabled = process.env.SCHEDULER_ENABLED !== 'false';
  const defaultWorkers = Math.max(Number(process.env.DEFAULT_WORKERS || 2), 0);
  const highWorkers = Math.max(Number(process.env.HIGH_WORKERS || 1), 0);
  const lowWorkers = Math.max(Number(process.env.LOW_WORKERS || 1), 0);
  const concurrency = Math.max(Number(process.env.WORKER_CONCURRENCY || 20), 1);

  const scheduler = new Scheduler();
  if (schedulerEnabled) {
    await scheduler.start();
  }

  const workers: Worker[] = [];
  for (let i = 0; i < defaultWorkers; i++) workers.push(new Worker('default', concurrency));
  for (let i = 0; i < highWorkers; i++) workers.push(new Worker('high-priority', concurrency));
  for (let i = 0; i < lowWorkers; i++) workers.push(new Worker('low-priority', concurrency));

  for (const worker of workers) {
    await worker.start();
  }

  const generator = process.env.JOB_GENERATOR_ENABLED === 'true'
    ? new JobGenerator()
    : null;
  if (generator) await generator.start();

  process.on('SIGINT', async () => {
    console.log('Shutting down gracefully...');
    generator?.stop();
    if (schedulerEnabled) scheduler.stop();
    for (const worker of workers) {
      await worker.stop();
    }
    process.exit(0);
  });
}

bootstrap().catch(console.error);
