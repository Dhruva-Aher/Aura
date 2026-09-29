# Aura

**Distributed job queue** · Backend / systems · TypeScript · Redis · PostgreSQL

Lease-based workers, idempotency fences, Postgres-backed crash recovery, adaptive backpressure, priority queues, and a live operator console — implemented in-repo as a monorepo (`api` · `worker` · `console`).

[![CI](https://github.com/Dhruva-Aher/Aura/actions/workflows/ci.yml/badge.svg)](https://github.com/Dhruva-Aher/Aura/actions/workflows/ci.yml)

| | |
|--|--|
| **Demo** | [aurasys.vercel.app](https://aurasys.vercel.app) |
| **Focus** | Reliability · concurrency · observability |
| **Stack** | Node.js · Redis · PostgreSQL · React · Vitest · Docker |

---

## Highlights

- **Reliability** — Leases + fences; leader-elected scheduler reaps crashes and restores Redis from Postgres (**6,000** jobs in **1,843 ms** in a documented recovery run).
- **Scale (local proof)** — Console snapshot: **303.72 jobs/min**, **18,223** completions/hour, P95 queue wait **7.40s**.
- **Correctness** — **224** automated tests (leases, fences, retries/DLQ, backpressure, priority, recovery, SLOs).
- **Operability** — SSE operator console for throughput, latency, queue depth, and DLQ actions.

![Aura Console — local high-volume run](./assets/system-overview.png)

*Local high-volume run (proof). Demo URL above is for interactive walkthrough.*

| Metric on screenshot | Value |
|----------------------|-------|
| Completions (1h) | **18,223** |
| Throughput | **303.72** jobs/min |
| P95 queue wait | **7.40s** |
| Dead letters (same window) | **3,479** |

P95 crop **7.60s**: [`assets/job-activity.png`](./assets/job-activity.png) · Evidence: [docs/BENCHMARKS.md](./docs/BENCHMARKS.md)

---

## Architecture

| Component | Responsibility |
|-----------|----------------|
| **API** | HTTP enqueue, Zod validation, adaptive backpressure → Postgres + Redis |
| **Workers** | Priority claim (`ZPOPMAX`), lease, fence, execute, complete / retry |
| **Scheduler** | Leader election — reap, promote delayed jobs, reconcile, evaluate SLOs |
| **Console** | React + SSE metrics, recent jobs, DLQ replay |

```text
Client → API → Postgres (truth) + Redis (queues / leases / delayed)
                ↑______ Workers claim & complete ________↑
                ↑______ Scheduler: reap / reconcile _____↑
```

More: [ARCHITECTURE.md](./ARCHITECTURE.md) · [docs/DECISIONS.md](./docs/DECISIONS.md) · [docs/POSITIONING.md](./docs/POSITIONING.md)

---

## Quick start

```bash
open https://aurasys.vercel.app
docker compose up -d && npm install && npm run db:push && npm run dev
```

Load test: `npm run load-test -w apps/worker -- burst --jobs 20000 --concurrency 20`  
Deploy: [Free](./docs/DEPLOY_FREE.md) · [Render](./docs/DEPLOY_RENDER.md) · [VPS](./docs/DEPLOY_VPS.md)

---

## For interview depth

| Doc | Use |
|-----|-----|
| [BENCHMARKS.md](./docs/BENCHMARKS.md) | Claim ↔ evidence |
| [FAANG_RECRUITER_CHECK.md](./docs/FAANG_RECRUITER_CHECK.md) | Research-backed sourcer audit |
| [INTERVIEW_GUIDE.md](./docs/INTERVIEW_GUIDE.md) | How to present Aura |
| [lease-protocol.md](./docs/lease-protocol.md) / [crash-recovery.md](./docs/crash-recovery.md) | Protocol deep-dives |
