# Aura

**A job queue built from scratch — not a BullMQ wrapper.**

Workers claim jobs with **leases** and **idempotency fences**. Postgres is the source of truth; Redis is the fast path. If Redis is wiped, jobs are **restored from Postgres**. Includes a live **operator console**.

| | |
|--|--|
| **Live demo** | [aurasys.vercel.app](https://aurasys.vercel.app) *(free tier — may take ~30–60s to wake)* |
| **Stack** | TypeScript · Node · Redis · PostgreSQL · React |
| **Not this** | Not a chat app, not Kafka/Temporal, not “Redis as a cache on a CRUD API” |

---

## What it does (10 seconds)

1. **Accepts jobs** over HTTP (rejects overload with backpressure).
2. **Runs them** on workers with priority queues, retries, and a dead-letter queue.
3. **Survives crashes** — worker death, scheduler failover, Redis data loss.
4. **Shows health** — throughput, P95 latency, queue depth — in a real-time dashboard.

![Operator console under load](./assets/system-overview.png)

---

## Why this stands out

Most portfolio “queues” configure **BullMQ/Celery**. Aura implements the hard parts in-repo:

| Attention hook | Plain meaning |
|----------------|---------------|
| **Owned primitives** | Claim → lease → execute → fence → complete — your code, not `node_modules` |
| **Redis wipe ≠ lost jobs** | Scheduler rebuilds queues from Postgres (**6,000** jobs in **1,843 ms** — case-study log) |
| **Honest metrics** | Screenshot: **303.72 jobs/min**, P95 **7.40s** / **7.60s**, **18,223** completions/hour |
| **Decision log** | Every major tradeoff written down for interviews |

Deeper comparison: [docs/POSITIONING.md](./docs/POSITIONING.md)

---

## Numbers at a glance

**Two environments — do not mix them.**

| | Local / Docker (proof) | Public demo (click around) |
|--|------------------------|----------------------------|
| **Purpose** | Scale + recovery evidence | Recruiter-friendly UI |
| **Throughput** | **303.72 jobs/min** → **18,223**/hour | ~1 job / 10–15s (on purpose) |
| **P95 queue wait** | **7.40s** (overview) · **7.60s** (latency widget) | Light load — not a scale claim |
| **Tests** | **224** Vitest cases (`npm test -w apps/worker`) | — |
| **Recovery** | **6,000** jobs restored in **1,843 ms** (case-study log) | — |

---

## Claims ↔ evidence (matched 1:1)

Every public claim below has exactly one evidence pointer. If it is not in this table, do not put it on a resume.

| # | Claim | Exact evidence (quote / path) | Grade |
|---|-------|-------------------------------|-------|
| 1 | Job queue **from scratch**, **not a BullMQ wrapper** | In-repo claim/lease/fence/reconcile — `apps/worker/src/services/Worker.ts`, `Scheduler.ts`, `packages/redis/src/lua.ts` (no BullMQ dependency) | A |
| 2 | **Leases** + **idempotency fences** | `LEASE_MS` + `aura:leased`; fence `aura:executing:<id>` — [lease-protocol.md](./docs/lease-protocol.md), `Idempotency.test.ts` | A |
| 3 | Postgres = truth; Redis = fast path; **wipe → restore** | `Scheduler.reconcilePendingJobs` — [crash-recovery.md](./docs/crash-recovery.md) | A |
| 4 | Live **operator console** | [aurasys.vercel.app](https://aurasys.vercel.app) · screenshot [`assets/system-overview.png`](./assets/system-overview.png) | A |
| 5 | Throughput **303.72 jobs/min** | Same pixel on `system-overview.png` (Throughput card) | A |
| 6 | Completions **18,223** / hour | Completed card on same screenshot; **303.72 × 60 ≈ 18,223** | A |
| 7 | P95 queue wait **7.40s** | Job Latency card on `system-overview.png` | A |
| 8 | P95 queue wait **7.60s** | [`assets/job-activity.png`](./assets/job-activity.png) (P95 widget) | A |
| 9 | Recovered **6,000** jobs in **1,843 ms** | Phase 9 case-study log: `{ restored:6000, durationMs:1843 }` — [BENCHMARKS.md](./docs/BENCHMARKS.md) | C |
| 10 | Reconcile loop handles **6,000** orphans **&lt; 2s** (in-memory) | `PersistenceRecovery.test.ts` — “restores 6000 … under 2s” | A |
| 11 | **224** unit tests | `npm test -w apps/worker` → **224 passed** | A |
| 12 | HTTP **backpressure** (429 when overloaded) | Lua admission + `AdaptiveThreshold` — `packages/redis/src/lua.ts`, backpressure tests | A |
| 13 | Free demo is **light** (~1 job / 10–15s; may sleep) | [DEPLOY_FREE.md](./docs/DEPLOY_FREE.md); Render Free behavior | A (ops) |
| 14 | Load harness can burst **20,000** enqueues | `apps/worker/src/load-test.ts` `--jobs 20000` — **capability**, not the screenshot’s in-flight depth | B |

Full definitions + “do not say”: [docs/BENCHMARKS.md](./docs/BENCHMARKS.md) · [docs/benchmark-runs/2026-console-dashboard.md](./docs/benchmark-runs/2026-console-dashboard.md)

**Rounding rule:** Prefer exact screenshot/log values in this table. Soft wording like “~304/min” or “~7.5s” is only OK in speech if you can still point at **303.72** / **7.40–7.60**.

---
## Try it

```bash
# Live UI (wake the free API if sleeping)
open https://aurasys.vercel.app

# Local (full system)
docker compose up -d && npm install && npm run db:push && npm run dev
```

Deploy guides: [Free $0](./docs/DEPLOY_FREE.md) · [Render paid](./docs/DEPLOY_RENDER.md) · [VPS](./docs/DEPLOY_VPS.md)

---

## Docs map

| Doc | For |
|-----|-----|
| [POSITIONING.md](./docs/POSITIONING.md) | What / why different / metrics glossary / XYZ scaffolds |
| [BENCHMARKS.md](./docs/BENCHMARKS.md) | Defensible numbers + evidence grades |
| [DECISIONS.md](./docs/DECISIONS.md) | Full engineering decision catalog |
| [INTERVIEW_GUIDE.md](./docs/INTERVIEW_GUIDE.md) | How to talk about the project |
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

`PENDING` → claim/lease → `PROCESSING` → `COMPLETED` / retry via delayed queue → `DEAD_LETTER` if max attempts exceeded. Crashed workers: lease TTL expires → reaper re-queues. Redis wipe: reconciler restores from Postgres.

### Protocol highlights

- **Lease** (`aura:leased`, ~30s) + **fence** (`aura:executing:<id>`) so a slow worker cannot double-complete after a reap.
- **Backoff** → delayed ZSET; then DLQ in Postgres.
- **Admission** — Lua gate + adaptive threshold from drain rate (HTTP 429 when overloaded).

Design notes: [docs/lease-protocol.md](./docs/lease-protocol.md) · [docs/crash-recovery.md](./docs/crash-recovery.md) · [docs/DECISIONS.md](./docs/DECISIONS.md)

### Benchmarks & limits

- Re-run load: `npm run load-test -w apps/worker -- burst --jobs 20000 --concurrency 20` (local stack). Archive under `docs/benchmark-runs/`.
- Payload `JSONB` is not schema-validated at read time; handlers must validate.
- API hard-depends on Redis for enqueue.
- Free demo sleeps after idle; cold start can be 30–60s.

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
