import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';

const prisma = new PrismaClient();

const JOB_NAMES = [
  'video.process.encode',
  'email.send.welcome',
  'thumbnail.generate',
  'report.daily.summary',
  'image.resize.batch',
  'pdf.export.invoice',
  'analytics.aggregate',
  'notification.push.batch',
  'cache.warm.products',
  'webhook.dispatch',
];

const TOTAL_JOBS = Math.max(Number(process.env.SEED_JOB_COUNT || 50000), 1000);
const WORKER_COUNT = Math.max(Number(process.env.SEED_WORKER_COUNT || 24), 3);
const RESET = process.env.SEED_RESET !== 'false';
const BATCH_SIZE = 1000;

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomDateWithinLastHours(hours: number) {
  return new Date(Date.now() - Math.floor(Math.random() * hours * 3600_000));
}

async function main() {
  console.log(`🌱 Seeding database with ${TOTAL_JOBS.toLocaleString()} jobs...`);

  if (RESET) {
    await prisma.jobEvent.deleteMany();
    await prisma.job.deleteMany();
    await prisma.worker.deleteMany();
  }

  const workerRows = Array.from({ length: WORKER_COUNT }, (_, i) => {
    const online = i < Math.floor(WORKER_COUNT * 0.8);
    return {
      id: `worker-${String(i + 1).padStart(4, '0')}`,
      pool: i % 5 === 0 ? 'high-priority' : 'default',
      status: online ? 'ONLINE' : 'OFFLINE',
      cpu: online ? Number((5 + Math.random() * 45).toFixed(1)) : 0,
      memory: online ? `${Math.floor(120 + Math.random() * 900)}MB` : '0MB',
      startedAt: randomDateWithinLastHours(24),
      lastHeartbeat: online ? new Date(Date.now() - Math.floor(Math.random() * 12000)) : randomDateWithinLastHours(6),
      currentJobId: null as string | null,
    };
  });
  await prisma.worker.createMany({ data: workerRows, skipDuplicates: true });

  let created = 0;
  while (created < TOTAL_JOBS) {
    const chunkSize = Math.min(BATCH_SIZE, TOTAL_JOBS - created);
    const chunk = Array.from({ length: chunkSize }, (_, i) => {
      const idx = created + i;
      const roll = Math.random();
      const status =
        roll < 0.58 ? 'COMPLETED' :
        roll < 0.72 ? 'PENDING' :
        roll < 0.84 ? 'PROCESSING' :
        roll < 0.92 ? 'DELAYED' :
        roll < 0.97 ? 'FAILED' : 'DEAD_LETTER';

      const createdAt = randomDateWithinLastHours(72);
      const startedAt = status === 'PENDING' || status === 'DELAYED' ? null : new Date(createdAt.getTime() + Math.floor(Math.random() * 90_000));
      const completedAt = status === 'COMPLETED' ? new Date((startedAt ?? createdAt).getTime() + Math.floor(Math.random() * 120_000 + 500)) : null;
      const updatedAt = completedAt ?? startedAt ?? createdAt;
      const attempts = status === 'DEAD_LETTER' ? 3 : status === 'FAILED' ? 2 : 1;

      return {
        idempotencyKey: randomUUID(),
        name: pick(JOB_NAMES),
        payload: {
          tenantId: `tenant-${(idx % 1500) + 1}`,
          requestId: randomUUID(),
          index: idx,
        },
        status,
        priority: Math.floor(Math.random() * 3),
        attempts,
        maxAttempts: 3,
        scheduledFor: status === 'DELAYED' ? new Date(Date.now() + Math.floor(Math.random() * 2 * 3600_000)) : createdAt,
        startedAt,
        completedAt,
        workerId: status === 'PROCESSING' ? `worker-${String((idx % WORKER_COUNT) + 1).padStart(4, '0')}` : null,
        errorLog: status === 'FAILED' || status === 'DEAD_LETTER' ? { message: 'Execution failed', code: 'TASK_ERROR' } : null,
        createdAt,
        updatedAt,
      };
    });

    await prisma.job.createMany({ data: chunk, skipDuplicates: true });
    created += chunkSize;
    if (created % 5000 === 0 || created === TOTAL_JOBS) {
      console.log(`  inserted ${created.toLocaleString()} / ${TOTAL_JOBS.toLocaleString()} jobs`);
    }
  }

  const processingJobs = await prisma.job.findMany({
    where: { status: 'PROCESSING' },
    orderBy: { updatedAt: 'desc' },
    take: Math.floor(WORKER_COUNT * 0.8),
    select: { id: true, workerId: true },
  });
  for (const job of processingJobs) {
    if (!job.workerId) continue;
    await prisma.worker.update({
      where: { id: job.workerId },
      data: { currentJobId: job.id, status: 'ONLINE' },
    });
  }

  console.log('✅ Large-scale seed complete!');
  console.log('Tip: SEED_JOB_COUNT=200000 npm exec --workspace @aura/database prisma db seed');
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
