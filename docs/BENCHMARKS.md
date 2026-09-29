# Aura Benchmarks — Defensible Numbers

**Rule:** Every public number has an evidence grade and a pointer. If you cannot point, do not claim.

Related: [benchmark-runs/](./benchmark-runs/) · [INTERVIEW_GUIDE.md](./INTERVIEW_GUIDE.md) · [DECISIONS.md](./DECISIONS.md) · [POSITIONING.md](./POSITIONING.md) (metric definitions + XYZ scaffolds)

---

## Two environments (never mix)

| | **A. Local / Docker (resume)** | **B. Free public demo** |
|--|--------------------------------|-------------------------|
| Purpose | Prove scale + recovery | Portfolio UI stays online cheaply |
| Where | Your machine + `docker compose` | [aurasys.vercel.app](https://aurasys.vercel.app) → [aura-api-184s.onrender.com](https://aura-api-184s.onrender.com) |
| Evidence | Screenshots, vitest, load-test harness | Live `/healthz`, light generator |

Never imply the free URL is processing tens of thousands of jobs.

---

## A. Resume numbers — claim sheet

Root [README.md](../README.md) is **recruiter-short**. This table is the canonical **1:1 claim ↔ evidence** match for interviews.

| Claim (say this) | Exact evidence | Grade | Interview note |
|------------------|----------------|-------|----------------|
| **303.72 jobs/min** (speech: ~304) | Throughput card — [`assets/system-overview.png`](../assets/system-overview.png), [write-up](./benchmark-runs/2026-console-dashboard.md) | **A** | Local proof; demo uses light traffic |
| **18,223** completions / hour | Completed card on same screenshot; `303.72 × 60` | **A** | Trailing-hour window |
| P95 **7.40s** / **7.60s** | `system-overview.png` + `job-activity.png` | **A** | Queue wait, not API RTT |
| In-flight at capture: Pending **0**, Processing **5** | Status cards on overview PNG | **A** | Drained snapshot |
| Dead letters **3,479** same hour | Dead Letters card on overview PNG | **A** | DLQ under failure injection |
| **20k** burst capability | `load-test.ts --jobs 20000` | **B** | Harness capacity |
| **6,000** restored in **1,843 ms** | Log `{ restored:6000, durationMs:1843 }` | **C** | Re-queue time |
| **6,000** orphans under **2s** in-memory | `PersistenceRecovery.test.ts` | **A** | Algorithm guard |
| **224** Vitest cases | `npm test -w apps/worker` → **224 passed** | **A** | Worker suite |
| Built from scratch in-repo | `Worker.ts`, `Scheduler.ts`, `lua.ts` | **A** | First-party primitives |
| Live console | [aurasys.vercel.app](https://aurasys.vercel.app) | **A** | Interactive UI |

### Preferred one-liner (interview-safe)

> “On a local high-volume run the console showed **303.72 completions/min**, P95 queue wait **7.40s** (widget **7.60s**), and **18,223** completions in that hour. A Redis-wipe case study restored **6,000** pending jobs in **1,843 ms**; the suite has **224** unit tests including a 6k restore timing guard. The public site is for UI walkthrough — scale evidence is local.”

---

## Definitions (so “concurrent” cannot trap you)

Full glossary (unit, window, formula, “not this”): [POSITIONING.md §3](./POSITIONING.md#3-metrics-glossary-crystal-clear).

| Phrase | Meaning in Aura |
|--------|-----------------|
| **Jobs/min (throughput)** | Completions in the last hour ÷ 60 (`metricsSnapshot`) |
| **P95 latency** | 95th percentile of **queue wait** (enqueue/scheduled → started), not API RTT |
| **In-flight / concurrent** | Jobs in Redis queues + leases + delayed — **not** OS threads |
| **20k exercised** | System ingested/processed on the order of tens of thousands of jobs in local testing; use load-test for a fresh burst |
| **Recovered** | Scheduler `reconcilePendingJobs` re-`ZADD`s Postgres `PENDING` jobs missing from Redis |

---

## How each number is produced in code

| Number | Code path |
|--------|-----------|
| Throughput jobs/min | `apps/api/src/services/metricsSnapshot.ts` — `zcount(aura:metrics:throughput, lastHour) / 60` |
| P95 latency | Same file — percentile over latency samples ZSET |
| Pulse jobs/sec | `apps/api/src/routes/metrics.ts` — 10s buckets; ×6 ≈ jobs/min |
| Reconcile duration | `Scheduler.reconcilePendingJobs` logs `{ restored, skipped, durationMs }` |
| Load-test P50/P95/P99 | `apps/worker/src/load-test.ts` — `summariseLatencies` |

---

## Reproducing load / recovery

```bash
# Worker unit tests (includes 6k in-memory reconcile timing)
npm test -w apps/worker

# Burst load (needs local API + Redis + Postgres + workers)
npm run load-test -w apps/worker -- burst --jobs 20000 --concurrency 20 --json
# Save output under docs/benchmark-runs/ (see README there)
```

Recovery against **real** Redis/Postgres: wipe Redis queues while Postgres still has `PENDING` rows, restart scheduler, read `Reconciliation complete` log / `aura:health:scheduler:reconcile` hash.

---

## B. Live free-tier demo (intentional small numbers)

| Metric | Target | Why |
|--------|--------|-----|
| Auto job rate | ~1 job / 10–15s (~4–6/min) when generator on | Survive Render Free sleep + 1 CPU |
| Workers | 1 loop, concurrency 3 | Embedded worker in API process |
| Queue cap | `MAX_QUEUE_THRESHOLD≈200` | Avoid free-tier meltdown |
| Cold start | 30–60s after ~15 min idle | Render Free behavior |

These are **ops targets**, not resume scale claims.

---

## Changelog of claim corrections

| Date | Change | Why |
|------|--------|-----|
| 2026-09-29 | Prefer **P95 ≈ 7.4–7.6s** over resume “~6.5s” | Screenshots are the A-grade evidence |
| 2026-09-29 | Prefer **~304 jobs/min** / **18,223 / hour** | Same screenshot; formula-consistent |
| 2026-09-29 | Tests = **224** (not “250”) | `vitest run` count this SHA |
| 2026-09-29 | Split 20k “exercised/burst” vs “concurrent in-flight on screenshot” | Screenshot shows drained queue |
| 2026-09-29 | Recovery: cite log **1843ms** + vitest 6k guard | Dual evidence |
