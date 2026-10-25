import { createMemoryDocumentStore, type DocumentHead, HeadConflictError } from '@staticflux/document/v2';
import { err, ok } from '@staticflux/core';
import { describe, expect, it } from 'vitest';
import { MilestoneNameError, VersionHeadConflictError } from './errors.js';
import { EMPTY_VERSIONING_STATE, readVersioningState, updateVersioningState, VERSIONING_APP_KEY, withVersioningState } from './head-state.js';
import type { MilestoneId } from './records.js';
import { signal, unwrap } from './test-helpers.js';

const a = `ms_${'a'.repeat(64)}` as MilestoneId;
const b = `ms_${'b'.repeat(64)}` as MilestoneId;
const head: DocumentHead = { asset: 'as_1', generation: 1, engine: 'loro/1', treeSchema: 1, parts: {}, logFrom: 1, undoHorizon: 200, app: { other: 1 } };

describe('readVersioningState / withVersioningState', () => {
  it('reads an absent or malformed state as empty and drops bad entries', () => {
    expect(readVersioningState(undefined)).toBe(EMPTY_VERSIONING_STATE);
    expect(readVersioningState(head)).toBe(EMPTY_VERSIONING_STATE);
    expect(readVersioningState({ ...head, app: { [VERSIONING_APP_KEY]: [] } })).toBe(EMPTY_VERSIONING_STATE);
    const messy = { ...head, app: { [VERSIONING_APP_KEY]: { milestones: [{ id: a, size: 3 }, { id: 'x', size: 1 }, { id: b }], pinned: [a, b, 'x'], names: { [a]: 'A2', [b]: 'gone', x: 'y' }, record: { digest: 1 } } } };
    expect(readVersioningState(messy as unknown as DocumentHead)).toEqual({ milestones: [{ id: a, size: 3 }], pinned: [a], names: { [a]: 'A2' } });
  });

  it('writes under app.versioning, keeping other app fields', () => {
    const state = { milestones: [{ id: a, size: 3 }], pinned: [a], names: {}, record: { digest: 'sha256:00', size: 2 } } as const;
    const next = withVersioningState(head, state);
    expect(next.app?.['other']).toBe(1);
    expect(readVersioningState(next)).toEqual(state);
  });
});

describe('updateVersioningState', () => {
  it('swaps the head by CAS (generation + 1) and skips the write when nothing changes', async () => {
    const store = createMemoryDocumentStore();
    unwrap(await store.writeHead('as_1', head, null, signal));
    const updated = unwrap(await updateVersioningState(store, 'as_1', (s) => ok({ ...s, milestones: [{ id: a, size: 1 }] }), signal));
    expect(updated).toMatchObject({ written: true, head: { generation: 2 } });
    const same = unwrap(await updateVersioningState(store, 'as_1', () => ok(undefined), signal));
    expect(same).toMatchObject({ written: false, head: { generation: 2 } });
  });

  it('re-reads and re-applies on a conflict, then gives up with IF-VER-004', async () => {
    const store = createMemoryDocumentStore();
    unwrap(await store.writeHead('as_1', head, null, signal));
    store.failNext('writeHead', HeadConflictError());
    let calls = 0;
    unwrap(await updateVersioningState(store, 'as_1', (s) => ((calls += 1), ok({ ...s, pinned: [] })), signal));
    expect(calls).toBe(2);

    const always = { ...store, writeHead: async () => err(HeadConflictError()) };
    expect(await updateVersioningState(always, 'as_1', (s) => ok(s), signal, 3)).toMatchObject({ ok: false, error: { code: VersionHeadConflictError.code } });
  });

  it('passes through update errors, missing heads and other store errors', async () => {
    const store = createMemoryDocumentStore();
    expect(await updateVersioningState(store, 'as_none', (s) => ok(s), signal)).toMatchObject({ ok: false, error: { code: VersionHeadConflictError.code } });
    unwrap(await store.writeHead('as_1', head, null, signal));
    expect(await updateVersioningState(store, 'as_1', () => err(MilestoneNameError()), signal)).toMatchObject({ ok: false, error: { code: MilestoneNameError.code } });
    store.failNext('writeHead', MilestoneNameError());
    expect(await updateVersioningState(store, 'as_1', (s) => ok({ ...s, pinned: [] }), signal)).toMatchObject({ ok: false, error: { code: MilestoneNameError.code } });
  });
});
