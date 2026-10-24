import { describe, expect, it } from 'vitest';
import {
  createFakePlatformEnv,
  deviceClassOf,
  probeLocalStorage,
  readAiPresence,
  readBrowser,
  readCapabilities,
  readDisplay,
  readInput,
  readNetwork,
  readOs,
  readPlatformFacts,
  readPreferences,
  tierOf,
  SAMPLE_USER_AGENTS as UA,
} from './index.js';

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => {
      map.delete(k);
    },
    setItem: (k, v) => {
      map.set(k, v);
    },
  };
}

describe('input facts', () => {
  it('desktop mouse', () => {
    const env = createFakePlatformEnv({ media: ['(pointer: fine)', '(hover: hover)', '(any-pointer: fine)'] });
    expect(readInput(env)).toEqual({ touch: false, pointer: 'fine', hover: true, anyFinePointer: true });
  });

  it('phone touch', () => {
    const env = createFakePlatformEnv({ media: ['(pointer: coarse)'], navigator: { maxTouchPoints: 5 } });
    expect(readInput(env)).toEqual({ touch: true, pointer: 'coarse', hover: false, anyFinePointer: false });
  });

  it('pointer none and unsupported matchMedia', () => {
    expect(readInput(createFakePlatformEnv({ media: ['(pointer: none)'] })).pointer).toBe('none');
    expect(readInput(createFakePlatformEnv({ noMatchMedia: true })).pointer).toBe('fine');
  });
});

describe('network facts', () => {
  it('unknown without Network Information API (Safari/Firefox)', () => {
    expect(readNetwork(createFakePlatformEnv())).toEqual({
      online: true,
      effectiveType: 'unknown',
      downlinkMbps: undefined,
      rttMs: undefined,
      saveData: false,
      quality: 'unknown',
    });
  });

  it('classifies quality', () => {
    const q = (connection: { effectiveType?: string; saveData?: boolean }): string =>
      readNetwork(createFakePlatformEnv({ connection })).quality;
    expect(q({ effectiveType: '4g' })).toBe('fast');
    expect(q({ effectiveType: '3g' })).toBe('moderate');
    expect(q({ effectiveType: '2g' })).toBe('slow');
    expect(q({ effectiveType: 'slow-2g' })).toBe('slow');
    expect(q({ effectiveType: '4g', saveData: true })).toBe('slow');
    expect(q({ effectiveType: '5g' })).toBe('unknown');
  });

  it('offline wins', () => {
    const env = createFakePlatformEnv({ connection: { effectiveType: '4g', downlink: 10, rtt: 50 } });
    env.setOnline(false);
    expect(readNetwork(env)).toMatchObject({ online: false, quality: 'offline', downlinkMbps: 10, rttMs: 50 });
  });
});

describe('device facts', () => {
  it('tiers from memory/cores', () => {
    expect(tierOf(undefined, undefined)).toBe('mid');
    expect(tierOf(2, 8)).toBe('low');
    expect(tierOf(8, 2)).toBe('low');
    expect(tierOf(8, 8)).toBe('high');
    expect(tierOf(undefined, 12)).toBe('high');
    expect(tierOf(4, 8)).toBe('mid');
  });

  it('device class from capabilities, UA-CH mobile as hint', () => {
    const touch = { touch: true, pointer: 'coarse' as const, hover: false, anyFinePointer: false };
    const mouse = { touch: false, pointer: 'fine' as const, hover: true, anyFinePointer: true };
    const env = createFakePlatformEnv();
    expect(deviceClassOf(env, mouse, 1280, 800)).toBe('desktop');
    expect(deviceClassOf(env, touch, 390, 844)).toBe('mobile');
    expect(deviceClassOf(env, touch, 820, 1180)).toBe('tablet');
    const ch = createFakePlatformEnv({ navigator: { userAgentData: { mobile: true } } });
    expect(deviceClassOf(ch, mouse, 390, 844)).toBe('mobile');
    expect(deviceClassOf(ch, mouse, 800, 1200)).toBe('tablet');
  });

  it('OS from UA-CH first, else UA', () => {
    const os = (userAgent: string, maxTouchPoints = 0): string => readOs(createFakePlatformEnv({ navigator: { userAgent, maxTouchPoints } }));
    expect(os(UA.iphoneSafari)).toBe('ios');
    expect(os(UA.macSafari, 5)).toBe('ios'); // iPadOS desktop UA
    expect(os(UA.macSafari)).toBe('macos');
    expect(os(UA.androidChrome)).toBe('android');
    expect(os(UA.windowsEdge)).toBe('windows');
    expect(os(UA.linuxChrome)).toBe('linux');
    expect(os(UA.chromebook)).toBe('chromeos');
    expect(os('')).toBe('unknown');
    for (const [platform, expected] of [
      ['Android', 'android'],
      ['Windows', 'windows'],
      ['macOS', 'macos'],
      ['Chrome OS', 'chromeos'],
      ['Linux', 'linux'],
      ['iOS', 'ios'],
    ] as const) {
      expect(readOs(createFakePlatformEnv({ navigator: { userAgent: UA.linuxChrome, userAgentData: { platform } } }))).toBe(expected);
    }
  });

  it('browser from UA-CH brands, else UA', () => {
    const b = (userAgent: string) => readBrowser(createFakePlatformEnv({ navigator: { userAgent } }));
    expect(b(UA.windowsEdge)).toEqual({ name: 'edge', major: 126 });
    expect(b(UA.macFirefox)).toEqual({ name: 'firefox', major: 127 });
    expect(b(UA.macSafari)).toEqual({ name: 'safari', major: 17 });
    expect(b(UA.androidChrome)).toEqual({ name: 'chrome', major: 126 });
    expect(b(UA.samsung)).toEqual({ name: 'samsung', major: 25 });
    expect(b(UA.opera)).toEqual({ name: 'opera', major: 111 });
    expect(b('curl/8')).toEqual({ name: 'unknown', major: undefined });
    const ch = readBrowser(
      createFakePlatformEnv({
        navigator: {
          userAgentData: {
            brands: [
              { brand: 'Not/A)Brand', version: '8' },
              { brand: 'Chromium', version: '126' },
              { brand: 'Microsoft Edge', version: '126' },
            ],
          },
        },
      }),
    );
    expect(ch).toEqual({ name: 'edge', major: 126 });
  });
});

