# Aura — Interview Guide (SWE)

Use this to explain the project clearly without over-claiming.  
**Numbers bible:** [BENCHMARKS.md](./BENCHMARKS.md) (every claim has an evidence grade).

---

## 30-second pitch

> Aura is a distributed job queue I built from scratch on Node, Redis, and Postgres. Redis runs priority queues and leases; Postgres is the durable source of truth. Workers claim with leases and an idempotency fence; a leader-elected scheduler reaps crashes and reconciles Redis from Postgres. On a local high-volume run the console showed about **304 completions/min** with **P95 queue wait around 7.5s**. The public demo is a free-tier, single-process deploy — scale numbers come from local evidence, not that free box.

---

## Numbers — what to say (defensible)

| If they ask… | Say… | Point at |
|--------------|------|----------|
| “Does the live site do 300/min?” | “No. Live is a free Render demo with light traffic. ~304/min is from a **local** console snapshot.” | `assets/system-overview.png` |
| “How do you know ~300/min / P95 ~7.5s?” | “Operator console: **303.72 jobs/min**, P95 **7.40s** (latency widget **7.60s**). Throughput × 60 matches the **18,223** completed card.” | [benchmark-runs/2026-console-dashboard.md](./benchmark-runs/2026-console-dashboard.md) |
| “Why did the resume say 6.5s?” | “I corrected to the screenshot: **~7.5s**. I don’t round down under pressure.” | Same |
| “20k concurrent?” | “Harness can burst **20k** enqueues; we exercised tens of thousands locally. That screenshot shows a **drained** queue (pending 0) after ~18k completions/hour — not 20k threads.” | `load-test.ts`, BENCHMARKS definitions |
| “224 vs 250 tests?” | “**224** Vitest cases in `apps/worker` as of this SHA — I count what `vitest run` reports.” | `npm test -w apps/worker` |
| “6000 jobs recovered in &lt;2s?” | “Case study log: `restored:6000, durationMs:1843`. Plus a vitest that restores 6000 orphans in under 2s in-memory.” | Phase 9 case study + `PersistenceRecovery.test.ts` |

Full matrix: [BENCHMARKS.md](./BENCHMARKS.md).

---

## Design deep-dives (pick 1–2)

1. **Why leases + fences?** Prevents double-complete when a slow worker finishes after reaping.  
2. **Why reconcile?** Redis is fast but ephemeral; Postgres saves you after flush.  
3. **Adaptive backpressure?** Threshold tracks drain rate so you don’t only use a static max depth.  
4. **SSE vs polling?** Push metrics/job updates; free-tier taught me to debounce invalidations.

---

## Failure story (strong interview answer)

> “We pointed the free demo at old Neon data with thousands of pending jobs. One free CPU tried to reap/process everything, the UI lagged, and health showed heavy load. We factory-reset queues, embedded the worker in the API for $0 hosting, and split ‘demo traffic’ from ‘benchmark claims’ so every resume number has an evidence pointer in `docs/BENCHMARKS.md`.”

---

## Repo map for quick navigation

| Path | Why it matters |
|------|----------------|
| `packages/redis/src/lua.ts` | Atomic claim / admission |
| `apps/worker/src/services/Worker.ts` | Claim → execute → complete |
| `apps/worker/src/services/Scheduler.ts` | Reap / promote / reconcile |
| `apps/worker/src/load-test.ts` | Benchmark harness |
| `apps/api/src/services/metricsSnapshot.ts` | Throughput + P95 formulas |
| `assets/*.png` | Resume metric screenshots |
| `docs/BENCHMARKS.md` | Evidence grades for every number |
| `docs/DECISIONS.md` | Why each major choice |

---

## Demo checklist (before a call)

1. Open https://aurasys.vercel.app (wait for Render wake if cold).  
2. Confirm System Health / workers look green.  
3. Enqueue 3–5 jobs live; watch Pending → Completed.  
4. If asked about scale: open BENCHMARKS / screenshots — never the free URL as proof of 300/min.
