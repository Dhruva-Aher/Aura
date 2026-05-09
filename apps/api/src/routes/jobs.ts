import { Router } from 'express';
import { z } from 'zod';
import { QueueService, redis } from '../services/QueueService';
import { prisma } from '@aura/database';

const router = Router();
const queueService = new QueueService();
const MAX_PAGE_SIZE = 200;
const MAX_QUEUE_THRESHOLD = Number(process.env.MAX_QUEUE_THRESHOLD || 10000);
const ENQUEUE_RATE_LIMIT_PER_SEC = Number(process.env.ENQUEUE_RATE_LIMIT_PER_SEC || 200);
let backpressureAccepted = 0;
let backpressureRejected = 0;

export const getBackpressureCounters = () => ({
  accepted: backpressureAccepted,
  rejected: backpressureRejected,
});
const ADMISSION_GATE_LUA = `
  local threshold = tonumber(ARGV[1])
  local rateLimit = tonumber(ARGV[2])
  local rateTtl = tonumber(ARGV[3])
  local reserveTtl = tonumber(ARGV[4])

  local reservations = tonumber(redis.call('get', KEYS[6]) or '0')
  local queued = redis.call('zcard', KEYS[1]) + redis.call('zcard', KEYS[2]) + redis.call('zcard', KEYS[3]) + redis.call('zcard', KEYS[4])
  local projected = queued + reservations

  if projected >= threshold then
    return {'REJECT_QUEUE', tostring(projected)}
  end

  local rate = redis.call('incr', KEYS[5])
  if rate == 1 then
    redis.call('expire', KEYS[5], rateTtl)
  end
  if rate > rateLimit then
    return {'REJECT_RATE', tostring(rate)}
  end

  local token = redis.call('incr', KEYS[6])
  if token == 1 then
    redis.call('expire', KEYS[6], reserveTtl)
  end
  return {'ACCEPT', tostring(token), tostring(projected)}
`;
const RELEASE_ADMISSION_LUA = `
  local current = tonumber(redis.call('get', KEYS[1]) or '0')
  if current <= 0 then return 0 end
  return redis.call('decr', KEYS[1])
`;

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
    const rateKey = `aura:ratelimit:enqueue:${Math.floor(Date.now() / 1000)}`;
    const reservationKey = 'aura:backpressure:reservations';
    const result = await redis.eval(
      ADMISSION_GATE_LUA,
      6,
      'aura:queue:high',
      'aura:queue:default',
      'aura:queue:low',
      'aura:delayed',
      rateKey,
      reservationKey,
      MAX_QUEUE_THRESHOLD,
      ENQUEUE_RATE_LIMIT_PER_SEC,
      2,
      30
    ) as unknown as [string, string];
    const decision = result?.[0];
    const info = result?.[1];
    if (decision === 'REJECT_RATE') {
      backpressureRejected++;
      res.setHeader('Retry-After', '1');
      return res.status(429).json({ error: `enqueue rate limit exceeded (${info})` });
    }
    if (decision === 'REJECT_QUEUE') {
      backpressureRejected++;
      res.setHeader('Retry-After', '5');
      return res.status(429).json({ error: `queue capacity exceeded (${info}/${MAX_QUEUE_THRESHOLD})` });
    }
    admissionAccepted = true;

    const job = await queueService.enqueue(data);
    backpressureAccepted++;
    res.json(job);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  } finally {
    if (admissionAccepted) {
      redis.eval(RELEASE_ADMISSION_LUA, 1, 'aura:backpressure:reservations').catch(() => {});
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
