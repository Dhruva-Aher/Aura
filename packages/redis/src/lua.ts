export const SCRIPTS = {
  CLAIM_JOB: `
    local job = redis.call('zpopmax', KEYS[1])
    if #job == 0 then return nil end
    local jobId = job[1]
    local priority = job[2]
    local leaseExpiry = ARGV[1]
    redis.call('zadd', KEYS[2], leaseExpiry, jobId)
    return {jobId, priority}
  `,

  PROMOTE_JOBS: `
    local jobs = redis.call('zrangebyscore', KEYS[1], 0, ARGV[1])
    for _, jobId in ipairs(jobs) do
      local priority = redis.call('hget', KEYS[3] .. jobId, 'priority') or 0
      local targetQueue = redis.call('hget', KEYS[3] .. jobId, 'queue') or 'default'
      local activeKey = KEYS[2]
      if targetQueue == 'high' then
        activeKey = KEYS[4]
      elseif targetQueue == 'low' then
        activeKey = KEYS[5]
      end
      redis.call('zrem', KEYS[1], jobId)
      redis.call('zadd', activeKey, priority, jobId)
    end
    return #jobs
  `,

  // KEYS[1]=aura:leased  KEYS[2]=aura:queue:default (unused, kept for arity)
  // KEYS[3]=aura:meta:   KEYS[4]=aura:queue:high   KEYS[5]=aura:queue:low
  // KEYS[6]=aura:delayed ARGV[1]=nowMs
  //
  // Retryable jobs are routed through aura:delayed with a 5 s hold instead of
  // being put directly back into the active queue.  This prevents a thundering
  // herd when many workers crash simultaneously (e.g. during a deploy).
  REAP_JOBS: `
    local expired = redis.call('zrangebyscore', KEYS[1], 0, ARGV[1])
    local reaped = {}
    for _, jobId in ipairs(expired) do
      local attempts = redis.call('hincrby', KEYS[3] .. jobId, 'attempts', 1)
      local max = tonumber(redis.call('hget', KEYS[3] .. jobId, 'maxAttempts') or 3)
      redis.call('zrem', KEYS[1], jobId)
      if attempts < max then
        local backoffMs = math.min(math.pow(2, attempts - 1) * 5000, 300000)
        local jitter = math.random(0, math.max(1, math.floor(backoffMs * 0.1)))
        local retryAt = tonumber(ARGV[1]) + backoffMs + jitter
        redis.call('zadd', KEYS[6], retryAt, jobId)
        table.insert(reaped, {jobId, 'REQUEUED'})
      else
        table.insert(reaped, {jobId, 'DEAD_LETTER'})
      end
    end
    return reaped
  `,

  COMPLETE_JOB: `
    redis.call('zrem', KEYS[1], ARGV[1])
    redis.call('del', KEYS[2] .. ARGV[1])
    return 1
  `,

  FAIL_JOB: `
    local jobId = ARGV[1]
    local now = tonumber(ARGV[2])
    local attempts = redis.call('hincrby', KEYS[3] .. jobId, 'attempts', 1)
    local max = tonumber(redis.call('hget', KEYS[3] .. jobId, 'maxAttempts') or 3)
    redis.call('zrem', KEYS[1], jobId)
    if attempts < max then
      local backoffMs = math.min(math.pow(2, attempts - 1) * 1000, 60000)
      local jitter = math.random(0, math.max(1, math.floor(backoffMs * 0.1)))
      local delay = now + backoffMs + jitter
      redis.call('zadd', KEYS[6], delay, jobId)
      return 'REQUEUED'
    else
      return 'DEAD_LETTER'
    end
  `,

  REPLAY_DLQ: `
    local jobId = ARGV[1]
    local priority = redis.call('hget', KEYS[2] .. jobId, 'priority') or 0
    redis.call('hset', KEYS[2] .. jobId, 'attempts', 0)
    redis.call('zadd', KEYS[1], priority, jobId)
    return 1
  `,

  DISCARD_DLQ: `
    local jobId = ARGV[1]
    redis.call('del', KEYS[1] .. jobId)
    return 1
  `,

  ADMISSION_GATE: `
    local threshold = tonumber(ARGV[1])
    local rateLimit = tonumber(ARGV[2])
    local rateTtl = tonumber(ARGV[3])
    local reserveTtl = tonumber(ARGV[4])

    local reservations = tonumber(redis.call('get', KEYS[6]) or '0')
    local queued = redis.call('zcard', KEYS[1]) + redis.call('zcard', KEYS[2]) + redis.call('zcard', KEYS[3]) + redis.call('zcard', KEYS[4])
    local projected = queued + reservations

    if projected >= threshold then
      return {'REJECT_QUEUE', tostring(projected)}
    end

    local rate = redis.call('incr', KEYS[5])
    if rate == 1 then
      redis.call('expire', KEYS[5], rateTtl)
    end
    if rate > rateLimit then
      return {'REJECT_RATE', tostring(rate)}
    end

    local token = redis.call('incr', KEYS[6])
    if token == 1 then
      redis.call('expire', KEYS[6], reserveTtl)
    end
    return {'ACCEPT', tostring(token), tostring(projected)}
  `,

  RELEASE_ADMISSION: `
    local current = tonumber(redis.call('get', KEYS[1]) or '0')
    if current <= 0 then return 0 end
    return redis.call('decr', KEYS[1])
  `,

  RENEW_LEASE: `
    local current = redis.call('zscore', KEYS[1], ARGV[1])
    if current == false then return 0 end
    redis.call('zadd', KEYS[1], ARGV[2], ARGV[1])
    return 1
  `,

  // Idempotency fence — atomically claims the execution slot for one job attempt.
  // KEYS[1] = aura:executing:<jobId>   ARGV[1] = workerId   ARGV[2] = TTL seconds
  // Returns 'OK' if this worker won the slot, null if already claimed.
  CLAIM_EXECUTION: `
    return redis.call('set', KEYS[1], ARGV[1], 'NX', 'EX', tonumber(ARGV[2]))
  `,

  // Scheduler leader-election helpers.
  // RENEW_SCHEDULER_LOCK — only renew if this instance still holds the lock.
  // KEYS[1]=lock key  ARGV[1]=instanceId  ARGV[2]=TTL seconds
  // Returns 1 if renewed (we're still the leader), 0 if someone else holds it.
  RENEW_SCHEDULER_LOCK: `
    local current = redis.call('get', KEYS[1])
    if current == ARGV[1] then
      redis.call('expire', KEYS[1], tonumber(ARGV[2]))
      return 1
    end
    return 0
  `,

  // RELEASE_SCHEDULER_LOCK — only delete the lock if we're the holder.
  // KEYS[1]=lock key  ARGV[1]=instanceId
  // Returns 1 if released, 0 if not the current holder (already expired / taken over).
  RELEASE_SCHEDULER_LOCK: `
    local current = redis.call('get', KEYS[1])
    if current == ARGV[1] then
      redis.call('del', KEYS[1])
      return 1
    end
    return 0
  `
};
