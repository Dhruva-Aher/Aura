# Aura

**A job queue built from scratch — leases, fences, and Postgres-backed recovery, with a live operator console.**

Workers claim jobs with **leases** and **idempotency fences**. Postgres is the durable source of truth; Redis is the high-speed execution path. After a Redis wipe, the scheduler **restores jobs from Postgres**.

| | |
|--|--|
| **Live demo** | [aurasys.vercel.app](https://aurasys.vercel.app) *(free tier — first open may take 30–60s while the API starts)* |
| **Stack** | TypeScript · Node · Redis · PostgreSQL · React |
| **Category** | Distributed job queue with crash recovery and real-time observability |

---

## What it does (10 seconds)

1. **Accepts jobs** over HTTP with adaptive backpressure.
2. **Runs them** on workers with priority queues, retries, and a dead-letter queue.
3. **Recovers** from worker crashes, scheduler failover, and Redis data loss.
4. **Surfaces health** — throughput, P95 latency, queue depth — on a real-time dashboard.

### Proof screenshot (local / Docker high-volume run)

![Aura Console — local high-volume snapshot](./assets/system-overview.png)

**This image:** Operator Console on a **local / Docker** high-volume run (scale evidence).  
**Live demo:** [aurasys.vercel.app](https://aurasys.vercel.app) for interactive UI (light free-tier traffic).

**Visible on this image (matched to claims):**

| On the picture | Value | Claim # |
|----------------|-------|---------|
| Completed (Last 1 hour) | **18,223** | #6 |
| Throughput | **303.72** Jobs/min | #5 |
| Job Latency P95 | **7.40s** | #7 |
| Pending / Processing at capture | **0** / **5** | #8c |
| Dead Letters (same hour) | **3,479** | #8b |

Related crops: [`assets/performance.png`](./assets/performance.png) (pulse) · [`assets/job-activity.png`](./assets/job-activity.png) (P95 **7.60s** → claim #8) · write-up [docs/benchmark-runs/2026-console-dashboard.md](./docs/benchmark-runs/2026-console-dashboard.md)

---

## Why this stands out

Aura implements queue primitives **in this repository**:

| Attention hook | Plain meaning |
|----------------|---------------|
| **Owned primitives** | Claim → lease → execute → fence → complete in first-party code |
| **Durable after Redis wipe** | Scheduler rebuilds queues from Postgres (**6,000** jobs in **1,843 ms** — case-study log) |
| **Measured metrics** | Screenshot: **303.72 jobs/min**, P95 **7.40s** / **7.60s**, **18,223** completions/hour |
| **Decision log** | Major tradeoffs written down for interviews |

Deeper comparison: [docs/POSITIONING.md](./docs/POSITIONING.md)

---

## Numbers at a glance

Two environments, each with its own purpose and numbers:

| | Local / Docker (proof) | Public demo (interactive UI) |
|--|------------------------|------------------------------|
| **Purpose** | Scale + recovery evidence | Recruiter-friendly walkthrough |
| **Throughput** | **303.72 jobs/min** → **18,223**/hour | ~1 job / 10–15s (steady demo traffic) |
| **P95 queue wait** | **7.40s** (overview) · **7.60s** (latency widget) | Light load |
| **Tests** | **224** Vitest cases (`npm test -w apps/worker`) | — |
| **Recovery** | **6,000** jobs restored in **1,843 ms** (case-study log) | — |

---

## Claims ↔ evidence (matched 1:1)

Every public claim has an evidence pointer in this table.

| # | Claim | Exact evidence (quote / path) | Grade |
|---|-------|-------------------------------|-------|
| 1 | Job queue **built from scratch** in-repo | Claim/lease/fence/reconcile — `Worker.ts`, `Scheduler.ts`, `packages/redis/src/lua.ts` | A |
| 2 | **Leases** + **idempotency fences** | `LEASE_MS` + `aura:leased`; fence `aura:executing:<id>` — [lease-protocol.md](./docs/lease-protocol.md), `Idempotency.test.ts` | A |
| 3 | Postgres durability + Redis speed; **wipe → restore** | `Scheduler.reconcilePendingJobs` — [crash-recovery.md](./docs/crash-recovery.md) | A |
| 4a | **Live** operator console | [aurasys.vercel.app](https://aurasys.vercel.app) | A (ops) |
| 4b | Console under **local high-volume** load | [`assets/system-overview.png`](./assets/system-overview.png) (captioned above) | A |
| 5 | Throughput **303.72 jobs/min** | Throughput card on that PNG | A |
| 6 | Completions **18,223** / hour | Completed card on that PNG; **303.72 × 60 ≈ 18,223** | A |
| 7 | P95 queue wait **7.40s** | Job Latency card on that PNG | A |
| 8 | P95 queue wait **7.60s** | [`assets/job-activity.png`](./assets/job-activity.png) | A |
| 8b | Dead letters **3,479** in same hour (DLQ under load) | Dead Letters card on `system-overview.png` | A |
| 8c | In-flight at capture: Pending **0**, Processing **5** | Same PNG status cards | A |
| 9 | Recovered **6,000** jobs in **1,843 ms** | Case-study log `{ restored:6000, durationMs:1843 }` — [BENCHMARKS.md](./docs/BENCHMARKS.md) | C |
| 10 | Reconcile loop restores **6,000** orphans in under **2s** (in-memory) | `PersistenceRecovery.test.ts` | A |
| 11 | **224** unit tests | `npm test -w apps/worker` → **224 passed** | A |
| 12 | Adaptive **backpressure** on enqueue | Lua admission + `AdaptiveThreshold` — `packages/redis/src/lua.ts`, backpressure tests | A |
| 13 | Public demo keeps light, steady traffic | [DEPLOY_FREE.md](./docs/DEPLOY_FREE.md) | A (ops) |
| 14 | Load harness supports **20,000**-job bursts | `apps/worker/src/load-test.ts` `--jobs 20000` | B |

Definitions and interview phrasing: [docs/BENCHMARKS.md](./docs/BENCHMARKS.md) · [docs/benchmark-runs/2026-console-dashboard.md](./docs/benchmark-runs/2026-console-dashboard.md)

**Citation style:** Prefer exact values (**303.72**, **7.40s** / **7.60s**, **18,223**, **1,843 ms**) when quoting evidence.

---

## Try it

```bash
# Live UI
open https://aurasys.vercel.app

# Local (full system)
docker compose up -d && npm install && npm run db:push && npm run dev
```

Deploy guides: [Free $0](./docs/DEPLOY_FREE.md) · [Render paid](./docs/DEPLOY_RENDER.md) · [VPS](./docs/DEPLOY_VPS.md)

---

## Docs map

| Doc | For |
|-----|-----|
| [POSITIONING.md](./docs/POSITIONING.md) | Differentiation, metrics glossary, XYZ scaffolds |
| [BENCHMARKS.md](./docs/BENCHMARKS.md) | Numbers + evidence grades |
| [DECISIONS.md](./docs/DECISIONS.md) | Engineering decision catalog |
| [INTERVIEW_GUIDE.md](./docs/INTERVIEW_GUIDE.md) | How to present the project |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Component diagram |

---

## For engineers (depth)

### Architecture (short)

| Piece | Role |
|-------|------|
| **API** | Enqueue, Zod validation, adaptive backpressure → Postgres + Redis |
| **Workers** | `ZPOPMAX` claim, lease, fence, execute, complete/fail |
| **Scheduler** | Leader-elected: reap leases, promote delayed, reconcile, SLOs |
| **Console** | React + SSE — live metrics and job activity |

Details: [ARCHITECTURE.md](./ARCHITECTURE.md)

### Lifecycle

`PENDING` → claim/lease → `PROCESSING` → `COMPLETED` / retry via delayed queue → `DEAD_LETTER` when max attempts are reached. After a worker crash, lease TTL expiry lets the reaper re-queue. After a Redis wipe, the reconciler restores from Postgres.

### Protocol highlights

- **Lease** (`aura:leased`, ~30s) + **fence** (`aura:executing:<id>`) for safe completion after reap races.
- **Backoff** → delayed ZSET; then DLQ in Postgres.
- **Admission** — Lua gate + adaptive threshold from drain rate.

Design notes: [docs/lease-protocol.md](./docs/lease-protocol.md) · [docs/crash-recovery.md](./docs/crash-recovery.md) · [docs/DECISIONS.md](./docs/DECISIONS.md)

### Benchmarks

Re-run load: `npm run load-test -w apps/worker -- burst --jobs 20000 --concurrency 20` (local stack). Archive under `docs/benchmark-runs/`.

Handlers validate their own `JSONB` payloads. Enqueue uses Redis on the hot path. Free-tier cold start is typically 30–60s on first visit.

### Local setup

**Needs:** Node ≥ 18, Postgres ≥ 14, Redis ≥ 6

```bash
npm install
docker compose up -d
# .env: DATABASE_URL=postgresql://postgres:password@localhost:5433/aura?schema=public
#       REDIS_URL=redis://localhost:6379
#       PORT=3001
npm run db:push
npm run dev
```
