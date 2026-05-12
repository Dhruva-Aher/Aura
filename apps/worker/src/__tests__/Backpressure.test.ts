/**
 * Backpressure / admission gate tests — Step 3
 *
 * The admission gate has two independent checks:
 *   1. Queue depth:  if projected queue >= threshold → REJECT_QUEUE (429, Retry-After: 5)
 *   2. Rate limit:   if per-second request count > limit → REJECT_RATE (429, Retry-After: 1)
 *
 * We test the logic by reimplementing it as a pure TypeScript function (same
 * algorithm as the ADMISSION_GATE Lua script) so tests are fast and
 * infrastructure-free.  A separate suite validates the HTTP response contract.
 */

import { describe, it, expect } from 'vitest';

// ── Pure TypeScript reimplementation of ADMISSION_GATE Lua ───────────────────

interface GateState {
  queueDepth: number;       // sum of high + default + low + delayed
  reservations: number;     // in-flight requests not yet committed
  rateCount: number;        // requests this second
}

type GateDecision =
  | { decision: 'ACCEPT';       token: number; projected: number }
  | { decision: 'REJECT_QUEUE'; projected: number }
  | { decision: 'REJECT_RATE';  rate: number };

function admissionGate(
  state: GateState,
  threshold: number,
  rateLimit: number,
): GateDecision {
  const projected = state.queueDepth + state.reservations;

  if (projected >= threshold) {
    return { decision: 'REJECT_QUEUE', projected };
  }

  const newRate = state.rateCount + 1;
  if (newRate > rateLimit) {
    return { decision: 'REJECT_RATE', rate: newRate };
  }

  return { decision: 'ACCEPT', token: state.reservations + 1, projected };
}

// ── Queue depth checks ────────────────────────────────────────────────────────

describe('Admission gate — queue depth limit', () => {
  it('accepts when queue is below threshold', () => {
    const result = admissionGate(
      { queueDepth: 5000, reservations: 0, rateCount: 0 },
      10_000, 200
    );
    expect(result.decision).toBe('ACCEPT');
  });

  it('rejects at exactly the threshold (projected = threshold)', () => {
    const result = admissionGate(
      { queueDepth: 10_000, reservations: 0, rateCount: 0 },
      10_000, 200
    );
    expect(result.decision).toBe('REJECT_QUEUE');
    expect((result as any).projected).toBe(10_000);
  });

  it('rejects when queue exceeds threshold', () => {
    const result = admissionGate(
      { queueDepth: 12_000, reservations: 0, rateCount: 0 },
      10_000, 200
    );
    expect(result.decision).toBe('REJECT_QUEUE');
  });

  it('counts in-flight reservations toward the projected depth', () => {
    // 9999 queued + 1 in-flight = 10000 projected → should reject
    const result = admissionGate(
      { queueDepth: 9_999, reservations: 1, rateCount: 0 },
      10_000, 200
    );
    expect(result.decision).toBe('REJECT_QUEUE');
    expect((result as any).projected).toBe(10_000);
  });

  it('accepts when reservations bring total just under threshold', () => {
    const result = admissionGate(
      { queueDepth: 9_998, reservations: 1, rateCount: 0 },
      10_000, 200
    );
    expect(result.decision).toBe('ACCEPT');
  });
});

// ── Rate limit checks ─────────────────────────────────────────────────────────

describe('Admission gate — per-second rate limit', () => {
  it('accepts when rate is below limit', () => {
    const result = admissionGate(
      { queueDepth: 0, reservations: 0, rateCount: 10 },
      10_000, 200
    );
    expect(result.decision).toBe('ACCEPT');
  });

  it('accepts at exactly the rate limit (rateCount+1 = rateLimit)', () => {
    const result = admissionGate(
      { queueDepth: 0, reservations: 0, rateCount: 199 },
      10_000, 200
    );
    expect(result.decision).toBe('ACCEPT');
  });

  it('rejects when rateCount+1 exceeds the limit', () => {
    const result = admissionGate(
      { queueDepth: 0, reservations: 0, rateCount: 200 },
      10_000, 200
    );
    expect(result.decision).toBe('REJECT_RATE');
    expect((result as any).rate).toBe(201);
  });

  it('queue check fires before rate check (queue rejection takes priority)', () => {
    // Both conditions true — queue check runs first in the Lua script
    const result = admissionGate(
      { queueDepth: 10_000, reservations: 0, rateCount: 300 },
      10_000, 200
    );
    expect(result.decision).toBe('REJECT_QUEUE');
  });
});

// ── HTTP response contract ────────────────────────────────────────────────────
// These tests validate what the API handler should return for each decision
// without spinning up Express.  They test the branching logic that maps
// GateDecision → HTTP status + headers + body.

interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: { error: string };
}

function applyGateDecision(
  decision: GateDecision,
  threshold: number,
  rateLimit: number,
): HttpResponse | null {
  if (decision.decision === 'REJECT_RATE') {
    return {
      status: 429,
      headers: { 'Retry-After': '1' },
      body: { error: `rate limit exceeded — ${decision.rate} req/s (max ${rateLimit})` },
    };
  }
  if (decision.decision === 'REJECT_QUEUE') {
    return {
      status: 429,
      headers: { 'Retry-After': '5' },
      body: { error: `queue full — ${decision.projected}/${threshold} jobs queued` },
    };
  }
  return null; // ACCEPT — handler continues to enqueue
}

describe('HTTP response contract', () => {
  it('REJECT_RATE → 429 with Retry-After: 1', () => {
    const gate = admissionGate({ queueDepth: 0, reservations: 0, rateCount: 200 }, 10_000, 200);
    const resp = applyGateDecision(gate, 10_000, 200)!;
    expect(resp.status).toBe(429);
    expect(resp.headers['Retry-After']).toBe('1');
    expect(resp.body.error).toContain('rate limit exceeded');
  });

  it('REJECT_QUEUE → 429 with Retry-After: 5', () => {
    const gate = admissionGate({ queueDepth: 10_000, reservations: 0, rateCount: 0 }, 10_000, 200);
    const resp = applyGateDecision(gate, 10_000, 200)!;
    expect(resp.status).toBe(429);
    expect(resp.headers['Retry-After']).toBe('5');
    expect(resp.body.error).toContain('queue full');
    expect(resp.body.error).toContain('10000/10000');
  });

  it('ACCEPT → null (handler proceeds to enqueue)', () => {
    const gate = admissionGate({ queueDepth: 100, reservations: 0, rateCount: 5 }, 10_000, 200);
    expect(applyGateDecision(gate, 10_000, 200)).toBeNull();
  });
});

// ── Rejection rate metric ─────────────────────────────────────────────────────

describe('Backpressure rejection rate calculation', () => {
  function rejectionRate(accepted: number, rejected: number): number {
    const total = accepted + rejected;
    if (total === 0) return 0;
    return Number(((rejected / total) * 100).toFixed(2));
  }

  it('returns 0 when no requests have been made', () => {
    expect(rejectionRate(0, 0)).toBe(0);
  });

  it('returns 0 when nothing was rejected', () => {
    expect(rejectionRate(1000, 0)).toBe(0);
  });

  it('returns 100 when everything was rejected', () => {
    expect(rejectionRate(0, 500)).toBe(100);
  });

  it('calculates partial rejection rate correctly', () => {
    expect(rejectionRate(75, 25)).toBe(25);
    expect(rejectionRate(900, 100)).toBe(10);
  });
});
