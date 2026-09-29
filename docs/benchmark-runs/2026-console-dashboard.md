# Console dashboard snapshot (primary resume evidence)

**Grade:** A — measured artifact (checked-in screenshots)  
**Artifacts:**
- [`assets/system-overview.png`](../../assets/system-overview.png)
- [`assets/performance.png`](../../assets/performance.png)
- [`assets/job-activity.png`](../../assets/job-activity.png)

**What this is:** Operator Console captured during a local/high-volume run (dark “AURA CONSOLE” UI). This is **not** the free Render demo.

## Numbers you can quote from the snapshot

| Visible metric | Value on screenshot | How the product computes it | Defensible claim |
|----------------|---------------------|-----------------------------|------------------|
| Throughput | **303.72 Jobs/min** | `metricsSnapshot`: completions in last hour ÷ 60 | **~304 jobs/min** (resume “~300/min”) |
| Completed (card) | **18,223** | Same 1h completion window as throughput | **~18k completions / hour** under that load |
| Job latency P95 | **7.40s** (`system-overview`) / **7.60s** (`job-activity`) | P95 of queue-wait samples in metrics ZSET | **P95 ≈ 7.4–7.6s** under that load |
| Processing | **5** | Live lease/processing count | Small in-flight at capture time (queue mostly drained) |
| Pending | **0** | Live pending | Snapshot after drain, not peak depth |
| Pulse line | Scheduled ~30–32 /s; Completed ~16–25 /s | 10s pulse buckets ×6 → jobs/min | Consistent with ~300+/min completions |

## What this does **not** prove

- It does **not** show 20,000 jobs simultaneously sitting in Redis. At capture, pending was 0 and processing was 5.
- It does **not** prove free-tier Render can sustain ~304/min.
- Dead letters **3,479** are part of that historical window (failure-injection / DLQ path was active) — do not hide this if asked; it is evidence the DLQ path worked under load.

## How “~300/min” and “P95 ~7.5s” map to the resume

Older resume wording used **P95 ~6.5s**. The **checked-in screenshots** show **7.4–7.6s**. Prefer the screenshot numbers in interviews so you cannot be caught rounding down.

Formula check (same snapshot):  
`303.72 jobs/min × 60 ≈ 18,223` → matches the Completed card. Throughput and Completed are one consistent story.