describe('preferences, display, capabilities, AI', () => {
  it('preferences', () => {
    expect(readPreferences(createFakePlatformEnv())).toEqual({
      reducedMotion: false,
      reducedData: false,
      reducedTransparency: false,
      contrast: 'no-preference',
      colorScheme: 'light',
      forcedColors: false,
    });
    const env = createFakePlatformEnv({
      media: ['(prefers-reduced-motion: reduce)', '(prefers-contrast: more)', '(prefers-color-scheme: dark)', '(forced-colors: active)'],
    });
    expect(readPreferences(env)).toMatchObject({ reducedMotion: true, contrast: 'more', colorScheme: 'dark', forcedColors: true });
    expect(readPreferences(createFakePlatformEnv({ media: ['(prefers-contrast: less)'] })).contrast).toBe('less');
    expect(readPreferences(createFakePlatformEnv({ media: ['(prefers-contrast: custom)'] })).contrast).toBe('custom');
  });

  it('display', () => {
    expect(readDisplay(createFakePlatformEnv({ width: 390, height: 844, devicePixelRatio: 3 }))).toEqual({
      width: 390,
      height: 844,
      devicePixelRatio: 3,
      orientation: 'portrait',
      displayMode: 'browser',
    });
    expect(readDisplay(createFakePlatformEnv({ media: ['(display-mode: fullscreen)'] })).displayMode).toBe('fullscreen');
    expect(readDisplay(createFakePlatformEnv({ navigator: { standalone: true } })).displayMode).toBe('standalone');
  });

  it('capabilities are presence + probes', () => {
    const none = readCapabilities(createFakePlatformEnv());
    expect(Object.entries(none).filter(([, v]) => v).map(([k]) => k)).toEqual(['popups']);
    const all = readCapabilities(
      createFakePlatformEnv({
        navigator: { serviceWorker: {}, share: () => undefined, credentials: {}, clipboard: {}, gpu: {} },
        globals: {
          localStorage: memoryStorage(),
          indexedDB: {},
          SharedWorker: class {},
          PublicKeyCredential: class {},
          Notification: class {},
          document: { startViewTransition: () => undefined },
          navigation: {},
          BeforeInstallPromptEvent: class {},
        },
      }),
    );
    expect(Object.values(all).every(Boolean)).toBe(true);
  });

  it('localStorage that throws (Safari private / blocked) is unavailable', () => {
    const throwing = { ...memoryStorage(), setItem: () => {
      throw new DOMException('quota', 'QuotaExceededError');
    } };
    expect(probeLocalStorage(createFakePlatformEnv({ globals: { localStorage: throwing } }))).toBe(false);
    expect(probeLocalStorage(createFakePlatformEnv({ globals: { localStorage: null } }))).toBe(false);
    expect(probeLocalStorage(createFakePlatformEnv({ globals: { localStorage: memoryStorage() } }))).toBe(true);
  });

  it('AI presence is unknown until probed', () => {
    expect(readAiPresence(createFakePlatformEnv({ globals: { LanguageModel: {}, Summarizer: {} } }))).toEqual({
      languageModel: 'unknown',
      summarizer: 'unknown',
      writer: 'unavailable',
      rewriter: 'unavailable',
      translator: 'unavailable',
      languageDetector: 'unavailable',
    });
  });

  it('readPlatformFacts composes every group', () => {
    const facts = readPlatformFacts(createFakePlatformEnv({ width: 390, height: 844, media: ['(pointer: coarse)'], navigator: { maxTouchPoints: 5, userAgent: UA.iphoneSafari } }));
    expect(facts.device).toMatchObject({ class: 'mobile', os: 'ios', browser: 'safari', tier: 'mid', tierKnown: false });
    expect(facts.host).toEqual({ standalone: false, webview: undefined, embedded: false });
    expect(readPlatformFacts(createFakePlatformEnv({ navigator: { userAgent: UA.androidWebview } })).host.webview).toBe('android');
    expect(readPlatformFacts(createFakePlatformEnv({ navigator: { userAgent: UA.iphoneWebview } })).host.webview).toBe('ios');
  });
});
