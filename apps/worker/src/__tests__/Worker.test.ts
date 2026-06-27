import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '@aura/database';

const mockRedisClient = vi.hoisted(() => ({
  claimExecution: vi.fn(),
  completeJob: vi.fn(),
  publish: vi.fn(),
  zadd: vi.fn(),
  del: vi.fn().mockResolvedValue(1),
  renewLease: vi.fn(),
  failJob: vi.fn(),
}));

vi.mock('@aura/redis', () => ({
  createRedisClient: () => mockRedisClient,
}));

import { Worker } from '../services/Worker';

vi.mock('@aura/database', () => {
  const txStub = {
    job: {
      updateMany: vi.fn(),
    },
    jobEvent: {
      create: vi.fn(),
    }
  };
  return {
    prisma: {
      job: {
        findUnique: vi.fn(),
      },
      $transaction: vi.fn(async (cb: any) => cb(txStub)),
    },
  };
});

describe('Worker idempotency race condition', () => {
  let worker: any;

  beforeEach(() => {
    vi.clearAllMocks();
    worker = new Worker('test-worker-1');
  });

  it('does NOT call completeJob if another worker holds the idempotency fence', async () => {
    // 1. Job exists in DB
    (prisma.job.findUnique as any).mockResolvedValue({ id: 'job-1', status: 'PENDING' });
    
    // 2. Fence is held by another worker
    mockRedisClient.claimExecution.mockResolvedValue(null);

    // Call processJob
    await worker.processJob('job-1');

    // 3. Verify completeJob is NOT called (this prevents destroying the other worker's lease)
    expect(mockRedisClient.completeJob).not.toHaveBeenCalled();
    // Verify it bailed out early before hitting Postgres
    const updateSpy = prisma.$transaction;
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('does NOT call completeJob if it wins the fence but loses the Postgres race', async () => {
    // 1. Job exists in DB
    (prisma.job.findUnique as any).mockResolvedValue({ id: 'job-1', status: 'PENDING' });
    
    // 2. Fence is successfully acquired
    mockRedisClient.claimExecution.mockResolvedValue('OK');

    // 3. Postgres race is lost (e.g., job was cancelled or claimed by another node while we paused)
    vi.mocked(prisma.$transaction).mockImplementationOnce(async (cb: any) => {
      // Mock the transaction callback returning false (because updateMany returned count: 0)
      return false;
    });

    // Call processJob
    await worker.processJob('job-1');

    // 4. Verify completeJob is NOT called
    expect(mockRedisClient.completeJob).not.toHaveBeenCalled();
    // 5. Verify the fence is released so we do not block legitimate execution if it was a false alarm
    expect(mockRedisClient.del).toHaveBeenCalledWith('aura:executing:job-1');
  });
});
