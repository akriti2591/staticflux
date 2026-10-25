import { describe, expect, it } from 'vitest';
import { ACTOR_KINDS, type Actor, actorOf, actorRecord, isActor, newTransactionId, transactionMeta, VIAS } from './actor.js';
import { agent, alice } from './test-helpers.js';

describe('actor records (SF-Δ10)', () => {
  it('validates actor records', () => {
    expect(ACTOR_KINDS).toEqual(['human', 'agent', 'flow']);
    expect(VIAS).toContain('webmcp');
    expect(isActor(alice)).toBe(true);
    expect(isActor(agent)).toBe(true);
    expect(isActor({ ...alice, kind: 'system' })).toBe(false);
    expect(isActor({ ...alice, id: '' })).toBe(false);
    expect(isActor({ ...alice, via: 'telepathy' })).toBe(false);
    expect(isActor({ ...alice, displayName: 3 })).toBe(false);
    expect(isActor({ ...alice, model: 4 })).toBe(false);
    expect(isActor(null)).toBe(false);
    expect(isActor('alice')).toBe(false);
  });

  it('converts to a JSON commit-meta record without undefined fields', () => {
    expect(actorRecord(alice)).toEqual({ kind: 'human', id: 'g-alice', displayName: 'Alice', via: 'direct' });
    const run: Actor = { ...agent, invocationId: 'inv-1' };
    expect(actorRecord(run)).toEqual({ kind: 'agent', id: 'ag-1', displayName: 'Helper', via: 'chat', model: 'claude-test', invocationId: 'inv-1', onBehalfOf: 'g-alice' });
    expect(Object.values(actorRecord(alice)).includes(undefined as never)).toBe(false);
  });

  it('reads the actor back from commit meta', () => {
    expect(actorOf(transactionMeta(agent, 'Edit'))).toEqual(agent);
    expect(actorOf({ actor: { kind: 'agent', id: 'x' }, label: 'Legacy' })).toBeUndefined();
  });

  it('creates unique transaction ids', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newTransactionId()));
    expect(ids.size).toBe(200);
  });

  it('builds transaction meta with txn, via, invocation and change set', () => {
    const meta = transactionMeta({ ...agent, invocationId: 'inv-9' }, 'Tidy up', { changeSet: 'cs_1' });
    expect(meta).toMatchObject({ label: 'Tidy up', via: 'chat', invocation: 'inv-9', changeSet: 'cs_1' });
    expect(typeof meta.txn).toBe('string');
    expect(transactionMeta(alice, 'Move', { txn: 't-fixed' }).txn).toBe('t-fixed');
    expect('invocation' in transactionMeta(alice, 'Move')).toBe(false);
  });
});
