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
| **Redis wipe ≠ lost jobs** | Scheduler rebuilds queues from Postgres (case study: **6,000** jobs in **~1.8s**) |
| **Honest metrics** | Screenshot-backed **~304 jobs/min**, P95 **~7.5s** — with definitions, not vibes |
| **Decision log** | Every major tradeoff written down for interviews |

Deeper comparison: [docs/POSITIONING.md](./docs/POSITIONING.md)

---

## Numbers at a glance

**Two environments — do not mix them.**

| | Local / Docker (proof) | Public demo (click around) |
|--|------------------------|----------------------------|
| **Purpose** | Scale + recovery evidence | Recruiter-friendly UI |
| **Throughput** | **~304 jobs/min** · **~18k**/hour | ~1 job / 10–15s (on purpose) |
| **P95 queue wait** | **≈7.4–7.6s** | N/A (light load) |
| **Tests** | **224** Vitest cases | — |
| **Recovery** | **6k** jobs re-queued after Redis wipe in **~1.8s** | — |

Evidence + definitions: [docs/BENCHMARKS.md](./docs/BENCHMARKS.md) · screenshots in `assets/`

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
