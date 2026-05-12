import { Redis } from 'ioredis';
import { SCRIPTS } from './lua';

export const createRedisClient = (url: string = process.env.REDIS_URL || 'redis://localhost:6379') => {
  const client = new Redis(url);

  client.defineCommand('claimJob', { numberOfKeys: 2, lua: SCRIPTS.CLAIM_JOB });
  client.defineCommand('promoteJobs', { numberOfKeys: 5, lua: SCRIPTS.PROMOTE_JOBS });
  client.defineCommand('reapJobs', { numberOfKeys: 6, lua: SCRIPTS.REAP_JOBS });
  client.defineCommand('completeJob', { numberOfKeys: 2, lua: SCRIPTS.COMPLETE_JOB });
  client.defineCommand('failJob', { numberOfKeys: 6, lua: SCRIPTS.FAIL_JOB });
  client.defineCommand('replayDlq', { numberOfKeys: 2, lua: SCRIPTS.REPLAY_DLQ });
  client.defineCommand('discardDlq', { numberOfKeys: 1, lua: SCRIPTS.DISCARD_DLQ });
  client.defineCommand('admissionGate', { numberOfKeys: 6, lua: SCRIPTS.ADMISSION_GATE });
  client.defineCommand('releaseAdmission', { numberOfKeys: 1, lua: SCRIPTS.RELEASE_ADMISSION });
  client.defineCommand('renewLease', { numberOfKeys: 1, lua: SCRIPTS.RENEW_LEASE });

  return client as Redis & {
    claimJob(activeKey: string, leasedKey: string, leaseExpiry: number): Promise<[string, string] | null>;
    promoteJobs(delayedKey: string, defaultActiveKey: string, metaPrefix: string, highActiveKey: string, lowActiveKey: string, currentTime: number): Promise<number>;
    reapJobs(leasedKey: string, defaultActiveKey: string, metaPrefix: string, highActiveKey: string, lowActiveKey: string, delayedKey: string, currentTime: number): Promise<[string, string][]>;
    completeJob(leasedKey: string, metaPrefix: string, jobId: string): Promise<number>;
    failJob(leasedKey: string, defaultActiveKey: string, metaPrefix: string, highActiveKey: string, lowActiveKey: string, delayedKey: string, jobId: string, nowMs: number): Promise<'REQUEUED' | 'DEAD_LETTER'>;
    replayDlq(activeKey: string, metaPrefix: string, jobId: string): Promise<number>;
    discardDlq(metaPrefix: string, jobId: string): Promise<number>;
    admissionGate(highQueueKey: string, defaultQueueKey: string, lowQueueKey: string, delayedQueueKey: string, rateKey: string, reservationKey: string, threshold: number, rateLimit: number, rateTtlSec: number, reserveTtlSec: number): Promise<[string, string, string?]>;
    releaseAdmission(reservationKey: string): Promise<number>;
    renewLease(leasedKey: string, jobId: string, newExpiry: number): Promise<0 | 1>;
  };
};

export type AuraRedisClient = ReturnType<typeof createRedisClient>;
export * from './lua';
