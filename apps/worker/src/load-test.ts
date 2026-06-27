/**
 * Aura Load Test — Phase 6
 *
 * Configurable load scenarios with P50/P95/P99 latency reporting.
 *
 * Scenarios
 * ─────────
 *   burst        — fire all jobs as fast as possible
 *   steady       — constant rate (--rps flag), measure queue depth stability
 *   mixed        — random mix of high/default/low priority
 *   priority-storm — all high-priority to measure queue-jump behaviour
 *   failure-flood  — jobs with shouldFail=true, measures retry/DLQ throughput
 *
 * Usage
 * ─────
 *   tsx src/load-test.ts [scenario] [--jobs N] [--concurrency N] [--rps N] [--watch] [--json]
 *
 * Examples
 *   tsx src/load-test.ts burst --jobs 2000 --concurrency 20
 *   tsx src/load-test.ts steady --jobs 500 --rps 50
 *   tsx src/load-test.ts mixed --jobs 1000 --json
 *
 * Output (human-readable)
 * ───────────────────────
 *   📊 Enqueue latency  P50=2ms  P95=8ms  P99=14ms  max=22ms
 *   📊 E2E latency      P50=1.2s P95=3.8s P99=5.1s  max=7.4s
 *   📈 Throughput       1234 jobs/s  (2000 jobs in 1.62s)
 *   📉 Queue depth      peak=1847  end=0
 *   ✅ Completed=1950  ⚠️ Failed=42  💀 DLQ=8  ⏳ Timeout=0
 */

import { prisma } from '@aura/database';
import { createRedisClient } from '@aura/redis';
import { randomUUID } from 'crypto';


const argv = process.argv.slice(2);
const scenario = (argv.find(a => !a.startsWith('--')) ?? 'burst') as Scenario;
const get = (flag: string, def: number) => {
  const i = argv.indexOf(flag);
  return i !== -1 ? Number(argv[i + 1] ?? def) : def;
};
const has = (flag: string) => argv.includes(flag);

const TOTAL_JOBS   = get('--jobs',        1_000);
const CONCURRENCY  = get('--concurrency',    20);
const RPS          = get('--rps',           100);
const WATCH        = has('--watch');
const JSON_OUTPUT  = has('--json');
// How long (ms) to wait for a job to complete before marking it as timed out
const COMPLETION_POLL_TIMEOUT_MS = get('--timeout', 60_000);
const COMPLETION_POLL_INTERVAL_MS = 500;

type Scenario = 'burst' | 'steady' | 'mixed' | 'priority-storm' | 'failure-flood';


export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(Math.floor(sorted.length * p / 100), sorted.length - 1);
  return sorted[idx] ?? 0;
}

export function summariseLatencies(samples: number[]): LatencySummary {
  if (samples.length === 0) return { p50: 0, p95: 0, p99: 0, max: 0, mean: 0, count: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    p50:   percentile(sorted, 50),
    p95:   percentile(sorted, 95),
    p99:   percentile(sorted, 99),
    max:   sorted[sorted.length - 1] ?? 0,
    mean:  Math.round(sum / sorted.length),
    count: sorted.length,
  };
}

interface LatencySummary {
  p50: number; p95: number; p99: number; max: number; mean: number; count: number;
}


function buildPayload(scenario: Scenario, idx: number): {
  name: string;
  payload: Record<string, unknown>;
  priority: number;
  maxAttempts: number;
} {
  switch (scenario) {
    case 'burst':
      return { name: `load:burst:${idx}`, payload: { idx }, priority: 0, maxAttempts: 3 };

    case 'steady':
      return { name: `load:steady:${idx}`, payload: { idx }, priority: 0, maxAttempts: 3 };

    case 'mixed': {
      const tier = idx % 3 === 0 ? 2 : idx % 3 === 1 ? 0 : -1;
      return { name: `load:mixed:${idx}`, payload: { idx, tier }, priority: tier, maxAttempts: 3 };
    }

    case 'priority-storm':
      return { name: `load:pstorm:${idx}`, payload: { idx }, priority: 2, maxAttempts: 3 };

    case 'failure-flood':
      return {
        name: `load:fail:${idx}`,
        payload: { idx, shouldFail: true },
        priority: 0,
        maxAttempts: 2,
      };
  }
}


async function enqueueOne(
  scenario: Scenario,
  idx: number,
): Promise<{ jobId: string; enqueuedAt: number; latencyMs: number }> {
  const { name, payload, priority, maxAttempts } = buildPayload(scenario, idx);
  const idempotencyKey = `load-${scenario}-${randomUUID()}`;
  const t0 = Date.now();

  const job = await prisma.job.create({
    data: {
      idempotencyKey,
      name,
      payload,
      priority,
      maxAttempts,
      status: 'PENDING',
    },
    select: { id: true },
  });

  const redis = await getRedis();
  const queueName = priority === 2 ? 'high' : priority === -1 ? 'low' : 'default';
  const pipe = redis.pipeline();
  pipe.zadd(`aura:queue:${queueName}`, priority, job.id);
  pipe.hset(`aura:meta:${job.id}`, {
    priority,
    attempts: 0,
    maxAttempts,
    queue: queueName,
  });
  await pipe.exec();

  return { jobId: job.id, enqueuedAt: t0, latencyMs: Date.now() - t0 };
}

