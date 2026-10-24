/**
 * Platform facts (R18.1, R18.2): a plain, serializable snapshot of what the
 * device and browser *can do*. Detection is capability-first; the user agent
 * is consulted only to name the OS/browser (and for webview detection).
 *
 * `readPlatformFacts(env)` is pure; the reactive source lives in `platform-facts.ts`.
 * Facts are plain data so they can be replicated to workers and fed to gates.
 */
import { isEmbedded, mediaMatches, type PlatformEnv, readGlobal } from './env.js';
import { detectPwa, detectWebviewAndroid, detectWebviewIos, isIosLike } from './detect-mode.js';

export type DeviceClass = 'mobile' | 'tablet' | 'desktop';
export type OsName = 'ios' | 'android' | 'windows' | 'macos' | 'linux' | 'chromeos' | 'unknown';
export type BrowserName = 'chrome' | 'edge' | 'safari' | 'firefox' | 'samsung' | 'opera' | 'unknown';
export type PointerKind = 'fine' | 'coarse' | 'none';
export type EffectiveConnection = 'slow-2g' | '2g' | '3g' | '4g' | 'unknown';
export type NetworkQuality = 'offline' | 'slow' | 'moderate' | 'fast' | 'unknown';
export type DeviceTier = 'low' | 'mid' | 'high';
export type ContrastPreference = 'no-preference' | 'more' | 'less' | 'custom';
export type ColorScheme = 'light' | 'dark';
export type DisplayMode = 'browser' | 'standalone' | 'minimal-ui' | 'fullscreen' | 'window-controls-overlay';
export type Orientation = 'portrait' | 'landscape';
/** Built-in AI availability (mirrors the `availability()` states of the Chrome built-in AI APIs). */
export type AiAvailability = 'unavailable' | 'downloadable' | 'downloading' | 'available' | 'unknown';
export type AiApiName = 'languageModel' | 'summarizer' | 'writer' | 'rewriter' | 'translator' | 'languageDetector';

export interface InputFacts {
  /** Touch points present. */
  readonly touch: boolean;
  /** Primary pointer accuracy. */
  readonly pointer: PointerKind;
  /** Primary pointer can hover. */
  readonly hover: boolean;
  /** Any attached pointer is fine (e.g. a tablet with a trackpad). */
  readonly anyFinePointer: boolean;
}

export interface NetworkFacts {
  readonly online: boolean;
  readonly effectiveType: EffectiveConnection;
  readonly downlinkMbps: number | undefined;
  readonly rttMs: number | undefined;
  readonly saveData: boolean;
  /** Derived class; `unknown` when the Network Information API is missing (Safari, Firefox). */
  readonly quality: NetworkQuality;
}

export interface DeviceFacts {
  readonly class: DeviceClass;
  readonly os: OsName;
  readonly browser: BrowserName;
  readonly browserMajor: number | undefined;
  readonly memoryGb: number | undefined;
  readonly cores: number | undefined;
  readonly tier: DeviceTier;
  /** False when neither memory nor cores were reported (tier is then an assumption). */
  readonly tierKnown: boolean;
}

export interface PreferenceFacts {
  readonly reducedMotion: boolean;
  readonly reducedData: boolean;
  readonly reducedTransparency: boolean;
  readonly contrast: ContrastPreference;
  readonly colorScheme: ColorScheme;
  readonly forcedColors: boolean;
}

export interface DisplayFacts {
  readonly width: number;
  readonly height: number;
  readonly devicePixelRatio: number;
  readonly orientation: Orientation;
  readonly displayMode: DisplayMode;
}

export interface HostFacts {
  /** Installed / standalone display (PWA). */
  readonly standalone: boolean;
  readonly webview: 'ios' | 'android' | undefined;
  /** Running inside a frame. */
  readonly embedded: boolean;
}

/** Detected availability of APIs (before host-mode restrictions; see `AppProfile.capabilities`). */
export interface CapabilityFacts {
  readonly localStorage: boolean;
  readonly indexedDB: boolean;
  readonly serviceWorker: boolean;
  readonly sharedWorker: boolean;
  readonly webAuthn: boolean;
  readonly notifications: boolean;
  readonly share: boolean;
  readonly clipboard: boolean;
  readonly webGpu: boolean;
  readonly viewTransitions: boolean;
  readonly navigationApi: boolean;
  readonly popups: boolean;
  readonly install: boolean;
}

export type CapabilityName = keyof CapabilityFacts;

export type AiFacts = { readonly [K in AiApiName]: AiAvailability };

export interface PlatformFacts {
  readonly input: InputFacts;
  readonly network: NetworkFacts;
  readonly device: DeviceFacts;
  readonly preferences: PreferenceFacts;
  readonly display: DisplayFacts;
  readonly host: HostFacts;
  readonly capabilities: CapabilityFacts;
  readonly ai: AiFacts;
}

// ---------------------------------------------------------------- readers

