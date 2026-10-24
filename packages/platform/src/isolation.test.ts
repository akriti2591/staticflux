import { createInjector, createMemorySink, createScope, createTelemetry, token, unit, unwrap } from '@staticflux/core';
import { describe, expect, it } from 'vitest';
import {
  createFakePlatformEnv,
  createIsolationPolicy,
  type IsolationFacts,
  IsolationPolicyToken,
  isolationPolicyUnit,
  IsolationReportingToken,
  isolationUnits,
  offIsolationPolicy,
  platformEnvUnit,
  readIsolationFacts,
  type ReportLike,
  startIsolationReporting,
  toLoaderIsolationPolicy,
  toSurfaceImagePolicy,
  toUiIsolationPolicy,
  toWorkerIsolationFacts,
  violationFromReport,
} from './index.js';

const O = 'https://app.test';
const facts = (overrides: Partial<IsolationFacts> = {}): IsolationFacts => ({
  crossOriginIsolated: true,
  embedded: false,
  sharedArrayBuffer: true,
  credentiallessIframes: true,
  ...overrides,
});
const isolatedGlobals = {
  crossOriginIsolated: true,
  SharedArrayBuffer: function SharedArrayBuffer() {},
  Atomics: {},
  HTMLIFrameElement: { prototype: { credentialless: false } },
};

describe('IsolationPolicy (R11.16b)', () => {
  it('reads facts through PlatformEnv', () => {
    expect(readIsolationFacts(createFakePlatformEnv({ globals: isolatedGlobals }))).toEqual(facts());
    expect(readIsolationFacts(createFakePlatformEnv({ embedded: true }))).toEqual({
      crossOriginIsolated: false,
      embedded: true,
      sharedArrayBuffer: false,
      credentiallessIframes: false,
    });
  });

  it('isolated + require-corp: CORS attributes for cross-origin, nothing for same-origin/data/blob', () => {
    const p = createIsolationPolicy({ mode: 'preferred', origin: O, credentialedOrigins: ['https://api.test'] }, facts());
    expect(p).toMatchObject({ isolated: true, sharedMemory: true, status: 'isolated', reason: undefined, coep: 'require-corp', gateReason: undefined });
    expect(p.crossOriginAttr('https://cdn.test/a.png', 'img')).toBe('anonymous');
    expect(p.crossOriginAttr('https://api.test/avatar.png')).toBe('use-credentials');
    expect(p.crossOriginAttr('/local.png')).toBeUndefined();
    expect(p.crossOriginAttr('data:image/png;base64,AA')).toBeUndefined();
    expect(p.crossOriginAttr('blob:https://app.test/1')).toBeUndefined();
    expect(p.crossOriginAttr('http://[bad')).toBeUndefined();
    expect(p.fetchInit('https://cdn.test/x.json')).toEqual({ mode: 'cors', credentials: 'same-origin' });
    expect(p.fetchInit('https://api.test/x')).toEqual({ mode: 'cors', credentials: 'include' });
    expect(p.fetchInit('/api/x')).toEqual({});
    expect(p.iframeAttrs('https://embed.test/')).toEqual({ credentialless: '' });
    expect(p.iframeAttrs('/same')).toEqual({});
    expect(p.check()).toEqual({ ok: true, value: undefined });
  });

  it('credentialless: no attribute for anonymous media (no-cors allowed), use-credentials still applied', () => {
    const p = createIsolationPolicy({ mode: 'required', coep: 'credentialless', origin: O, credentialedOrigins: ['https://api.test'] }, facts({ credentiallessIframes: false }));
    expect(p.crossOriginAttr('https://cdn.test/a.png', 'img')).toBeUndefined();
    expect(p.crossOriginAttr('https://api.test/a.png', 'img')).toBe('use-credentials');
    expect(p.iframeAttrs('https://embed.test/')).toEqual({}); // unsupported attribute
  });

  it('surface images are always CORS cross-origin (no tainted canvas), even when isolation is off', () => {
    const p = createIsolationPolicy({ mode: 'off', origin: O, credentialedOrigins: ['https://api.test'] }, facts({ crossOriginIsolated: false }));
    expect(p.imageCors('https://cdn.test/t.png')).toBe('anonymous');
    expect(p.imageCors('https://api.test/t.png')).toBe('use-credentials');
    expect(p.imageCors('/t.png')).toBeUndefined();
  });

  it('off is a no-op binding even when the document happens to be isolated', () => {
    const p = createIsolationPolicy({ mode: 'off', origin: O }, facts());
    expect(p).toMatchObject({ isolated: false, sharedMemory: false, status: 'off', reason: 'mode-off' });
    expect(p.crossOriginAttr('https://cdn.test/a.png')).toBeUndefined();
    expect(p.fetchInit('https://cdn.test/a')).toEqual({});
    expect(p.iframeAttrs('https://cdn.test/')).toEqual({});
    expect(p.gateReason).toMatch(/off/);
    expect(offIsolationPolicy.status).toBe('off');
  });

  it('preferred but not isolated → fallback; required but not isolated → blocked with SF-PLAT-006', () => {
    const preferred = createIsolationPolicy({ mode: 'preferred', origin: O }, facts({ crossOriginIsolated: false }));
    expect(preferred).toMatchObject({ status: 'fallback', reason: 'not-isolated', sharedMemory: false });
    expect(preferred.crossOriginAttr('https://cdn.test/a.png')).toBeUndefined();
    expect(preferred.check().ok).toBe(true);
    const required = createIsolationPolicy({ mode: 'required', origin: O }, facts({ crossOriginIsolated: false }));
    expect(required.status).toBe('blocked');
    const checked = required.check();
    expect(!checked.ok && checked.error.code).toBe('SF-PLAT-006');
    expect(!checked.ok && checked.error.fix).toMatch(/Cross-Origin-Embedder-Policy/);
    expect(required.gateReason).toMatch(/COOP\/COEP/);
  });

  it('embedded hosts always fall back (never block), isolated without SAB has no shared memory', () => {
    const embedded = createIsolationPolicy({ mode: 'required', origin: O }, facts({ embedded: true }));
    expect(embedded).toMatchObject({ status: 'fallback', reason: 'embedded', isolated: false, sharedMemory: false });
    expect(embedded.check().ok).toBe(true);
    expect(embedded.gateReason).toMatch(/Embedded/);
    const noSab = createIsolationPolicy({ mode: 'preferred', origin: O }, facts({ sharedArrayBuffer: false }));
    expect(noSab).toMatchObject({ status: 'isolated', isolated: true, sharedMemory: false, reason: 'no-shared-memory' });
    expect(noSab.gateReason).toMatch(/SharedArrayBuffer/);
  });

  it('adapters match the ui / loader / surface / worker port shapes', () => {
    const p = createIsolationPolicy({ mode: 'preferred', origin: O }, facts());
    expect(toUiIsolationPolicy(p).crossOriginFor('https://cdn.test/a.mp4', 'video')).toBe('anonymous');
    expect(toLoaderIsolationPolicy(p).crossOriginFor('https://cdn.test/chunk.js')).toBe('anonymous');
    expect(toLoaderIsolationPolicy(p).crossOriginFor('/assets/chunk.js')).toBeUndefined();
    expect(toSurfaceImagePolicy(p).crossOriginFor('https://cdn.test/t.png')).toBe('anonymous');
    expect(toWorkerIsolationFacts(p)).toEqual({ crossOriginIsolated: true, mode: 'preferred', embedded: false });
    const embedded = createIsolationPolicy({ mode: 'preferred', origin: O }, facts({ embedded: true }));
    expect(toWorkerIsolationFacts(embedded)).toEqual({ crossOriginIsolated: false, mode: 'preferred', embedded: true });
  });
});

