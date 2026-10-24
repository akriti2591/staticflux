import { createMemorySink, createScope, createTelemetry, effect, err, ok } from '@staticflux/core';
import { describe, expect, it, vi } from 'vitest';
import {
  BUILT_IN_HOST_MODES,
  createAppProfile,
  createFakePlatformEnv,
  createPlatformFacts,
  defineHostMode,
  detectMode,
  effectiveCapabilities,
  type FakePlatformEnvOptions,
  type HostBridge,
  matchesProfile,
  profileKey,
  readCapabilities,
  webHostMode,
  type AppProfileOptions,
  type AppProfileSource,
  type HostModeDefinition,
  SAMPLE_USER_AGENTS,
} from './index.js';

declare module './detect-mode.js' {
  interface HostModeRegistry {
    'test-tv': true;
  }
}

function setup(envOptions: FakePlatformEnvOptions = {}, options: Partial<AppProfileOptions> = {}) {
  const scope = createScope('t');
  const env = createFakePlatformEnv(envOptions);
  const facts = createPlatformFacts({ env, scope });
  const result = createAppProfile({ env, facts, scope, ...options });
  if (!result.ok) throw result.error;
  return { scope, env, facts, profile: result.value as AppProfileSource };
}

function fakeBridge(id: string): HostBridge & { disposed: boolean } {
  return {
    id,
    disposed: false,
    send: () => ok(),
    onMessage: () => () => undefined,
    dispose() {
      this.disposed = true;
    },
  };
}