export function readInput(env: PlatformEnv): InputFacts {
  const coarse = mediaMatches(env, '(pointer: coarse)');
  const fine = mediaMatches(env, '(pointer: fine)');
  return {
    touch: (env.navigator?.maxTouchPoints ?? 0) > 0,
    pointer: fine ? 'fine' : coarse ? 'coarse' : mediaMatches(env, '(pointer: none)') ? 'none' : 'fine',
    hover: mediaMatches(env, '(hover: hover)'),
    anyFinePointer: mediaMatches(env, '(any-pointer: fine)'),
  };
}

const EFFECTIVE: readonly EffectiveConnection[] = ['slow-2g', '2g', '3g', '4g'];

export function readNetwork(env: PlatformEnv): NetworkFacts {
  const connection = env.navigator?.connection;
  const online = env.navigator?.onLine ?? true;
  const effectiveType = EFFECTIVE.find((e) => e === connection?.effectiveType) ?? 'unknown';
  const saveData = connection?.saveData === true;
  let quality: NetworkQuality;
  if (!online) quality = 'offline';
  else if (saveData || effectiveType === 'slow-2g' || effectiveType === '2g') quality = 'slow';
  else if (effectiveType === '3g') quality = 'moderate';
  else if (effectiveType === '4g') quality = 'fast';
  else quality = 'unknown';
  return {
    online,
    effectiveType,
    downlinkMbps: connection?.downlink,
    rttMs: connection?.rtt,
    saveData,
    quality,
  };
}

/** OS name from UA-CH when present, else the user agent string (fallback only). */
export function readOs(env: PlatformEnv): OsName {
  const platform = env.navigator?.userAgentData?.platform?.toLowerCase();
  if (platform !== undefined && platform !== '') {
    if (platform === 'android') return 'android';
    if (platform === 'windows') return 'windows';
    if (platform === 'macos') return 'macos';
    if (platform === 'chrome os' || platform === 'chromeos') return 'chromeos';
    if (platform === 'linux') return 'linux';
    if (platform === 'ios') return 'ios';
  }
  const agent = env.navigator?.userAgent ?? '';
  if (isIosLike(env)) return 'ios';
  if (/Android/.test(agent)) return 'android';
  if (/CrOS/.test(agent)) return 'chromeos';
  if (/Windows/.test(agent)) return 'windows';
  if (/Macintosh|Mac OS X/.test(agent)) return 'macos';
  if (/Linux/.test(agent)) return 'linux';
  return 'unknown';
}

