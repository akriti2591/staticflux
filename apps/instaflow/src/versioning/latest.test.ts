import { err, ok, type Result, type SfError } from '@staticflux/core';
import { type CommitRecord, HeadConflictError } from '@staticflux/document/v2';
import { describe, expect, it } from 'vitest';
import { createLatestService, deriveSaveState, type LatestSource, type MirrorStatusSource, type SaveClock, type SaveState } from './latest.js';
import { createCountingStore, priya, repoOn, seedDocument, signal, unwrap } from './test-helpers.js';

function manualClock(): SaveClock & { advance(ms: number): void } {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout(fn, ms) {
      seq += 1;
      timers.set(seq, { at: now + ms, fn });
      return seq;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at > now) continue;
        timers.delete(id);
        timer.fn();
      }
    },
  };
}

/** A document whose flushes resolve when the test says so. */
function controlledDoc(): LatestSource & { commit(): void; ack(result?: Result<void>): void; ackOldest(): void; pending(): number } {
  const listeners = new Set<(record: CommitRecord) => void>();
  const waiting: ((r: Result<void>) => void)[] = [];
  return {
    onCommit(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    flush: () => new Promise<Result<void>>((resolve) => waiting.push(resolve)),
    commit() {
      for (const l of listeners) l({ peer: '1', meta: { actor: { kind: 'human', id: 'h' }, label: 'x' }, updates: {}, inverse: {} });
    },
    ack(result = ok()) {
      for (const resolve of waiting.splice(0)) resolve(result);
    },
    ackOldest() {
      waiting.shift()?.(ok());
    },
    pending: () => waiting.length,
  };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function mirrorStub(): MirrorStatusSource & { set(state: string, extra?: { pending?: number; lastError?: SfError; readOnly?: boolean }): void } {
  const listeners = new Set<() => void>();
  const stub = {
    state: 'idle',
    readOnly: false,
    pending: 0,
    lastError: undefined as SfError | undefined,
    onStateChange(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(state: string, extra: { pending?: number; lastError?: SfError; readOnly?: boolean } = {}) {
      stub.state = state;
      stub.pending = extra.pending ?? 0;
      stub.lastError = extra.lastError;
      stub.readOnly = extra.readOnly ?? false;
      for (const l of listeners) l();
    },
  };
  return stub;
}

describe('deriveSaveState', () => {
  it('maps the local machine and the mirror onto the three statuses', () => {
    const cause = HeadConflictError();
    expect(deriveSaveState('saved', undefined, undefined, 1)).toEqual({ status: 'saved', stalled: false, since: 1 });
    expect(deriveSaveState('saving', undefined, undefined, 1)).toEqual({ status: 'saving', stalled: false, since: 1 });
    expect(deriveSaveState('stalled', undefined, cause, 1)).toMatchObject({ status: 'saving', stalled: true, cause });
    const mirror = { state: 'paused', readOnly: true, pending: 3, lastError: undefined, onStateChange: () => () => {} };
    expect(deriveSaveState('saved', mirror, undefined, 1).status).toBe('offline-mirror-behind');
    expect(deriveSaveState('saved', { ...mirror, state: 'flushing', readOnly: false }, undefined, 1).status).toBe('saved');
    expect(deriveSaveState('saved', { ...mirror, state: 'scheduled', readOnly: false, lastError: cause }, undefined, 1)).toMatchObject({ status: 'offline-mirror-behind', cause });
    expect(deriveSaveState('saving', mirror, undefined, 1).status).toBe('saving');
  });
});

describe('createLatestService', () => {
  it('saved → saving on a commit → saved when acknowledged; no save button anywhere', async () => {
    const doc = controlledDoc();
    const clock = manualClock();
    const latest = createLatestService({ doc, clock });
    const seen: SaveState['status'][] = [];
    latest.onChange((s) => seen.push(s.status));
    expect(latest.state().status).toBe('saved');
    doc.commit();
    expect(latest.state()).toMatchObject({ status: 'saving', stalled: false });
    doc.ack();
    await tick();
    expect(latest.state().status).toBe('saved');
    expect(seen).toEqual(['saving', 'saved']);
    latest.dispose();
  });

  it('stays saving until the newest commit is acknowledged', async () => {
    const doc = controlledDoc();
    const latest = createLatestService({ doc, clock: manualClock() });
    doc.commit();
    doc.commit();
    expect(doc.pending()).toBe(2);
    doc.ackOldest(); // the first commit is durable, the second is not
    await tick();
    expect(latest.state().status).toBe('saving');
    doc.ackOldest();
    await tick();
    expect(latest.state().status).toBe('saved');
    latest.dispose();
  });

  it('after 2 s without an acknowledgement: "Not saved yet"', async () => {
    const doc = controlledDoc();
    const clock = manualClock();
    const latest = createLatestService({ doc, clock });
    doc.commit();
    clock.advance(1999);
    expect(latest.state().stalled).toBe(false);
    clock.advance(1);
    expect(latest.state()).toMatchObject({ status: 'saving', stalled: true });
    expect(latest.state().cause).toBeUndefined();
    doc.ack();
    await tick();
    expect(latest.state()).toMatchObject({ status: 'saved', stalled: false });
    latest.dispose();
  });

  it('an append failure stalls with its cause and retries until it succeeds', async () => {
    const doc = controlledDoc();
    const clock = manualClock();
    const latest = createLatestService({ doc, clock, retryMs: 500 });
    doc.commit();
    const cause = HeadConflictError({ message: 'quota exceeded' });
    doc.ack(err(cause));
    await tick();
    expect(latest.state()).toMatchObject({ status: 'saving', stalled: true, cause: { message: 'quota exceeded' } });
    expect(doc.pending()).toBe(0);
    clock.advance(500); // retry
    expect(doc.pending()).toBe(1);
    expect(latest.state().stalled).toBe(false);
    doc.ack();
    await tick();
    expect(latest.state().status).toBe('saved');
    latest.dispose();
  });

  it('reports the folder mirror falling behind once everything is durable locally', () => {
    const doc = controlledDoc();
    const mirror = mirrorStub();
    const latest = createLatestService({ doc, mirror, clock: manualClock() });
    mirror.set('paused', { readOnly: true, pending: 4 });
    expect(latest.state().status).toBe('offline-mirror-behind');
    mirror.set('idle');
    expect(latest.state().status).toBe('saved');
    latest.dispose();
    mirror.set('paused');
    expect(latest.state().status).toBe('saved'); // disposed: no longer listening
  });

  it('works on a real DocumentRepo: commit → saving → durable → saved; a failed append recovers', async () => {
    const store = createCountingStore();
    const doc = await seedDocument(repoOn(store), 'as_doc', 1);
    const clock = manualClock();
    const latest = createLatestService({ doc, clock, retryMs: 10 });
    unwrap(doc.commit({ actor: { kind: 'human', id: priya.id }, label: 'Nudge' }, { 'page:p0': [{ op: 'set', node: 's0-0', path: 'spatial.x', value: 1 }] }));
    expect(latest.state().status).toBe('saving');
    unwrap(await latest.flush(signal));
    await tick();
    expect(latest.state().status).toBe('saved');

    store.inner.failNext('appendLog', HeadConflictError({ message: 'disk full' }));
    unwrap(doc.commit({ actor: { kind: 'human', id: priya.id }, label: 'Nudge' }, { 'page:p0': [{ op: 'set', node: 's0-0', path: 'spatial.x', value: 2 }] }));
    for (let i = 0; i < 5 && !latest.state().stalled; i += 1) await tick();
    expect(latest.state()).toMatchObject({ stalled: true, cause: { message: 'disk full' } });
    clock.advance(10);
    for (let i = 0; i < 5 && latest.state().status !== 'saved'; i += 1) await tick();
    expect(latest.state().status).toBe('saved');
    latest.dispose();
  });
});
