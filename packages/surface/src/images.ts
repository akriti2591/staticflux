/**
 * CORS-clean image / texture loading for surfaces (R11.16b, surface part).
 * A cross-origin image drawn without CORS taints the canvas (no readback, no
 * WebGL/WebGPU upload) and is blocked outright under COEP `require-corp`. So
 * surface images are always fetched in `cors` mode, with the credentials mode
 * decided by the injected isolation policy (same shape as the loader's), and
 * decoded with `createImageBitmap` (works on the main thread and in workers).
 * Opaque responses fail with a typed error that names the fix.
 */
import { createNoopTelemetry, createSingleFlight, err, ok, type Result, type Telemetry, toSfError } from '@staticflux/core';
import { ImageLoadError, TaintedImageError } from './errors.js';

export type CrossOriginMode = 'anonymous' | 'use-credentials';

/** Isolation policy port (R11.16b): `crossorigin` for a URL; undefined = same-origin / policy default. */
export interface SurfaceImagePolicy {
  crossOriginFor(url: string): CrossOriginMode | undefined;
}

/** Default: every cross-origin surface image is fetched anonymously (CORS, no credentials). */
export const anonymousImagePolicy: SurfaceImagePolicy = Object.freeze({ crossOriginFor: () => 'anonymous' as const });

export interface ImageResponseLike {
  readonly ok: boolean;
  readonly status: number;
  /** `basic` (same-origin), `cors`, `opaque`… */
  readonly type: string;
  blob(): Promise<Blob>;
}

export interface ImageLoaderPorts {
  fetch(url: string, init: { readonly mode: 'cors'; readonly credentials: RequestCredentials; readonly signal: AbortSignal }): Promise<ImageResponseLike>;
  decode(blob: Blob): Promise<ImageBitmap>;
  /** Origin of the page/worker (`location.origin`). */
  readonly origin: string;
}

export function defaultImageLoaderPorts(globals: {
  readonly fetch?: unknown;
  readonly createImageBitmap?: unknown;
  readonly location?: { readonly origin: string };
} = globalThis as never): ImageLoaderPorts | undefined {
  const fetchFn = globals.fetch as ImageLoaderPorts['fetch'] | undefined;
  const decode = globals.createImageBitmap as ((blob: Blob) => Promise<ImageBitmap>) | undefined;
  if (typeof fetchFn !== 'function' || typeof decode !== 'function') return undefined;
  return {
    fetch: (url, init) => fetchFn.call(globalThis, url, init),
    decode: (blob) => decode.call(globalThis, blob),
    origin: globals.location?.origin ?? 'null',
  };
}

export interface SurfaceImageLoader {
  /** Load and decode a CORS-clean bitmap. Concurrent loads of one URL share a request. */
  load(url: string, signal?: AbortSignal): Promise<Result<ImageBitmap>>;
}

export interface SurfaceImageLoaderOptions {
  readonly ports: ImageLoaderPorts;
  readonly policy?: SurfaceImagePolicy;
  readonly telemetry?: Telemetry;
}

const SUBSYSTEM = 'surface/images';

function isCrossOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url, origin === 'null' ? undefined : origin).origin !== origin;
  } catch {
    return true;
  }
}

/** Credentials mode for a surface image request. */
export function imageCredentials(url: string, origin: string, policy: SurfaceImagePolicy): RequestCredentials {
  if (!isCrossOrigin(url, origin)) return 'same-origin';
  return policy.crossOriginFor(url) === 'use-credentials' ? 'include' : 'omit';
}

export function createSurfaceImageLoader(options: SurfaceImageLoaderOptions): SurfaceImageLoader {
  const { ports } = options;
  const policy = options.policy ?? anonymousImagePolicy;
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const flights = createSingleFlight<string, ImageBitmap>();

  const fetchImage = async (url: string, signal: AbortSignal): Promise<Result<ImageBitmap>> => {
    const credentials = imageCredentials(url, ports.origin, policy);
    const span = telemetry.span('surface.image-load', { subsystem: SUBSYSTEM, level: 'verbose', attrs: { url, credentials } });
    let response: ImageResponseLike;
    try {
      response = await ports.fetch(url, { mode: 'cors', credentials, signal });
    } catch (error) {
      const sf = toSfError(error);
      const failure = sf.kind === 'aborted' ? sf : ImageLoadError({ cause: error, message: `Fetching image "${url}" failed (network or CORS).`, details: { url } });
      span.end(sf.kind === 'aborted' ? 'cancelled' : 'error', failure);
      return err(failure);
    }
    if (response.type === 'opaque') {
      const tainted = TaintedImageError({ details: { url } });
      telemetry.event('surface.tainted-image', { subsystem: SUBSYSTEM, level: 'critical', attrs: { url, code: tainted.code } });
      span.end('error', tainted);
      return err(tainted);
    }
    if (!response.ok) {
      const failure = ImageLoadError({ message: `Image "${url}" failed with HTTP ${response.status}.`, details: { url, status: response.status } });
      span.end('error', failure);
      return err(failure);
    }
    try {
      const bitmap = await ports.decode(await response.blob());
      span.end('ok');
      return ok(bitmap);
    } catch (error) {
      const failure = ImageLoadError({ cause: error, message: `Decoding image "${url}" failed.`, details: { url } });
      span.end('error', failure);
      return err(failure);
    }
  };

  return {
    load(url, signal) {
      return flights.run(url, (flightSignal) => fetchImage(url, flightSignal), signal ?? new AbortController().signal);
    },
  };
}
