# Aura — Distributed Job Queue

A production-grade distributed job queue built on Redis sorted sets and PostgreSQL.  Handles priority queuing, lease-based execution, automatic crash recovery, adaptive backpressure, and formal SLO tracking.

Tested under 20 000+ jobs with injected failures, worker crashes, and Redis wipes — all with full automated recovery.

---

## System in Action

### End-to-End Processing (20k Jobs)
![System Overview](./assets/system-overview.png)

### Throughput & Latency
![Performance](./assets/performance.png)

### Real-Time Job Activity
![Job Activity](./assets/job-activity.png)

---

## Architecture

```
┌──────────────┐     HTTP      ┌─────────────────────────────────────┐
│   Client /   │ ─────────────▶│            API (Express)            │
│  Dashboard   │               │  admission gate · adaptive BP       │
└──────────────┘               └────────────────┬────────────────────┘
                                                 │ ZADD + HSET (pipeline)
                                                 ▼
                                    ┌────────────────────┐
                                    │       Redis        │
                                    │  aura:queue:high   │ ◀─── ZPOPMAX
                                    │  aura:queue:default│      (workers)
                                    │  aura:queue:low    │
                                    │  aura:delayed      │ ◀─── promote
                                    │  aura:leased       │      (scheduler)
                                    │  aura:meta:<id>    │
                                    └─────────┬──────────┘
                                              │
                     ┌────────────────────────┼────────────────────────┐
                     ▼                        ▼                        ▼
              ┌────────────┐          ┌────────────┐           ┌────────────┐
              │  Worker 0  │          │  Worker 1  │    …      │  Worker N  │
              │  (pool:    │          │  (pool:    │           │  (pool:    │
              │  default)  │          │  high-pri) │           │  low-pri)  │
              └─────┬──────┘          └─────┬──────┘           └─────┬──────┘
                    │                       │                         │
                    └───────────────────────┼─────────────────────────┘
                                            │ updateMany / create
                                            ▼
                                    ┌────────────────────┐
                                    │     PostgreSQL     │
                                    │  Job · JobEvent    │
                                    │  Worker            │
                                    └────────────────────┘
                                            ▲
                                    ┌───────┴────────┐
                                    │   Scheduler    │
                                    │  (one leader   │
                                    │  via Redis     │
                                    │  SET NX EX)    │
                                    └────────────────┘
```

---

## Job Lifecycle

```
             enqueue
               │
               ▼
           ┌────────┐      claim (ZPOPMAX + ZADD leased)
           │PENDING │ ─────────────────────────────────▶ ┌────────────┐
           └────────┘                                     │ PROCESSING │
               ▲                                          └─────┬──────┘
               │                                                │
               │  reap / recover                     ┌──────────┴──────────┐
               │  (lease expired)                    │                     │
               │                                     ▼                     ▼
               └──────── PENDING ◀─── retry   ┌──────────┐         ┌─────────┐
                         (delayed)             │COMPLETED │         │ FAILED  │
                                               └──────────┘         └────┬────┘
                                                                          │
                                                                  attempts ≥ maxAttempts
                                                                          │
                                                                          ▼
                                                                   ┌────────────┐
                                                                   │DEAD_LETTER │
                                                                   └────────────┘
```

---

## Redis Data Model

