# Lease Protocol

In a distributed system, safely granting ownership of a job to a specific worker without risking double-execution is a critical challenge. Aura solves this using a strict, time-bound lease protocol enforced entirely in Redis.

## Acquisition (The Claim)
Aura relies on Redis sorted sets and Lua pipelines to make job acquisition atomic.
When a worker claims a job via `ZPOPMAX`:
1. The job is popped from `aura:queue:<priority>`.
2. It is immediately inserted into `aura:leased` with a score of `Date.now() + 30000ms`.
3. The worker writes a temporary key `aura:executing:<jobId>` with an expiration equal to the lease duration.

This guarantees the job is hidden from other polling workers, and the worker now officially "owns" the lease for 30 seconds.

## The Idempotency Fence
A major distributed systems edge case occurs when a worker experiences a long event-loop stall, garbage collection pause, or network partition.
- **The Problem:** The worker holds the job, but its lease expires. The Scheduler's Reaper re-enqueues the job. Another worker claims it. Both workers are now executing the same job concurrently.
- **The Solution:** Before a worker is allowed to write its completion state to Postgres, it must verify it still holds the idempotency fence (`aura:executing:<jobId>`). Because the fence key strictly expires in Redis when the lease ends, a stalled worker will lose the fence. When it wakes up and attempts to complete the job, the fence check will fail, and the worker gracefully aborts the completion commit.

## Rationale
Using a time-bound lease avoids "zombie" jobs that are permanently locked by crashed workers. The idempotency fence guarantees safety against the split-brain scenario where a slow worker attempts to commit a job that has already been reassigned.
