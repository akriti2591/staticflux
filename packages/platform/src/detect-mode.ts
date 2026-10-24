/**
 * The tiny inline mode detector (R12.9, R12.11). Runs before boot to pick the
 * app profile (host mode × form factor) so the right boot plan is fetched.
 *
 * Budget: < 1 KB min+brotli. Rules for this file:
 * - no runtime imports except `env.ts` and `form-factor.ts` (both import-free);
 * - no `@staticflux/core` (no injector, telemetry or reactivity here);
 * - plain functions and data only.
 *
 * Precedence: dev URL flag (`?sf-mode=embed-agent-host:compact`) > config override > detection.
 */
import { isEmbedded, mediaMatches, type PlatformEnv, readGlobal } from './env.js';
import { BUILT_IN_FORM_FACTORS, computeFormFactor, type FormFactorDefinition, type FormFactorId } from './form-factor.js';

/** Open set of host mode ids; extend via declaration merging (R18.3a). */
export interface HostModeRegistry {
  web: true;
  pwa: true;
  'embed-iframe': true;
  'embed-agent-host': true;
  'webview-ios': true;
  'webview-android': true;
}

export type HostModeId = keyof HostModeRegistry & string;

/** The detection half of a host mode (the full plugin bundle is `defineHostMode`). */
export interface ModeDetector {
  readonly id: HostModeId;
  /** Higher runs first; the first detector returning true wins. */
  readonly priority: number;
  /** Must be cheap and synchronous; it runs inline before boot. */
  detect(env: PlatformEnv): boolean;
}

export type ModeSource = 'detected' | 'config' | 'url' | 'devtools';

export interface ModeOverride {
  readonly hostMode?: HostModeId;
  readonly formFactor?: FormFactorId;
}

export interface DetectModeOptions {
  readonly detectors?: readonly ModeDetector[];
  readonly formFactors?: readonly FormFactorDefinition[];
  /** Forced by app config. */
  readonly override?: ModeOverride;
  /** Dev URL flag name; `false` disables URL overrides (e.g. production builds). Default `sf-mode`. */
  readonly urlParam?: string | false;
}

export interface DetectedMode {
  readonly hostMode: HostModeId;
  readonly formFactor: FormFactorId;
  readonly hostModeSource: ModeSource;
  readonly formFactorSource: ModeSource;
  /** URL override tokens that matched no known host mode or form factor. */
  readonly ignored: readonly string[];
}

export const DEFAULT_MODE_PARAM = 'sf-mode';

// ---------------------------------------------------------------- built-in detectors

function ua(env: PlatformEnv): string {
  return env.navigator?.userAgent ?? '';
}

/** iOS / iPadOS (iPadOS 13+ reports a Mac UA but has touch points). */
export function isIosLike(env: PlatformEnv): boolean {
  const agent = ua(env);
  return /iPhone|iPad|iPod/.test(agent) || (/Macintosh/.test(agent) && (env.navigator?.maxTouchPoints ?? 0) > 1);
}

export const detectWebviewAndroid = (env: PlatformEnv): boolean => {
  const agent = ua(env);
  return /Android/.test(agent) && (/; wv\)/.test(agent) || /Version\/\d+(\.\d+)? Chrome\//.test(agent));
};

export const detectWebviewIos = (env: PlatformEnv): boolean => {
  const webkit = readGlobal(env, 'webkit') as { messageHandlers?: unknown } | undefined;
  if (webkit?.messageHandlers !== undefined) return true;
  const agent = ua(env);
  return isIosLike(env) && /AppleWebKit/.test(agent) && !/Safari\//.test(agent);
};

/** Agent hosts (ChatGPT Apps SDK exposes `window.openai`; MCP Apps hosts are embedded frames with a bridge). */
export const detectEmbedAgentHost = (env: PlatformEnv): boolean =>
  isEmbedded(env) && (readGlobal(env, 'openai') !== undefined || readGlobal(env, 'mcpHost') !== undefined);

