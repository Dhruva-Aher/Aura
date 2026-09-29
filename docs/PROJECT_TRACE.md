# Project Trace — Aura (full backtrace)

Narrative of what exists, why, and where to look. Companion to [DECISIONS.md](./DECISIONS.md) and [BENCHMARKS.md](./BENCHMARKS.md).

## Problem statement

Build a **job orchestration engine** that:

1. Accepts work over HTTP  
2. Prioritizes and executes it under concurrency  
3. Survives worker crash, scheduler crash, and Redis loss  
4. Exposes live ops metrics to a console  

Without treating Redis as the only source of truth.

## Solution shape

```
Client/UI ──► API (Express, admission gate, SSE)
                │
                ├─► PostgreSQL (Job, JobEvent, Worker)     durability
                └─► Redis (queues, leased, delayed, locks) execution

Workers ◄── poll Redis ──► execute ──► write Postgres
Scheduler (elected) ──► reap / promote / reconcile / SLOs
```

## Package map

| Path | Role |
|------|------|
| `apps/api` | HTTP API, SSE, metrics snapshot, backpressure |
| `apps/worker` | Workers, scheduler, load-test, Vitest |
| `apps/operator-console` | Vite/React ops UI |
| `packages/database` | Prisma schema + client |
| `packages/redis` | ioredis + Lua (claim, admission, etc.) |

## Lifecycle (short)

1. `POST /jobs` → validate → adaptive admit → insert Postgres `PENDING` → ZADD Redis queue  
2. Worker `ZPOPMAX` → lease + fence → `PROCESSING` → handler  
3. Success → `COMPLETED` + clear Redis; fail → delayed backoff or DLQ  
4. Scheduler reaps expired leases; reconciles Postgres↔Redis gaps  

## Correctness mechanisms

| Mechanism | Failure it addresses |
|-----------|----------------------|
| Lease TTL | Dead worker holding a job forever |
| Execution fence | Double-complete after late finish |
| Scheduler lock | Duplicate reap/reconcile loops |
| Reconciler | Redis flush / eviction |
| DLQ | Poison messages |

## Observability

- Redis metrics hash / throughput ZSET  
- SSE `metrics_update`, `job_update`  
- SLO evaluator publishes breaches  

## Deployment evolution

1. Local Docker Compose (dev + load tests)  
2. Railway (API/worker) — trial ended  
3. Free Render web + Neon + Render Redis + Vercel SPA (current public demo)  
4. Optional VPS / paid Render for always-on scale (documented, not required for resume claims)

## How to verify claims

See [BENCHMARKS.md](./BENCHMARKS.md). Do not use the free URL as proof of 20k concurrency.
