/**
 * `IsolationPolicy` (R11.16a, R11.16b): one decision, derived from the app's declared
 * isolation mode, the COEP flavour and platform facts, consumed via DI by every layer
 * so feature code never reads `crossOriginIsolated` or picks `crossorigin` values.
 *
 * | mode      | isolated (fact)      | status     | effect                                         |
 * |-----------|----------------------|------------|------------------------------------------------|
 * | off       | any                  | `off`      | no-op binding (no attributes, no shared memory) |
 * | preferred | yes                  | `isolated` | CORS attributes; shared memory if SAB present   |
 * | preferred | no                   | `fallback` | no attributes; transfer paths                   |
 * | required  | yes                  | `isolated` | as preferred                                    |
 * | required  | no                   | `blocked`  | `check()` → `SF-PLAT-006` (boot error) + gate reason |
 * | any       | embedded host        | `fallback` | embedded hosts cannot set COOP/COEP: always fall back |
 *
 * Adapters at the bottom map the policy to the ports other packages already declare
 * (structurally — platform does not import them).
 */
import { err, ok, type Result } from '@staticflux/core';
import { isEmbedded, type PlatformEnv, readGlobal } from './env.js';
import { IsolationRequiredError } from './errors.js';

export type IsolationMode = 'required' | 'preferred' | 'off';
export type CoepFlavour = 'require-corp' | 'credentialless';
export type CrossOriginValue = 'anonymous' | 'use-credentials';
export type CrossOriginElementKind = 'img' | 'video' | 'audio' | 'script' | 'link';
export type IsolationStatus = 'isolated' | 'off' | 'fallback' | 'blocked';
export type IsolationFallbackReason = 'mode-off' | 'not-isolated' | 'embedded' | 'no-shared-memory';

/** Platform facts relevant to isolation (read through `PlatformEnv`). */
export interface IsolationFacts {
  /** `globalThis.crossOriginIsolated`. */
  readonly crossOriginIsolated: boolean;
  readonly embedded: boolean;
  /** `SharedArrayBuffer` + `Atomics` exposed. */
  readonly sharedArrayBuffer: boolean;
  /** `<iframe credentialless>` supported (Chromium 110+). */
  readonly credentiallessIframes: boolean;
}

export function readIsolationFacts(env: PlatformEnv): IsolationFacts {
  const iframe = readGlobal(env, 'HTMLIFrameElement') as { prototype?: object } | undefined;
  const atomics = readGlobal(env, 'Atomics');
  return {
    crossOriginIsolated: readGlobal(env, 'crossOriginIsolated') === true,
    embedded: isEmbedded(env),
    sharedArrayBuffer: typeof readGlobal(env, 'SharedArrayBuffer') === 'function' && typeof atomics === 'object' && atomics !== null,
    credentiallessIframes: typeof iframe?.prototype === 'object' && 'credentialless' in iframe.prototype,
  };
}

/** The app's declaration (`app.isolation`). */
export interface IsolationDeclaration {
  readonly mode: IsolationMode;
  /** Default `require-corp`. */
  readonly coep?: CoepFlavour;
  /** Page origin (default: from `env.window.location`, else `globalThis.location`). */
  readonly origin?: string;
  /** Origins whose resources need credentials (`use-credentials` / `credentials: 'include'`). */
  readonly credentialedOrigins?: readonly string[];
}

/** `RequestInit` subset for `fetch()` of a URL (data package). */
export interface IsolationFetchInit {
  readonly mode?: 'cors';
  readonly credentials?: 'omit' | 'same-origin' | 'include';
}

export interface IsolationPolicy {
  readonly mode: IsolationMode;
  readonly coep: CoepFlavour;
  /** Actually cross-origin isolated and allowed to use it (mode ≠ off, not embedded). */
  readonly isolated: boolean;
  /** Shared channels / Wasm threads may be used. */
  readonly sharedMemory: boolean;
  readonly status: IsolationStatus;
  readonly reason: IsolationFallbackReason | undefined;
  readonly facts: IsolationFacts;
  /** Reason for gating isolation-dependent features off (undefined when shared memory is available). */
  readonly gateReason: string | undefined;
  /** `crossorigin` value for a media/script/link element, or undefined for none. */
  crossOriginAttr(url: string, kind?: CrossOriginElementKind): CrossOriginValue | undefined;
  /** `fetch()` init additions for a URL. */
  fetchInit(url: string): IsolationFetchInit;
  /** Attributes for an `<iframe>` of a URL (e.g. `credentialless` for third-party embeds). */
  iframeAttrs(url: string): Readonly<Record<string, string>>;
  /** CORS mode for images/textures drawn to canvas (always CORS cross-origin: no tainted canvas). */
  imageCors(url: string): CrossOriginValue | undefined;
  /** Boot check: `required` but not isolated → `SF-PLAT-006`. */
  check(): Result<void>;
}

function originOf(env: PlatformEnv | undefined, explicit: string | undefined): string {
  if (explicit !== undefined) return explicit;
  const fromEnv = (env?.window as { location?: { origin?: string } } | undefined)?.location?.origin;
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv;
  return (globalThis as { location?: { origin?: string } }).location?.origin ?? '';
}

