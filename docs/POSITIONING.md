# Aura — Positioning, Metrics Glossary & XYZ Scaffold

**Purpose:** Make it obvious what Aura is, what is different about it, and how every metric is defined — so you can later write resume lines yourself using Google’s **XYZ** formula.

**This file is not a resume.** It is raw material. Do not paste sections below into LinkedIn/GitHub “Achievements” without rewriting.

Related: [BENCHMARKS.md](./BENCHMARKS.md) (evidence grades) · [DECISIONS.md](./DECISIONS.md) · [INTERVIEW_GUIDE.md](./INTERVIEW_GUIDE.md)

---

## 1. One-sentence product definition

**Aura is a from-scratch distributed job queue:** an HTTP API admits work, Redis holds priority queues and leases, Postgres is the durable source of truth, workers claim and execute under leases + idempotency fences, and a leader-elected scheduler reaps crashes, promotes delayed retries, evaluates SLOs, and reconciles Redis from Postgres after data loss — with an operator console for live metrics.

### What it is / is not

| Aura **is** | Aura is **not** |
|-------------|-----------------|
| A learning / portfolio systems project that owns queue semantics end-to-end | A SaaS product competing with AWS SQS |
| Hybrid Redis (execution) + Postgres (durability) | “Just Redis lists” or “just Postgres `SKIP LOCKED`” alone |
| At-least-once delivery with explicit crash domains | Exactly-once distributed transactions |
| Local/Docker for scale proof; free Render for clickable demo | Proof that free hosting = resume throughput |
| Operator console + SSE observability | A full multi-tenant control plane |

---

## 2. What is different (the “so what”)

Interviewers have seen BullMQ wrappers. Lead with **owned semantics**, not “I used Redis.”

### Differentiation map

| Dimension | Common approach | What Aura does differently | Why it matters |
|-----------|-----------------|----------------------------|----------------|
| Persistence | Queue library persists in Redis only, or DB polling only | **Postgres = truth, Redis = hot path**; reconcile rebuilds Redis after wipe | Survive Redis flush without losing PENDING work |
| Concurrency | Simple lock or visibility timeout | **Lease TTL in `aura:leased` + execution fence** (`SET NX`) + Postgres `updateMany` status guard | Slow worker after reap cannot double-complete |
| Leadership | Single scheduler process assumed | **Redis `SET NX EX` lock**; any worker can become scheduler | No single-process SPOF for promote/reap |
| Admission | Static max queue depth | **Lua admission gate + adaptive threshold** from recent drain rate | Reject overload before Redis/Postgres melt |
| Priority | One queue + score | **Three queues + pool-specific poll order** with anti-starvation | Urgent work jumps; low work still drains |
| Retry | Immediate re-queue or sleep in worker | **Delayed ZSET + exponential backoff + DLQ** | Failures don’t busy-loop workers |
| Observability | Logs only | **Metrics snapshot, P50/P95/P99, SSE, SLO evaluator** | You can defend latency/throughput with the same formulas the UI uses |
| Proof | “It works on my machine” | **Vitest correctness suite + load harness + screenshot evidence grades** | Numbers are auditable ([BENCHMARKS.md](./BENCHMARKS.md)) |

### Contrast lines (speak these; don’t ship as resume bullets yet)

- vs **BullMQ / Agenda:** You didn’t configure a library — you implemented claim, lease, fence, reconcile, and backpressure yourself and can walk the code.
- vs **Postgres-only `FOR UPDATE SKIP LOCKED`:** Works, but Aura’s Redis claim path is the performance/learning target under large in-flight sets; Postgres still wins on durability.
- vs **Kafka / Temporal:** Different problem class (event log / workflow orchestration). Aura is a **job queue** with leases and DLQ, not a workflow engine.
- vs **CRUD portfolio app:** Failure domains (worker crash, scheduler crash, Redis wipe) are first-class, not afterthoughts.

---

## 3. Metrics glossary (crystal clear)

Every metric has: **definition**, **unit**, **window**, **where computed**, **what it does *not* mean**.

### Throughput

| | |
|--|--|
| **Name** | Completions per minute |
| **Definition** | Count of jobs that reached a successful completion event in the trailing window, divided by minutes in that window |
| **Unit** | jobs/min |
| **Window** | Last **60 minutes** (dashboard “Throughput” card) |
| **Formula** | `completed_in_last_hour / 60` |
| **Code** | `apps/api/src/services/metricsSnapshot.ts` (`aura:metrics:throughput` ZSET) |
| **Evidence example** | **303.72 jobs/min** → implies ~**18,223** completions/hour (same snapshot) |
| **Not** | Enqueue rate, API RPS, free-demo generator rate, or “concurrent workers” |

### Pulse / jobs per second (chart)

