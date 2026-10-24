import { createInjector, unwrap } from '@staticflux/core';
import { describe, expect, it } from 'vitest';
import {
  AppProfileToken,
  appProfileUnit,
  BUILT_IN_HOST_MODES,
  browserEnvUnit,
  createFakePlatformEnv,
  defineFormFactor,
  defineHostMode,
  formFactorUnit,
  FormFactorsToken,
  hostModeUnit,
  HostModesToken,
  PlatformEnvToken,
  platformEnvUnit,
  PlatformFactsToken,
  platformFactsUnit,
  platformOptionsUnit,
  platformUnits,
  webHostMode,
} from './index.js';

describe('platform DI units', () => {
  it('platformUnits() resolves facts and profile as critical units', async () => {
    const env = createFakePlatformEnv({ width: 700, search: '?sf-mode=pwa' });
    const injector = createInjector({ units: platformUnits({}, env) });
    expect((await injector.resolveCritical()).ok).toBe(true);
    const profile = unwrap(await injector.get(AppProfileToken));
    const facts = unwrap(await injector.get(PlatformFactsToken));
    expect(profile.current.key).toBe('pwa:medium');
    expect(facts.display.width).toBe(700);
    expect(unwrap(await injector.get(HostModesToken)).map((m) => m.id)).toEqual([
      'webview-android',
      'webview-ios',
      'embed-agent-host',
      'embed-iframe',
      'pwa',
      'web',
    ]);
    expect(unwrap(await injector.get(FormFactorsToken)).map((f) => f.id)).toEqual(['compact', 'medium', 'expanded']);
    env.resize(1200);
    expect(profile.current.formFactor).toBe('expanded');
    await injector.dispose();
    expect(env.listenerCount()).toBe(0);
  });

  it('options flow into the profile; zero contributions fall back to built-ins', async () => {
    const env = createFakePlatformEnv({ width: 1280 });
    const injector = createInjector({
      units: [platformEnvUnit(env), platformOptionsUnit({ override: { formFactor: 'compact' }, hysteresis: 0, urlParam: false, aiProbeTimeoutMs: 10, probeAiOnStart: false }), platformFactsUnit, appProfileUnit],
    });
    const profile = unwrap(await injector.get(AppProfileToken));
    expect(profile.current).toMatchObject({ hostMode: 'web', formFactor: 'compact', formFactorSource: 'config' });
    expect(profile.hostModes).toEqual(BUILT_IN_HOST_MODES.map((m) => m.id));
  });

  it('plugin host modes and form factors contribute through multi tokens', async () => {
    const env = createFakePlatformEnv({ width: 2000, embedded: true });
    const kiosk = defineHostMode({ ...webHostMode, id: 'embed-iframe', priority: 200, detect: () => true, historyStrategy: 'memory' });
    const injector = createInjector({
      units: [
        platformEnvUnit(env),
        platformOptionsUnit({ initial: { hostMode: 'embed-iframe', formFactor: 'expanded', hostModeSource: 'detected', formFactorSource: 'detected', ignored: [] } }),
        platformFactsUnit,
        appProfileUnit,
        hostModeUnit(webHostMode),
        hostModeUnit(kiosk),
        formFactorUnit(defineFormFactor({ id: 'compact', minWidth: 0 })),
        formFactorUnit(defineFormFactor({ id: 'expanded', minWidth: 1000 })),
      ],
    });
    const profile = unwrap(await injector.get(AppProfileToken));
    expect(profile.hostMode).toBe(kiosk);
    expect(profile.formFactors).toEqual(['compact', 'expanded']);
  });

  it('invalid options surface as a create failure with the SF-PLAT cause', async () => {
    const injector = createInjector({
      units: [platformEnvUnit(createFakePlatformEnv()), platformOptionsUnit({ override: { hostMode: 'nope' as never } }), platformFactsUnit, appProfileUnit],
    });
    const result = await injector.get(AppProfileToken);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(JSON.stringify(result.error.message)).toContain('not registered');
  });

  it('browserEnvUnit provides the real globals', async () => {
    const injector = createInjector({ units: [browserEnvUnit] });
    const env = unwrap(await injector.get(PlatformEnvToken));
    expect(env.globals).toBe(globalThis);
  });
});