export const detectEmbedIframe = (env: PlatformEnv): boolean => isEmbedded(env);

export const detectPwa = (env: PlatformEnv): boolean =>
  env.navigator?.standalone === true ||
  ['standalone', 'fullscreen', 'minimal-ui', 'window-controls-overlay'].some((mode) =>
    mediaMatches(env, `(display-mode: ${mode})`),
  );

export const BUILT_IN_DETECTORS: readonly ModeDetector[] = [
  { id: 'webview-android', priority: 90, detect: detectWebviewAndroid },
  { id: 'webview-ios', priority: 85, detect: detectWebviewIos },
  { id: 'embed-agent-host', priority: 80, detect: detectEmbedAgentHost },
  { id: 'embed-iframe', priority: 70, detect: detectEmbedIframe },
  { id: 'pwa', priority: 60, detect: detectPwa },
  { id: 'web', priority: 0, detect: () => true },
];

// ---------------------------------------------------------------- detection

/** First matching detector by priority; `web` when none match. */
export function detectHostMode(env: PlatformEnv, detectors: readonly ModeDetector[] = BUILT_IN_DETECTORS): HostModeId {
  for (const detector of [...detectors].sort((a, b) => b.priority - a.priority)) {
    try {
      if (detector.detect(env)) return detector.id;
    } catch {
      // A broken detector must never break boot; fall through to the next one.
    }
  }
  return 'web';
}

/**
 * Parse `?sf-mode=<host>[:<form>]` (either part alone also works, any order;
 * `,` is accepted as separator too).
 */
export function parseModeOverride(
  search: string,
  hostModes: readonly HostModeId[],
  formFactors: readonly FormFactorId[],
  param: string = DEFAULT_MODE_PARAM,
): { readonly override: ModeOverride; readonly ignored: readonly string[] } {
  const raw = new URLSearchParams(search).get(param);
  if (raw === null || raw === '') return { override: {}, ignored: [] };
  let hostMode: HostModeId | undefined;
  let formFactor: FormFactorId | undefined;
  const ignored: string[] = [];
  for (const part of raw.split(/[:,]/)) {
    if (part === '') continue;
    if ((hostModes as readonly string[]).includes(part)) hostMode = part as HostModeId;
    else if ((formFactors as readonly string[]).includes(part)) formFactor = part as FormFactorId;
    else ignored.push(part);
  }
  return {
    override: { ...(hostMode === undefined ? {} : { hostMode }), ...(formFactor === undefined ? {} : { formFactor }) },
    ignored,
  };
}

/** Detect the app profile before boot. Pure function of `env` and options. */
export function detectMode(env: PlatformEnv, options: DetectModeOptions = {}): DetectedMode {
  const detectors = options.detectors ?? BUILT_IN_DETECTORS;
  const formFactors = options.formFactors ?? BUILT_IN_FORM_FACTORS;
  const param = options.urlParam ?? DEFAULT_MODE_PARAM;
  const url =
    param === false
      ? { override: {} as ModeOverride, ignored: [] as readonly string[] }
      : parseModeOverride(
          env.window?.location?.search ?? '',
          detectors.map((d) => d.id),
          formFactors.map((f) => f.id),
          param,
        );
  const config = options.override ?? {};
  const pick = <T>(fromUrl: T | undefined, fromConfig: T | undefined, detect: () => T): [T, ModeSource] =>
    fromUrl !== undefined ? [fromUrl, 'url'] : fromConfig !== undefined ? [fromConfig, 'config'] : [detect(), 'detected'];
  const [hostMode, hostModeSource] = pick(url.override.hostMode, config.hostMode, () => detectHostMode(env, detectors));
  const [formFactor, formFactorSource] = pick(url.override.formFactor, config.formFactor, () =>
    computeFormFactor(env.window?.innerWidth ?? 0, formFactors),
  );
  return { hostMode, formFactor, hostModeSource, formFactorSource, ignored: url.ignored };
}
