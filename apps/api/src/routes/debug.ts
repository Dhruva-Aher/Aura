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
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
