import { describe, expect, it, vi } from 'vitest';
import {
  AbortedError,
  backoffDelay,
  createCircuitBreaker,
  createDeferred,
  createLimiter,
  createMachine,
  createScope,
  createSingleFlight,
  defineError,
  defineMachine,
  err,
  isSfError,
  listErrorDefinitions,
  map,
  ok,
  retry,
  sleep,
  type Task,
  task,
  timeout,
  toSfError,
  unwrap,
  attempt,
} from './index.js';

describe('errors & result', () => {
  it('defineError registers in the catalog and creates typed errors', () => {
    const Boom = defineError('SF-TEST-001', 'conflict', 'Boom happened.', 'Do not boom.');
    const e = Boom({ units: ['a/b'] });
    expect(isSfError(e)).toBe(true);
    expect(e.code).toBe('SF-TEST-001');
    expect(e.kind).toBe('conflict');
    expect(e.fix).toBe('Do not boom.');
    expect(listErrorDefinitions().some((d) => d.code === 'SF-TEST-001')).toBe(true);
  });

  it('defineError allows identical re-definition but rejects a clashing one', () => {
    const a = defineError('SF-TEST-DUP', 'conflict', 'Dup.', 'Fix.');
    expect(defineError('SF-TEST-DUP', 'conflict', 'Dup.', 'Fix.')).toBe(a);
    expect(() => defineError('SF-TEST-DUP', 'network', 'Other.', 'Fix.')).toThrow(/already defined/);
  });

  it('toSfError maps AbortError and unknown values', () => {
    expect(toSfError(new DOMException('x', 'AbortError')).kind).toBe('aborted');
    expect(toSfError('nope').code).toBe('SF-CORE-000');
  });

  it('result helpers', () => {
    expect(map(ok(2), (n) => n * 2)).toEqual(ok(4));
    expect(attempt(() => JSON.parse('{')).ok).toBe(false);
    expect(() => unwrap(err(AbortedError()))).toThrow();
  });
});