// Lazy singleton Redis client — avoids creating a connection for every job
let _redis: Awaited<ReturnType<typeof createRedisClient>> | null = null;
async function getRedis() {
  if (!_redis) _redis = createRedisClient();
  return _redis;
}


async function runBurst(): Promise<Array<{ jobId: string; enqueuedAt: number; latencyMs: number }>> {
  const results: Array<{ jobId: string; enqueuedAt: number; latencyMs: number }> = [];
  let idx = 0;
  let done = 0;

  async function workerLoop() {
    while (true) {
      const myIdx = idx++;
      if (myIdx >= TOTAL_JOBS) return;
      const r = await enqueueOne(scenario, myIdx);
      results.push(r);
      done++;
      if (!JSON_OUTPUT) process.stdout.write(`\r  Enqueued ${done}/${TOTAL_JOBS}`);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, workerLoop));
  return results;
}


async function runSteady(): Promise<Array<{ jobId: string; enqueuedAt: number; latencyMs: number }>> {
  const results: Array<{ jobId: string; enqueuedAt: number; latencyMs: number }> = [];
  const intervalMs = 1000 / RPS;
  let idx = 0;
  let done = 0;

  await new Promise<void>((resolve, reject) => {
    const fire = async () => {
      if (idx >= TOTAL_JOBS) { resolve(); return; }
      const myIdx = idx++;
      enqueueOne(scenario, myIdx).then(r => {
        results.push(r);
        done++;
        if (!JSON_OUTPUT) process.stdout.write(`\r  Enqueued ${done}/${TOTAL_JOBS} @ ${RPS} rps`);
        setTimeout(fire, intervalMs);
      }).catch(reject);
    };
    // Start `CONCURRENCY` parallel streams, each self-regulating at intervalMs
    for (let i = 0; i < Math.min(CONCURRENCY, RPS); i++) {
      setTimeout(fire, i * (intervalMs / CONCURRENCY));
    }
  });

  return results;
}


interface CompletionResult {
  completed: number;
  failed: number;
  dlq: number;
  timedOut: number;
  e2eLatenciesMs: number[];
}

async function waitForCompletion(
  jobs: Array<{ jobId: string; enqueuedAt: number }>,
): Promise<CompletionResult> {
  const pending = new Map(jobs.map(j => [j.jobId, j.enqueuedAt]));
  const result: CompletionResult = {
    completed: 0, failed: 0, dlq: 0, timedOut: 0, e2eLatenciesMs: [],
  };

  const deadline = Date.now() + COMPLETION_POLL_TIMEOUT_MS;

  while (pending.size > 0 && Date.now() < deadline) {
    const ids = [...pending.keys()];
    // Poll in batches of 200
    const POLL_BATCH = 200;
    for (let i = 0; i < ids.length; i += POLL_BATCH) {
      const batch = ids.slice(i, i + POLL_BATCH);
      const rows = await prisma.job.findMany({
        where: { id: { in: batch }, status: { in: ['COMPLETED', 'FAILED', 'DEAD_LETTER'] } },
        select: { id: true, status: true, completedAt: true },
      });
      for (const row of rows) {
        const enqueuedAt = pending.get(row.id)!;
        pending.delete(row.id);
        const e2e = row.completedAt
          ? row.completedAt.getTime() - enqueuedAt
          : Date.now() - enqueuedAt;
        result.e2eLatenciesMs.push(e2e);
        if (row.status === 'COMPLETED')    result.completed++;
        else if (row.status === 'DEAD_LETTER') result.dlq++;
        else                                result.failed++;
      }
    }

    if (pending.size > 0) {
      if (!JSON_OUTPUT) {
        const pct = Math.round(((jobs.length - pending.size) / jobs.length) * 100);
        process.stdout.write(`\r  Awaiting completion… ${pct}% (${pending.size} remaining)   `);
      }
      await new Promise(r => setTimeout(r, COMPLETION_POLL_INTERVAL_MS));
    }
  }

  result.timedOut = pending.size;
  return result;
}


async function queueDepth(): Promise<number> {
  const redis = await getRedis();
  const [h, d, l] = await Promise.all([
    redis.zcard('aura:queue:high'),
    redis.zcard('aura:queue:default'),
    redis.zcard('aura:queue:low'),
  ]);
  return h + d + l;
}


