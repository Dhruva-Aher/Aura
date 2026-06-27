/**
 * Structured logger tests — Phase 7 Observability
 *
 * All tests use an injected sink so no stdout is written during the suite.
 * Covers:
 *   1.  JSON output fields: ts, level, service, msg, extra ctx
 *   2.  All four log levels (debug, info, warn, error) routed correctly
 *   3.  Min-level filtering (LOG_LEVEL env var logic, injected via minLevel param)
 *   4.  Child logger merges parent context into every entry
 *   5.  Child logger overrides are allowed (child ctx wins over parent)
 *   6.  Sink receives LogEntry — not a string
 *   7.  ts is an ISO date string
 *   8.  Extra context fields are spread at the top level (not nested)
 *   9.  Logger with no extra ctx emits only the base fields
 *  10.  Multiple sinks are independent (two loggers, two sinks)
 */

import { describe, it, expect } from 'vitest';
import { Logger, LogEntry, LogLevel } from '../services/Logger';


function captureSink(): { entries: LogEntry[]; sink: (e: LogEntry) => void } {
  const entries: LogEntry[] = [];
  return { entries, sink: (e) => entries.push(e) };
}

function makeLogger(service: string, sink: (e: LogEntry) => void, minLevel: LogLevel = 'debug') {
  // Default to 'debug' in tests so all levels pass through — tests that want
  // filtering behaviour construct the Logger with explicit minLevel values.
  return new Logger(service, sink, minLevel);
}


describe('Logger — output fields', () => {
  it('emits ts, level, service, msg', () => {
    const { entries, sink } = captureSink();
    const log = makeLogger('TestService', sink);
    log.info('hello');
    const e = entries[0]!;
    expect(e.ts).toBeDefined();
    expect(e.level).toBe('info');
    expect(e.service).toBe('TestService');
    expect(e.msg).toBe('hello');
  });

  it('ts is an ISO date string', () => {
    const { entries, sink } = captureSink();
    makeLogger('X', sink).warn('test');
    expect(entries[0]!.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('spreads extra context fields at the top level', () => {
    const { entries, sink } = captureSink();
    makeLogger('S', sink).info('msg', { jobId: 'j1', durationMs: 42 });
    const e = entries[0]!;
    expect(e.jobId).toBe('j1');
    expect(e.durationMs).toBe(42);
  });

  it('emits only base fields when no ctx is provided', () => {
    const { entries, sink } = captureSink();
    makeLogger('S', sink).info('bare');
    const keys = Object.keys(entries[0]!);
    expect(keys).toEqual(expect.arrayContaining(['ts', 'level', 'service', 'msg']));
    expect(keys).toHaveLength(4);
  });
});


describe('Logger — log levels', () => {
  it('debug() emits level=debug', () => {
    const { entries, sink } = captureSink();
    makeLogger('S', sink).debug('d');
    expect(entries[0]!.level).toBe('debug');
  });

  it('info() emits level=info', () => {
    const { entries, sink } = captureSink();
    makeLogger('S', sink).info('i');
    expect(entries[0]!.level).toBe('info');
  });

  it('warn() emits level=warn', () => {
    const { entries, sink } = captureSink();
    makeLogger('S', sink).warn('w');
    expect(entries[0]!.level).toBe('warn');
  });

  it('error() emits level=error', () => {
    const { entries, sink } = captureSink();
    makeLogger('S', sink).error('e');
    expect(entries[0]!.level).toBe('error');
  });
});


describe('Logger — min-level filtering', () => {
  it('debug filtered out when minLevel=info', () => {
    const { entries, sink } = captureSink();
    const log = new Logger('S', sink, 'info');
    log.debug('hidden');
    log.info('visible');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.level).toBe('info');
  });

  it('info and warn filtered out when minLevel=error', () => {
    const { entries, sink } = captureSink();
    const log = new Logger('S', sink, 'error');
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.level).toBe('error');
  });

  it('all levels pass when minLevel=debug', () => {
    const { entries, sink } = captureSink();
    const log = new Logger('S', sink, 'debug');
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(entries).toHaveLength(4);
  });
});


describe('Logger.child()', () => {
  it('merges parent context into every entry', () => {
    const { entries, sink } = captureSink();
    const log   = makeLogger('Parent', sink);
    const child = log.child({ workerId: 'w-001', pool: 'high-priority' });
    child.info('job started', { jobId: 'j-99' });
    const e = entries[0]!;
    expect(e.workerId).toBe('w-001');
    expect(e.pool).toBe('high-priority');
    expect(e.jobId).toBe('j-99');
  });

  it('message-level ctx overrides child-level ctx', () => {
    const { entries, sink } = captureSink();
    const log   = makeLogger('S', sink);
    const child = log.child({ region: 'us-east' });
    child.info('override test', { region: 'eu-west' });
    // message-level ctx is spread last so it wins
    expect(entries[0]!.region).toBe('eu-west');
  });

  it('does not affect sibling calls on the parent logger', () => {
    const { entries, sink } = captureSink();
    const log   = makeLogger('S', sink);
    const child = log.child({ childKey: true });
    log.info('parent msg');
    child.info('child msg');
    expect(entries[0]!.childKey).toBeUndefined();
    expect(entries[1]!.childKey).toBe(true);
  });
});


describe('Logger — sink contract', () => {
  it('sink is called exactly once per log call', () => {
    const { entries, sink } = captureSink();
    const log = makeLogger('S', sink);
    log.info('one');
    log.warn('two');
    expect(entries).toHaveLength(2);
  });

  it('two independent loggers use independent sinks', () => {
    const a = captureSink();
    const b = captureSink();
    makeLogger('A', a.sink).info('from A');
    makeLogger('B', b.sink).error('from B');
    expect(a.entries).toHaveLength(1);
    expect(b.entries).toHaveLength(1);
    expect(a.entries[0]!.service).toBe('A');
    expect(b.entries[0]!.service).toBe('B');
  });
});
