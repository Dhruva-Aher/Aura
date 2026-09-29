# FAANG recruiter check (evidence-backed)

**Date:** 2026-09-29  
**Method:** Re-indexed codebase knowledge graph · verified live URLs · re-ran Vitest · web research on recruiter portfolio signals · claim↔code match  

**Sources (external):** Google XYZ / Laszlo Bock achievement framing; portfolio guidance emphasizing ~12s README scans, live demos, CI, reliability features (rate limits / backpressure, observability), and production-shaped practices — see research notes in session + [POSITIONING.md](./POSITIONING.md).

This is an **audit for you**, not recruiter-facing copy.

---

## Graph / repo reinforcement (what we refreshed)

| Check | Result |
|-------|--------|
| Knowledge graph project | `Users-dhruv-.gemini-antigravity-scratch-aura` — **981** nodes, **1634** edges (re-indexed) |
| Architecture clusters | Worker loop / reconcile / metrics / SSE / console / load-test / lock — present |
| BullMQ / Bull dependency | **None** in workspace `package.json` files |
| Core symbols | `reconcilePendingJobs`, `SchedulerLock`, `AdaptiveThreshold`, `buildMetricsOverview`, `getQueueOrder`, SSE `sendEvent` |
| Live demo | `https://aurasys.vercel.app` → **HTTP 200** |
| Live API | `https://aura-api-184s.onrender.com/healthz` → `{"ok":true}` |
| Tests | `npm test -w apps/worker` → **224 passed** (14 files) |
| Proof assets | `assets/system-overview.png`, `performance.png`, `job-activity.png` present |

---

## What a FAANG sourcer scans for (~7–12 seconds)

| Signal | Aura status | Evidence |
|--------|-------------|----------|
| Clear role (Backend / systems) | **Pass** | README focus line |
| Stack keywords (Redis, Postgres, TS) | **Pass** | README + monorepo |
| Live demo URL | **Pass** | Verified 200 + healthz |
| Quantified outcomes (XYZ-ready Y) | **Pass** | Screenshot metrics + recovery log |
| Reliability / fault tolerance story | **Pass** | Leases, fences, reconcile, DLQ |
| Observability | **Pass** | Console + SSE + P95/throughput + SLOs |
| Automated tests | **Pass** | 224 Vitest |
| CI badge / green checks | **Added** | `.github/workflows/ci.yml` (worker tests) |
| Short recruiter-first README | **Pass** | ~70 lines, highlights first |
| IaC / deploy story | **Partial** | Docker Compose + Render/Vercel docs (Terraform absent — optional) |
| Multi-region / Kafka-scale | **Out of scope** | Portfolio job queue, not streaming platform |

---

## Claims re-verified against artifacts

| Claim | Match |
|-------|--------|
| 303.72 jobs/min · 18,223/h · P95 7.40s | `assets/system-overview.png` |
| P95 7.60s | `assets/job-activity.png` |
| 6,000 · 1,843 ms restore | Phase 9 case-study log (BENCHMARKS grade C) + vitest 6k guard |
| 224 tests | Vitest run this SHA |
| From-scratch primitives | `Worker.ts`, `Scheduler.ts`, `lua.ts` — no BullMQ |
| Leader-elected scheduler | `SchedulerLock.ts` + tests |
| Adaptive backpressure | `AdaptiveThreshold.ts` + Lua admission |
| Priority queues | `getQueueOrder` + `PriorityQueue.test.ts` |

Full matrix: [BENCHMARKS.md](./BENCHMARKS.md)

---

## Gaps worth knowing (for your roadmap — keep off README)

1. **CI was missing** until this audit — now present for worker tests. Coverage % / security scan badges still optional.
2. **Pulse jobs/sec vs hour throughput** are different windows — defend in interview (BENCHMARKS / dashboard write-up).
3. **Free demo ≠ local proof** — already separated in docs; README stays affirmative.
4. **Terraform / K8s** absent — Docker + Render is enough for many new-grad screens; add only if targeting infra-heavy roles.
5. **Company prod traffic** — never claim; design depth is the pitch.

---

## Recruiter pass / fail (honest)

| Question | Answer |
|----------|--------|
| Would a sourcer understand the role in 12s? | **Yes** — distributed job queue, Redis/Postgres, demo link |
| Would they forward to an eng? | **Likely yes** if highlights + screenshot load; eng will dig leases/fences |
| Is it peer-competitive with BullMQ wrappers? | **Yes on depth**; wrappers may look flashier live |
| Is it peer-competitive with unfinished Raft/K8s clones? | **Yes on shippability**; narrower scope |
| Does XYZ have real Y? | **Yes** — screenshot + recovery log + test count |

---

## Follow-ups (optional)

- Add coverage reporting to CI if you want a coverage badge.
- Pin a second screenshot (latency widget) inline only if README stays scannable.
- Keep claim sheet in BENCHMARKS as interview source of truth.
