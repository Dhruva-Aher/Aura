# Worker Lifecycle

Aura workers are designed to be stateless, horizontally scalable consumers that actively pull work from Redis.

## Lifecycle Phases

1. **Boot and Registration**: On startup, a worker registers itself in the `aura:workers:active` Redis set and begins emitting a heartbeat every few seconds. It determines its queue polling strategy based on its configured pool (`high-priority`, `default`, `low-priority`).
2. **Polling (`ZPOPMAX`)**: The worker queries the Redis sorted sets for the highest priority job available. This operation is highly efficient and avoids the need for a push-based broker.
3. **Execution**: Upon finding a job, the worker executes the associated handler payload. It operates asynchronously, allowing Node.js to manage concurrency limits efficiently.
4. **Completion/Failure**: The worker commits the result back to Postgres and Redis, tearing down its execution state.

## Worker Pools and Starvation Prevention
Workers specify a priority pool on startup, dictating the order they poll the queues:
- `high-priority` polls `high` -> `default` -> `low`.
- `default` polls `default` -> `high` -> `low`.

However, strict priority queues can lead to indefinite starvation of low-priority jobs during high-load periods. To counter this, workers track consecutive cache misses. After a configurable number of consecutive misses, they forcefully poll the lowest priority queue.

## Rationale
The pull-based (polling) model over a push-based model simplifies backpressure. If workers are saturated, they simply stop polling. The queue depth grows, and the API admission gate automatically throttles ingestion, creating a natural, self-regulating flow.
