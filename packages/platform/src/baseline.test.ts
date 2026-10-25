import { createScope } from '@staticflux/core';
import { describe, expect, it, vi } from 'vitest';
import {
  type AsyncFactReading,
  checkBaseline,
  checkBaselineSync,
  createAsyncFactLane,
  createFakePlatformEnv,
  defineAsyncFact,
  defineBaseline,
  evaluateBaseline,
  readWebApis,
  requireApi,
  requireFact,
  type WebApiFacts,
} from './index.js';

const adapterFact = defineAsyncFact({ id: 'test/adapter', probe: async () => ({ ok: true }) });
const baseline = defineBaseline({
  id: 'test-app',
  code: 'APP-PLAT-001',
  fix: 'Use Chrome on desktop.',
  requirements: [
    requireApi('webCodecs', { label: 'WebCodecs' }),
    requireApi('crossOriginIsolated', { label: 'Cross-origin isolation', code: 'APP-PLAT-003', fix: 'Serve COOP/COEP headers.' }),
    requireFact(adapterFact, (value) => value.ok, { label: 'A GPU adapter', code: 'APP-PLAT-002' }),
  ],
});

const allApis = (overrides: Partial<WebApiFacts> = {}): WebApiFacts => ({
  ...Object.fromEntries(Object.keys(readWebApis(createFakePlatformEnv())).map((k) => [k, true])),
  ...overrides,
}) as WebApiFacts;
const reading = (state: AsyncFactReading<unknown>['state'], value?: unknown): AsyncFactReading<unknown> => ({ state, value, error: undefined });

describe('baseline definitions', () => {
  it('requireApi / requireFact derive ids and leave code and fix to the baseline', () => {
    expect(requireApi('editContext', { label: 'EditContext' })).toMatchObject({ kind: 'api', id: 'api:editContext', code: undefined, fix: undefined });
    expect(requireApi('editContext', { id: 'text-input', label: 'x' }).id).toBe('text-input');
    expect(requireFact(adapterFact, () => true, { label: 'GPU' })).toMatchObject({ kind: 'fact', id: 'fact:test/adapter', fact: adapterFact });
    expect(baseline.kind).toBe('baseline');
    expect(Object.isFrozen(baseline)).toBe(true);
  });
});

describe('evaluateBaseline', () => {
  it('supported when every API is present and every fact accepted', () => {
    const verdict = evaluateBaseline(baseline, allApis(), () => reading('settled', { ok: true }));
    expect(verdict).toEqual({ baseline: 'test-app', status: 'supported', missing: [], pending: [], codes: [] });
  });

  it('pending while async facts are unknown, idle or probing', () => {
    expect(evaluateBaseline(baseline, allApis()).pending).toEqual(['fact:test/adapter']);
    expect(evaluateBaseline(baseline, allApis(), () => reading('probing')).status).toBe('pending');
    expect(evaluateBaseline(baseline, allApis(), () => reading('idle')).status).toBe('pending');
  });

  it('unsupported beats pending; misses carry the requirement or baseline code and fix, in order', () => {
    const verdict = evaluateBaseline(baseline, allApis({ webCodecs: false, crossOriginIsolated: false }));
    expect(verdict.status).toBe('unsupported');
    expect(verdict.pending).toEqual(['fact:test/adapter']);
    expect(verdict.missing).toEqual([
      { id: 'api:webCodecs', label: 'WebCodecs', code: 'APP-PLAT-001', fix: 'Use Chrome on desktop.', reason: 'absent' },
      { id: 'api:crossOriginIsolated', label: 'Cross-origin isolation', code: 'APP-PLAT-003', fix: 'Serve COOP/COEP headers.', reason: 'absent' },
    ]);
    expect(verdict.codes).toEqual(['APP-PLAT-001', 'APP-PLAT-003']);
  });

  it('a settled fact that is not accepted is "rejected"; a throwing accept counts as rejected', () => {
    const rejected = evaluateBaseline(baseline, allApis(), () => reading('settled', { ok: false }));
    expect(rejected.missing).toEqual([{ id: 'fact:test/adapter', label: 'A GPU adapter', code: 'APP-PLAT-002', fix: 'Use Chrome on desktop.', reason: 'rejected' }]);
    const throws = defineBaseline({
      ...baseline,
      requirements: [
        requireFact(adapterFact, () => {
          throw new Error('bad accept');
        }, { label: 'GPU' }),
      ],
    });
    expect(evaluateBaseline(throws, allApis(), () => reading('settled', {})).missing[0]?.reason).toBe('rejected');
  });

  it('failed or disposed facts are "probe-failed"', () => {
    expect(evaluateBaseline(baseline, allApis(), () => reading('failed')).missing[0]?.reason).toBe('probe-failed');
    expect(evaluateBaseline(baseline, allApis(), () => reading('disposed')).missing[0]?.reason).toBe('probe-failed');
  });

  it('distinct codes keep first-seen order', () => {
    const verdict = evaluateBaseline(
      defineBaseline({ id: 'b', code: 'APP-1', fix: 'f', requirements: [requireApi('webGpu', { label: 'a' }), requireApi('webLocks', { label: 'b' })] }),
      allApis({ webGpu: false, webLocks: false }),
    );
    expect(verdict.codes).toEqual(['APP-1']);
  });
});

