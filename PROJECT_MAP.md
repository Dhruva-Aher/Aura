# PROJECT_MAP.md

## 1. HIGH-LEVEL ARCHITECTURE

Aura is a robust, distributed Job Orchestration Engine and "Operator Console" dashboard. It uses a State Machine pattern backed by Redis for high-throughput atomic job queuing/leasing and Postgres for durable state persistence and event logging.

- **`api`**: Express.js REST API layer. Serves as the gateway for the frontend. Handles job creation, DLQ management, queue operations, and broadcasts real-time system metrics via Server-Sent Events (SSE).
- **`worker`**: Node.js service running the execution pipelines. Contains the `Worker` class (polls Redis for jobs, manages leases, executes tasks, handles failures) and the `Scheduler` class (promotes delayed jobs, reaps expired/crashed worker leases, marks offline workers).
- **`operator-console`**: Vite + React frontend dashboard. A high-density "System-of-Systems" dark-mode UI. It consumes the REST API and the SSE stream to render real-time optimistic updates using React Query.
- **`@aura/database`**: Shared Prisma Postgres schema and client. Contains models for `Job`, `JobEvent`, and `Worker`.
- **`@aura/redis`**: Shared Redis client utilizing custom Lua scripts to guarantee atomic operations (e.g., claim, complete, fail, reap) across distributed workers.

---

## 2. FOLDER STRUCTURE

```
/apps
  /api
    - package.json
    - tsconfig.json
    /src
      - index.ts
      /routes
        - jobs.ts
        - metrics.ts
        - stream.ts
        - system.ts
      /services
        - QueueService.ts
  /operator-console
    - index.html
    - package.json
    - postcss.config.js
    - tailwind.config.js
    - tsconfig.json
    - vite.config.ts
    /src
      - App.tsx
      - AuraContext.tsx
      - index.css
      - main.tsx
      /components
        /cards
          - BottomPanels.tsx
          - KpiRow.tsx
          - PulseLineChart.tsx
          - RecentJobsList.tsx
          - SecondaryMetrics.tsx
        /layout
          - DashboardLayout.tsx
          - Header.tsx
          - Sidebar.tsx
        /modals
          - ConfirmActionDialog.tsx
          - EnqueueJobModal.tsx
          - JobDrawer.tsx
      /services
        - apiClient.ts
        - jobsService.ts
        - metricsService.ts
        - systemService.ts
      /utils
        - cn.ts
  /worker
    - package.json
    - tsconfig.json
    /src
      - index.ts
      /services
        - Scheduler.ts
        - Worker.ts

/packages
  /database
    - .env
    - .gitignore
    - index.ts
    - package.json
    - prisma.config.ts
    /prisma
      - schema.prisma
      - seed.ts
    - tsconfig.json
  /redis
    - package.json
    /src
      - index.ts
      - lua.ts
    - tsconfig.json
```

---

## 3. KEY FILE SUMMARIES

**`apps/api/src/index.ts`**
- Main Express application entry point.
- Sets up routes and handles the global error boundary.
- Contains the `setInterval` loop that polls Prisma and broadcasts `metrics_update` via Server-Sent Events (SSE) to `/events/stream`.

**`apps/api/src/routes/jobs.ts`**
- Exposes endpoints to create and manage jobs.
- Key functions: `POST /`, `GET /recent`, `GET /dlq`, `POST /:id/replay`, `POST /:id/discard`.

**`apps/worker/src/services/Worker.ts`**
- Manages the execution lifecycle of a worker node.
- Key functions: `start()` (registers worker), `loop()` (polls Redis for jobs), `processJob()` (handles execution, failure, and completion), `startHeartbeat()` (extends lease and reports CPU/Mem).

**`apps/worker/src/services/Scheduler.ts`**
- Background cleanup and promotion process.
- Key functions: `loop()` runs constantly to promote delayed jobs in Redis, reap expired leases from crashed workers (using Lua scripts), and clean up offline workers in Postgres.

**`apps/operator-console/src/App.tsx`**
- The monolithic frontend UI entry point utilizing React Router (`Routes`).
- Renders the Header, Sidebar, `<DashboardView>`, `<JobsView>`, `<DlqView>`, and `<WorkersView>`.
- Includes the `JobDrawer` and `EnqueueJobModal` components globally.

**`apps/operator-console/src/AuraContext.tsx`**
- Global React Query state manager and SSE stream consumer.
- Initializes queries (`metrics`, `pulse`, `recentJobs`, `workers`) and handles mutations.
- Uses `EventSource` to listen to `metrics_update` and `job_update` to instantly invalidate/update the frontend cache.

**`packages/redis/src/lua.ts`**
- Contains raw Lua scripts for atomic queue operations.
- Key scripts: `CLAIM_JOB` (ZPOPMIN from active, ZADD to leased), `COMPLETE_JOB` (ZREM from leased, cleanup meta), `FAIL_JOB`, `REAP_JOBS`.

**`packages/database/prisma/schema.prisma`**
- Relational schema.
- Models: `Job` (core state, idempotency), `JobEvent` (audit trail), `Worker` (fleet management).

---

## 4. DATA FLOW

