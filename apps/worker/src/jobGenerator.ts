import { randomUUID } from 'crypto';

const API_URL = process.env.API_URL || 'http://localhost:3001';
const INTERVAL_MS = Math.max(Number(process.env.GENERATOR_INTERVAL_MS || 300), 100);

// Realistic job types that would exist in a real background-processing system.
const JOB_TYPES = [
  { name: 'image.resize',        queue: 'default' as const, priority:  0 },
  { name: 'email.send',          queue: 'high'    as const, priority:  2 },
  { name: 'report.generate',     queue: 'low'     as const, priority: -1 },
  { name: 'data.sync',           queue: 'default' as const, priority:  1 },
  { name: 'notification.push',   queue: 'high'    as const, priority:  2 },
  { name: 'thumbnail.generate',  queue: 'default' as const, priority:  0 },
  { name: 'invoice.export',      queue: 'low'     as const, priority: -1 },
];

export class JobGenerator {
  private isRunning = false;
  private counter = 0;
  private enqueued = 0;
  private rejected = 0;

  async start() {
    this.isRunning = true;
    console.log(`[JobGenerator] Started — interval: ${INTERVAL_MS}ms, target: ${API_URL}`);
    this.loop();
  }

  stop() {
    this.isRunning = false;
    console.log(`[JobGenerator] Stopped. enqueued=${this.enqueued} rejected=${this.rejected}`);
  }

  private async loop() {
    while (this.isRunning) {
      await new Promise(r => setTimeout(r, INTERVAL_MS));
      try {
        await this.enqueueOne();
      } catch {
        // Generator must never crash the worker process — errors are silent here.
      }
    }
  }

  private async enqueueOne() {
    this.counter++;

    // Every 5th job is a deterministic failure so we always have DLQ/retry activity.
    const shouldFail = this.counter % 5 === 0;

    // Every 7th job is delayed by 5–15 seconds to exercise the delayed queue path.
    const isDelayed = this.counter % 7 === 0;
    const scheduledFor = isDelayed
      ? new Date(Date.now() + 5000 + Math.random() * 10000)
      : undefined;

    const type = JOB_TYPES[this.counter % JOB_TYPES.length];

    const body = {
      idempotencyKey: randomUUID(),
      name: type.name,
      queue: type.queue,
      priority: type.priority,
      maxAttempts: 3,
      payload: {
        source: 'generator',
        counter: this.counter,
        shouldFail,
        generatedAt: Date.now(),
        batch: Math.floor(this.counter / 20),
      },
      ...(scheduledFor ? { scheduledFor: scheduledFor.toISOString() } : {}),
    };

    const res = await fetch(`${API_URL}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      this.enqueued++;
    } else if (res.status === 429) {
      // Backpressure — system is under load, slow down.
      this.rejected++;
      await new Promise(r => setTimeout(r, 1000));
    } else {
      console.error(`[JobGenerator] Unexpected ${res.status} on job #${this.counter}`);
    }
  }
}
