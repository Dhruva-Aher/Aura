import { Router } from 'express';
import { z } from 'zod';
import { QueueService, redis } from '../services/QueueService';
import { AdaptiveThreshold } from '../services/AdaptiveThreshold';
import { prisma } from '@aura/database';

const router = Router();
const queueService = new QueueService();
const MAX_PAGE_SIZE = 200;
const MAX_QUEUE_THRESHOLD = Number(process.env.MAX_QUEUE_THRESHOLD || 10000);
const ENQUEUE_RATE_LIMIT_PER_SEC = Number(process.env.ENQUEUE_RATE_LIMIT_PER_SEC || 200);

// Adaptive backpressure — threshold adjusts with observed drain rate.
const adaptiveThreshold = AdaptiveThreshold.fromEnv();

// Counters are stored in Redis so they survive process restarts and are
// visible across multiple API replicas.  The in-process variables are gone.
const BP_ACCEPTED_KEY = 'aura:metrics:bp:accepted';
const BP_REJECTED_KEY = 'aura:metrics:bp:rejected';

export async function getBackpressureCounters() {
  const [accepted, rejected] = await Promise.all([
    redis.get(BP_ACCEPTED_KEY),
    redis.get(BP_REJECTED_KEY),
  ]);
  return {
    accepted: parseInt(accepted ?? '0', 10),
    rejected: parseInt(rejected ?? '0', 10),
  };
}

const CreateJobSchema = z.object({
  idempotencyKey: z.string().min(1),
  name: z.string().min(1),
  payload: z.any(),
  priority: z.number().optional(),
  queue: z.enum(['high', 'default', 'low']).optional(),
  scheduledFor: z.string().datetime().optional().transform(v => v ? new Date(v) : undefined),
  maxAttempts: z.number().min(1).optional()
});

router.post('/', async (req, res) => {
  let admissionAccepted = false;
  try {
    const data = CreateJobSchema.parse(req.body);

    // Compute effective threshold — adapts to observed drain rate.
    // Falls back to MAX_QUEUE_THRESHOLD when there is no throughput data yet.
    const now = Date.now();
    const threshold = await adaptiveThreshold.getThreshold(
      (windowMs) => redis.zcount('aura:metrics:throughput', now - windowMs, now),
      now,
    );

    // Use the shared admissionGate custom command — single source of truth
    // for the Lua script (packages/redis/src/lua.ts ADMISSION_GATE).
    // rateKey rotates every second so the counter resets per second naturally.
    const rateKey = `aura:ratelimit:enqueue:${Math.floor(now / 1000)}`;
    const [decision, info] = await redis.admissionGate(
      'aura:queue:high',
      'aura:queue:default',
      'aura:queue:low',
      'aura:delayed',
      rateKey,
      'aura:backpressure:reservations',
      threshold,                   // dynamic, not static
      ENQUEUE_RATE_LIMIT_PER_SEC,
      2,   // rate window TTL in seconds
      30   // reservation TTL in seconds
    );

    if (decision === 'REJECT_RATE') {
      redis.incr(BP_REJECTED_KEY).catch(() => {});
      res.setHeader('Retry-After', '1');
      return res.status(429).json({ error: `rate limit exceeded — ${info} req/s (max ${ENQUEUE_RATE_LIMIT_PER_SEC})` });
    }
    if (decision === 'REJECT_QUEUE') {
      redis.incr(BP_REJECTED_KEY).catch(() => {});
      res.setHeader('Retry-After', '5');
      return res.status(429).json({ error: `queue full — ${info}/${threshold} jobs queued (drain rate: ${adaptiveThreshold.lastDrainRatePerSec.toFixed(1)}/s)` });
    }

    admissionAccepted = true;
    const job = await queueService.enqueue(data);
    redis.incr(BP_ACCEPTED_KEY).catch(() => {});
    res.json(job);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  } finally {
    if (admissionAccepted) {
      redis.releaseAdmission('aura:backpressure:reservations').catch(() => {});
    }
  }
});

router.get('/recent', async (req, res) => {
  try {
    const search = req.query.search as string;
    const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 50);
    const whereClause = search ? {
      OR: [
        { id: { contains: search } },
        { name: { contains: search, mode: 'insensitive' as const } }
      ]
    } : {};

    const jobs = await prisma.job.findMany({
      where: whereClause,
      take: limit,
      orderBy: { createdAt: 'desc' }
    });
    res.json(jobs);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/', async (req, res) => {
  try {
    const search = req.query.search as string | undefined;
    const status = req.query.status as string | undefined;
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), MAX_PAGE_SIZE);
    const cursorCreatedAt = req.query.cursorCreatedAt as string | undefined;
    const cursorId = req.query.cursorId as string | undefined;

    const where = {
      ...(status ? { status: status as any } : {}),
      ...(search ? {
        OR: [
          { name: { contains: search, mode: 'insensitive' as const } },
          { id: { contains: search } }
        ]
      } : {})
    };

    const jobs = await prisma.job.findMany({
      where: {
        ...where,
        ...(cursorCreatedAt && cursorId ? {
          OR: [
            { createdAt: { lt: new Date(cursorCreatedAt) } },
            { AND: [{ createdAt: new Date(cursorCreatedAt) }, { id: { lt: cursorId } }] }
          ]
        } : {})
      },
      take: limit + 1,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
    });

    const hasMore = jobs.length > limit;
    const items = hasMore ? jobs.slice(0, limit) : jobs;
    const last = items[items.length - 1];
    const total = await prisma.job.count({ where });

    res.json({
      items,
      total,
      nextCursor: hasMore && last ? { cursorCreatedAt: last.createdAt.toISOString(), cursorId: last.id } : null
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/dlq', async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), MAX_PAGE_SIZE);
    const cursorCreatedAt = req.query.cursorCreatedAt as string | undefined;
    const cursorId = req.query.cursorId as string | undefined;

    const jobs = await prisma.job.findMany({
      where: {
        status: 'DEAD_LETTER',
        ...(cursorCreatedAt && cursorId ? {
          OR: [
            { createdAt: { lt: new Date(cursorCreatedAt) } },
            { AND: [{ createdAt: new Date(cursorCreatedAt) }, { id: { lt: cursorId } }] }
          ]
        } : {})
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const hasMore = jobs.length > limit;
    const items = hasMore ? jobs.slice(0, limit) : jobs;
    const last = items[items.length - 1];
    const total = await prisma.job.count({ where: { status: 'DEAD_LETTER' } });
    res.json({
      items,
      total,
      nextCursor: hasMore && last ? { cursorCreatedAt: last.createdAt.toISOString(), cursorId: last.id } : null
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/replay', async (req, res) => {
  try {
    const job = await queueService.replayDlq(req.params.id);
    res.json(job);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/discard', async (req, res) => {
  try {
    const job = await queueService.discardDlq(req.params.id);
    res.json(job);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/retry', async (req, res) => {
  try {
    const job = await queueService.retryJob(req.params.id);
    res.json(job);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