describe('scope', () => {
  it('disposes children first, then resources LIFO, and aborts its signal', async () => {
    const order: string[] = [];
    const root = createScope('root');
    root.defer(() => {
      order.push('root-1');
    });
    const child = root.child('child');
    child.defer(() => {
      order.push('child');
    });
    root.defer(() => {
      order.push('root-2');
    });
    await root.dispose();
    expect(order).toEqual(['child', 'root-2', 'root-1']);
    expect(root.signal.aborted).toBe(true);
    expect(child.disposed).toBe(true);
  });

  it('runs late cleanups immediately and collects errors', async () => {
    const onError = vi.fn();
    const scope = createScope('s', { onError });
    scope.defer(() => {
      throw new Error('bad');
    });
    const errors = await scope.dispose();
    expect(errors).toHaveLength(1);
    const late = vi.fn();
    scope.defer(late);
    expect(late).toHaveBeenCalled();
  });

  it('removes listeners on dispose', async () => {
    const scope = createScope('s');
    const target = new EventTarget();
    const handler = vi.fn();
    scope.listen(target, 'ping', handler);
    target.dispatchEvent(new Event('ping'));
    await scope.dispose();
    target.dispatchEvent(new Event('ping'));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('use() disposes Disposable resources', async () => {
    const scope = createScope('s');
    const disposed = vi.fn();
    scope.use({ [Symbol.dispose]: disposed });
    await scope.dispose();
    expect(disposed).toHaveBeenCalled();
  });
});

describe('async primitives', () => {
  const signal = new AbortController().signal;

  it('backoffDelay grows exponentially, caps, and applies full jitter', () => {
    expect(backoffDelay(1, 100, 1000, 'none')).toBe(100);
    expect(backoffDelay(3, 100, 1000, 'none')).toBe(400);
    expect(backoffDelay(10, 100, 1000, 'none')).toBe(1000);
    expect(backoffDelay(3, 100, 1000, 'full', () => 0.5)).toBe(200);
  });

  it('retry retries retryable errors and stops on success', async () => {
    let calls = 0;
    const flaky: Task<string> = async () => {
      calls += 1;
      return calls < 3 ? err(toSfError(Object.assign(new Error('net'), {}))) : ok('done');
    };
    const retryable = defineError('SF-TEST-NET', 'network', 'net', 'retry');
    const flakyNet: Task<string> = async () => {
      calls += 1;
      return calls < 3 ? err(retryable()) : ok('done');
    };
    calls = 0;
    const result = await retry(flakyNet, { attempts: 5, baseDelayMs: 1, random: () => 0 })(signal);
    expect(result).toEqual(ok('done'));
    expect(calls).toBe(3);
    calls = 0;
    const unknown = await retry(flaky, { attempts: 5, baseDelayMs: 1 })(signal);
    expect(unknown.ok).toBe(false);
    expect(calls).toBe(1); // unknown errors are not retried by default
  });

  it('retry honours a server retryAfterMs hint (capped at maxDelayMs)', async () => {
    const Rate = defineError('SF-TEST-RATE', 'rate', 'slow down', 'wait');
    let calls = 0;
    const delays: number[] = [];
    const limited: Task<string> = async () => {
      calls += 1;
      return calls < 2 ? err(Rate({ details: { retryAfterMs: 7 } })) : ok('done');
    };
    const result = await retry(limited, { attempts: 3, maxDelayMs: 50, onRetry: (_e, _a, d) => delays.push(d) })(signal);
    expect(result).toEqual(ok('done'));
    expect(delays).toEqual([7]);
  });

  it('timeout aborts the inner task', async () => {
    let innerSignal: AbortSignal | undefined;
    const slow = task(async (s) => {
      innerSignal = s;
      await new Promise((r) => setTimeout(r, 50));
      return 'late';
    });
    const result = await timeout(slow, 5)(signal);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('timeout');
    expect(innerSignal?.aborted).toBe(true);
  });

  it('sleep resolves aborted when signal aborts', async () => {
    const controller = new AbortController();
    const pending = sleep(1000, controller.signal);
    controller.abort();
    const result = await pending;
    expect(result.ok).toBe(false);
  });

  it('singleFlight coalesces concurrent runs', async () => {
    const flight = createSingleFlight<string, number>();
    let runs = 0;
    const d = createDeferred<void>();
    const t: Task<number> = async () => {
      runs += 1;
      await d.promise;
      return ok(42);
    };
    const a = flight.run('k', t, signal);
    const b = flight.run('k', t, signal);
    expect(flight.inFlight('k')).toBe(true);
    d.resolve();
    expect(await a).toEqual(ok(42));
    expect(await b).toEqual(ok(42));
    expect(runs).toBe(1);
  });

  it('limiter caps concurrency', async () => {
    const limiter = createLimiter(2);
    let peak = 0;
    let active = 0;
    const t: Task<void> = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return ok();
    };
    await Promise.all([1, 2, 3, 4, 5].map(() => limiter.run(t, signal)));
    expect(peak).toBe(2);
  });

  it('circuit breaker opens after threshold and half-opens after reset', async () => {
    let now = 0;
    const breaker = createCircuitBreaker({ failureThreshold: 2, resetAfterMs: 100, now: () => now });
    const Net = defineError('SF-TEST-NET2', 'network', 'net', 'retry');
    const failing: Task<void> = async () => err(Net());
    await breaker.run(failing, signal);
    await breaker.run(failing, signal);
    expect(breaker.state).toBe('open');
    const blocked = await breaker.run(async () => ok(), signal);
    expect(blocked.ok).toBe(false);
    now = 150;
    expect(breaker.state).toBe('half-open');
    await breaker.run(async () => ok(), signal);
    expect(breaker.state).toBe('closed');
  });
});

describe('machine', () => {
  const def = defineMachine({
    id: 'test/door',
    initial: 'closed',
    states: ['closed', 'open', 'locked'],
    transitions: {
      closed: { open: 'open', lock: 'locked' },
      open: { close: 'closed' },
      locked: { unlock: 'closed' },
    },
  });

  it('applies valid transitions and rejects invalid ones', () => {
    const m = createMachine(def);
    const seen: string[] = [];
    m.onTransition((r) => seen.push(`${r.from}->${r.to}`));
    expect(m.send('open')).toEqual(ok('open'));
    const bad = m.send('lock');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe('SF-CORE-010');
    expect(m.state).toBe('open');
    expect(m.can('close')).toBe(true);
    expect(seen).toEqual(['closed->open']);
  });
});

describe('reactivity tracker', () => {
  it('invalidates when a tracked value changes and stops after dispose', async () => {
    const { box, createTracker } = await import('./index.js');
    const value = box(1);
    let invalidations = 0;
    const tracker = createTracker('test', () => {
      invalidations += 1;
    });
    expect(tracker.track(() => value.get() * 2)).toBe(2);
    value.set(2);
    expect(invalidations).toBe(1);
    tracker.track(() => value.get());
    tracker.dispose();
    value.set(3);
    expect(invalidations).toBe(1);
  });
});