| | |
|--|--|
| **Name** | Pulse line (Completed / Failed / Scheduled) |
| **Definition** | Counts in short buckets (≈10s), displayed as jobs/sec |
| **Unit** | jobs/sec on the chart |
| **Relationship** | Roughly `jobs/sec × 60 ≈ jobs/min` for a stable series |
| **Code** | `apps/api/src/routes/metrics.ts` pulse buckets |
| **Not** | A substitute for the 1h throughput card without converting units |

### P95 latency (queue wait)

| | |
|--|--|
| **Name** | P95 queue wait / job latency |
| **Definition** | 95th percentile of time from **scheduled/enqueued** until **worker start** (queue wait), across recent samples |
| **Unit** | seconds (UI) / ms (internal samples) |
| **Window** | Recent latency sample ZSET (same metrics plane as overview) |
| **Code** | `metricsSnapshot` percentile helpers; SLO uses warn/crit thresholds (~5s / ~10s) |
| **Evidence example** | **7.40s** overview card; **7.60s** latency widget |
| **Not** | HTTP request latency, DB query time, or end-to-end including handler CPU unless samples encode that |

### Completions (card)

| | |
|--|--|
| **Name** | Completed (trailing hour) |
| **Definition** | Number of jobs completed in the last hour |
| **Consistency check** | Should ≈ `throughput_jobs_per_min × 60` |
| **Evidence example** | **18,223** ↔ **303.72 × 60** |

### In-flight / “concurrent”

| | |
|--|--|
| **Name** | In-flight work |
| **Definition** | Jobs currently in Redis **queues + delayed + leased** (and optionally Postgres `PENDING`/`PROCESSING` not yet reflected) |
| **Unit** | job count |
| **Not** | OS threads, Node cluster size, or “Completed” card (that is historical completions) |

### Recovery time

| | |
|--|--|
| **Name** | Reconcile duration |
| **Definition** | Wall time for scheduler to restore orphaned Postgres `PENDING` jobs into Redis after they were missing from queues |
| **Unit** | milliseconds |
| **Log shape** | `{ restored, skipped, durationMs }` from `Scheduler.reconcilePendingJobs` |
| **Evidence** | Case study: restored **6000**, **durationMs 1843**; vitest: 6000 in-memory &lt; 2s |
| **Not** | Time to re-process/execute those jobs — only time to **re-queue** them |

### Test count

| | |
|--|--|
| **Name** | Worker Vitest cases |
| **Definition** | Number of `it`/`test` cases under `apps/worker/src/__tests__` that pass in `npm test -w apps/worker` |
| **Current** | **224** (re-count after adding tests) |
| **Not** | Line coverage %, or “250” as a rounded brand number |

### Live demo metrics (separate universe)

| Metric | Typical free-demo value | Definition |
|--------|-------------------------|------------|
| Generator rate | ~1 job / 10–15s | Synthetic enqueue interval on Render |
| Workers | 1 loop × concurrency 3 | Embedded worker process |
| Cold start | 30–60s | Render Free sleep wake |

**Never** mix demo rates into XYZ “Y” measurements for scale.

---

## 4. Google XYZ formula (how to use this later)

Google’s resume guidance (paraphrased):

> **Accomplished [X] as measured by [Y], by doing [Z].**

| Letter | Meaning | Aura rule |
|--------|---------|-----------|
| **X** | Outcome / impact | Reliability, scale exercised, observability, correctness — not “learned Redis” |
| **Y** | Metric with unit + evidence | Only numbers graded A/B/C in [BENCHMARKS.md](./BENCHMARKS.md) |
| **Z** | What you built or did | Own mechanism: leases, fence, reconcile, adaptive BP, etc. |

### Template (fill when writing the resume — leave blank here)

```
Accomplished ____________________ (X)
as measured by __________________ (Y: number + unit + window)
by ______________________________ (Z: mechanism you implemented).
Evidence pointer: _______________
```

### Anti-patterns

- Y without unit or window (“improved performance a lot”)
- Y from free demo while Z describes local architecture
- Z that is only “used Redis and Postgres”
- X that claims “production at company scale” for a portfolio deploy

---

## 5. XYZ scaffolds (raw material — not resume bullets)

Fill these into real resume lines later. Each block is a **worksheet**, not a polished bullet.

### Scaffold A — Durability after Redis loss

| | |
|--|--|
| **X (outcome)** | Jobs not permanently orphaned when Redis queue state is wiped |
| **Y (measure)** | Restored **6,000** `PENDING` jobs in **1,843 ms** (case-study log); vitest restores 6,000 orphans &lt; 2s in-memory |
| **Z (how)** | Leader-elected scheduler `reconcilePendingJobs`: page Postgres PENDING, skip if already in any Redis structure, pipeline `ZADD`+`HSET` meta |
| **Evidence** | Phase 9 failure case study; `PersistenceRecovery.test.ts`; `Scheduler.ts` |
| **Differentiation hook** | Redis-only queues would lose work; Aura rebuilds execution plane from Postgres |