| Key pattern | Type | Purpose |
|---|---|---|
| `aura:queue:high` | Sorted Set | High-priority jobs, score = job.priority |
| `aura:queue:default` | Sorted Set | Default-priority jobs |
| `aura:queue:low` | Sorted Set | Low-priority jobs |
| `aura:delayed` | Sorted Set | Jobs awaiting delayed retry, score = runAt ms |
| `aura:leased` | Sorted Set | Jobs being processed, score = leaseExpiry ms |
| `aura:meta:<jobId>` | Hash | `{priority, attempts, maxAttempts, queue}` |
| `aura:executing:<jobId>` | String | Idempotency fence (NX EX 300s) |
| `aura:scheduler:lock` | String | Leader election (NX EX 15s) |
| `aura:health:scheduler:last_loop` | String | Heartbeat timestamp (EX 10s) |
| `aura:health:scheduler:reconcile` | Hash | Last reconcile stats |
| `aura:health:slo:snapshot` | String | JSON SLO evaluation (EX 120s) |
| `aura:metrics:throughput` | Sorted Set | Completed jobs by time |
| `aura:metrics:latency` | Sorted Set | Queue latencies `latencyMs:jobId` |
| `aura:metrics:failed` | Sorted Set | Failed jobs by time |
| `aura:workers:active` | Set | Currently active worker IDs |
| `aura:events` | Pub/Sub | Real-time event stream (SSE) |
| `aura:alerts` | Pub/Sub | SLO breach alerts |

---

## System Guarantees

### At-least-once execution
Every PENDING job will eventually be executed.  A job can be executed more than once only if:
- A worker crashes during execution (lease expires → reaper re-enqueues)
- A scheduler restart races with an in-flight job

Callers should make handlers idempotent.  The execution fence (`aura:executing:<id>`) reduces duplicates to a narrow window around lease expiry.

### No lost jobs
PENDING jobs are written to PostgreSQL **before** being added to Redis.  On any restart, `reconcilePendingJobs` scans Postgres and re-adds any PENDING job that isn't already in a Redis structure.

### Crash recovery timeline

| Event | Detection | Recovery |
|---|---|---|
| Worker crash (job in flight) | Lease expires (30s) | Reaper re-enqueues within next 5s reap cycle |
| Worker crash (between jobs) | Worker heartbeat ages out (30s) | Scheduler marks OFFLINE; jobs unaffected |
| Redis wipe | Startup | `reconcilePendingJobs` restores all PENDING jobs |
| Scheduler crash | Heartbeat key expires (10s TTL) | Stand-by scheduler acquires lock within 15s |
| Stale PROCESSING (no Redis lease) | Heartbeat > 45s stale | `recoverStaleProcessingJobs` resets to PENDING |

### Retry / exponential backoff
Failed jobs are re-enqueued to `aura:delayed` with backoff:

```
backoffMs = min(2^(attempts-1) × 5 000ms, 300 000ms)  +  ±10% jitter
```

Attempts 1→2→3: ~5s → ~10s → ~20s, capped at 5 minutes.

After `maxAttempts` the job moves to `DEAD_LETTER`.

### Backpressure
When the queue grows faster than workers can drain it, the API admission gate starts rejecting new enqueue requests with HTTP 429.  The rejection threshold is not fixed — it adapts to the current drain rate so the system never accepts more work than it can complete in a reasonable time.  Clients are expected to back off and retry.  The floor (`BP_MIN_THRESHOLD=100`) ensures the queue never fully closes during a temporary drain slowdown.

### Dead-letter queue
A job lands in `DEAD_LETTER` when it has exhausted all retry attempts (`attempts >= maxAttempts`).  DLQ'd jobs are not automatically retried.  They remain in PostgreSQL with status `DEAD_LETTER` and are visible in the dashboard for manual inspection or replay.  The DLQ rate is tracked as a formal SLO — if more than 5% of jobs per hour are dead-lettered, an alert fires on `aura:alerts`.

---

## Priority Queue Routing

Workers poll queues in order based on their pool assignment:

| Pool | Poll order | Low-queue inclusion |
|---|---|---|
| `high-priority` | high → default → low | every 5th consecutive miss |
| `low-priority` | low → default → high | every 5th consecutive miss |
| `default` | high → default → low | every 3rd consecutive miss |

Anti-starvation: every pool eventually polls every queue so low-priority jobs can't be starved indefinitely.

---

## Adaptive Backpressure

The enqueue endpoint rejects requests when the queue is too deep.  Instead of a fixed threshold, the ceiling adapts to the current drain rate:

```
effectiveThreshold = min(staticMax, max(ceil(drainRate × drainWindow × safetyFactor), minThreshold))
```

