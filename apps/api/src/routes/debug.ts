import { Router } from 'express';
import { prisma } from '@aura/database';
import { redis } from '../services/QueueService';
import { getBackpressureCounters } from './jobs';

const router = Router();
const API_PROCESS_STARTED_AT = new Date();

router.get('/verify', async (_req, res) => {
  try {
    const pendingJobs = await prisma.job.findMany({
      where: { status: 'PENDING' },
      select: { id: true },
    });

    let pendingNotInRedis = 0;
    for (const job of pendingJobs) {
      const [high, def, low, leased, delayed] = await Promise.all([
        redis.zscore('aura:queue:high', job.id),
        redis.zscore('aura:queue:default', job.id),
        redis.zscore('aura:queue:low', job.id),
        redis.zscore('aura:leased', job.id),
        redis.zscore('aura:delayed', job.id),
      ]);
      if (high === null && def === null && low === null && leased === null && delayed === null) {
        pendingNotInRedis++;
      }
    }

    const duplicateRows = await prisma.$queryRaw<Array<{ count: bigint | number }>>`
      SELECT COUNT(*)::bigint AS count
      FROM (
        SELECT "jobId"
        FROM "JobEvent"
        WHERE type = 'COMPLETED'
          AND "timestamp" >= ${API_PROCESS_STARTED_AT}
        GROUP BY "jobId"
        HAVING COUNT(*) > 1
      ) t
    `;
    const duplicateCompletions = Number(duplicateRows[0]?.count ?? 0);

    res.json({
      pendingNotInRedis,
      duplicateCompletions,
      backpressure: getBackpressureCounters(),
    });
  } catch (err: unknown) {
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

/**
 * Factory-reset queues for free-tier / demo cleanup.
 * Requires header: X-Reset-Token: <RESET_TOKEN>
 */
router.post('/factory-reset', async (req, res) => {
  const expected = process.env.RESET_TOKEN;
  if (!expected || req.header('x-reset-token') !== expected) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  try {
    await prisma.jobEvent.deleteMany();
    await prisma.job.deleteMany();
    await prisma.worker.deleteMany();

    const keys = await redis.keys('aura:*');
    if (keys.length) {
      // Pipeline deletes in chunks to avoid huge MULTI payloads.
      for (let i = 0; i < keys.length; i += 500) {
        await redis.del(...keys.slice(i, i + 500));
      }
    }

    res.json({
      ok: true,
      deletedRedisKeys: keys.length,
    });
  } catch (err: unknown) {
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

export default router;
