import { box, createScope, err, ok, type Result, sfError } from '@staticflux/core';
import { describe, expect, it } from 'vitest';
import { createMirrorHub, createMirrorServers, defineMirror, type MirrorUpdate, reportFailure } from './mirror.js';
import { fromWire, toWire, WIRE_ERROR_KEY } from './wire.js';

const failure = sfError({ code: 'IF-TEST-001' as never, kind: 'validation', message: 'Nope.', fix: 'Do it right.', details: { a: 1 } });

describe('wire values (B9)', () => {
  it('marks SfErrors anywhere in a value and restores them; plain data and typed arrays pass through', () => {
    const value = { result: err(failure), list: [ok(1), { cause: failure }], bytes: new Uint8Array([1, 2]), n: 3, fn: () => 1 };
    const wire = toWire(value) as Record<string, unknown>;
    expect(JSON.stringify(wire)).toContain(WIRE_ERROR_KEY);
    expect('fn' in wire).toBe(false);
    const back = fromWire<{ result: Result<never>; list: [Result<number>, { cause: unknown }]; bytes: Uint8Array; n: number }>(structuredClone(wire));
    expect(!back.result.ok && back.result.error.code).toBe('IF-TEST-001');
    expect(!back.result.ok && back.result.error.fix).toBe('Do it right.');
    expect(back.list[0]).toEqual({ ok: true, value: 1 });
    expect((back.list[1].cause as { message: string }).message).toBe('Nope.');
    expect([...back.bytes]).toEqual([1, 2]);
    expect(back.n).toBe(3);
  });
});

interface CounterShape {
  readonly reads: { readonly count: number; readonly label: string | undefined; readonly last: Result<number> | undefined };
  readonly actions: { add(n: number): Result<number>; fail(): Result<void>; later(n: number): Promise<Result<number>>; plain(): string };
}
const CounterMirror = defineMirror<CounterShape>('instaflow/mirror/test-counter', { count: 0, label: undefined, last: undefined });

function setup() {
  const scope = createScope('mirror-test');
  const count = box(0);
  let label = 'a';
  const listeners = new Set<() => void>();
  const updates: MirrorUpdate[] = [];
  const servers = createMirrorServers((u) => {
    const copy = structuredClone(u);
    updates.push(copy);
    hub.apply(copy);
  }, { schedule: (fn) => fn() });
  const hub = createMirrorHub((call) => servers.call(structuredClone(call)));
  servers.serve(
    CounterMirror,
    {
      reads: { count: () => count.get(), label: () => label, last: () => (count.get() > 1 ? err(failure) : ok(count.get())) },
      actions: {
        add: (n) => {
          count.set(count.get() + n);
          return ok(count.get());
        },
        fail: () => err(failure),
        later: async (n) => ok(n * 2),
        plain: () => 'plain',
      },
      changes: (l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    },
    scope,
  );
  return { scope, count, setLabel: (l: string) => (label = l), changed: () => listeners.forEach((l) => l()), updates, hub, servers };
}

describe('service mirrors (B9)', () => {
  it('posts reads when tracked values change or a change signal fires (only when they differ); main reads them reactively', async () => {
    const m = setup();
    const view = m.hub.view(CounterMirror);
    expect(view.ready).toBe(true);
    expect(view.read('count')).toBe(0);
    m.count.set(1);
    expect(view.read('count')).toBe(1);
    const posts = m.updates.length;
    m.changed(); // nothing differs: no post
    expect(m.updates.length).toBe(posts);
    m.setLabel('b'); // not reactive: the change signal re-reads
    m.changed();
    expect(view.read('label')).toBe('b');
    m.count.set(2);
    const last = view.read('last');
    expect(last !== undefined && !last.ok && last.error.code).toBe('IF-TEST-001');
    await m.scope.dispose();
  });

  it('forwards actions and answers with the worker result; unknown mirrors and actions are IF-WRK-003', async () => {
    const m = setup();
    const view = m.hub.view(CounterMirror);
    const changes: number[] = [];
    view.onChange(() => changes.push(view.read('count')));
    expect(await view.call('add', 2)).toEqual({ ok: true, value: 2 });
    expect(changes.at(-1)).toBe(2);
    const failed = await view.call('fail');
    expect(!failed.ok && failed.error.code).toBe('IF-TEST-001');
    expect(await view.call('later', 4)).toEqual({ ok: true, value: 8 });
    expect(await view.call('plain')).toEqual({ ok: true, value: 'plain' });
    expect((await m.servers.call({ id: 'instaflow/mirror/nope', action: 'x', args: [] })).ok).toBe(false);
    const unknown = await m.servers.call({ id: CounterMirror.id, action: 'nope', args: [] });
    expect(!unknown.ok && unknown.error.code).toBe('IF-WRK-003');
    const problems: string[] = [];
    reportFailure(view.call('fail'), (e) => problems.push(e.code));
    await new Promise((r) => setTimeout(r, 0));
    expect(problems).toEqual(['IF-TEST-001']);
    await m.scope.dispose();
    expect((await view.call('add', 1)).ok).toBe(false); // the scope ended: no longer served
  });

  it('reposts every mirror on request (a late subscriber) and keeps posts for views created later', async () => {
    const m = setup();
    const before = m.updates.length;
    m.servers.repost();
    expect(m.updates.length).toBe(before + 1);
    const hub = createMirrorHub(async () => ok(undefined));
    hub.apply({ id: CounterMirror.id, values: { count: 7 } });
    expect(hub.view(CounterMirror).read('count')).toBe(7);
    expect(hub.view(CounterMirror).read('label')).toBeUndefined(); // the initial value for reads not posted
    expect(hub.view(CounterMirror)).toBe(hub.view(CounterMirror));
    await m.scope.dispose();
  });
});