function fmt(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`;
}

function printReport(
  scenario: Scenario,
  durationMs: number,
  enqueueLatencies: number[],
  completion: CompletionResult,
  peakDepth: number,
  endDepth: number,
) {
  const eq  = summariseLatencies(enqueueLatencies);
  const e2e = summariseLatencies(completion.e2eLatenciesMs);
  const throughput = (enqueueLatencies.length / (durationMs / 1000)).toFixed(1);

  if (JSON_OUTPUT) {
    console.log(JSON.stringify({
      scenario,
      jobs: TOTAL_JOBS,
      concurrency: CONCURRENCY,
      durationMs,
      throughputPerSec: Number(throughput),
      enqueueLatency: eq,
      e2eLatency: e2e,
      outcomes: {
        completed: completion.completed,
        failed: completion.failed,
        dlq: completion.dlq,
        timedOut: completion.timedOut,
      },
      queue: { peak: peakDepth, end: endDepth },
    }, null, 2));
    return;
  }

  console.log('\n');
  console.log(`╔══════════════════════════════════════════════════════════╗`);
  console.log(`║  Aura Load Test Report — scenario: ${scenario.padEnd(20)} ║`);
  console.log(`╠══════════════════════════════════════════════════════════╣`);
  console.log(`║  Jobs: ${String(TOTAL_JOBS).padEnd(8)}  Concurrency: ${String(CONCURRENCY).padEnd(24)}║`);
  console.log(`╠══════════════════════════════════════════════════════════╣`);
  console.log(`║  📈 Throughput    ${throughput.padEnd(8)} jobs/s  (${fmt(durationMs)} total)`.padEnd(63) + '║');
  console.log(`╠══════════════════════════════════════════════════════════╣`);
  console.log(`║  📊 Enqueue P50=${fmt(eq.p50).padEnd(7)} P95=${fmt(eq.p95).padEnd(7)} P99=${fmt(eq.p99).padEnd(7)} max=${fmt(eq.max).padEnd(5)} ║`);
  if (completion.e2eLatenciesMs.length > 0) {
  console.log(`║  🕐 E2E     P50=${fmt(e2e.p50).padEnd(7)} P95=${fmt(e2e.p95).padEnd(7)} P99=${fmt(e2e.p99).padEnd(7)} max=${fmt(e2e.max).padEnd(5)} ║`);
  }
  console.log(`╠══════════════════════════════════════════════════════════╣`);
  console.log(`║  📉 Queue depth  peak=${String(peakDepth).padEnd(8)} end=${String(endDepth).padEnd(19)}║`);
  console.log(`╠══════════════════════════════════════════════════════════╣`);
  console.log(`║  ✅ Completed=${String(completion.completed).padEnd(7)} ⚠️  Failed=${String(completion.failed).padEnd(5)} 💀 DLQ=${String(completion.dlq).padEnd(4)} ⏳ Timeout=${String(completion.timedOut).padEnd(3)} ║`);
  console.log(`╚══════════════════════════════════════════════════════════╝`);
}


async function main() {
  console.log(`\n🚀 Aura Load Test  scenario=${scenario}  jobs=${TOTAL_JOBS}  concurrency=${CONCURRENCY}`);
  if (scenario === 'steady') console.log(`   Target rate: ${RPS} rps`);
  console.log('');

  const t0 = Date.now();
  let peakDepth = 0;

  // Optional live queue-depth watcher
  let depthInterval: NodeJS.Timeout | undefined;
  if (WATCH) {
    depthInterval = setInterval(async () => {
      const d = await queueDepth().catch(() => 0);
      peakDepth = Math.max(peakDepth, d);
      process.stdout.write(`\r  Queue depth: ${d}       `);
    }, 1000);
  }

  let enqueueResults: Array<{ jobId: string; enqueuedAt: number; latencyMs: number }>;

  if (scenario === 'steady') {
    enqueueResults = await runSteady();
  } else {
    // burst, mixed, priority-storm, failure-flood — all use burst concurrency
    enqueueResults = await runBurst();
  }

  const enqueueDurationMs = Date.now() - t0;
  if (depthInterval) clearInterval(depthInterval);

  // Final queue depth
  const endDepth = await queueDepth().catch(() => 0);
  if (!WATCH) peakDepth = endDepth; // best approximation without polling

  console.log(`\n  Enqueue phase done in ${fmt(enqueueDurationMs)}`);

  // Wait for all jobs to finish (skipped for failure-flood since they intentionally fail)
  let completion: CompletionResult = {
    completed: 0, failed: 0, dlq: 0, timedOut: 0, e2eLatenciesMs: [],
  };

  if (!has('--no-wait')) {
    console.log(`  Waiting for completion (timeout ${fmt(COMPLETION_POLL_TIMEOUT_MS)})…`);
    completion = await waitForCompletion(enqueueResults);
    console.log('');
  }

  const totalDurationMs = Date.now() - t0;
  const finalDepth = await queueDepth().catch(() => 0);
  peakDepth = Math.max(peakDepth, endDepth);

  printReport(
    scenario,
    enqueueDurationMs,
    enqueueResults.map(r => r.latencyMs),
    completion,
    peakDepth,
    finalDepth,
  );

  await (_redis as any)?.quit?.().catch(() => {});
  await prisma.$disconnect();
  process.exit(0);
}

// Only run when executed directly (tsx src/load-test.ts …), not when imported by tests.
if (process.argv[1]?.endsWith('load-test.ts') || process.argv[1]?.endsWith('load-test.js')) {
  main().catch(err => {
    console.error('Load test crashed:', err);
    process.exit(1);
  });
}
