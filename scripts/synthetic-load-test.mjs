import { spawn } from 'child_process';
import { setTimeout as sleep } from 'timers/promises';
import { prisma } from '@aura/database';
import { createRedisClient } from '@aura/redis';

const API_PORT = 3101;
const BASE_URL = `http://localhost:${API_PORT}`;
const redis = createRedisClient();

function startProcess(command, args, env) {
  return spawn(command, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: 'ignore',
  });
}

async function waitForApi(timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${BASE_URL}/system/health`);
      if (r.ok) return;
    } catch {}
    await sleep(500);
  }
  throw new Error('API did not become healthy in time');
}

async function resetState() {
  await prisma.jobEvent.deleteMany();
  await prisma.job.deleteMany();
  await prisma.worker.deleteMany();
  await redis.flushdb();
}

function pickQueue(i) {
  if (i % 10 === 0) return 'high';
  if (i % 7 === 0) return 'low';
  return 'default';
}

async function enqueueJobs(runId, total, injectionConcurrency) {
  let submitted = 0;
  let rejected = 0;
  let index = 0;
  const workers = Array.from({ length: injectionConcurrency }).map(async () => {
    while (true) {
      const i = index++;
      if (i >= total) return;
      const payload = {
        idempotencyKey: `${runId}-${i}`,
        name: `bench.${runId}.${i}`,
        payload: { runId, i },
        queue: pickQueue(i),
        priority: i % 10 === 0 ? 2 : i % 7 === 0 ? -1 : 0,
        maxAttempts: 3,
      };
      const res = await fetch(`${BASE_URL}/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.status === 429) {
        rejected++;
        continue;
      }
      if (res.ok) submitted++;
    }
  });
  await Promise.all(workers);
  return { submitted, rejected };
}

async function collectBacklogPeak(stopSignal) {
  let peak = 0;
  while (!stopSignal.stop) {
    const [high, def, low, delayed, leased] = await Promise.all([
      redis.zcard('aura:queue:high'),
      redis.zcard('aura:queue:default'),
      redis.zcard('aura:queue:low'),
      redis.zcard('aura:delayed'),
      redis.zcard('aura:leased'),
    ]);
    const backlog = high + def + low + delayed + leased;
    if (backlog > peak) peak = backlog;
    await sleep(250);
  }
  return peak;
}

async function waitForDrain(runId, expected, timeoutMs) {
  const start = Date.now();
  let idleSince = 0;
  while (Date.now() - start < timeoutMs) {
    const jobs = await prisma.job.aggregate({
      _count: { _all: true },
      where: { name: { startsWith: `bench.${runId}.` } },
    });
    const terminal = await prisma.job.count({
      where: {
        name: { startsWith: `bench.${runId}.` },
        status: { in: ['COMPLETED', 'FAILED', 'DEAD_LETTER'] },
      },
    });
    const [high, def, low, delayed, leased] = await Promise.all([
      redis.zcard('aura:queue:high'),
      redis.zcard('aura:queue:default'),
      redis.zcard('aura:queue:low'),
      redis.zcard('aura:delayed'),
      redis.zcard('aura:leased'),
    ]);
    const inFlight = high + def + low + delayed + leased;
    if (jobs._count._all >= expected && terminal >= expected) return true;
    if (terminal < expected && inFlight === 0) {
      if (!idleSince) idleSince = Date.now();
      if (Date.now() - idleSince > 10000) return false;
    } else {
      idleSince = 0;
    }
    await sleep(500);
  }
  return false;
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.floor((sorted.length - 1) * p);
  return sorted[idx] ?? 0;
}