| Env var | Default | Meaning |
|---|---|---|
| `MAX_QUEUE_THRESHOLD` | 10 000 | Hard upper bound |
| `BP_DRAIN_WINDOW_SEC` | 10 | Seconds of history to sample |
| `BP_SAFETY_FACTOR` | 4.0 | Backlog headroom multiplier |
| `BP_THRESHOLD_REFRESH_MS` | 5 000 | Cache TTL for threshold calculation |
| `BP_MIN_THRESHOLD` | 100 | Floor — never reject everything |

---

## Service Level Objectives

Evaluated every 30 seconds by the scheduler.  Results written to `aura:health:slo:snapshot` and breaches published to `aura:alerts`.

| SLO | Default target | Warning | Critical |
|---|---|---|---|
| P95 Queue Latency | ≤ 5s | > 5s | > 10s |
| Dead-Letter Rate | < 5% / hr | > 5% | > 15% |
| Drain Rate | ≥ 1 job/s | < 1 job/s | = 0 (stalled) |
| Worker Availability | ≥ 1 online | — | 0 workers |
| Scheduler Heartbeat | < 5s stale | > 5s | > 15s / offline |

All thresholds are overridable via env vars (prefix `SLO_`).

---

## Failure Case Study: Redis Wipe

**Scenario:** Redis is wiped (OOM eviction, cluster failover, or operator error).  6 000 PENDING jobs remain in Postgres.

**Without Phase 5:** Jobs are orphaned forever.  Workers see empty queues and idle.  No automatic recovery.

**With Phase 5:**
1. Scheduler restarts and calls `reconcilePendingJobs`.
2. Iterates Postgres in pages of 1 000 jobs.
3. For each job: checks all five Redis structures via `zscore` (≤ 5 parallel calls).
4. If missing from all structures: pipelines a `ZADD` + `HSET` into the correct queue.
5. 6 000 jobs restored in < 2s.  Workers resume processing without intervention.

**Observable output:**
```json
{ "level":"info", "service":"Scheduler", "msg":"Reconciliation complete",
  "restored":6000, "skipped":0, "durationMs":1843 }
```

---

## Failure Case Study: Scheduler Crash

**Scenario:** The scheduler process dies mid-operation.  Delayed jobs stop promoting.  Stale leases stop being reaped.

**Timeline:**
- t+0s: Scheduler crashes. `aura:health:scheduler:last_loop` key stops renewing.
- t+10s: Key expires (10s TTL). Dashboard shows "Scheduler Loop = Delayed".
- t+15s: `aura:scheduler:lock` expires (15s TTL).
- t+~15s: Stand-by scheduler instance acquires lock (retry interval 10s + jitter).
- t+~15s: New scheduler calls `reconcilePendingJobs`, then resumes normal loop.

**Maximum gap:** 15–25 seconds.  During this window delayed jobs do not promote and expired leases are not reaped.  No jobs are lost.

---

## Failure Case Study: Duplicate Execution (Worker + Reaper Race)

**Scenario:** Worker A takes 35s on a job with a 30s lease.  Reaper re-enqueues the job.  Worker B claims it.  Worker A finishes.

**Guards:**
1. **Execution fence** (`aura:executing:<id>`, SET NX EX 300): only one worker holds the fence at a time.  Worker A set it; Worker B gets `null` and aborts without executing.
2. **`updateMany` status guard**: completion writes `WHERE status='PROCESSING'`.  The second write is a no-op.
3. **Idempotency key**: the API rejects a re-submitted job with the same `idempotencyKey`.

---

## Postmortem: Scheduler Offline in Production

**Date:** Discovered after deploying to Railway.  
**Impact:** ~6 000 delayed jobs stuck in queue.  Queue lag reached several hours.  Workers healthy; scheduler silent.

### What happened

Three independent bugs combined to take the scheduler fully offline:

