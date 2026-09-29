# Aura — Interview Guide (SWE)

Use this to explain the project clearly without over-claiming.

---

## 30-second pitch

> Aura is a distributed job queue I built from scratch on Node, Redis, and Postgres. Redis runs priority queues and leases; Postgres is the durable source of truth. Workers claim with leases and an idempotency fence; a leader-elected scheduler reaps crashes and reconciles Redis from Postgres. I load-tested it locally to ~20k in-flight jobs and ~300 completions/min. The public demo is a free-tier, single-process deploy so recruiters can click the UI — scale numbers come from local benchmarks, not that free box.

---

## Numbers — what to say

| If they ask… | Say… |
|--------------|------|
| “Does the live site do 20k jobs?” | “No. Live is a free Render demo with light traffic. 20k was a **local** burst load test.” |
| “How do you know 300/min / P95 6.5s?” | “From the `load-test` harness in `apps/worker` — E2E latency percentiles while workers drain.” |
| “250 tests?” | “Vitest under `apps/worker/src/__tests__` — ~223 cases covering leases, fences, DLQ, backpressure, recovery, SLOs.” |
| “6000 jobs recovered in &lt;2s?” | “Reconciler rebuilds Redis queues from Postgres `PENDING`/`PROCESSING` after Redis loss; validated in recovery tests / scripts.” |

Full detail: [BENCHMARKS.md](./BENCHMARKS.md)

---

## Design deep-dives (pick 1–2)

1. **Why leases + fences?** Prevents double-complete when a slow worker finishes after reaping.  
2. **Why reconcile?** Redis is fast but ephemeral; Postgres saves you after flush.  
3. **Adaptive backpressure?** Threshold tracks drain rate so you don’t only use a static max depth.  
4. **SSE vs polling?** Push metrics/job updates; free-tier taught me to debounce invalidations.

---

## Failure story (strong interview answer)

> “We pointed the free demo at old Neon data with thousands of pending jobs. One free CPU tried to reap/process everything, the UI lagged, and health showed heavy load. We factory-reset queues, embedded the worker in the API for $0 hosting, and split ‘demo traffic’ from ‘benchmark claims’ in the docs so the resume stays accurate.”

---

## Repo map for quick navigation

| Path | Why it matters |
|------|----------------|
| `packages/redis/src/lua.ts` | Atomic claim / admission |
| `apps/worker/src/services/Worker.ts` | Claim → execute → complete |
| `apps/worker/src/services/Scheduler.ts` | Reap / promote / reconcile |
| `apps/worker/src/load-test.ts` | Benchmark harness |
| `apps/api/src/routes/jobs.ts` | Enqueue + backpressure |
| `docs/DECISIONS.md` | Why each major choice |

---

## Demo checklist (before a call)

1. Open https://aurasys.vercel.app (wait for Render wake if cold).  
2. Confirm System Health / workers look green.  
3. Enqueue 3–5 jobs live; watch Pending → Completed.  
4. If asked about scale: switch to explaining local load-test + architecture, not the free URL.