/** Browser name + major version from UA-CH brands, else the user agent (fallback only). */
export function readBrowser(env: PlatformEnv): { readonly name: BrowserName; readonly major: number | undefined } {
  const brands = env.navigator?.userAgentData?.brands ?? [];
  const brandOrder: readonly [string, BrowserName][] = [
    ['Microsoft Edge', 'edge'],
    ['Opera', 'opera'],
    ['Samsung Internet', 'samsung'],
    ['Google Chrome', 'chrome'],
    ['Chromium', 'chrome'],
  ];
  for (const [brand, name] of brandOrder) {
    const hit = brands.find((b) => b.brand === brand);
    if (hit !== undefined) return { name, major: Number.parseInt(hit.version, 10) || undefined };
  }
  const agent = env.navigator?.userAgent ?? '';
  const patterns: readonly [RegExp, BrowserName][] = [
    [/Edg(?:e|A|iOS)?\/(\d+)/, 'edge'],
    [/OPR\/(\d+)/, 'opera'],
    [/SamsungBrowser\/(\d+)/, 'samsung'],
    [/(?:Firefox|FxiOS)\/(\d+)/, 'firefox'],
    [/(?:Chrome|CriOS)\/(\d+)/, 'chrome'],
    [/Version\/(\d+).*Safari\//, 'safari'],
  ];
  for (const [pattern, name] of patterns) {
    const match = pattern.exec(agent);
    if (match !== null) return { name, major: Number.parseInt(match[1] ?? '', 10) || undefined };
  }
  return { name: 'unknown', major: undefined };
}

/** Device tier from memory and cores. Unknown values count as mid-range. */
export function tierOf(memoryGb: number | undefined, cores: number | undefined): DeviceTier {
  if ((memoryGb !== undefined && memoryGb <= 2) || (cores !== undefined && cores <= 2)) return 'low';
  const memHigh = memoryGb === undefined || memoryGb >= 8;
  const coresHigh = cores === undefined || cores >= 8;
  if ((memoryGb !== undefined || cores !== undefined) && memHigh && coresHigh) return 'high';
  return 'mid';
}

/** Device class from capabilities (pointer/hover/size), UA-CH `mobile` as a hint. */
export function deviceClassOf(env: PlatformEnv, input: InputFacts, width: number, height: number): DeviceClass {
  const shortSide = Math.min(width, height);
  if (env.navigator?.userAgentData?.mobile === true) return shortSide >= 600 ? 'tablet' : 'mobile';
  const touchPrimary = input.pointer === 'coarse' || (input.touch && !input.hover);
  if (!touchPrimary) return 'desktop';
  return shortSide >= 600 ? 'tablet' : 'mobile';
}

export function readDevice(env: PlatformEnv, input: InputFacts, display: DisplayFacts): DeviceFacts {
  const memoryGb = env.navigator?.deviceMemory;
  const cores = env.navigator?.hardwareConcurrency;
  const browser = readBrowser(env);
  return {
    class: deviceClassOf(env, input, display.width, display.height),
    os: readOs(env),
    browser: browser.name,
    browserMajor: browser.major,
    memoryGb,
    cores,
    tier: tierOf(memoryGb, cores),
    tierKnown: memoryGb !== undefined || cores !== undefined,
  };
}

export function readPreferences(env: PlatformEnv): PreferenceFacts {
  const contrast: ContrastPreference = mediaMatches(env, '(prefers-contrast: more)')
    ? 'more'
    : mediaMatches(env, '(prefers-contrast: less)')
      ? 'less'
      : mediaMatches(env, '(prefers-contrast: custom)')
        ? 'custom'
        : 'no-preference';
  return {
    reducedMotion: mediaMatches(env, '(prefers-reduced-motion: reduce)'),
    reducedData: mediaMatches(env, '(prefers-reduced-data: reduce)'),
    reducedTransparency: mediaMatches(env, '(prefers-reduced-transparency: reduce)'),
    contrast,
    colorScheme: mediaMatches(env, '(prefers-color-scheme: dark)') ? 'dark' : 'light',
    forcedColors: mediaMatches(env, '(forced-colors: active)'),
  };
}

const DISPLAY_MODES: readonly DisplayMode[] = ['window-controls-overlay', 'fullscreen', 'standalone', 'minimal-ui'];

export function readDisplay(env: PlatformEnv): DisplayFacts {
  const width = env.window?.innerWidth ?? 0;
  const height = env.window?.innerHeight ?? 0;
  const displayMode =
    DISPLAY_MODES.find((mode) => mediaMatches(env, `(display-mode: ${mode})`)) ??
    (env.navigator?.standalone === true ? 'standalone' : 'browser');
  return {
    width,
    height,
    devicePixelRatio: env.window?.devicePixelRatio ?? 1,
    orientation: width >= height ? 'landscape' : 'portrait',
    displayMode,
  };
}

export function readHost(env: PlatformEnv): HostFacts {
  return {
    standalone: detectPwa(env),
    webview: detectWebviewIos(env) ? 'ios' : detectWebviewAndroid(env) ? 'android' : undefined,
    embedded: isEmbedded(env),
  };
}

/** `localStorage` exists *and* works (Safari private mode / blocked cookies throw). */
export function probeLocalStorage(env: PlatformEnv): boolean {
  try {
    const storage = readGlobal(env, 'localStorage') as Storage | undefined;
    if (storage === undefined || storage === null) return false;
    const key = '__sf_probe__';
    storage.setItem(key, '1');
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

function present(env: PlatformEnv, name: string): boolean {
  const value = readGlobal(env, name);
  return value !== undefined && value !== null;
}

export function readCapabilities(env: PlatformEnv): CapabilityFacts {
  const nav = env.navigator;
  const doc = readGlobal(env, 'document') as { startViewTransition?: unknown } | undefined;
  return {
    localStorage: probeLocalStorage(env),
    indexedDB: present(env, 'indexedDB'),
    serviceWorker: nav?.serviceWorker !== undefined && nav.serviceWorker !== null,
    sharedWorker: present(env, 'SharedWorker'),
    webAuthn: present(env, 'PublicKeyCredential') && nav?.credentials !== undefined,
    notifications: present(env, 'Notification'),
    share: typeof nav?.share === 'function',
    clipboard: nav?.clipboard !== undefined && nav.clipboard !== null,
    webGpu: nav?.gpu !== undefined && nav.gpu !== null,
    viewTransitions: typeof doc?.startViewTransition === 'function',
    navigationApi: present(env, 'navigation'),
    popups: env.window !== undefined,
    install: present(env, 'BeforeInstallPromptEvent'),
  };
}

/** Global names of the built-in AI APIs (Chrome 138+ shape: `LanguageModel`, `Summarizer`, …). */
export const AI_API_GLOBALS: { readonly [K in AiApiName]: string } = {
  languageModel: 'LanguageModel',
  summarizer: 'Summarizer',
  writer: 'Writer',
  rewriter: 'Rewriter',
  translator: 'Translator',
  languageDetector: 'LanguageDetector',
};

export const AI_API_NAMES = Object.keys(AI_API_GLOBALS) as readonly AiApiName[];

/** Synchronous AI facts: `unknown` when the API exists (needs an async probe), `unavailable` otherwise. */
export function readAiPresence(env: PlatformEnv): AiFacts {
  const out = {} as Record<AiApiName, AiAvailability>;
  for (const name of AI_API_NAMES) out[name] = present(env, AI_API_GLOBALS[name]) ? 'unknown' : 'unavailable';
  return out;
}

/** Read every fact once. */
export function readPlatformFacts(env: PlatformEnv): PlatformFacts {
  const input = readInput(env);
  const display = readDisplay(env);
  return {
    input,
    network: readNetwork(env),
    device: readDevice(env, input, display),
    preferences: readPreferences(env),
    display,
    host: readHost(env),
    capabilities: readCapabilities(env),
    ai: readAiPresence(env),
  };
}