async function runScenario(jobs, workerProcesses, workerConcurrency) {
  const runId = `${jobs}j_${workerProcesses}w_${workerConcurrency}c_${Date.now()}`;
  await resetState();

  const api = startProcess('node', ['apps/api/dist/index.js'], {
    PORT: String(API_PORT),
    ENQUEUE_RATE_LIMIT_PER_SEC: '50000',
    MAX_QUEUE_THRESHOLD: '1000000',
    LATENCY_WINDOW_MINUTES: '10',
  });
  const workers = [];
  for (let i = 0; i < workerProcesses; i++) {
    workers.push(startProcess('node', ['apps/worker/dist/index.js'], {
      SCHEDULER_ENABLED: i === 0 ? 'true' : 'false',
      DEFAULT_WORKERS: '1',
      HIGH_WORKERS: '0',
      LOW_WORKERS: '0',
      WORKER_CONCURRENCY: String(workerConcurrency),
    }));
  }

  await waitForApi();
  await sleep(1000);

  const backlogStop = { stop: false };
  const backlogPeakPromise = collectBacklogPeak(backlogStop);

  const start = Date.now();
  const { submitted, rejected } = await enqueueJobs(runId, jobs, Math.min(200, Math.max(20, workerProcesses * workerConcurrency)));
  const expected = submitted;
  const drained = await waitForDrain(runId, expected, 10 * 60_000);
  const durationSec = (Date.now() - start) / 1000;

  backlogStop.stop = true;
  const peakBacklog = await backlogPeakPromise;

  const runJobs = await prisma.job.findMany({
    where: { name: { startsWith: `bench.${runId}.` } },
    select: { id: true, status: true, startedAt: true, scheduledFor: true, completedAt: true, attempts: true },
  });

  const completed = runJobs.filter((j) => j.status === 'COMPLETED').length;
  const failed = runJobs.filter((j) => j.status === 'FAILED').length;
  const deadLetter = runJobs.filter((j) => j.status === 'DEAD_LETTER').length;
  const retried = runJobs.filter((j) => j.attempts > 1).length;

  const latencySec = runJobs
    .filter((j) => j.startedAt)
    .map((j) => Math.max(0, (j.startedAt.getTime() - j.scheduledFor.getTime()) / 1000));
  const procSec = runJobs
    .filter((j) => j.startedAt && j.completedAt)
    .map((j) => Math.max(0, (j.completedAt.getTime() - j.startedAt.getTime()) / 1000));

  const completionEvents = await prisma.jobEvent.findMany({
    where: { type: 'COMPLETED', job: { name: { startsWith: `bench.${runId}.` } } },
    select: { jobId: true },
  });
  const completionCounts = new Map();
  for (const evt of completionEvents) {
    completionCounts.set(evt.jobId, (completionCounts.get(evt.jobId) ?? 0) + 1);
  }
  const duplicateCompletedJobs = [...completionCounts.values()].filter((c) => c > 1).length;

  const terminalCount = completed + failed + deadLetter;
  const jobLoss = Math.max(0, submitted - terminalCount);

  for (const w of workers) w.kill('SIGINT');
  api.kill('SIGINT');
  await sleep(1000);

  return {
    jobs,
    workerProcesses,
    workerConcurrency,
    submitted,
    rejected,
    completed,
    failed,
    deadLetter,
    retried,
    durationSec: Number(durationSec.toFixed(2)),
    throughput: Number((terminalCount / Math.max(durationSec, 1)).toFixed(2)),
    avgLatencySec: Number((latencySec.reduce((a, b) => a + b, 0) / Math.max(latencySec.length, 1)).toFixed(3)),
    p95LatencySec: Number(percentile(latencySec, 0.95).toFixed(3)),
    avgProcessingSec: Number((procSec.reduce((a, b) => a + b, 0) / Math.max(procSec.length, 1)).toFixed(3)),
    p95ProcessingSec: Number(percentile(procSec, 0.95).toFixed(3)),
    peakBacklog,
    drainRate: Number((terminalCount / Math.max(durationSec, 1)).toFixed(2)),
    retryRate: Number(((retried / Math.max(submitted, 1)) * 100).toFixed(2)),
    failureRate: Number((((failed + deadLetter) / Math.max(submitted, 1)) * 100).toFixed(2)),
    duplicateCompletedJobs,
    jobLoss,
    recovered: drained && jobLoss === 0,
  };
}

async function runBackpressureTest() {
  await resetState();
  const api = startProcess('node', ['apps/api/dist/index.js'], {
    PORT: String(API_PORT),
    ENQUEUE_RATE_LIMIT_PER_SEC: '50',
    MAX_QUEUE_THRESHOLD: '200',
  });
  const worker = startProcess('node', ['apps/worker/dist/index.js'], {
    SCHEDULER_ENABLED: 'true',
    DEFAULT_WORKERS: '1',
    HIGH_WORKERS: '0',
    LOW_WORKERS: '0',
    WORKER_CONCURRENCY: '1',
  });
  await waitForApi();

  let accepted = 0;
  let rejected429 = 0;
  const burst = 1200;
  await Promise.all(Array.from({ length: burst }, async (_, i) => {
    const res = await fetch(`${BASE_URL}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        idempotencyKey: `backpressure-${Date.now()}-${i}`,
        name: `bench.backpressure.${i}`,
        payload: { i },
      }),
    });
    if (res.status === 429) rejected429++;
    else if (res.ok) accepted++;
  }));

  worker.kill('SIGINT');
  api.kill('SIGINT');
  await sleep(1000);
  return { burst, accepted, rejected429 };
}

async function main() {
  const scenarios = [
    { jobs: 1000, workers: 1, conc: 5 },
    { jobs: 1000, workers: 5, conc: 10 },
    { jobs: 1000, workers: 10, conc: 20 },
    { jobs: 5000, workers: 1, conc: 5 },
    { jobs: 5000, workers: 5, conc: 10 },
    { jobs: 5000, workers: 10, conc: 20 },
    { jobs: 10000, workers: 1, conc: 5 },
    { jobs: 10000, workers: 5, conc: 10 },
    { jobs: 10000, workers: 10, conc: 20 },
  ];

  const results = [];
  for (const s of scenarios) {
    console.log(`Running scenario ${s.jobs} jobs, ${s.workers} workers, c=${s.conc}`);
    const result = await runScenario(s.jobs, s.workers, s.conc);
    results.push(result);
    console.log(JSON.stringify(result));
  }

  const backpressure = await runBackpressureTest();
  console.log('BACKPRESSURE', JSON.stringify(backpressure));
  console.log('RESULTS', JSON.stringify(results, null, 2));
  await prisma.$disconnect();
  redis.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  redis.disconnect();
  process.exit(1);
});
