# Crash Recovery

Aura guarantees "at-least-once" execution. To achieve this, the system must gracefully recover from crashes at any layer of the architecture: Worker processes, the Scheduler, or Redis itself.

## 1. Worker Crashes
If a worker process crashes (OOM, unhandled exception, node eviction), it leaves behind two artifacts:
- A stale heartbeat in `aura:workers:active`.
- A hanging lease in `aura:leased`.

**Recovery:**
- The Scheduler periodically scans worker heartbeats. If a heartbeat is older than 30 seconds, the worker is marked `OFFLINE`.
- The Scheduler's Reaper loop scans `aura:leased`. Because the worker is dead, it will never complete the job. The lease score will eventually become less than the current time. The Reaper detects this, pops the job from `aura:leased`, and pushes it back into the active priority queue. The job will be picked up by another healthy worker.

## 2. Scheduler Crashes
If the worker acting as the Scheduler leader crashes, its `SET NX EX` lock on `aura:scheduler:lock` will naturally expire within 15 seconds.

**Recovery:**
- All other active workers are constantly polling to acquire this lock. Once the lock expires, a new worker will win the race condition and seamlessly take over Scheduler duties without any operational intervention.

## 3. Redis Data Loss / Eviction
Redis operates as an ephemeral state layer. If Redis is flushed, restarted without persistence, or evicts keys due to memory pressure, the entire queue state is lost.

**Recovery:**
- PostgreSQL serves as the durable source of truth. The Scheduler's Reconciler loop continually compares Postgres against Redis.
- If the Reconciler finds jobs in Postgres with a status of `PENDING` or `PROCESSING` that do not exist anywhere in the Redis queues, it reconstructs the Redis state, pushing the jobs back into their respective queues.
- This guarantees zero lost jobs even in the event of a total Redis failure, provided the API successfully committed to Postgres during ingestion.

## Rationale
Building specific, isolated recovery mechanisms for each failure domain ensures that Aura can self-heal without manual operator intervention. The lease TTL fundamentally bounds the maximum duration a system can remain in an inconsistent state following a worker crash.