describe('checkBaselineSync', () => {
  it('reads the env and leaves async requirements pending', () => {
    const verdict = checkBaselineSync(baseline, createFakePlatformEnv({ globals: { crossOriginIsolated: true } }));
    expect(verdict.status).toBe('unsupported');
    expect(verdict.missing.map((m) => m.id)).toEqual(['api:webCodecs']);
    expect(verdict.pending).toEqual(['fact:test/adapter']);
  });
});

describe('checkBaseline', () => {
  const fn = (): void => {};
  const chromeEnv = createFakePlatformEnv({
    globals: { VideoDecoder: fn, VideoEncoder: fn, AudioDecoder: fn, AudioEncoder: fn, crossOriginIsolated: true },
  });

  it('a synchronous miss short-circuits: no async probe runs', async () => {
    const probe = vi.fn(async () => ({ ok: true }));
    const fact = defineAsyncFact({ id: 'test/spy', probe });
    const spyBaseline = defineBaseline({ ...baseline, requirements: [requireApi('webCodecs', { label: 'x' }), requireFact(fact, (v) => v.ok, { label: 'y' })] });
    const env = createFakePlatformEnv();
    const verdict = await checkBaseline(spyBaseline, { env, lane: createAsyncFactLane({ env, scope: createScope('test') }) });
    expect(verdict.status).toBe('unsupported');
    expect(probe).not.toHaveBeenCalled();
  });

  it('resolves async requirements through the lane and caches them there', async () => {
    const lane = createAsyncFactLane({ env: chromeEnv, scope: createScope('test') });
    const verdict = await checkBaseline(baseline, { env: chromeEnv, lane });
    expect(verdict.status).toBe('supported');
    expect(lane.read(adapterFact).state).toBe('settled');
  });

  it('a probe that throws is a miss, not a rejection', async () => {
    const broken = defineAsyncFact({
      id: 'test/broken',
      probe: async (): Promise<{ ok: boolean }> => {
        throw new Error('crash');
      },
    });
    const b = defineBaseline({ ...baseline, requirements: [requireFact(broken, (v) => v.ok, { label: 'GPU', code: 'APP-PLAT-002' })] });
    const verdict = await checkBaseline(b, { env: chromeEnv, lane: createAsyncFactLane({ env: chromeEnv, scope: createScope('test') }) });
    expect(verdict).toMatchObject({ status: 'unsupported', codes: ['APP-PLAT-002'] });
    expect(verdict.missing[0]?.reason).toBe('probe-failed');
  });

  it('an aborted check stays pending; precomputed apis are used as given', async () => {
    const lane = createAsyncFactLane({ env: chromeEnv, scope: createScope('test') });
    const aborted = await checkBaseline(baseline, { env: chromeEnv, lane, signal: AbortSignal.abort() });
    expect(aborted.status).toBe('pending');
    const given = await checkBaseline(baseline, { env: createFakePlatformEnv(), lane, apis: allApis() });
    expect(given.status).toBe('supported');
  });
});
