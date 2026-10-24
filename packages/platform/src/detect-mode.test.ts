import { describe, expect, it } from 'vitest';
import {
  BUILT_IN_DETECTORS,
  computeFormFactor,
  createFakePlatformEnv,
  defineFormFactor,
  detectHostMode,
  detectMode,
  isEmbedded,
  parseModeOverride,
  type FormFactorDefinition,
  BUILT_IN_FORM_FACTORS,
  browserEnv,
  mediaMatches,
  readGlobal,
  SAMPLE_USER_AGENTS as UA,
} from './index.js';


describe('host mode detection (built-ins)', () => {
  it('defaults to web', () => {
    expect(detectHostMode(createFakePlatformEnv({ navigator: { userAgent: UA.macSafari } }))).toBe('web');
  });

  it('detects pwa from display-mode or iOS navigator.standalone', () => {
    expect(detectHostMode(createFakePlatformEnv({ media: ['(display-mode: standalone)'] }))).toBe('pwa');
    expect(detectHostMode(createFakePlatformEnv({ media: ['(display-mode: window-controls-overlay)'] }))).toBe('pwa');
    expect(detectHostMode(createFakePlatformEnv({ navigator: { userAgent: UA.iphoneSafari, standalone: true } }))).toBe('pwa');
  });

  it('detects embed-iframe and embed-agent-host', () => {
    expect(detectHostMode(createFakePlatformEnv({ embedded: true }))).toBe('embed-iframe');
    expect(detectHostMode(createFakePlatformEnv({ crossOriginFrame: true }))).toBe('embed-iframe');
    expect(detectHostMode(createFakePlatformEnv({ embedded: true, globals: { openai: {} } }))).toBe('embed-agent-host');
    // `openai` outside a frame is not an agent host.
    expect(detectHostMode(createFakePlatformEnv({ globals: { openai: {} } }))).toBe('web');
  });

  it('detects webviews (capability first, UA fallback)', () => {
    expect(detectHostMode(createFakePlatformEnv({ navigator: { userAgent: UA.androidWebview } }))).toBe('webview-android');
    expect(detectHostMode(createFakePlatformEnv({ navigator: { userAgent: UA.androidChrome } }))).toBe('web');
    expect(detectHostMode(createFakePlatformEnv({ navigator: { userAgent: UA.iphoneWebview } }))).toBe('webview-ios');
    expect(detectHostMode(createFakePlatformEnv({ navigator: { userAgent: UA.iphoneSafari } }))).toBe('web');
    expect(
      detectHostMode(createFakePlatformEnv({ navigator: { userAgent: UA.iphoneSafari }, globals: { webkit: { messageHandlers: {} } } })),
    ).toBe('webview-ios');
  });

  it('webview beats embedded/pwa by priority', () => {
    const env = createFakePlatformEnv({ embedded: true, media: ['(display-mode: standalone)'], navigator: { userAgent: UA.androidWebview } });
    expect(detectHostMode(env)).toBe('webview-android');
  });

  it('a throwing detector is skipped', () => {
    const env = createFakePlatformEnv();
    const detectors = [
      {
        id: 'pwa' as const,
        priority: 100,
        detect: () => {
          throw new Error('boom');
        },
      },
      ...BUILT_IN_DETECTORS,
    ];
    expect(detectHostMode(env, detectors)).toBe('web');
    expect(detectHostMode(env, [])).toBe('web');
  });

  it('isEmbedded is false without a window', () => {
    expect(isEmbedded({ window: undefined, navigator: undefined, matchMedia: undefined, globals: {} })).toBe(false);
  });
});

describe('env helpers', () => {
  it('browserEnv reads globalThis and degrades', () => {
    const env = browserEnv();
    expect(env.globals).toBe(globalThis);
    expect(typeof mediaMatches(env, '(pointer: fine)')).toBe('boolean');
  });

  it('mediaMatches and readGlobal never throw', () => {
    const env = {
      window: undefined,
      navigator: undefined,
      matchMedia: () => {
        throw new Error('bad query');
      },
      globals: Object.defineProperty({}, 'localStorage', {
        get() {
          throw new DOMException('denied', 'SecurityError');
        },
      }),
    };
    expect(mediaMatches(env, '(x)')).toBe(false);
    expect(readGlobal(env, 'localStorage')).toBeUndefined();
  });
});