describe('isolation DI units', () => {
  it('binds the policy and overrides other packages’ default ports by token id', async () => {
    // Stand-ins for ports declared in ui / loader / surface / worker (same ids, default no-op units).
    const UiPort = token('ui/isolation-policy').type<{ crossOriginFor(url: string, kind: string): string | undefined }>();
    const LoaderPort = token('loader/isolation-policy').type<{ crossOriginFor(url: string): string | undefined }>();
    const SurfacePort = token('surface/image-policy').type<{ crossOriginFor(url: string): string | undefined }>();
    const WorkerPort = token('worker/isolation-facts').type<{ crossOriginIsolated: boolean }>();
    const noop = { crossOriginFor: () => undefined };
    const env = createFakePlatformEnv({ globals: isolatedGlobals });
    const injector = createInjector({
      units: [
        unit({ id: 'ui/default-isolation', provides: UiPort, scope: 'app', create: () => noop }),
        unit({ id: 'loader/default-isolation', provides: LoaderPort, scope: 'app', create: () => noop }),
        unit({ id: 'surface/default-image-policy', provides: SurfacePort, scope: 'app', create: () => ({ crossOriginFor: () => 'anonymous' }) }),
        unit({ id: 'worker/default-facts', provides: WorkerPort, scope: 'app', create: () => ({ crossOriginIsolated: false }) }),
        platformEnvUnit(env),
        ...isolationUnits({ mode: 'preferred', origin: O }),
      ],
    });
    expect((await injector.resolveCritical()).ok).toBe(true);
    expect(unwrap(await injector.get(IsolationPolicyToken)).status).toBe('isolated');
    expect(unwrap(await injector.get(UiPort)).crossOriginFor('https://cdn.test/a.png', 'img')).toBe('anonymous');
    expect(unwrap(await injector.get(LoaderPort)).crossOriginFor('https://cdn.test/a.js')).toBe('anonymous');
    expect(unwrap(await injector.get(SurfacePort)).crossOriginFor('/a.png')).toBeUndefined();
    expect(unwrap(await injector.get(WorkerPort)).crossOriginIsolated).toBe(true);
  });

  it('required but not isolated blocks boot with SF-PLAT-006', async () => {
    const injector = createInjector({ units: [platformEnvUnit(createFakePlatformEnv()), ...isolationUnits({ mode: 'required', origin: O })] });
    const boot = await injector.resolveCritical();
    expect(boot.ok).toBe(false);
    const policy = await injector.get(IsolationPolicyToken);
    expect(policy.ok).toBe(false);
    const cause = !boot.ok ? (boot.error.cause as { code?: string } | undefined) : undefined;
    expect(!boot.ok && boot.error.message).toContain('not cross-origin isolated');
    expect(cause?.code).toBe('SF-PLAT-006');
  });

  it('dev reporting unit is only added with dev: true', async () => {
    const env = createFakePlatformEnv();
    const injector = createInjector({ units: [platformEnvUnit(env), ...isolationUnits({ mode: 'off' }, { dev: true })] });
    expect(unwrap(await injector.get(IsolationReportingToken))).toMatchObject({ supported: false });
    expect(isolationUnits({ mode: 'off' })).toHaveLength(2 + 4);
    expect(isolationPolicyUnit.critical).toBe(true);
  });
});

