import { prisma, Prisma } from '@aura/database';
import { createRedisClient } from '@aura/redis';
import { EventEmitter } from 'events';

export const redis = createRedisClient();
export const queueEvents = new EventEmitter(); // For SSE

export interface CreateJobDTO {
  idempotencyKey: string;
  name: string;
  payload: any;
  priority?: number;
  queue?: 'high' | 'default' | 'low';
  scheduledFor?: Date;
  maxAttempts?: number;
}

const QUEUE_KEYS = {
  high: 'aura:queue:high',
  default: 'aura:queue:default',
  low: 'aura:queue:low',
} as const;

function queueFromInput(inputQueue: CreateJobDTO['queue'], priority: number): keyof typeof QUEUE_KEYS {
  if (inputQueue) return inputQueue;
  if (priority >= 2) return 'high';
  if (priority <= -1) return 'low';
  return 'default';
}

export class QueueService {
  async enqueue(data: CreateJobDTO) {
    const priority = data.priority || 0;
    const maxAttempts = data.maxAttempts || 3;
    const scheduledFor = data.scheduledFor || new Date();
    const queueName = queueFromInput(data.queue, priority);

    return await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // 1. Idempotency handling
      const job = await tx.job.upsert({
        where: { idempotencyKey: data.idempotencyKey },
        update: {},
        create: { 
          idempotencyKey: data.idempotencyKey,
          name: data.name,
          payload: data.payload,
          priority: priority,
          maxAttempts: maxAttempts,
          scheduledFor: scheduledFor,
          status: scheduledFor > new Date() ? 'DELAYED' : 'PENDING' 
        }
      });

      const isNew = job.createdAt.getTime() === job.updatedAt.getTime();
      
      if (isNew) {
        // Sync to Redis
        await redis.hset(`aura:meta:${job.id}`, {
          priority: job.priority,
          attempts: 0,
          maxAttempts: job.maxAttempts,
          queue: queueName
        });

        const now = Date.now();
        if (job.status === 'DELAYED') {
          await redis.zadd('aura:delayed', job.scheduledFor.getTime(), job.id);
        } else {
          await redis.zadd(QUEUE_KEYS[queueName], job.priority, job.id);
        }
        await redis.zadd('aura:metrics:scheduled', now, job.id);
        
        const bucket = Math.floor(now / 10000) * 10000;
        await redis.hincrby('aura:pulse:scheduled', bucket.toString(), 1);

        // Emit Event for UI
        queueEvents.emit('job_created', job);
        await tx.jobEvent.create({
          data: {
            jobId: job.id,
            type: 'CREATED',
            message: `Job enqueued with priority ${job.priority}`
          }
        });
      }
      return job;
    });
  }

  async replayDlq(jobId: string) {
    return await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const job = await tx.job.update({
        where: { id: jobId, status: 'DEAD_LETTER' },
        data: { status: 'PENDING', attempts: 0 }
      });

      await redis.replayDlq(QUEUE_KEYS.default, 'aura:meta:', jobId);

      await tx.jobEvent.create({
        data: { jobId, type: 'REPLAYED', message: 'Replayed from Dead Letter Queue' }
      });
      queueEvents.emit('job_replayed', job);
      queueEvents.emit('job_requeued', { ...job, queue: 'default' });
      return job;
    });
  }

  async discardDlq(jobId: string) {
    return await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const job = await tx.job.delete({
        where: { id: jobId, status: 'DEAD_LETTER' }
      });

      await redis.discardDlq('aura:meta:', jobId);
      return job;
    });
  }

  async retryJob(jobId: string) {
    return await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const job = await tx.job.update({
        where: { id: jobId, status: { in: ['FAILED', 'DEAD_LETTER'] } },
        data: { status: 'PENDING', attempts: 0 }
      });

      const queueRaw = await redis.hget(`aura:meta:${job.id}`, 'queue');
      const queueName = (queueRaw === 'high' || queueRaw === 'low' || queueRaw === 'default') ? queueRaw : queueFromInput(undefined, job.priority);
      await redis.zadd(QUEUE_KEYS[queueName], job.priority, job.id);
      await redis.hset(`aura:meta:${job.id}`, {
        priority: job.priority,
        attempts: 0,
        maxAttempts: job.maxAttempts,
        queue: queueName
      });

      await tx.jobEvent.create({
        data: { jobId, type: 'RETRIED', message: 'Job manually retried' }
      });
      await redis.zadd('aura:metrics:retried', Date.now(), job.id);
      queueEvents.emit('job_retried', job);
      queueEvents.emit('job_requeued', { ...job, queue: queueName });
      return job;
    });
  }
}
