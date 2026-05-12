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

## Load Testing

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