1. **Enqueue:** The frontend hits `POST /jobs`. The API's `QueueService` creates a `Job` row in Postgres (status: `PENDING`) and uses a Lua script to add it to the Redis `aura:active` Sorted Set.
2. **Lease:** A `Worker` running its `loop()` calls `claimJob`. The Lua script atomically moves the job from `aura:active` to `aura:leased` in Redis. The worker updates Postgres status to `PROCESSING` and creates a `CLAIMED` event.
3. **Execution:** The worker extends the Redis lease via heartbeats and processes the job payload.
4. **Completion/Failure:** 
   - **Success:** The worker removes the job from Redis (`completeJob`) and updates Postgres to `COMPLETED`.
   - **Failure:** The worker invokes `failJob` in Redis. Depending on max attempts, Redis moves it back to `aura:active` or marks it as `DEAD_LETTER`. Postgres reflects this state and increments attempts.
5. **Real-time Updates:** The API continually emits state aggregations via SSE. The `AuraContext` in the frontend intercepts these, updates the React Query cache, and causes immediate visual re-renders on the Operator Console.

**Inconsistencies Risk:** Split-brain between Redis and Postgres if process crashes occur mid-transaction. The Lua scripts ensure Redis is the source of truth for the queue, but Postgres state updates happen sequentially after Redis actions. If a worker crashes after completing the job in Redis but before writing to Postgres, the job might be lost from queues but stuck in `PROCESSING` in Postgres.

---

## 5. CURRENT PROBLEMS

- **Missing `retry` Endpoint:** The frontend UI includes a "Retry Job" button in the `JobDrawer` for `FAILED` jobs and hits `POST /jobs/:id/retry` via `jobsService.retryJob`. However, this endpoint **does not exist** in `apps/api/src/routes/jobs.ts`. Clicking it will result in a 404.
- **Backend Search/Filtering:** The Search Bar in the frontend header (`App.tsx`) is completely disconnected. It only holds local state (`search`) and does not filter anything.
- **Settings & Theme Gaps:** The Sidebar "Settings" button triggers an alert (`not yet implemented`). Dark Mode is bound to a CSS class (`dark`), but Tailwind's config might not be utilizing it properly if the dark theme defaults are hardcoded arbitrary colors (e.g., `bg-[#0B0C10]`).
- **Worker Pools View:** The `/pools` route in `App.tsx` just renders a `PlaceholderView`.
- **Metrics Mock Data:** The `pulse` (time-series) data fetched via `metricsService.getPulse` might still be relying on static/stub data if `apps/api/src/routes/metrics.ts` hasn't been fully mapped to Postgres historical data.
- **No Redis-to-Postgres Reconciliation:** If Redis crashes or is flushed, there is no startup script to repopulate the Redis queues from Postgres `PENDING` states.

---

## 6. API SURFACE

| Method | Path | Description | Status |
|---|---|---|---|
| POST | `/jobs` | Enqueues a new job payload | ✅ Complete |
| GET | `/jobs/recent` | Retrieves the 10 most recent jobs | ✅ Complete |
| GET | `/jobs/dlq` | Retrieves all DEAD_LETTER jobs | ✅ Complete |
| POST | `/jobs/:id/replay` | Moves a DEAD_LETTER job back to the active queue | ✅ Complete |
| POST | `/jobs/:id/discard` | Removes a job from the queue/system | ✅ Complete |
| POST | `/jobs/:id/retry` | Retries a FAILED job | ❌ **Missing entirely** |
| GET | `/metrics/overview` | Retrieves queue depth and throughput | ✅ Complete |
| GET | `/metrics/pulse` | Retrieves time-series graph data | ⚠️ Potentially Mocked |
| GET | `/system/workers` | Retrieves all active/offline workers | ✅ Complete |
| GET | `/system/health` | Retrieves sub-system ping statuses | ✅ Complete |
| GET | `/events/stream` | Server-Sent Events (SSE) push stream | ✅ Complete |

---

## 7. FRONTEND STATE & DATA LAYER

- **State Manager:** `@tanstack/react-query` is the primary data layer.
- **Global Context:** `AuraContext.tsx` wraps React Query. It exports normalized accessors (`metrics`, `pulse`, `recentJobs`, `workers`) and mutation helpers (`enqueueJob`, `replayDlq`, `discardDlq`).
- **Real-time Engine:** Standard `EventSource` listens to `http://localhost:3001/events/stream`. On `metrics_update` or `job_update`, it uses `queryClient.setQueryData` to optimistically update the cache without requiring a new HTTP fetch.
- **Disconnects:** The Search Bar state `[search, setSearch]` in the `<Header>` is entirely local and unused. `<DlqView>` handles its own `useQuery` fetch for `/jobs/dlq` rather than pushing it through the SSE stream, meaning DLQ updates are not real-time.

---

## 8. MISSING PIECES

**Backend Gaps:**
- Implement `POST /jobs/:id/retry` in `apps/api/src/routes/jobs.ts`.
- Ensure `metrics/pulse` returns real historical Postgres aggregation, not mock arrays.
- Add an API endpoint to support searching and filtering jobs (`GET /jobs?search=`).

**Frontend Wiring Gaps:**
- Implement the Worker Pools View (`/pools`).
- Wire the Search bar to the new jobs filter endpoint and debounce the input.
- Create an actual Settings modal or page.

**Worker/Scheduler Gaps:**
- Add a reconciliation boot script: On start, the Scheduler should query Postgres for `status: 'PENDING'` jobs and ensure they exist in the Redis `aura:active` set to heal from Redis restarts.

**Metrics Gaps:**
- P95 Latency on the dashboard is currently hardcoded (`2.34s`). The API needs to calculate real completion duration (`completedAt - startedAt`) and expose it in the metrics payload.
