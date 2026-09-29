# Aura Benchmarks & Claimed Numbers

This document separates **two different environments** so resume claims stay honest and interview-safe.

| Environment | Purpose | What you can claim |
|-------------|---------|-------------------|
| **A. Local / Docker load test** | Engineering proof of scale | Resume numbers (20k, ~300/min, P95, recovery) |
| **B. Free public demo** (Render + Neon + Render Redis) | Portfolio UI that stays online cheaply | Live traffic is **light by design** |

Never imply that [aurasys.vercel.app](https://aurasys.vercel.app) is currently processing 20,000 concurrent jobs. That number comes from **local** load testing.

---

## A. Resume / local benchmark claims

These match the project resume bullet and the load-test tooling in-repo.

### Claims

| Claim | Meaning | How to reproduce |
|-------|---------|------------------|
| **20,000+ concurrent tasks** | Burst enqueue of ≥20k jobs through the API while workers drain the Redis priority queues | `npm run load-test -w apps/worker -- burst --jobs 20000 --concurrency 20` (API + workers + Postgres + Redis running locally via `docker compose` + `npm run dev`) |
| **~300 jobs/min @ P95 ≈ 6.5s** | Sustained completion throughput with end-to-end queue-wait P95 around 6.5 seconds under that load profile | Same load-test harness; read **E2E latency P95** and throughput from the report (`tsx src/load-test.ts …`). Steady scenario: `--rps` / watch mode. |
| **~220–250 unit tests** | Vitest suites under `apps/worker/src/__tests__/` covering leases, idempotency, retry/DLQ, backpressure, scheduler lock, recovery, SLOs, etc. | `npm test -w apps/worker` — currently **~223** `it`/`test` cases (resume “250” is the rounded suite size as tests were added). |
| **6,000+ jobs recovered in &lt;2s** | After Redis queue state is wiped, reconciler restores `PENDING`/`PROCESSING` jobs from Postgres back into Redis | Covered by recovery paths in `docs/crash-recovery.md` + `PersistenceRecovery` tests; large-N validation via reconcile + synthetic scripts (`scripts/synthetic-load-test.ts`). |

### What “concurrent” means here

- Jobs sit in Redis sorted sets (`aura:queue:*`) and/or leases (`aura:leased`) while workers claim with `ZPOPMAX`.
- “20,000+ concurrent” = **in-flight queue depth / outstanding work**, not 20,000 Node threads.
- Postgres remains the durable source of truth; Redis is the execution plane.

### Hardware / setup assumptions (local)

- Node 18+
- Postgres 15 + Redis 7 via `docker compose`
- Multiple worker loops (`DEFAULT_WORKERS` / pools) — **not** a single free-tier container

If you re-run benchmarks, paste the load-test summary into `docs/benchmark-runs/` (date, machine, commit SHA, command, P50/P95/P99, throughput) so claims stay auditable.

---

## B. Live free-tier demo (current production)

| Item | Value |
|------|--------|
| Console | https://aurasys.vercel.app |
| API | https://aura-api-184s.onrender.com |
| Postgres | Neon free (`Aura` project) |
| Redis | Render Key Value **free** |
| Compute | **One** Render Free web service: API + embedded worker + scheduler |

### Live demo targets (intentional)

| Metric | Target on free demo |
|--------|---------------------|
| Auto job rate | ~1 job / 10–15s when generator is on (~4–6 jobs/min) |
| Workers | 1 loop, concurrency 3 |
| Queue cap | Low (`MAX_QUEUE_THRESHOLD≈200`) |
| Sleep | Render Free sleeps after ~15 min idle; first request can take 30–60s |

These limits exist so the site can stay **$0** and remain usable. They are **not** the resume scale numbers.

### How to keep the dashboard “alive” longer

1. Keep `JOB_GENERATOR_ENABLED=true` with a slow interval (see Render env).
2. Or periodically open the console / hit `/healthz` so the free service does not sleep as often.
3. For interview demos: open the site a minute early (wake), then enqueue 5–10 jobs live.

---

## Interview one-liner

> “The public demo runs on a free single-process host with light synthetic traffic so recruiters can click around. The resume throughput and recovery numbers come from local Docker load tests and Vitest suites documented in `docs/BENCHMARKS.md` — happy to walk through the lease/reconcile design that makes those numbers possible.”

---

## Related docs

- Architecture: [ARCHITECTURE.md](../ARCHITECTURE.md)
- Decisions: [DECISIONS.md](./DECISIONS.md)
- Interview deep-dive: [INTERVIEW_GUIDE.md](./INTERVIEW_GUIDE.md)
- Crash recovery: [crash-recovery.md](./crash-recovery.md)
- Free deploy: [DEPLOY_FREE.md](./DEPLOY_FREE.md)
