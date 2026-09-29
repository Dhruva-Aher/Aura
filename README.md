# Aura

**Distributed job queue** · TypeScript · Redis · PostgreSQL  

Built from scratch: lease-based workers, idempotency fences, crash recovery, adaptive backpressure, and a live operator console.

| | |
|--|--|
| **Demo** | [aurasys.vercel.app](https://aurasys.vercel.app) |
| **Focus** | Backend / distributed systems · reliability · observability |
| **Stack** | Node.js · Redis · PostgreSQL · React · Vitest |

---

## Highlights

- **Reliability** — Workers use leases + fences; a leader-elected scheduler reaps crashes and restores queues from Postgres after Redis loss (**6,000** jobs in **1,843 ms** in a documented recovery run).
- **Scale (local proof)** — Console snapshot: **303.72 jobs/min**, **18,223** completions/hour, P95 queue wait **7.40s**.
- **Correctness** — **224** automated tests covering leases, fences, retries/DLQ, backpressure, and recovery.
- **Operability** — Real-time dashboard (SSE) for throughput, latency, and queue depth.

![Aura Console — local high-volume run](./assets/system-overview.png)

*Local high-volume run (proof). Live demo is the URL above for interactive walkthrough.*

| Metric on screenshot | Value |
|----------------------|-------|
| Completions (1h) | **18,223** |
| Throughput | **303.72** jobs/min |
| P95 queue wait | **7.40s** |
| Dead letters (same window) | **3,479** |

P95 crop **7.60s**: [`assets/job-activity.png`](./assets/job-activity.png) · Evidence notes: [docs/BENCHMARKS.md](./docs/BENCHMARKS.md)

---

## Architecture

| Component | Responsibility |
|-----------|----------------|
| **API** | HTTP enqueue, validation, adaptive backpressure → Postgres + Redis |
| **Workers** | Priority claim (`ZPOPMAX`), lease, fence, execute, complete / retry |
| **Scheduler** | Leader election — reap, promote delayed jobs, reconcile, SLOs |
| **Console** | React + SSE metrics and job activity |

```text
Client → API → Postgres (truth) + Redis (queues/leases)
                ↑______ Workers claim & complete ______↑
                ↑______ Scheduler: reap / reconcile ___↑
```

More: [ARCHITECTURE.md](./ARCHITECTURE.md) · [docs/DECISIONS.md](./docs/DECISIONS.md) · [docs/POSITIONING.md](./docs/POSITIONING.md)

---

## Quick start

```bash
# Demo
open https://aurasys.vercel.app

# Local
docker compose up -d && npm install && npm run db:push && npm run dev
```

Load test: `npm run load-test -w apps/worker -- burst --jobs 20000 --concurrency 20`  
Deploy: [Free](./docs/DEPLOY_FREE.md) · [Render](./docs/DEPLOY_RENDER.md) · [VPS](./docs/DEPLOY_VPS.md)

---

## For interview depth

| Doc | Use |
|-----|-----|
| [BENCHMARKS.md](./docs/BENCHMARKS.md) | Claim ↔ evidence (exact numbers) |
| [INTERVIEW_GUIDE.md](./docs/INTERVIEW_GUIDE.md) | How to present Aura |
| [lease-protocol.md](./docs/lease-protocol.md) / [crash-recovery.md](./docs/crash-recovery.md) | Protocol deep-dives |
