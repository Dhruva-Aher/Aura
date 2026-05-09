import { QueueService } from '../../api/src/services/QueueService';
import { randomUUID } from 'crypto';

const queueService = new QueueService();

const BATCH_SIZE = 100;

async function runLoadTest(totalJobs: number = 5000, concurrency: number = 5) {
  console.log(`🚀 Starting load test: Enqueuing ${totalJobs} jobs with concurrency ${concurrency}...`);
  const startTime = Date.now();

  let enqueued = 0;

  async function worker() {
    while (enqueued < totalJobs) {
      const remaining = totalJobs - enqueued;
      if (remaining <= 0) break;

      const batchSize = Math.min(BATCH_SIZE, remaining);
      enqueued += batchSize; // optimistic increment

      const promises = [];
      for (let i = 0; i < batchSize; i++) {
        promises.push(
          queueService.enqueue({
            idempotencyKey: `load-test-${randomUUID()}`,
            name: `Load Test Job ${Math.random().toString(36).substring(7)}`,
            payload: { data: 'test payload', ts: Date.now() },
            priority: Math.floor(Math.random() * 5),
            maxAttempts: 3
          }).catch(err => console.error('Failed to enqueue job:', err.message))
        );
      }
      await Promise.all(promises);
      process.stdout.write(`\rEnqueued: ${Math.min(enqueued, totalJobs)} / ${totalJobs}`);
    }
  }

  const workers = Array.from({ length: concurrency }).map(() => worker());
  await Promise.all(workers);

  const duration = (Date.now() - startTime) / 1000;
  console.log(`\n✅ Load test complete! Enqueued ${totalJobs} jobs in ${duration.toFixed(2)}s`);
  console.log(`⚡ Injection rate: ${(totalJobs / duration).toFixed(2)} jobs/sec`);
  
  process.exit(0);
}

const args = process.argv.slice(2);
const totalJobs = parseInt(args[0], 10) || 5000;
const concurrency = parseInt(args[1], 10) || 10;

runLoadTest(totalJobs, concurrency);