1. **Missing start script.** The `apps/worker/package.json` had no `"start"` field.  Railway fell back to running a non-existent compiled output (`dist/index.js`).  The process exited immediately with no error visible in worker logs — Railway reported the service as "running" because the crash happened after boot.

2. **Silent env-var disable.** The old startup code checked `SCHEDULER_ENABLED !== 'false'`.  A stale Railway env var set to the string `'false'` silently disabled the scheduler.  No log, no metric, no alert.

3. **No redundancy.** The scheduler ran as a single coroutine inside the worker process.  There was no standby, no heartbeat-based detection, and no automatic restart path.  Once it stopped, it stayed stopped.

### Why it wasn't caught immediately

- Workers continued processing jobs already in the active queues, so throughput metrics looked normal.
- Delayed jobs (retries, scheduled work) silently accumulated in `aura:delayed` with no promotion.
- The health endpoint showed "Scheduler Loop = Offline" but this state had never been tested against the real deployment — it was treated as a cosmetic display issue.

### Fix

Three changes shipped together:

1. **Added `"start": "tsx src/index.ts"`** to both `apps/worker` and `apps/api` package.json.  Added `nixpacks.toml` per service with explicit `cmd = "npm start"` so Railway's build detection is bypassed.

2. **Removed the env-var toggle entirely.**  The scheduler now always attempts to start.  There is no runtime switch that can accidentally disable it.

3. **Implemented Redis leader election** (`aura:scheduler:lock`, SET NX EX 15).  Every worker process competes for the lock on startup.  The winner runs the scheduler loop and renews the lock every 5s.  If the leader dies, the lock expires in 15s and any standby worker takes over automatically.

### Result

- Scheduler availability is now tied to worker availability — if any worker process is alive, the scheduler runs.
- Maximum recovery gap after a crash: 15–25 seconds (lock TTL + retry jitter).
- The dashboard "Scheduler Loop" health row now reflects reality: it reads a heartbeat key with a 10s TTL, so a crashed scheduler goes to "Offline" within one TTL window.

---

## Key Design Decisions

**Why Redis for the queue (not Kafka, SQS, etc.)?**  
Redis sorted sets give O(log N) ZPOPMAX with atomic lease acquisition in a single Lua script.  For a system at this scale (thousands of jobs, sub-second latency targets) the operational simplicity of a single Redis instance outweighs the throughput ceiling.  Kafka would add consumer group complexity, partition lag, and at-least-5-second commit latency for no benefit at this scale.

**Why at-least-once instead of exactly-once?**  
True exactly-once requires distributed transactions across Redis and Postgres on every state transition — prohibitively expensive.  At-least-once with idempotent handlers is the standard tradeoff: duplicates are rare (bounded to the lease expiry window), cheap to handle in the job handler, and the system remains simple and fast.

**Why leader election instead of a dedicated scheduler service?**  
A dedicated scheduler service is another thing to deploy, monitor, and fail.  Co-locating the scheduler inside worker processes means it scales automatically with the worker fleet and requires zero additional infrastructure.  Leader election ensures exactly one scheduler runs at a time without coordination overhead.  The only cost: a worker that loses the election wastes ~5s in a retry loop before standing by.