describe('createAppProfile', () => {
  it('detects the initial profile', () => {
    const { profile } = setup({ width: 390 });
    expect(profile.current).toEqual({
      hostMode: 'web',
      formFactor: 'compact',
      key: 'web:compact',
      hostModeSource: 'detected',
      formFactorSource: 'detected',
    });
    expect(profile.hostMode).toBe(webHostMode);
    expect(profile.hostModes).toContain('embed-agent-host');
    expect(profile.formFactors).toEqual(['compact', 'medium', 'expanded']);
  });

  it('form factor follows the viewport with hysteresis (R18.6)', () => {
    const { env, profile, scope } = setup({ width: 590 });
    const seen: string[] = [];
    effect(() => seen.push(profile.current.formFactor), scope);
    env.resize(610); // within the band: stays compact
    expect(profile.current.formFactor).toBe('compact');
    env.resize(640);
    expect(profile.current.formFactor).toBe('medium');
    env.resize(590); // within the band below: stays medium
    expect(profile.current.formFactor).toBe('medium');
    env.resize(500);
    expect(profile.current.formFactor).toBe('compact');
    expect(seen).toEqual(['compact', 'medium', 'compact']);
  });

  it('onChange + telemetry on profile changes', () => {
    const sink = createMemorySink();
    const telemetry = createTelemetry();
    telemetry.addSink(sink);
    const { env, profile } = setup({ width: 1280 }, { telemetry });
    const changes: string[] = [];
    const off = profile.onChange((next, prev) => changes.push(`${prev.key}->${next.key}`));
    env.resize(400);
    expect(changes).toEqual(['web:expanded->web:compact']);
    off();
    env.resize(1280);
    expect(changes).toHaveLength(1);
    expect(sink.records.some((r) => r.type === 'event' && r.name === 'platform.profile-changed')).toBe(true);
    expect(sink.records.some((r) => r.type === 'metric' && r.metric === 'platform/profile-changes')).toBe(true);
  });

  it('host mode re-detects on host fact changes (e.g. installed PWA)', () => {
    const { env, profile } = setup();
    env.setMedia('(display-mode: standalone)', true);
    expect(profile.current.hostMode).toBe('pwa');
    expect(profile.current.hostModeSource).toBe('detected');
  });

  it('config override and URL flag (R12.11)', () => {
    expect(setup({}, { override: { hostMode: 'embed-iframe' } }).profile.current).toMatchObject({
      hostMode: 'embed-iframe',
      hostModeSource: 'config',
    });
    const url = setup({ search: '?sf-mode=pwa:compact', width: 1280 });
    expect(url.profile.current).toMatchObject({ hostMode: 'pwa', formFactor: 'compact', formFactorSource: 'url' });
    // forced axes do not follow detection
    url.env.resize(1300);
    expect(url.profile.current.formFactor).toBe('compact');
    url.env.setMedia('(display-mode: standalone)', true);
    expect(url.profile.current.hostMode).toBe('pwa');
    expect(setup({ search: '?sf-mode=pwa' }, { urlParam: false }).profile.current.hostMode).toBe('web');
  });

  it('reports ignored URL tokens', () => {
    const sink = createMemorySink();
    const telemetry = createTelemetry();
    telemetry.addSink(sink);
    setup({ search: '?sf-mode=fridge' }, { telemetry });
    expect(sink.records.some((r) => r.type === 'event' && r.name === 'platform.mode-override-ignored')).toBe(true);
  });

  it('accepts the inline detector result and validates it', () => {
    const env = createFakePlatformEnv({ width: 700 });
    const initial = detectMode(env, { override: { hostMode: 'embed-agent-host' } });
    const { profile } = setup({ width: 700 }, { initial });
    expect(profile.current.key).toBe('embed-agent-host:medium');
    const scope = createScope('x');
    const bad = createAppProfile({
      env,
      facts: createPlatformFacts({ env, scope }),
      scope,
      initial: { ...initial, hostMode: 'nope' as never },
    });
    expect(bad.ok).toBe(false);
  });

  it('force / unforce (devtools)', () => {
    const { profile, env } = setup({ width: 1280 });
    const forced = profile.force({ formFactor: 'compact' });
    expect(forced.ok && forced.value).toMatchObject({ formFactor: 'compact', formFactorSource: 'devtools', hostModeSource: 'detected' });
    env.resize(1400);
    expect(profile.current.formFactor).toBe('compact');
    expect(profile.force({ hostMode: 'pwa' }, 'config').ok).toBe(true);
    expect(profile.current).toMatchObject({ hostMode: 'pwa', hostModeSource: 'config', formFactorSource: 'devtools' });
    const back = profile.force(undefined);
    expect(back.ok && back.value).toMatchObject({ hostMode: 'web', formFactor: 'expanded', hostModeSource: 'detected' });
  });

  it('unknown forced ids are SF-PLAT-001 and change nothing', () => {
    const { profile } = setup();
    const before = profile.current;
    const r1 = profile.force({ hostMode: 'nope' as never });
    const r2 = profile.force({ formFactor: 'huge' as never });
    expect(!r1.ok && r1.error.code).toBe('SF-PLAT-001');
    expect(!r2.ok && r2.error.code).toBe('SF-PLAT-001');
    expect(profile.current).toEqual(before);
    const scope = createScope('x');
    const env = createFakePlatformEnv();
    const bad = createAppProfile({ env, facts: createPlatformFacts({ env, scope }), scope, override: { hostMode: 'nope' as never } });
    expect(!bad.ok && bad.error.code).toBe('SF-PLAT-001');
  });

  it('duplicate host mode ids are SF-PLAT-002', () => {
    const scope = createScope('x');
    const env = createFakePlatformEnv();
    const result = createAppProfile({ env, facts: createPlatformFacts({ env, scope }), scope, hostModes: [webHostMode, webHostMode] });
    expect(!result.ok && result.error.code).toBe('SF-PLAT-002');
  });

  it('effective capabilities apply the host profile (R18.10)', () => {
    const globals = { SharedWorker: class {}, Notification: class {} };
    const web = setup({ globals, navigator: { serviceWorker: {} } }).profile;
    expect(web.has('serviceWorker')).toBe(true);
    const agent = setup({ globals, navigator: { serviceWorker: {} }, embedded: true }, { override: { hostMode: 'embed-agent-host' } }).profile;
    expect(agent.has('serviceWorker')).toBe(false);
    expect(agent.has('sharedWorker')).toBe(false);
    expect(agent.capabilities.notifications).toBe(false);
    expect(agent.hostMode.historyStrategy).toBe('memory-host-synced');
    const caps = readCapabilities(createFakePlatformEnv({ navigator: { serviceWorker: {} } }));
    expect(effectiveCapabilities(caps, webHostMode)).toEqual(caps);
  });

  it('open set: custom host modes via declaration merging', () => {
    const tv = defineHostMode({
      id: 'test-tv',
      priority: 100,
      detect: (env) => /SMART-TV/.test(env.navigator?.userAgent ?? ''),
      capabilities: { webAuthn: false },
      historyStrategy: 'memory',
      shellPreset: 'chromeless',
    });
    const { profile } = setup({ navigator: { userAgent: 'Mozilla/5.0 SMART-TV' } }, { hostModes: [...BUILT_IN_HOST_MODES, tv] });
    expect(profile.current.hostMode).toBe('test-tv');
    expect(profile.hostMode).toBe(tv);
    // unknown current mode falls back to web definition
    const plain = setup({ navigator: { userAgent: SAMPLE_USER_AGENTS.macSafari } }).profile;
    expect(plain.hostMode.id).toBe('web');
  });
});

