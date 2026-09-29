# Benchmark run archive

Every **resume-facing** number must point here (or to a checked-in screenshot under `assets/`).

## Evidence grades

| Grade | Meaning | Safe in interviews? |
|-------|---------|---------------------|
| **A — measured artifact** | Screenshot, JSON report, or vitest output checked into git | Yes — quote the artifact |
| **B — reproducible harness** | Command exists; re-run produces the metric | Yes — say “harness; last recorded run is …” |
| **C — historical log** | Documented log line from an older README / case study; not re-run this SHA | Yes with caveat — “Phase 9 case study recorded …” |
| **D — design target** | SLO / capacity estimate, not a measured run | Only as a target, never as “we hit” |

**Rule:** If there is no A/B/C evidence, do not put the number on a resume.

## How to add a new load-test run

```bash
# With API + workers + Postgres + Redis local:
npm run load-test -w apps/worker -- burst --jobs 20000 --concurrency 20 --json \
  > docs/benchmark-runs/$(date +%Y-%m-%d)-burst-20k.json
```

Paste a short markdown companion next to the JSON: machine, commit SHA, docker versions, command, and the P50/P95/P99 + throughput lines.

## Index

| File / asset | What it defends |
|--------------|-----------------|
| [2026-console-dashboard.md](./2026-console-dashboard.md) | ~304 jobs/min, P95 ≈ 7.4s, ~18k completions/hour |
| `assets/system-overview.png` | Same dashboard snapshot (visual) |
| `assets/performance.png` | Pulse line jobs/sec under load |
| `assets/job-activity.png` | P95 latency widget (~7.6s) |
| Vitest `PersistenceRecovery` 6k case | Reconcile loop restores 6000 orphans &lt;2s (in-memory) |
| Phase 9 README case study | Real Redis wipe: `restored:6000, durationMs:1843` |
