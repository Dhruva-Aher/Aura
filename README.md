# Aura — Distributed Job Queue

Aura is a distributed job queue built on Redis sorted sets and PostgreSQL. It handles priority queuing, lease-based execution, automatic crash recovery, adaptive backpressure, and SLO tracking.

This document describes the engineering implementation of the system.

## Project Motivation
Aura provides a hybrid persistence model: PostgreSQL serves as the durable source of truth (guaranteeing no jobs are lost), while Redis serves as the high-throughput execution plane (providing fast polling, sorting, and backpressure).

## System Architecture

For a detailed view of the components and data flow, see [ARCHITECTURE.md](./ARCHITECTURE.md).

The system consists of:
- **API (Express)**: Ingests HTTP requests, evaluates adaptive backpressure, and writes to PostgreSQL and Redis.
- **Workers**: Node.js processes that poll Redis sorted sets (`ZPOPMAX`) to claim leases and execute jobs.
- **Scheduler**: A singleton (leader-elected via Redis) that promotes delayed jobs, reaps expired leases, evaluates SLOs, and reconciles the PostgreSQL database with the Redis state.
- **Operator Console**: A React frontend that visualizes queue depths, latencies, worker health, and dead letters using server-sent events (SSE).

## Execution Lifecycle

1. **Enqueue**: A client POSTs to the API. If backpressure thresholds are met, the request is rejected (HTTP 429). Otherwise, the job is written to Postgres (`PENDING`) and pushed to a Redis priority queue (`aura:queue:<priority>`).
2. **Claim**: A worker polls the Redis queue using `ZPOPMAX`. If a job is found, it atomically adds it to the `aura:leased` sorted set with a score equal to `now + lease_duration` and writes an idempotency fence. It then updates the Postgres status to `PROCESSING`.
3. **Process**: The worker executes the job payload.
4. **Completion**: If successful, the job is marked `COMPLETED` in Postgres, and its metadata is removed from Redis. If it throws an error, it is marked `FAILED` and scheduled for retry.
5. **Reap (Crash)**: If a worker crashes while processing, the lease score in `aura:leased` will eventually expire (i.e. become less than `now`). The Scheduler reaps the job and moves it back to the priority queue.

## Scheduler Flow
The Scheduler is a decentralized process. Every worker instance attempts to acquire a Redis lock (`aura:scheduler:lock`) with a 15-second TTL. The winner becomes the active scheduler.
The Scheduler runs periodic loops:
- **Reaper**: Scans `aura:leased` for expired timestamps and re-enqueues them.
- **Promoter**: Scans `aura:delayed` for timestamps that have reached `now` and moves them to the active queues.
- **Reconciler**: Scans Postgres for `PENDING` or `PROCESSING` jobs that are missing from Redis (due to an eviction or cache wipe) and restores them.
- **SLO Evaluator**: Checks latency and DLQ rates and publishes alerts if thresholds are breached.

## Worker Lifecycle
Workers run an asynchronous event loop. Each worker registers a pool (`high-priority`, `default`, or `low-priority`) which dictates its polling order across queues.
A worker periodically writes a heartbeat to Redis. If a worker misses heartbeats, the Scheduler marks it `OFFLINE`.

## Lease Protocol
When a worker claims a job, it acquires a lease via `aura:leased`. To prevent race conditions where a slow worker finishes a job after its lease has been reaped and given to another worker, workers acquire an idempotency fence (`aura:executing:<jobId>`) before writing completion to the database. If the fence is lost, the worker aborts the commit.

## Retry Strategy & DLQ Behavior
Failed jobs are moved to the `aura:delayed` queue using an exponential backoff formula:
`backoffMs = min(2^(attempts-1) * 5000, 300000) + jitter`
Once a job exceeds its `maxAttempts`, it is marked as `DEAD_LETTER` in PostgreSQL. It is completely removed from Redis. Dead letters must be manually inspected, discarded, or replayed via the API/Dashboard.

## Crash Recovery
- **Worker Crash (during job)**: Lease expires in 30s. Scheduler reaps and re-enqueues.
- **Worker Crash (idle)**: Heartbeat ages out. Scheduler marks worker `OFFLINE`.
- **Scheduler Crash**: Lock expires in 15s. Another worker acquires the lock and takes over scheduling duties.
- **Redis Data Loss**: The Reconciler scans PostgreSQL and restores any `PENDING` jobs back into the appropriate Redis queues.

## Observability
The API exposes an SSE endpoint (`/events/stream`) that broadcasts metrics and job state changes. The Operator Console connects to this stream for live updates. 
Key metrics tracked:
- Queue depth by state (Pending, Processing, Delayed)
- P95 Queue Latency
- Throughput (Jobs/min)
- Dead letter rates

## Benchmark Methodology
To benchmark the system, run `npm run load-test` from `apps/worker`. The load test pushes 20,000 jobs through the API concurrently while running multiple worker instances. It tracks end-to-end latency, queue wait time, and processing throughput.

## Known Limitations
- The payload column in PostgreSQL uses `JSONB`, which is not structurally validated upon extraction. Handlers must parse/validate their own payloads.
- If Redis is entirely unavailable, the API will fail to accept new jobs (hard dependency).
- Cursor-based pagination on the `/jobs` endpoint is unindexed on `createdAt`, which may cause slow queries at scale.

## Deployment Instructions

### Requirements
- Node.js >= 18
- PostgreSQL >= 14
- Redis >= 6

### Setup
1. Clone the repository and install dependencies:
   ```bash
   npm install
   ```
2. Configure `.env`:
   ```env
   DATABASE_URL="postgresql://user:password@localhost:5432/aura"
   REDIS_URL="redis://localhost:6379"
   PORT=3001
   ```
3. Initialize the database:
   ```bash
   npm run db:push
   ```
4. Start the API:
   ```bash
   cd apps/api && npm run dev
   ```
5. Start the workers:
   ```bash
   cd apps/worker && npm run dev
   ```
6. Start the dashboard:
   ```bash
   cd apps/operator-console && npm run dev
   ```