**Why adaptive backpressure instead of a fixed queue limit?**  
A fixed limit (e.g. "reject at 10 000 jobs") is either too tight (causes unnecessary rejections during transient bursts) or too loose (lets the queue grow to a size workers can't drain for hours).  The adaptive threshold anchors rejection to actual drain capacity: if workers are fast, the ceiling rises; if they slow down or fall offline, the ceiling drops before the backlog becomes unmanageable.

---

## Behavior Under Load

**Ingestion faster than processing:**  
Queue depth grows.  The adaptive backpressure threshold shrinks as drain rate falls, so the API begins rejecting requests before the backlog becomes hours deep.  Workers continue draining at maximum throughput.  Once ingestion slows or more workers are added, the threshold rises and requests are admitted again.

**How backlog and latency change:**  
At steady state (ingestion ≈ drain), queue depth stays flat and P95 latency is stable.  During a burst, depth spikes, P95 latency rises proportionally (jobs wait longer in the sorted set), and backpressure kicks in around the effective threshold.  After the burst, the queue drains and latency returns to baseline.

**Adding workers:**  
Each new worker self-registers, starts polling, and immediately reduces queue depth.  There is no coordination step — workers are stateless consumers of the Redis sorted sets.  Adding N workers roughly multiplies throughput by N until Redis becomes the bottleneck (typically > 50 concurrent workers on a single Redis instance).

**Scheduler crash and recovery:**  
During the 15–25s recovery gap:
- Jobs already in active queues continue to be processed normally.
- Delayed jobs (retries) stop promoting — they accumulate in `aura:delayed`.
- Expired leases stop being reaped — stale PROCESSING jobs are not retried until recovery.

After recovery, the new scheduler leader promotes all due delayed jobs immediately on its first loop iteration and picks up reaping on the next 5s cycle.  There is no data loss; the worst case is a ~25s delay in retry scheduling.

---

```bash
# Burst: 2000 jobs as fast as possible
tsx apps/worker/src/load-test.ts burst --jobs 2000 --concurrency 20

# Steady rate: 500 jobs at 50 rps
tsx apps/worker/src/load-test.ts steady --jobs 500 --rps 50

# Mixed priorities
tsx apps/worker/src/load-test.ts mixed --jobs 1000

# Priority storm (all high)
tsx apps/worker/src/load-test.ts priority-storm --jobs 500

# Failure flood (shouldFail=true payload)
tsx apps/worker/src/load-test.ts failure-flood --jobs 200

# JSON output for CI
tsx apps/worker/src/load-test.ts burst --jobs 1000 --json
```

Output:
```
╔══════════════════════════════════════════════════════════╗
║  Aura Load Test Report — scenario: burst                 ║
╠══════════════════════════════════════════════════════════╣
║  📈 Throughput    1234.5   jobs/s  (1.62s total)         ║
╠══════════════════════════════════════════════════════════╣
║  📊 Enqueue P50=2ms    P95=8ms    P99=14ms   max=22ms   ║
║  🕐 E2E     P50=1.24s  P95=3.80s P99=5.10s  max=7.40s  ║
╠══════════════════════════════════════════════════════════╣
║  📉 Queue depth  peak=1847     end=0                     ║
╠══════════════════════════════════════════════════════════╣
║  ✅ Completed=1950 ⚠️  Failed=42 💀 DLQ=8 ⏳ Timeout=0  ║
╚══════════════════════════════════════════════════════════╝
```

---

## Test Suite

250 unit tests, zero infrastructure required (no Redis, no Postgres):

```bash
npm run test -w worker
```

| File | Tests | What it covers |
|---|---|---|
| `FailureInjector.test.ts` | 29 | Failure modes, spike cycles, deterministic rand |
| `Idempotency.test.ts` | 17 | Execution fence: acquire / duplicate / TTL / race |
| `SchedulerLock.test.ts` | 17 | Leader election: acquire / renew / release / race |
| `AdaptiveThreshold.test.ts` | 15 | Backpressure formula, caching, Redis error isolation |
| `PriorityQueue.test.ts` | 19 | Queue ordering, anti-starvation, drain simulation |
| `PersistenceRecovery.test.ts` | 11 | Redis wipe recovery, skip-check, routing, batching |
| `LoadTestStats.test.ts` | 15 | P50/P95/P99 calculation edge cases |
| `Logger.test.ts` | 16 | Structured logging, min-level filter, child logger |
| `SloEvaluator.test.ts` | 31 | All 5 SLOs, breach detection, custom thresholds |
| `Backpressure.test.ts` | 14 | Admission gate, queue depth, rejection path |
| `RetryDlq.test.ts` | 21 | Retry logic, dead-letter promotion, backoff |
| `Metrics.test.ts` | 25 | Metrics collection, throughput, latency samples |

---

## Scaling Limits

| Dimension | Current design | How to scale |
|---|---|---|
| Job ingestion | ~1 000/s (API throughput) | Horizontal API replicas; each writes to shared Redis |
| Job processing | ~300–600/s (20 workers × 20 concurrency) | Add worker replicas; each self-registers |
| Queue depth | ~10 000 before BP rejects | Raise `MAX_QUEUE_THRESHOLD`; scale workers first |
| Scheduler | 1 active (leader election) | Add replicas; standby acquires lock on crash in < 15s |
| Redis | Single instance | Switch to Redis Cluster; Lua scripts use KEYS[1] consistently |
| Postgres | Single instance | Read replicas for metrics queries; partitioned `Job` table by status |

**Redis as the primary bottleneck.**  All job state transitions go through Redis.  A single-threaded Redis instance handles ~100 000 simple ops/s, but each job claim is a Lua script touching 3–4 keys, and each heartbeat renewal is a separate write.  At ~50 concurrent workers with 20 concurrency each, Redis command rate exceeds 50 000/s and latency starts climbing.  The fix is Redis Cluster — the current Lua scripts already hash to single slots (`KEYS[1]` only), so sharding is a configuration change, not a code change.

**Scheduler scan cost.**  `reconcileOrphanedPendingJobs` fetches up to 500 PENDING rows from Postgres every 10 seconds and checks each against Redis.  At 10 000 PENDING jobs this is 10 Postgres rows/s and 5 000 Redis `zscore` calls/s — manageable, but the scan window (500 jobs) means a large orphan backlog takes minutes to fully reconcile.  The startup `reconcilePendingJobs` handles the bulk case in batches; the periodic sweep is a best-effort catch-up for jobs that slip through.

**Worker coordination overhead.**  Workers don't coordinate directly — they compete for jobs via Redis ZPOPMAX.  At high concurrency, contention on the sorted set increases: multiple workers race on the same key, losing workers retry on the next poll cycle (1s sleep).  This is not a correctness problem but a throughput ceiling.  Partitioning queues by worker pool (high/default/low) already reduces hot-key contention; further sharding by job type is the natural next step.

---

## Running Locally

```bash
# Start dependencies
docker-compose up -d

# Push schema
npm run db:push

# Start all services
DATABASE_URL="postgresql://postgres:password@localhost:5433/aura" \
REDIS_URL="redis://localhost:6379" \
npm run dev
```

Dashboard: http://localhost:5173

### Environment Variables

| Variable | Default | Service |
|---|---|---|
| `DATABASE_URL` | — | all |
| `REDIS_URL` | — | all |
| `FAILURE_MODE` | `none` | worker |
| `FAILURE_RATE` | `0.1` | worker |
| `WORKER_CONCURRENCY` | `20` | worker |
| `WORKER_POOL` | `default` | worker |
| `RECONCILE_BATCH_SIZE` | `1000` | worker |
| `MAX_QUEUE_THRESHOLD` | `10000` | api |
| `LOG_FORMAT` | `pretty` | all (`json` for prod) |
| `LOG_LEVEL` | `info` | all |

---

## Production Improvements (9 Phases)

| Phase | Commit | Change |
|---|---|---|
| 1 | `feat(chaos)` | Failure injection (FAILURE_MODE env var, spike/crash modes) |
| 2 | `feat(idempotency)` | Execution fence prevents double-execution on reaper race |
| 3 | `feat(backpressure)` | Adaptive threshold based on real-time drain rate |
| 4 | `test(priority-queue)` | Correctness proof for anti-starvation ordering |
| 5 | `feat(recovery)` | Bounded reconcilePendingJobs with skip-check + pipeline |
| 6 | `feat(load-test)` | Configurable scenarios with P50/P95/P99 reporting |
| 7 | `feat(observability)` | Structured JSON logging + scheduler performance metrics |
| 8 | `feat(slos)` | SLO evaluation with breach alerts via Redis pub/sub |
| 9 | `docs` | This document |

---

## Author

Dhruva Aher