### Scaffold B — Throughput under load (local)

| | |
|--|--|
| **X (outcome)** | Sustained completion throughput under a high-volume local run |
| **Y (measure)** | **~304 jobs/min** (303.72), **~18,223** completions in 1h, same console snapshot |
| **Z (how)** | Redis priority queues + multi-worker claim (`ZPOPMAX` + leases) + metrics throughput ZSET driving the console |
| **Evidence** | `assets/system-overview.png`; [benchmark-runs/2026-console-dashboard.md](./benchmark-runs/2026-console-dashboard.md) |
| **Differentiation hook** | Metric is **completions/min** from trailing hour — not enqueue RPS from a load script banner |

### Scaffold C — Latency visibility / SLO awareness

| | |
|--|--|
| **X (outcome)** | Queue-wait latency is measurable and alertable, not guessed |
| **Y (measure)** | P95 queue wait **≈7.4–7.6s** on snapshot; SLO warn/crit thresholds **5s / 10s** in code |
| **Z (how)** | Latency sample ZSET + percentile helpers + `SloEvaluator` + operator console cards/SSE |
| **Evidence** | `system-overview.png`, `job-activity.png`; `SloEvaluator.ts` |
| **Differentiation hook** | You can explain P95 definition and why 7.5s exceeded warn but informed worker scaling talk |

### Scaffold D — Crash-safe completion

| | |
|--|--|
| **X (outcome)** | At-least-once execution without silent double-complete under reap races |
| **Y (measure)** | Covered by Vitest fence/lifecycle cases (suite **224** tests total; subset is fence/reap) — qualitative correctness, not a % “bug reduction” |
| **Z (how)** | Lease TTL + reaper; `aura:executing:<id>` fence; Postgres status-conditioned updates |
| **Evidence** | `Idempotency.test.ts`, `Worker.test.ts`, `JobLifecycle.test.ts`, [lease-protocol.md](./lease-protocol.md) |
| **Differentiation hook** | Visibility timeout alone is weaker than fence + DB guard combo you can diagram |

### Scaffold E — Overload protection

| | |
|--|--|
| **X (outcome)** | API refuses work when the system cannot drain, instead of unbounded queue growth |
| **Y (measure)** | Behavioral: HTTP **429** when Lua/adaptive gate rejects; design queue thresholds (e.g. free demo ~200) — use measured 429 counts from a specific run if you archive one |
| **Z (how)** | Redis Lua admission + `AdaptiveThreshold` from recent throughput |
| **Evidence** | `packages/redis/src/lua.ts`, `AdaptiveThreshold.ts`, backpressure tests |
| **Differentiation hook** | Static max depth alone ignores drain rate; adaptive uses completions history |

### Scaffold F — Priority without starvation

| | |
|--|--|
| **X (outcome)** | High-priority work preferred while low-priority still completes |
| **Y (measure)** | Unit-test proofs of poll order / anti-starvation cadence (not a production % SLA unless measured) |
| **Z (how)** | Separate high/default/low ZSETs + pool-specific `getQueueOrder` |
| **Evidence** | `PriorityQueue.test.ts` |
| **Differentiation hook** | Single sorted set can starve lows; pools encode fairness policy |

### Scaffold G — Operability

| | |
|--|--|
| **X (outcome)** | Operators see live queue health without SSH/log diving |
| **Y (measure)** | Console shows throughput, P95, depths, worker health via SSE (demo = qualitative; local snapshot = quantitative) |
| **Z (how)** | Express metrics/SSE + React Query console + debounce under free-tier |
| **Evidence** | Operator console; `assets/*.png`; free-tier broadcast decisions in DECISIONS |
| **Differentiation hook** | Queue without a console is harder to defend in demos |

---

## 6. Suggested story order (when you later write the resume)

1. **What you built** (one line product definition from §1).  
2. **Hardest reliability problem** (Scaffold A or D).  
3. **Measured scale** (Scaffold B + C) with evidence grades.  
4. **Admission / priority** (E / F) if space.  
5. **Do not** list free Render sleep times as achievements.

When drafting bullets later: one scaffold → one XYZ sentence → one evidence link in interview notes (not on the resume).

---

## 7. Quick link map

| Need | Doc |
|------|-----|
| Can I claim this number? | [BENCHMARKS.md](./BENCHMARKS.md) |
| Why was this designed this way? | [DECISIONS.md](./DECISIONS.md) |
| How do I say it in an interview? | [INTERVIEW_GUIDE.md](./INTERVIEW_GUIDE.md) |
| Where is the code path? | [PROJECT_TRACE.md](./PROJECT_TRACE.md) |
