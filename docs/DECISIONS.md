# Aura — Complete Engineering Decisions Catalog

**Purpose:** Every meaningful product and engineering decision in this repository, written so you can explain the system in SWE interviews without mixing up environments or inventing rationale.

**How to use**
- Skim the **index** for the topic you need.
- Each entry has: **Context → Decision → Why → Alternatives → Tradeoffs → Evidence** (code / tests / docs / commit when known).
- Status: `DECIDED` shipped · `SUPERSEDED` replaced later · `DEMO` free-tier only · `OPS` deploy/infra

**Related**
- [BENCHMARKS.md](./BENCHMARKS.md) — resume numbers vs live demo  
- [POSITIONING.md](./POSITIONING.md) — product definition, differentiation, metric glossary, XYZ scaffolds  
- [INTERVIEW_GUIDE.md](./INTERVIEW_GUIDE.md) — how to talk about claims  
- [PROJECT_TRACE.md](./PROJECT_TRACE.md) — structural backtrace  
- [ARCHITECTURE.md](../ARCHITECTURE.md) — component diagram  

---

## Index

| ID | Topic |
|----|--------|
| [P0](#p0-project-intent) | Why build Aura at all |
| [P1](#p1-core-data-plane) | Postgres + Redis hybrid |
| [P2](#p2-queue-model) | Priority queues & pool ordering |
| [P3](#p3-leases--fences) | Leases + idempotency fences |
| [P4](#p4-scheduler) | Leader election & loops |
| [P5](#p5-retry--dlq) | Backoff, reaping, dead letters |
| [P6](#p6-admission--backpressure) | Rate limits & adaptive threshold |
| [P7](#p7-recovery) | Reconcile, orphans, stale PROCESSING |
| [P8](#p8-api--contracts) | HTTP shape, Zod, pagination |
| [P9](#p9-observability) | Metrics, SSE, logging, SLOs |
| [P10](#p10-console-ui) | Operator console choices |
| [P11](#p11-testing--load) | Vitest, chaos, load-test harness |
| [P12](#p12-repo--tooling) | Monorepo, tsx, Prisma |
| [P13](#p13-deployment-evolution) | Railway → Vercel → Render free |
| [P14](#p14-demo-vs-benchmark-honesty) | Two-number-system documentation |

---

## P0. Project intent

### D-P0-01 — Build a job queue from first principles (`DECIDED`)

| | |
|--|--|
| **Context** | SWE portfolio needs a systems project deeper than a CRUD app. |
| **Decision** | Implement a distributed job queue (API + workers + scheduler + console) instead of wrapping Bull/BullMQ. |
| **Why** | Own the lease, fence, reconcile, and backpressure semantics so interviews can go deep. |
| **Alternatives** | BullMQ, Agenda, Temporal, Kafka consumers. |
| **Tradeoffs** | More code to maintain; reinventing solved infra; must document carefully. |
| **Evidence** | Whole repo; resume bullet “Aura – Distributed Job Queue”. |

### D-P0-02 — At-least-once delivery (`DECIDED`)

| | |
|--|--|
| **Context** | Exactly-once is extremely hard across crash domains. |
| **Decision** | Guarantee **at-least-once** execution; handlers must be idempotent. |
| **Why** | Leases + reaping can re-deliver after crash; fence prevents *double commit*, not double *attempt*. |
| **Tradeoffs** | Side-effectful jobs need their own idempotency keys. |
| **Evidence** | [crash-recovery.md](./crash-recovery.md), fence in `Worker` complete path. |

---

## P1. Core data plane

### D-P1-01 — Hybrid Postgres + Redis (`DECIDED`)

| | |
|--|--|
| **Context** | Need durability under crash *and* high-contention claim. |
| **Decision** | Postgres = durable job rows / events / workers; Redis = queues, leases, delay, locks, hot metrics. |
| **Why** | Row-locking Postgres queues contend badly; Redis `ZPOPMAX` is O(log N) and atomic. Redis alone loses data on flush. |
| **Alternatives** | Postgres `SKIP LOCKED` only; Redis-only with AOF; Kafka. |
| **Tradeoffs** | Dual-write complexity; requires reconciler. |
| **Evidence** | [redis-postgres-interaction.md](./redis-postgres-interaction.md), Prisma `Job` model, `packages/redis`. |

### D-P1-02 — Write Postgres before Redis on enqueue (`DECIDED`)

| | |
|--|--|
| **Context** | If Redis write succeeds and Postgres fails, you have undurable work. |
| **Decision** | Insert/commit job in Postgres as `PENDING`, then `ZADD` to Redis. |
| **Why** | Worst case: durable row without Redis entry → reconciler restores. Opposite order can lose the job. |
| **Tradeoffs** | Brief window where Postgres has work Redis doesn’t yet see. |
| **Evidence** | API enqueue path in `apps/api` queue service / jobs route. |

### D-P1-03 — Job status enum in Postgres (`DECIDED`)

| | |
|--|--|
| **Decision** | Statuses: `DELAYED`, `PENDING`, `PROCESSING`, `COMPLETED`, `FAILED`, `DEAD_LETTER`. |
| **Why** | Separates “waiting for time”, “ready”, “leased”, terminals, and ops-held poison. |
| **Evidence** | `packages/database/prisma/schema.prisma`. |

### D-P1-04 — Client `idempotencyKey` on create (`DECIDED`)

| | |
|--|--|
| **Decision** | Unique `idempotencyKey` per job at enqueue. |
| **Why** | Safe client retries on network failure without duplicate business jobs. |
| **Evidence** | Prisma `@unique`, Zod `CreateJobSchema`. |

---

## P2. Queue model

### D-P2-01 — Three priority queues as Redis ZSETs (`DECIDED`)

| | |
|--|--|
| **Decision** | `aura:queue:high`, `aura:queue:default`, `aura:queue:low` with score = priority. |
| **Why** | Simple multi-lane priority without a single huge ZSET scan. |
| **Evidence** | `Worker.ts` `QUEUE_KEYS`, Lua claim scripts. |

### D-P2-02 — Worker pools with anti-starvation order (`DECIDED`)

| | |
|--|--|
| **Decision** | Pools `high-priority` / `default` / `low-priority` with `getQueueOrder(pool, claimMisses)` that periodically peeks lower/higher lanes. |
| **Why** | Pure high-only workers starve low; pure fair share ignores urgency. Miss-counter includes low/high every N misses. |
| **Evidence** | Exported `getQueueOrder`; `PriorityQueue.test.ts`. Commit `90e1694`. |

### D-P2-03 — Delayed queue as ZSET by ready-time (`DECIDED`)

| | |
|--|--|
| **Decision** | `aura:delayed` score = unix ms when job may run. |
| **Why** | Same structure as leases; promoter uses `ZRANGEBYSCORE`. |
| **Evidence** | Lua `PROMOTE_JOBS`, [retry-dlq.md](./retry-dlq.md). |

---

## P3. Leases & fences

### D-P3-01 — Visibility lease on claim (`DECIDED`)

| | |
|--|--|
| **Decision** | Atomic Lua: `ZPOPMAX` queue → `ZADD aura:leased` with score `now + 30_000`. |
| **Why** | Crash mid-job auto-expires; reaper requeues. Classic visibility timeout. |
| **Tradeoffs** | Long jobs need renewals or longer TTL. |
| **Evidence** | `SCRIPTS.CLAIM_JOB`, `LEASE_MS = 30000`, [lease-protocol.md](./lease-protocol.md). |

### D-P3-02 — Execution fence before durable complete (`DECIDED`)

| | |
|--|--|
| **Context** | Slow worker finishes after lease reaped → second worker also ran → both try to complete. |
| **Decision** | Before Postgres complete, `SET NX` fence `aura:executing:<jobId>` owned by worker id; abort if not owner. |
| **Why** | Separates “who may commit” from “who held the lease historically.” |
| **Evidence** | Commit `1b88731`; `Idempotency.test.ts`; worker complete path. |

### D-P3-03 — Fence acquisition ordering fix (`DECIDED`)

| | |
|--|--|
| **Context** | Race: late worker could commit after fence lost if order wrong. |
| **Decision** | Acquire fence **before** Postgres completion transaction (bootstrap/idempotency race fix). |
| **Evidence** | Commit `65d1ec3`. |

---

## P4. Scheduler

### D-P4-01 — Decentralized scheduler via Redis lock (`DECIDED`)

| | |
|--|--|
| **Context** | Earlier approaches could leave scheduler disabled / misconfigured. |
| **Decision** | Every worker competes for `aura:scheduler:lock` (`SET NX EX` ~15s); winner runs Scheduler; renew until loss. |
| **Why** | No `SCHEDULER_ENABLED` footgun; automatic failover. |
| **Evidence** | Commit `dcad939`; `SchedulerLock.ts`; [scheduler-lifecycle.md](./scheduler-lifecycle.md). |

### D-P4-02 — Scheduler watchdog restart (`DECIDED`)

| | |
|--|--|
| **Decision** | Wrap scheduler loop in `watchdog()` that restarts after crash instead of dying silently. |
| **Why** | Uncaught error in loop would freeze reap/reconcile. |
| **Evidence** | Commit `2c47c9e`; `Scheduler.watchdog`. |

### D-P4-03 — Scheduler loops (`DECIDED`)

| Loop | Responsibility |
|------|----------------|
| Reaper | Expired `aura:leased` → delayed backoff or DLQ |
| Promoter | Ready `aura:delayed` → active queues |
| Reconciler | Postgres PENDING/PROCESSING missing from Redis → restore |
| Orphan / stale PROCESSING sweep | Postgres PROCESSING without lease & stale heartbeat |
| SLO evaluator | Breach detection + pub/sub alerts |

**Evidence:** `Scheduler.ts`, Phase 5–8 commits.

---

## P5. Retry & DLQ

### D-P5-01 — Reap goes through delayed backoff, not instant requeue (`DECIDED`)

| | |
|--|--|
| **Context** | Mass worker crash / deploy would stampede the active queues. |
| **Decision** | `REAP_JOBS` Lua sends retryable jobs to `aura:delayed` with exponential backoff + jitter, not straight back to active. |
| **Formula** | `backoffMs = min(2^(attempts-1) * 5000, 300000) + jitter` |
| **Evidence** | Comment in `lua.ts` REAP_JOBS; commit `86c4018`; [retry-dlq.md](./retry-dlq.md). |

### D-P5-02 — Dead letter after maxAttempts (`DECIDED`)

| | |
|--|--|
| **Decision** | Exceed `maxAttempts` (default 3) → Postgres `DEAD_LETTER`, remove from Redis; manual replay/discard via API. |
| **Why** | Poison pills must stop consuming capacity. |
| **Evidence** | DLQ routes, `RetryDlq.test.ts`. |

---

## P6. Admission & backpressure

### D-P6-01 — Lua admission gate (`DECIDED`)

| | |
|--|--|
| **Decision** | Custom Redis command `admissionGate` decides ACCEPT / REJECT_RATE / REJECT_QUEUE using depth, reservations, and per-second rate key. |
| **Why** | Atomic multi-key check; single source of truth across API replicas. |
| **Evidence** | Commit `eaec31b`; `packages/redis` ADMISSION_GATE; `jobs.ts`. |

### D-P6-02 — Persist backpressure counters in Redis (`DECIDED`)

| | |
|--|--|
| **Decision** | `aura:metrics:bp:accepted` / `rejected` in Redis, not process memory. |
| **Why** | Survive restarts; visible across replicas. |
| **Evidence** | Commit `eaec31b`. |

### D-P6-03 — Adaptive threshold from drain rate (`DECIDED`)

| | |
|--|--|
| **Context** | Static `MAX_QUEUE_THRESHOLD` is either too strict or too loose. |
| **Decision** | `AdaptiveThreshold` raises/lowers effective cap from recent completions / window (with floor/ceiling). |
| **Evidence** | Commit `208056f`; `AdaptiveThreshold.ts` + tests. |

---

## P7. Recovery

### D-P7-01 — Bounded reconcile with skip-if-present (`DECIDED`)

| | |
|--|--|
| **Decision** | `reconcilePendingJobs` pages Postgres (`RECONCILE_BATCH_SIZE` default 1000), skips IDs already in any Redis structure, pipelines restores. |
| **Why** | Unbounded load on free/restart; avoid duplicate ZADDs. |
| **Evidence** | Commit `48c326c`; `Scheduler.reconcilePendingJobs`. |

### D-P7-02 — Stale PROCESSING threshold > lease TTL (`DECIDED`)

| | |
|--|--|
| **Decision** | `STALE_PROCESSING_THRESHOLD_MS = 45_000` (> `LEASE_MS` 30s). |
| **Why** | Don’t race live lease renewals; catch “Postgres PROCESSING but Redis lost lease.” |
| **Evidence** | Comment in `Scheduler.ts`. |

### D-P7-03 — Crash-domain specific recovery (`DECIDED`)

Documented in [crash-recovery.md](./crash-recovery.md): worker crash → reap; scheduler crash → lock TTL; Redis loss → reconcile.

---

## P8. API & contracts

### D-P8-01 — Express + Zod validation (`DECIDED`)

| | |
|--|--|
| **Decision** | Express routes; Zod for create-job body (`idempotencyKey`, `name`, `payload`, optional priority/queue/schedule). |
| **Evidence** | `apps/api/src/routes/jobs.ts`. |

### D-P8-02 — Cursor pagination helper (`DECIDED`)

| | |
|--|--|
| **Decision** | Shared pagination helper for list endpoints. |
| **Tradeoffs** | README notes `createdAt` cursor may be unindexed at scale. |
| **Evidence** | Commit `fe91dce`; `utils/pagination`. |

### D-P8-03 — Simplify QueueService to functions (`DECIDED`)

| | |
|--|--|
| **Decision** | Prefer exported functions over a heavy class wrapper. |
| **Why** | Less indirection for a small API surface. |
| **Evidence** | Commit `fe91dce`. |

### D-P8-04 — CORS open for demo console (`DECIDED` / `DEMO`)

| | |
|--|--|
| **Decision** | `app.use(cors())` permissive for Vercel origin demos. |
| **Tradeoffs** | Not production-hardening; tighten if Aura becomes a real multi-tenant product. |

### D-P8-05 — `/healthz` vs `/system/health` (`DECIDED`)

| | |
|--|--|
| **Decision** | `/healthz` = liveness (no deps); `/system/health` = deep checks (Postgres, Redis, workers, SLOs). |
| **Why** | Orchestrators need a cheap probe that doesn’t fail when DB is briefly waking. |

### D-P8-06 — Token-gated factory reset (`DEMO`)

| | |
|--|--|
| **Decision** | `POST /debug/factory-reset` with `X-Reset-Token` clears jobs/workers and `aura:*` keys. |
| **Why** | Free-tier recovery from toxic Neon backlog without shell access to Redis. |
| **Evidence** | Commit `38c0199`. |

---

## P9. Observability

### D-P9-01 — Real metrics from Redis + Postgres (`DECIDED`)

| | |
|--|--|
| **Context** | Early UI had placeholders. |
| **Decision** | Dashboard cards driven by `metricsSnapshot` (queue depths, latency percentiles, throughput ZSET, state hash). |
| **Evidence** | Commits `7a4644d`, `437a844` (remove fake UI). |

### D-P9-02 — P50 / P95 / P99 latency (`DECIDED`)

| | |
|--|--|
| **Decision** | Compute percentiles from recent completed jobs’ queue-wait (`startedAt - scheduledFor`). |
| **Evidence** | `metricsSnapshot.ts`; load-test summarizer. |

### D-P9-03 — SSE event bridge (`DECIDED`)

| | |
|--|--|
| **Decision** | Workers publish Redis pub/sub `aura:events`; API subscribes and fans out SSE; also poll Postgres for recent updates. |
| **Why** | Console feels live without hammering REST. |
| **Tradeoffs** | Free tier + invalidate storms → later debounce (D-P10-03). |

### D-P9-04 — Structured JSON logging (`DECIDED`)

| | |
|--|--|
| **Decision** | `LOG_FORMAT=json` or `NODE_ENV=production` → JSON logs via `Logger`. |
| **Evidence** | Commit `4a58920`; `Logger.ts`. |

### D-P9-05 — SLO evaluator + alerts channel (`DECIDED`)

| | |
|--|--|
| **Decision** | Periodic SLO checks (latency, DLQ rate, drain rate, scheduler lag); publish breaches on `aura:alerts` / health snapshot. |
| **Evidence** | Commit `7c2ec2b`; `SloEvaluator.ts`. |

### D-P9-06 — Chaos / failure injection (`DECIDED`)

| | |
|--|--|
| **Decision** | `FAILURE_MODE` / payload `shouldFail` for controlled failure floods in load tests. |
| **Evidence** | Commit `54ecfe7`; failure-flood load-test scenario. |

---

## P10. Console UI

### D-P10-01 — Vite + React + TanStack Query (`DECIDED`)

| | |
|--|--|
| **Decision** | SPA operator console separate from API. |
| **Why** | Fast iteration; static host on Vercel. |

### D-P10-02 — Remove placeholder / fake metrics (`DECIDED`)

| | |
|--|--|
| **Decision** | Strip mock toggles and rely on SSE + real APIs. |
| **Evidence** | Commit `437a844`. |

### D-P10-03 — Debounce SSE-driven invalidations (`DECIDED` / `DEMO`)

| | |
|--|--|
| **Context** | Free Render CPU + invalidate pulse/workers on every metrics tick → UI lag. |
| **Decision** | `setQueryData` for metrics/jobs; debounce pulse (2.5s) and workers (5s) invalidations. |
| **Evidence** | Commit `5c41315`; `AuraContext.tsx`. |

### D-P10-04 — Production API base URL strategy (`DECIDED`)

| | |
|--|--|
| **Decision** | Prefer `VITE_API_URL`, else same-origin `/api` in production builds; Vercel rewrite proxies to Render. |
| **Why** | Avoid hardcoding dead Railway URL; avoid mixed-content issues. |
| **Evidence** | `apiClient.ts`, `vercel.json` rewrite to `aura-api-184s.onrender.com`. |

---

## P11. Testing & load

### D-P11-01 — Vitest unit suites as correctness proof (`DECIDED`)

| | |
|--|--|
| **Decision** | Large Vitest suite under `apps/worker/src/__tests__` (**224** `it`/`test` cases as of 2026-09-29): lifecycle, fence, DLQ, backpressure, priority, scheduler lock, recovery (incl. 6k restore timing), SLOs, metrics, logger. |
| **Why** | Interviewable proofs without needing a production cluster; count matches `vitest run`, not a rounded “250”. |
| **Evidence** | `__tests__/*`; `npm test -w apps/worker`. |

### D-P11-02 — Pure functions extracted for testability (`DECIDED`)

| | |
|--|--|
| **Decision** | Export `getQueueOrder`, percentile helpers, backoff pure functions. |
| **Evidence** | Priority / load-test / retry tests. |

### D-P11-03 — Configurable load-test harness (`DECIDED`)

| | |
|--|--|
| **Decision** | `apps/worker/src/load-test.ts` scenarios: burst, steady, mixed, priority-storm, failure-flood with P50/P95/P99. |
| **Why** | Reproduce resume-scale claims locally. |
| **Evidence** | Commit `4f34f3b`; [BENCHMARKS.md](./BENCHMARKS.md). |

### D-P11-04 — Synthetic / diagnose scripts (`DECIDED`)

| | |
|--|--|
| **Decision** | `scripts/synthetic-load-test.ts` and diagnose helpers for recovery experiments. |

---

## P12. Repo & tooling

### D-P12-01 — npm workspaces monorepo (`DECIDED`)

| | |
|--|--|
| **Decision** | `apps/api`, `apps/worker`, `apps/operator-console`, `packages/database`, `packages/redis`. |
| **Tradeoffs** | Deploy install must run at root for workspace links. |

### D-P12-02 — Runtime via `tsx` (not always `dist/`) (`DECIDED`)

| | |
|--|--|
| **Context** | Railway/Vercel fought compiled `dist/` vs workspace TS resolution. |
| **Decision** | Prefer `tsx src/index.ts` at runtime for API/worker; `tsx` in dependencies. |
| **Evidence** | Commits `eedf483`, `2b9c986`, nixpacks notes. |

### D-P12-03 — Prisma generate at build; `db push` at start (`DECIDED` / `OPS`)

| | |
|--|--|
| **Decision** | `npm run db:generate` in image/build; `db:push` on container start for free demo schema sync. |
| **Tradeoffs** | `db push` is fine for demo; production apps usually migrate. |

### D-P12-04 — Ignore stale `*.tsbuildinfo` (`DECIDED`)

| | |
|--|--|
| **Decision** | Gitignore / untrack tsbuildinfo — stale files broke CI rebuilds. |
| **Evidence** | Commits `2ff9432`, `c6897b1`. |

---

## P13. Deployment evolution

### D-P13-01 — Operator console on Vercel (`DECIDED`)

| | |
|--|--|
| **Decision** | Static Vite build on Vercel (`aurasys.vercel.app`). |
| **Evidence** | Commits `339ec5e`, `e651e68` (skip tsc, vite build). |

### D-P13-02 — API/worker originally on Railway (`SUPERSEDED`)

| | |
|--|--|
| **Decision** | Nixpacks + Railway for Node API/worker. |
| **Why superseded** | Trial expired → `api-production-2689.up.railway.app` 404. |
| **Evidence** | nixpacks files; historical `VITE_API_URL`. |

### D-P13-03 — VPS Docker Compose path documented (`DECIDED` / unused for $0)

| | |
|--|--|
| **Decision** | `docker-compose.prod.yml` + Caddy HTTPS for always-on ~$5 VPS. |
| **Why not default now** | Student chose $0 path. |
| **Evidence** | Commit `f1cabe2`; [DEPLOY_VPS.md](./DEPLOY_VPS.md). |

### D-P13-04 — Paid Render Blueprint attempt (`SUPERSEDED` for demo)

| | |
|--|--|
| **Decision** | `render.yaml` with starter web+worker+redis+postgres. |
| **Why not used** | Requires payment; free tier has no background worker. |
| **Evidence** | [DEPLOY_RENDER.md](./DEPLOY_RENDER.md). |

### D-P13-05 — Free single-process embed (`DEMO` / current)

| | |
|--|--|
| **Decision** | `EMBEDDED_WORKER=true` starts worker runtime inside API process on Render Free; Neon Postgres; Render free Key Value Redis. |
| **Why** | $0; no paid worker. |
| **Tradeoffs** | Sleep, shared CPU, cannot hit resume scale. |
| **Evidence** | Commits `5e07391`, `runtime.ts`; [DEPLOY_FREE.md](./DEPLOY_FREE.md). |

### D-P13-06 — Job generator uses `PORT` (`DECIDED`)

| | |
|--|--|
| **Context** | Generator called `:3001` while Render listens on `:10000`. |
| **Decision** | Default `API_URL` to `http://127.0.0.1:${PORT}`; env override for demo. |
| **Evidence** | Commit `5c41315`; `jobGenerator.ts`. |

### D-P13-07 — Slow metrics broadcast on FREE_TIER (`DEMO`)

| | |
|--|--|
| **Decision** | `METRICS_BROADCAST_MS` default 5s when `FREE_TIER=true`; job broadcast 2s. |
| **Why** | Reduce CPU + SSE chatter on tiny instance. |

---

## P14. Demo vs benchmark honesty

### D-P14-01 — Two environments, two number sets (`DECIDED`)

| | |
|--|--|
| **Decision** | Document **local load-test claims** (resume) separately from **live free demo** (light generator). |
| **Why** | Prevents false implication that Vercel UI = 20k concurrency. |
| **Evidence** | [BENCHMARKS.md](./BENCHMARKS.md), README “Numbers” table; commit `e93f174`. |

### D-P14-02 — Sustained light generator for demo life (`DEMO`)

| | |
|--|--|
| **Decision** | Optional `JOB_GENERATOR_ENABLED` with interval ≥10–12s for long-lived sparse activity. |
| **Why** | Dashboard not stuck at zeros; still safe for free CPU. |

### D-P14-03 — Resume wording stays tied to methodology (`DECIDED`)

| Claim | Methodology pointer |
|-------|---------------------|
| ~304 jobs/min, P95 ≈ 7.4–7.6s, ~18k completions/h | Console screenshots (`assets/`) — see [BENCHMARKS.md](./BENCHMARKS.md) grade A |
| 20k burst / tens of thousands exercised | `load-test.ts --jobs 20000` + historical README (not “20k threads on screenshot”) |
| 224 tests | `npm test -w apps/worker` this SHA |
| 6k recover &lt;2s | Case-study log `durationMs:1843` + vitest 6k in-memory restore |

### D-P14-04 — Evidence grades for every public number (`DECIDED`)

| | |
|--|--|
| **Decision** | Every resume/demo number must have grade **A** (artifact), **B** (reproducible harness), **C** (historical log), or **D** (design target only). Undocumented numbers are forbidden in pitch docs. |
| **Why** | Interviewers ask “how do you know?”; rounded claims (6.5s, 250 tests) were weaker than screenshots/vitest. |
| **Evidence** | [BENCHMARKS.md](./BENCHMARKS.md), [benchmark-runs/](./benchmark-runs/). |

### D-P14-05 — Positioning + XYZ scaffolds, not canned resume bullets (`DECIDED`)

| | |
|--|--|
| **Decision** | Keep [POSITIONING.md](./POSITIONING.md) as product definition, differentiation vs BullMQ/DB-only, metric glossary, and Google XYZ **worksheets** — never paste-ready resume lines. |
| **Why** | User owns final resume wording; repo should make X/Y/Z and evidence obvious without fabricating achievement copy. |
| **Evidence** | [POSITIONING.md](./POSITIONING.md). |

### D-P14-06 — Category honesty + attention hooks (`DECIDED`)

| | |
|--|--|
| **Decision** | Document where Aura pales vs wrappers, DB pollers, Kafka/Temporal, and unfinished mega-systems; lead with differentiators that survive scrutiny (owned primitives, Redis-wipe recovery, evidence-graded metrics, decision log). |
| **Why** | Recruiters skip jargon walls; interviewers punish overclaim. Category matchup prevents false peer comparisons. |
| **Evidence** | [POSITIONING.md §2b](./POSITIONING.md#2b-category-matchup--where-aura-pales-matches-and-wins-attention). |

### D-P14-07 — Always document decisions from this chat (`DECIDED`)

| | |
|--|--|
| **Decision** | Every engineering/product/deploy/metrics/honesty choice made while working on Aura in chat is written into `docs/DECISIONS.md` (and BENCHMARKS/POSITIONING when claims or positioning change) in the same workstream. Enforced via `.cursor/rules/document-decisions.mdc` (`alwaysApply`). |
| **Why** | User standing order: decisions must stay crystal clear for interviews; chat context evaporates. |
| **Evidence** | This entry; `.cursor/rules/document-decisions.mdc`. |

---

## Chronological timeline (from git)

| Phase | Commits / themes |
|-------|------------------|
| Bootstrap | Initial monorepo, Prisma, Redis Lua, API/worker/console |
| Deploy wrestling | Vercel/Railway packaging (`tsx`, nixpacks, tsbuildinfo) |
| Correctness | Lifecycle bugs, crash recovery tests (`38c742a`) |
| Scheduler | Lock election, watchdog, utilization (`dcad939`, `2c47c9e`) |
| Backpressure | Lua gate, Redis counters, adaptive threshold |
| Idempotency | Execution fence |
| Priority proofs | `getQueueOrder` tests |
| Recovery | Bounded reconcile |
| Load / obs / SLOs | Phases 6–8 |
| Docs | Architecture + lifecycle docs (Phase 9) |
| Hosting shift | Railway dead → VPS docs → free Render embed |
| Honesty layer | Benchmarks vs demo docs |

---

## Quick “why not X?” cheat sheet

| Question | Answer |
|----------|--------|
| Why not only Postgres `FOR UPDATE SKIP LOCKED`? | Works at moderate scale; Redis claim path was the learning/perf target under 20k in-flight. |
| Why not only Redis? | Durability + reconcile story for interviews and real crash recovery. |
| Why not Temporal/Cadence? | Heavier ops; project goal is understanding primitives. |
| Why is prod “slow”? | Free single CPU + sleep; see DEMO decisions — not a failed benchmark. |

---

## Maintenance rule

When you make a new non-trivial choice (protocol, storage, deploy, API contract, testing strategy):

1. Add a **D-…** entry here (Context / Decision / Why / Alternatives / Tradeoffs / Evidence).  
2. If it changes what you can claim on a resume, update [BENCHMARKS.md](./BENCHMARKS.md).  
3. Link evidence (path or commit SHA).

This file is the source of truth for “what did we decide and why?”
