import { prisma } from '@aura/database';
import { createRedisClient } from '@aura/redis';
import { setTimeout as sleep } from 'timers/promises';

const API = 'http://localhost:3001';
const API_BP = 'http://localhost:3101';
const redis = createRedisClient();

async function traceSingleJob() {
  const key = `diag-single-${Date.now()}`;
  const res = await fetch(`${API}/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      idempotencyKey: key,
      name: `diag.single.${key}`,
      payload: { key },
      queue: 'high',
      priority: 2,
      maxAttempts: 3,
    }),
  });
  const body = await res.json();
  if (!res.ok) return { accepted: false, status: res.status, body };
  const jobId = body.id;

  const timeline = [];
  for (let i = 0; i < 60; i++) {
    const job = await prisma.job.findUnique({ where: { id: jobId } });
    const [qHigh, qDefault, qLow, leased, delayed] = await Promise.all([
      redis.zscore('aura:queue:high', jobId),
      redis.zscore('aura:queue:default', jobId),
      redis.zscore('aura:queue:low', jobId),
      redis.zscore('aura:leased', jobId),
      redis.zscore('aura:delayed', jobId),
    ]);
    timeline.push({
      t: i * 200,
      status: job?.status,
      startedAt: job?.startedAt?.toISOString() ?? null,
      completedAt: job?.completedAt?.toISOString() ?? null,
      inRedis: { qHigh: qHigh !== null, qDefault: qDefault !== null, qLow: qLow !== null, leased: leased !== null, delayed: delayed !== null },
    });
    if (job && ['COMPLETED', 'FAILED', 'DEAD_LETTER'].includes(job.status)) break;
    await sleep(200);
  }

  const events = await prisma.jobEvent.findMany({
    where: { jobId },
    orderBy: { timestamp: 'asc' },
    select: { type: true, message: true, timestamp: true },
  });

  return { accepted: true, jobId, timeline, events };
}

async function boundaryRun() {
  const runId = `diag-batch-${Date.now()}`;
  const total = 500;
  let accepted = 0;
  let rejected = 0;

  await Promise.all(Array.from({ length: total }, async (_, i) => {
    const r = await fetch(`${API}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        idempotencyKey: `${runId}-${i}`,
        name: `diag.batch.${runId}.${i}`,
        payload: { runId, i },
        queue: i % 9 === 0 ? 'high' : i % 11 === 0 ? 'low' : 'default',
        priority: i % 9 === 0 ? 2 : i % 11 === 0 ? -1 : 0,
        maxAttempts: 3,
      }),
    });
    if (r.status === 429) rejected++;
    else if (r.ok) accepted++;
  }));

  const start = Date.now();
  while (Date.now() - start < 120000) {
    const terminal = await prisma.job.count({
      where: {
        name: { startsWith: `diag.batch.${runId}.` },
        status: { in: ['COMPLETED', 'FAILED', 'DEAD_LETTER'] },
      },
    });
    if (terminal >= accepted) break;
    await sleep(500);
  }

  const jobs = await prisma.job.findMany({
    where: { name: { startsWith: `diag.batch.${runId}.` } },
    select: { id: true, status: true, attempts: true },
  });
  const ids = jobs.map((j) => j.id);

  const eventCounts = await prisma.jobEvent.groupBy({
    by: ['type'],
    where: { job: { name: { startsWith: `diag.batch.${runId}.` } } },
    _count: { _all: true },
  });

  let pendingNotInRedis = 0;
  for (const job of jobs.filter((j) => j.status === 'PENDING')) {
    const [h, d, l, leased, delayed] = await Promise.all([
      redis.zscore('aura:queue:high', job.id),
      redis.zscore('aura:queue:default', job.id),
      redis.zscore('aura:queue:low', job.id),
      redis.zscore('aura:leased', job.id),
      redis.zscore('aura:delayed', job.id),
    ]);
    if (h === null && d === null && l === null && leased === null && delayed === null) pendingNotInRedis++;
  }

  const completedEvents = await prisma.jobEvent.findMany({
    where: { type: 'COMPLETED', job: { name: { startsWith: `diag.batch.${runId}.` } } },
    select: { jobId: true },
  });
  const map = new Map();
  for (const e of completedEvents) map.set(e.jobId, (map.get(e.jobId) ?? 0) + 1);
  const duplicates = [...map.values()].filter((n) => n > 1).length;

  const terminal = jobs.filter((j) => ['COMPLETED', 'FAILED', 'DEAD_LETTER'].includes(j.status)).length;
  return {
    runId,
    acceptedByApi: accepted,
    rejectedByApi: rejected,
    writtenPostgres: jobs.length,
    insertedRedisCreatedEvents: eventCounts.find((e) => e.type === 'CREATED')?._count._all ?? 0,
    claimedByWorkers: eventCounts.find((e) => e.type === 'CLAIMED')?._count._all ?? 0,
    completed: jobs.filter((j) => j.status === 'COMPLETED').length,
    failed: jobs.filter((j) => j.status === 'FAILED').length,
    deadLetter: jobs.filter((j) => j.status === 'DEAD_LETTER').length,
    requeued: (eventCounts.find((e) => e.type === 'REAPED')?._count._all ?? 0) + jobs.filter((j) => j.attempts > 1).length,
    terminal,
    pending: jobs.filter((j) => j.status === 'PENDING').length,
    pendingNotInRedis,
    duplicateCompletedJobs: duplicates,
    firstDivergence:
      accepted !== jobs.length ? 'enqueue persistence'
      : (eventCounts.find((e) => e.type === 'CREATED')?._count._all ?? 0) !== jobs.length ? 'redis insertion'
      : terminal !== accepted ? 'worker/terminal sync'
      : 'none',
  };
}

async function backpressureCheck() {
  const burst = 2000;
  let ok = 0;
  let tooMany = 0;
  await Promise.all(Array.from({ length: burst }, async (_, i) => {
    const r = await fetch(`${API_BP}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        idempotencyKey: `diag-bp-${Date.now()}-${i}`,
        name: `diag.bp.${i}`,
        payload: { i },
      }),
    });
    if (r.status === 429) tooMany++;
    if (r.ok) ok++;
  }));
  return { burst, accepted: ok, rejected429: tooMany };
}

async function main() {
  const single = await traceSingleJob();
  const boundaries = await boundaryRun();
  const backpressure = await backpressureCheck();
  console.log(JSON.stringify({ single, boundaries, backpressure }, null, 2));
  await prisma.$disconnect();
  redis.disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  redis.disconnect();
  process.exit(1);
});
