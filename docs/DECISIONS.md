# Aura — Engineering Decisions Log

Chronological / thematic record of **why** the system is shaped this way. Use this in SWE interviews when asked “why didn’t you just use Bull/BullMQ?” or “why Postgres and Redis?”

Status key: **DECIDED** = chosen and shipped · **TRADEOFF** = accepted cost · **DEMO** = free-tier only

---

## D1. Hybrid Postgres + Redis (DECIDED)

**Problem:** Need durability *and* fast priority pop under load.  
**Decision:** Postgres = source of truth for job rows; Redis sorted sets = execution queues, leases, delay, metrics.  
**Why:** Redis alone loses jobs on flush; Postgres alone is too slow for `ZPOPMAX`-style claim loops.  
**Tradeoff:** Must reconcile the two stores (see Reconciler).  
**Doc:** [redis-postgres-interaction.md](./redis-postgres-interaction.md)

## D2. Lease + idempotency fence (DECIDED)

**Problem:** Worker can finish after its lease was reaped and given to another worker → double complete.  
**Decision:** Claim writes `aura:leased` score `now+TTL`; before durable complete, take `aura:executing:<jobId>` fence.  
**Why:** Separates “visibility timeout” from “who may commit.”  
**Tradeoff:** At-least-once semantics; handlers must be idempotent.  
**Doc:** [lease-protocol.md](./lease-protocol.md)

## D3. Leader-elected scheduler (DECIDED)

**Problem:** Reap/promote/reconcile must run exactly once across replicas.  
**Decision:** Redis `SET NX EX` lock (`aura:scheduler:lock`); any worker may become leader.  
**Why:** No single “scheduler service” SPOF; failover when lock TTL expires (~15s).  
**Doc:** [scheduler-lifecycle.md](./scheduler-lifecycle.md)

## D4. Adaptive backpressure (DECIDED)

**Problem:** Static max queue depth either rejects too early or melts the system.  
**Decision:** Admission gate Lua + threshold from recent drain rate (`AdaptiveThreshold`).  
**Why:** Protects latency when workers slow down; relaxes when drain recovers.  
**Tradeoff:** More moving parts than a fixed 10k cap.  
**Tests:** `AdaptiveThreshold.test.ts`, `Backpressure.test.ts`

## D5. Exponential backoff + DLQ (DECIDED)

**Problem:** Hot failures thrash the active queues.  
**Decision:** Failed jobs → `aura:delayed` with `min(2^(attempts-1)*5000, 300000)+jitter`; after `maxAttempts` → `DEAD_LETTER`.  
**Doc:** [retry-dlq.md](./retry-dlq.md)

## D6. Operator console via SSE (DECIDED)

**Problem:** Polling every N ms wastes bandwidth and feels jumpy.  
**Decision:** API broadcasts `metrics_update` / `job_update` over SSE; React Query holds state.  
**Tradeoff (free tier):** Too-aggressive `invalidateQueries` caused UI lag → debounced refreshes (2026-09).

## D7. Monorepo workspaces (DECIDED)

**Problem:** Share Prisma + Redis Lua across API and worker.  
**Decision:** npm workspaces `apps/*`, `packages/database`, `packages/redis`.  
**Tradeoff:** Deploy must install from repo root (`npm install` + `db:generate`).

## D8. Free-tier public demo (DEMO / TRADEOFF)

**Problem:** Railway trial ended; student budget ≈ $0; still need a public URL for recruiters.  
**Decision:** Single Render **Free** web service with `EMBEDDED_WORKER=true` + Neon Postgres + Render free Redis; Vercel hosts the SPA.  
**Why:** No paid background worker plan required.  
**Tradeoff:** Sleeps when idle; cannot reproduce resume-scale throughput; API+worker share one CPU.  
**Doc:** [DEPLOY_FREE.md](./DEPLOY_FREE.md), [BENCHMARKS.md](./BENCHMARKS.md)

## D9. Separate “resume numbers” from “live numbers” (DECIDED)

**Problem:** Demo UI showing 0–1 jobs looked like the project “regressed” vs resume.  
**Decision:** Document two environments explicitly; keep live generator **slow** for sustained activity; keep load-test as the source of scale claims.  
**Doc:** [BENCHMARKS.md](./BENCHMARKS.md)

## D10. Factory-reset endpoint (DEMO)

**Problem:** Old Neon backlog (10k+ jobs) hammered free CPU after reconnect.  
**Decision:** Token-gated `POST /debug/factory-reset` clears jobs + `aura:*` Redis keys.  
**Tradeoff:** Dangerous if token leaks — rotate `RESET_TOKEN` after use.

---

## Alternatives considered (summary)

| Alternative | Why not (for this project) |
|-------------|----------------------------|
| Bull/BullMQ only | Great library; goal was to **own** lease/reconcile semantics for learning + interview depth |
| Kafka | Overkill for job lease/retry teaching model; ops cost |
| Free Render worker service | Not available on free plan |
| Always-on VPS (~$5) | Best perf/$ ; deferred while prioritizing $0 demo |

---

## Timeline (high level)

1. Core queue + Prisma schema + Redis Lua  
2. Worker leases, retries, DLQ  
3. Scheduler lock + reconcile + SLOs  
4. Operator console + SSE  
5. Load-test harness + Vitest suites  
6. Railway deploy (expired)  
7. Free Render + Neon + embedded worker (2026-09)  
8. Benchmarks vs demo documentation split (2026-09)
