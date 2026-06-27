# Retry and Dead Letter Flow

Aura provides robust mechanisms for handling intermittent failures, ensuring that transient errors do not cause permanent data loss while preventing failing jobs from permanently clogging the active queues.

## Exponential Backoff
When a job handler throws an error, the worker catches the exception and marks the job as `FAILED`. Instead of immediately re-enqueueing the job, Aura calculates a backoff delay.
The calculation is exponential with a capped maximum and slight jitter to prevent thundering herd problems:
`backoffMs = Math.min((2 ^ (attempts - 1)) * 5000, 300000) + jitter`

This creates a retry progression approximately like: 5s -> 10s -> 20s -> 40s -> etc., up to a maximum of 5 minutes.

## The Delayed Queue
The failed job is pushed to the `aura:delayed` Redis sorted set. Unlike the active queues (where score = priority), the score in the delayed queue represents the exact Unix timestamp when the job should become active again (`Date.now() + backoffMs`).
The Scheduler's Promoter loop periodically scans this set for scores less than the current time, popping them out and pushing them back into the standard priority queues.

## Dead Letter Queue (DLQ)
Every job is initialized with a `maxAttempts` configuration. If a job continually fails and reaches this threshold, the backoff strategy is aborted.
1. The job is marked as `DEAD_LETTER` in PostgreSQL.
2. The job is permanently removed from all Redis queues.

Dead letters act as an operational isolation ward. They stop poisoning the active worker pools. An operator must use the Aura dashboard (or API) to manually inspect the stack trace, fix the underlying software issue, and choose to either `Replay` the job or `Discard` it permanently.

## Rationale
Decoupling the retry wait-time into a distinct sorted set (`aura:delayed`) prevents the active queues from being polluted with jobs that aren't ready to execute. The strict DLQ mechanism is crucial for overall system health, ensuring that poison-pill jobs do not consume unbounded compute resources.