describe('host bridge', () => {
  const bridged = (loader: HostModeDefinition['bridge']): HostModeDefinition =>
    defineHostMode({
      id: 'embed-agent-host',
      priority: 80,
      detect: () => true,
      capabilities: {},
      historyStrategy: 'memory-host-synced',
      ...(loader === undefined ? {} : { bridge: loader }),
    });

  it('loads once (single-flight), caches, and disposes with the scope', async () => {
    const bridge = fakeBridge('mcp');
    const loader = vi.fn(async () => ok(bridge as HostBridge));
    const { profile, scope } = setup({}, { hostModes: [webHostMode, bridged(loader)] });
    const [a, b] = await Promise.all([profile.loadBridge(), profile.loadBridge()]);
    expect(a.ok && a.value).toBe(bridge);
    expect(b.ok && b.value).toBe(bridge);
    expect(await profile.loadBridge()).toEqual(ok(bridge));
    expect(loader).toHaveBeenCalledTimes(1);
    await scope.dispose();
    expect(bridge.disposed).toBe(true);
  });

  it('no bridge → SF-PLAT-004; failures → SF-PLAT-005 or the loader error', async () => {
    const none = setup().profile;
    const r = await none.loadBridge();
    expect(!r.ok && r.error.code).toBe('SF-PLAT-004');
    const throwing = setup({}, {
      hostModes: [
        bridged(async () => {
          throw new Error('chunk 404');
        }),
      ],
    }).profile;
    const t = await throwing.loadBridge();
    expect(!t.ok && t.error.code).toBe('SF-PLAT-005');
    const failing = setup({}, { hostModes: [bridged(async () => err(new Error('x') as never))] }).profile;
    expect((await failing.loadBridge()).ok).toBe(false);
  });

  it('aborting the load cancels; a bridge arriving after disposal is disposed', async () => {
    let resolve!: (b: HostBridge) => void;
    const bridge = fakeBridge('late');
    const { profile, scope } = setup({}, {
      hostModes: [bridged(() => new Promise((r) => (resolve = (b) => r(ok(b)))))],
    });
    const controller = new AbortController();
    const pending = profile.loadBridge(controller.signal);
    controller.abort();
    const aborted = await pending;
    expect(!aborted.ok && aborted.error.kind).toBe('aborted');

    const again = profile.loadBridge(createScope('caller').signal);
    await scope.dispose();
    resolve(bridge);
    const late = await again;
    expect(late.ok).toBe(false);
    expect(bridge.disposed).toBe(true);
  });
});

describe('profile helpers', () => {
  it('matchesProfile / profileKey', () => {
    const p = { hostMode: 'web' as const, formFactor: 'compact' as const };
    expect(profileKey('web', 'compact')).toBe('web:compact');
    expect(matchesProfile(p, {})).toBe(true);
    expect(matchesProfile(p, { formFactors: ['compact'] })).toBe(true);
    expect(matchesProfile(p, { formFactors: ['medium', 'expanded'] })).toBe(false);
    expect(matchesProfile(p, { hostModes: ['web', 'pwa'], formFactors: ['compact'] })).toBe(true);
    expect(matchesProfile(p, { hostModes: ['embed-agent-host'] })).toBe(false);
  });
});
