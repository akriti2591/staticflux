import { defineError, err, ok } from '@staticflux/core';
import { describe, expect, it, vi } from 'vitest';
import {
  createMockRemoteTransport,
  createModelAdvisor,
  createRemoteAdvisor,
  type DecisionModelPort,
  defineDecisionPoint,
  modelBinding,
  remoteBinding,
} from './index.js';

const Retention = defineDecisionPoint({
  id: 'runtime/retention',
  purpose: 'retention',
  options: ['keep', 'archive', 'evict'] as const,
  latency: 'background',
  heuristic: () => 'keep',
});
const Other = defineDecisionPoint({ id: 'x/other', purpose: 'sampling', options: ['a'] as const, latency: 'sync', heuristic: () => 'a' });

const ctx = () => ({ signal: new AbortController().signal });

describe('model advisor', () => {
  it('sends the encoded question and the closed options to the model', async () => {
    const decide = vi.fn<DecisionModelPort['decide']>(async () =>
      ok({ probabilities: { keep: 0.2, archive: 0.8 }, confidence: 0.9, explanation: 'idle for 20 min' }),
    );
    const advisor = createModelAdvisor({
      id: 'jev',
      model: { decide },
      bindings: [modelBinding(Retention, (q: { idleMinutes: number; secret: string }) => ({ idleMinutes: q.idleMinutes }))],
    });
    expect(advisor.tier).toBe('model');
    expect(advisor.latency).toBe('background');
    expect(advisor.supports(Retention)).toBe(true);
    expect(advisor.supports(Other)).toBe(false);
    const answer = await advisor.advise(Retention, { idleMinutes: 20, secret: 'doc text' }, ctx());
    expect(answer).toEqual(ok({ distribution: { keep: 0.2, archive: 0.8 }, confidence: 0.9, explanation: 'idle for 20 min' }));
    expect(decide.mock.calls[0]?.[0]).toMatchObject({ question: { idleMinutes: 20 }, options: ['keep', 'archive', 'evict'] });
    expect(await advisor.advise(Other, {}, ctx())).toMatchObject({ ok: false, error: { code: 'SF-ADV-006' } });
  });

  it('passes model errors through', async () => {
    const Down = defineError('SF-TESTADV-001', 'unavailable', 'down', 'later');
    const advisor = createModelAdvisor({ id: 'm', model: { decide: async () => err(Down()) }, bindings: [modelBinding(Retention, () => ({}))] });
    expect(await advisor.advise(Retention, {}, ctx())).toMatchObject({ ok: false, error: { code: 'SF-TESTADV-001' } });
  });
});

describe('remote advisor', () => {
  it('sends only the declared feature vector (R19.14)', async () => {
    const transport = createMockRemoteTransport(() => ({ probabilities: { evict: 1 } }));
    const advisor = createRemoteAdvisor({
      id: 'remote',
      transport,
      bindings: [remoteBinding(Retention, (q: { idleMinutes: number; content: string }) => ({ idleBucket: q.idleMinutes > 10 ? 'long' : 'short' }))],
    });
    expect(advisor.tier).toBe('remote');
    expect(await advisor.advise(Retention, { idleMinutes: 30, content: 'PRIVATE' }, ctx())).toEqual(ok({ distribution: { evict: 1 } }));
    expect(transport.requests).toEqual([{ point: 'runtime/retention', options: ['keep', 'archive', 'evict'], features: { idleBucket: 'long' } }]);
    expect(JSON.stringify(transport.requests)).not.toContain('PRIVATE');
    expect(await advisor.advise(Other, {}, ctx())).toMatchObject({ ok: false, error: { code: 'SF-ADV-006' } });
  });

  it('mock transport supports latency, abort and error results', async () => {
    const Rate = defineError('SF-TESTADV-002', 'rate', 'slow down', 'later');
    const slow = createMockRemoteTransport(() => err(Rate()), { latencyMs: 5 });
    expect(await slow.advise({ point: 'p/x', options: [], features: {} }, new AbortController().signal)).toMatchObject({
      ok: false,
      error: { code: 'SF-TESTADV-002' },
    });
    const controller = new AbortController();
    const pending = slow.advise({ point: 'p/x', options: [], features: {} }, controller.signal);
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, error: { kind: 'aborted' } });
  });
});