describe('dev ReportingObserver → conformance violations', () => {
  function fakeObserverEnv() {
    const instances: { callback: (r: readonly ReportLike[]) => void; options: unknown; observed: boolean; disconnected: boolean }[] = [];
    class FakeReportingObserver {
      readonly state;
      constructor(callback: (r: readonly ReportLike[]) => void, options: unknown) {
        this.state = { callback, options, observed: false, disconnected: false };
        instances.push(this.state);
      }
      observe() {
        this.state.observed = true;
      }
      disconnect() {
        this.state.disconnected = true;
      }
    }
    return { env: createFakePlatformEnv({ globals: { ReportingObserver: FakeReportingObserver } }), instances };
  }

  it('emits one `violation` event per COEP/COOP report with code, fix and attribution; disconnects on dispose', async () => {
    const { env, instances } = fakeObserverEnv();
    const sink = createMemorySink();
    const telemetry = createTelemetry();
    telemetry.addSink(sink);
    const scope = createScope('t');
    const seen: string[] = [];
    const reporting = startIsolationReporting({ env, telemetry, scope, attribute: (url) => `img[src="${url}"]`, onViolation: (v) => seen.push(v.code) });
    expect(reporting.supported).toBe(true);
    expect(instances[0]?.options).toEqual({ types: ['coep', 'coop'], buffered: true });
    expect(instances[0]?.observed).toBe(true);
    instances[0]?.callback([
      { type: 'coep', url: `${O}/`, body: { type: 'corp', blockedURL: 'https://cdn.test/a.png', destination: 'image', disposition: 'enforce' } },
      { type: 'coep', url: `${O}/`, body: { blockedURL: 'https://embed.test/', destination: 'iframe', disposition: 'reporting' } },
      { type: 'coop', url: `${O}/`, body: { type: 'navigation-to-response', disposition: 'enforce', effectivePolicy: 'same-origin' } },
      { type: 'deprecation', url: `${O}/`, body: {} },
    ]);
    expect(reporting.count).toBe(3);
    expect(seen).toEqual(['SF-PLAT-007', 'SF-PLAT-007', 'SF-PLAT-008']);
    const events = sink.records.filter((r) => r.type === 'event' && r.name === 'violation');
    expect(events).toHaveLength(3);
    const first = events[0] as { subsystem: string; level: string; attrs: Record<string, string> };
    expect(first.subsystem).toBe('platform/isolation');
    expect(first.level).toBe('critical');
    expect(first.attrs).toMatchObject({ code: 'SF-PLAT-007', severity: 'error' });
    expect(JSON.parse(first.attrs['details'] as string)).toEqual({
      page: `${O}/`,
      kind: 'corp',
      blockedUrl: 'https://cdn.test/a.png',
      destination: 'image',
      disposition: 'enforce',
      element: 'img[src="https://cdn.test/a.png"]',
    });
    expect((events[1] as { attrs: Record<string, string> }).attrs).toMatchObject({ severity: 'warning' });
    expect((events[1] as { attrs: Record<string, string> }).attrs['fix']).toMatch(/credentialless/);
    await scope.dispose();
    expect(instances[0]?.disconnected).toBe(true);
  });

  it('feature-detected: unsupported browsers and production are no-ops', () => {
    const scope = createScope('t');
    const telemetry = createTelemetry();
    expect(startIsolationReporting({ env: createFakePlatformEnv(), telemetry, scope }).supported).toBe(false);
    expect(startIsolationReporting({ env: fakeObserverEnv().env, telemetry, scope, dev: false }).supported).toBe(false);
    const throwing = createFakePlatformEnv({
      globals: {
        ReportingObserver: class {
          constructor() {
            throw new Error('nope');
          }
        },
      },
    });
    expect(startIsolationReporting({ env: throwing, telemetry, scope }).supported).toBe(false);
    expect(violationFromReport({ type: 'coep', url: 'u', body: null })).toMatchObject({ code: 'SF-PLAT-007', details: { kind: 'corp' } });
    expect(violationFromReport({ type: 'coep', url: 'u', body: { destination: 'worker' } })?.fix).toMatch(/Worker scripts/);
  });
});