export function createIsolationPolicy(declaration: IsolationDeclaration, facts: IsolationFacts, env?: PlatformEnv): IsolationPolicy {
  const mode = declaration.mode;
  const coep = declaration.coep ?? 'require-corp';
  const origin = originOf(env, declaration.origin);
  const credentialed = new Set(declaration.credentialedOrigins ?? []);
  const isolated = mode !== 'off' && facts.crossOriginIsolated && !facts.embedded;
  const sharedMemory = isolated && facts.sharedArrayBuffer;
  // COEP is in force for this document: subresources must be CORS/CORP-clean.
  const coepActive = mode !== 'off' && facts.crossOriginIsolated;

  let status: IsolationStatus;
  let reason: IsolationFallbackReason | undefined;
  if (mode === 'off') {
    status = 'off';
    reason = 'mode-off';
  } else if (facts.embedded) {
    status = 'fallback';
    reason = 'embedded';
  } else if (!facts.crossOriginIsolated) {
    status = mode === 'required' ? 'blocked' : 'fallback';
    reason = 'not-isolated';
  } else {
    status = 'isolated';
    reason = facts.sharedArrayBuffer ? undefined : 'no-shared-memory';
  }

  /** undefined = same-origin / data / blob / unparsable. */
  const crossOrigin = (url: string): URL | undefined => {
    let target: URL;
    try {
      target = new URL(url, origin === '' ? undefined : origin);
    } catch {
      return undefined;
    }
    if (target.protocol === 'data:' || target.protocol === 'blob:' || target.origin === origin) return undefined;
    return target;
  };

  const gateReason =
    sharedMemory
      ? undefined
      : reason === 'mode-off'
        ? 'Cross-origin isolation is off for this app.'
        : reason === 'embedded'
          ? 'Embedded hosts cannot be cross-origin isolated.'
          : reason === 'no-shared-memory'
            ? 'SharedArrayBuffer is unavailable in this browser.'
            : 'The page is not cross-origin isolated (missing COOP/COEP headers).';

  return Object.freeze({
    mode,
    coep,
    isolated,
    sharedMemory,
    status,
    reason,
    facts,
    gateReason,
    crossOriginAttr(url: string): CrossOriginValue | undefined {
      if (!coepActive) return undefined;
      const target = crossOrigin(url);
      if (target === undefined) return undefined;
      if (credentialed.has(target.origin)) return 'use-credentials';
      // credentialless loads no-cors subresources without credentials: no attribute needed.
      return coep === 'credentialless' ? undefined : 'anonymous';
    },
    fetchInit(url: string): IsolationFetchInit {
      if (!coepActive) return {};
      const target = crossOrigin(url);
      if (target === undefined) return {};
      return { mode: 'cors', credentials: credentialed.has(target.origin) ? 'include' : 'same-origin' };
    },
    iframeAttrs(url: string): Readonly<Record<string, string>> {
      if (!coepActive || !facts.credentiallessIframes || crossOrigin(url) === undefined) return {};
      return { credentialless: '' };
    },
    imageCors(url: string): CrossOriginValue | undefined {
      const target = crossOrigin(url);
      if (target === undefined) return undefined;
      return credentialed.has(target.origin) ? 'use-credentials' : 'anonymous';
    },
    check(): Result<void> {
      if (status !== 'blocked') return ok();
      return err(IsolationRequiredError({ details: { mode, coep, crossOriginIsolated: facts.crossOriginIsolated } }));
    },
  });
}

/** The no-op binding (isolation off). */
export const offIsolationPolicy: IsolationPolicy = createIsolationPolicy(
  { mode: 'off', origin: '' },
  { crossOriginIsolated: false, embedded: false, sharedArrayBuffer: false, credentiallessIframes: false },
);

// ---------------------------------------------------------------- port adapters
// Structural matches for ports declared in packages platform cannot import.

/** For `@staticflux/ui` `IsolationPolicyToken` (`ui/isolation-policy`, shape `IsolationPolicy` in ui/ports.ts). */
export interface UiCrossOriginPort {
  crossOriginFor(url: string, kind: CrossOriginElementKind): CrossOriginValue | undefined;
}
export function toUiIsolationPolicy(policy: IsolationPolicy): UiCrossOriginPort {
  return Object.freeze({ crossOriginFor: (url: string, kind: CrossOriginElementKind) => policy.crossOriginAttr(url, kind) });
}

/** For `@staticflux/loader` `LoaderIsolationPolicyToken` (`loader/isolation-policy`, shape `LoaderIsolationPolicy`). */
export interface LoaderCrossOriginPort {
  crossOriginFor(url: string): CrossOriginValue | undefined;
}
export function toLoaderIsolationPolicy(policy: IsolationPolicy): LoaderCrossOriginPort {
  return Object.freeze({ crossOriginFor: (url: string) => policy.crossOriginAttr(url, 'script') });
}

/** For `@staticflux/surface` `SurfaceImagePolicyToken` (`surface/image-policy`, shape `SurfaceImagePolicy`). */
export interface SurfaceImageCorsPort {
  crossOriginFor(url: string): CrossOriginValue | undefined;
}
export function toSurfaceImagePolicy(policy: IsolationPolicy): SurfaceImageCorsPort {
  return Object.freeze({ crossOriginFor: (url: string) => policy.imageCors(url) });
}

/** For `@staticflux/worker` `IsolationFactsToken` (`worker/isolation-facts`, shape `IsolationFacts` in worker/isolation.ts). */
export interface WorkerIsolationFactsPort {
  readonly crossOriginIsolated: boolean;
  readonly mode?: IsolationMode;
  readonly embedded?: boolean;
}
export function toWorkerIsolationFacts(policy: IsolationPolicy): WorkerIsolationFactsPort {
  return Object.freeze({ crossOriginIsolated: policy.isolated, mode: policy.mode, embedded: policy.facts.embedded });
}
