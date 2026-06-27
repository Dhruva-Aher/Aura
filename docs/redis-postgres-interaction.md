# Redis and PostgreSQL Interaction

Aura operates a hybrid-persistence architecture. It is crucial to understand why both systems are used and how they synchronize.

## The Roles

### PostgreSQL (The Source of Truth)
PostgreSQL provides ACID compliance and durability. Every job created is written to the `Job` table before anything else occurs. It holds the authoritative payload, status history, and the final state (`COMPLETED`, `FAILED`, `DEAD_LETTER`). However, relational databases struggle with the extreme contention caused by thousands of workers concurrently polling and locking rows in a queue pattern.

### Redis (The Execution Plane)
Redis provides single-threaded, in-memory operations that are perfect for concurrent state manipulation. Using sorted sets (`ZSET`), Redis can instantly rank jobs by priority (`aura:queue:high`) or by a future execution timestamp (`aura:delayed`). Workers pull exclusively from Redis using `ZPOPMAX`, bypassing the database entirely for job acquisition.

## Interaction Flow

1. **Ingestion**: The API starts a Postgres transaction, inserts the job as `PENDING`, and upon commit, pipelines a `ZADD` to the appropriate Redis queue. 
2. **Execution State**: Workers do not lock rows in Postgres. They claim leases strictly in Redis. Only *after* executing the payload does the worker update the Postgres row to `COMPLETED` or `FAILED`.
3. **Reconciliation**: Because a Redis crash would wipe the execution plane, the Scheduler runs a Reconciler loop. This loop treats Postgres as the ultimate authority. It identifies any job in Postgres that should be in the queue but is missing from Redis, and pushes it back in.

## Rationale
By strictly decoupling the durability layer (Postgres) from the routing and concurrency layer (Redis), Aura achieves the throughput characteristics of an in-memory datastore while preserving the strict durability guarantees of a traditional relational database.
