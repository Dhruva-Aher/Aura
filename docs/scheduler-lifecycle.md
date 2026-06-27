# Scheduler Lifecycle

The Scheduler in Aura is designed as a decentralized, highly available background process. Rather than relying on a standalone orchestration service, every worker instance is capable of acting as the scheduler. 

## Leader Election
To prevent duplicate processing, the scheduler leverages Redis as a distributed lock (`SET NX EX`). 
- Every worker instance runs a `SchedulerLock` loop that attempts to acquire the lock (`aura:scheduler:lock`) every 5 seconds.
- The lock is granted with a 15-second TTL.
- The winning instance begins executing the scheduler loops. If the leader crashes or becomes unresponsive, the lock expires and another worker seamlessly promotes itself to leader.

## Core Loops
Once elected, the scheduler coordinates the system through distinct, decoupled loops:

1. **Reaper**: Sweeps the `aura:leased` queue. If a job's lease score is strictly less than the current time, it indicates the worker crashed or hung. The job is atomically popped from the leased set and pushed back into the active priority queue.
2. **Promoter**: Sweeps the `aura:delayed` queue. Delayed jobs (e.g., retries) have a score representing their future execution time. Once the score matches the current time, the job is promoted to the active queue.
3. **Reconciler**: Addresses the fundamental split-brain between Redis and PostgreSQL. It queries Postgres for `PENDING` and `PROCESSING` jobs that have vanished from Redis (due to eviction or temporary loss) and rehydrates them into the active queues.
4. **SLO Evaluator**: Monitors queue depth and historical latency percentiles. If P95 latency exceeds target SLAs, it publishes a breach alert.

## Rationale
Decentralizing the scheduler removes a single point of failure and simplifies deployment (users only deploy the API and Workers). The use of distinct, isolated loops ensures that a failure or stall in one loop (e.g., the Postgres Reconciler) does not block critical path operations like the Reaper or Promoter.