describe('form factors', () => {
  it('maps widths to built-in classes', () => {
    expect(computeFormFactor(0)).toBe('compact');
    expect(computeFormFactor(599)).toBe('compact');
    expect(computeFormFactor(600)).toBe('medium');
    expect(computeFormFactor(839)).toBe('medium');
    expect(computeFormFactor(840)).toBe('expanded');
  });

  it('applies hysteresis in both directions', () => {
    // growing: must clear boundary + 24
    expect(computeFormFactor(610, BUILT_IN_FORM_FACTORS, 'compact')).toBe('compact');
    expect(computeFormFactor(624, BUILT_IN_FORM_FACTORS, 'compact')).toBe('medium');
    // shrinking: must drop below boundary - 24
    expect(computeFormFactor(590, BUILT_IN_FORM_FACTORS, 'medium')).toBe('medium');
    expect(computeFormFactor(575, BUILT_IN_FORM_FACTORS, 'medium')).toBe('compact');
    // jumping several classes
    expect(computeFormFactor(1200, BUILT_IN_FORM_FACTORS, 'compact')).toBe('expanded');
    expect(computeFormFactor(850, BUILT_IN_FORM_FACTORS, 'compact')).toBe('medium');
    expect(computeFormFactor(300, BUILT_IN_FORM_FACTORS, 'expanded')).toBe('compact');
    expect(computeFormFactor(830, BUILT_IN_FORM_FACTORS, 'expanded')).toBe('expanded');
    // zero hysteresis = raw
    expect(computeFormFactor(600, BUILT_IN_FORM_FACTORS, 'compact', 0)).toBe('medium');
    // unknown previous = raw
    expect(computeFormFactor(700, BUILT_IN_FORM_FACTORS, 'nope' as never)).toBe('medium');
  });

  it('supports extra definitions and empty lists', () => {
    const large = defineFormFactor({ id: 'expanded', minWidth: 1600 });
    const defs: FormFactorDefinition[] = [{ id: 'compact', minWidth: 0 }, large];
    expect(computeFormFactor(1000, defs)).toBe('compact');
    expect(computeFormFactor(1700, defs)).toBe('expanded');
    expect(computeFormFactor(1700, [])).toBe('compact');
  });
});

describe('detectMode (inline detector)', () => {
  it('detects host mode and form factor', () => {
    const mode = detectMode(createFakePlatformEnv({ width: 390, navigator: { userAgent: UA.iphoneSafari } }));
    expect(mode).toEqual({ hostMode: 'web', formFactor: 'compact', hostModeSource: 'detected', formFactorSource: 'detected', ignored: [] });
  });

  it('config override beats detection; URL flag beats config', () => {
    const env = createFakePlatformEnv({ width: 1280, search: '?sf-mode=embed-agent-host:compact' });
    const fromConfig = detectMode(createFakePlatformEnv({ width: 1280 }), { override: { hostMode: 'pwa' } });
    expect(fromConfig.hostMode).toBe('pwa');
    expect(fromConfig.hostModeSource).toBe('config');
    expect(fromConfig.formFactorSource).toBe('detected');
    const fromUrl = detectMode(env, { override: { hostMode: 'pwa', formFactor: 'expanded' } });
    expect(fromUrl).toMatchObject({ hostMode: 'embed-agent-host', formFactor: 'compact', hostModeSource: 'url', formFactorSource: 'url' });
  });

  it('URL override can be disabled or renamed', () => {
    const env = createFakePlatformEnv({ width: 1280, search: '?sf-mode=pwa&mode=compact' });
    expect(detectMode(env, { urlParam: false }).hostMode).toBe('web');
    expect(detectMode(env, { urlParam: 'mode' })).toMatchObject({ hostMode: 'web', formFactor: 'compact', formFactorSource: 'url' });
  });

  it('reports unknown URL tokens', () => {
    const env = createFakePlatformEnv({ search: '?sf-mode=tv,medium' });
    expect(detectMode(env)).toMatchObject({ formFactor: 'medium', hostMode: 'web', ignored: ['tv'] });
  });

  it('works without a window', () => {
    const mode = detectMode({ window: undefined, navigator: undefined, matchMedia: undefined, globals: {} });
    expect(mode.hostMode).toBe('web');
    expect(mode.formFactor).toBe('compact');
  });

  it('parseModeOverride handles empty and partial values', () => {
    expect(parseModeOverride('', ['web'], ['compact'])).toEqual({ override: {}, ignored: [] });
    expect(parseModeOverride('?sf-mode=', ['web'], ['compact'])).toEqual({ override: {}, ignored: [] });
    expect(parseModeOverride('?sf-mode=compact:', ['web'], ['compact'])).toEqual({ override: { formFactor: 'compact' }, ignored: [] });
  });
});
