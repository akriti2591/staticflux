/**
 * DOM side of loading: `modulepreload` / stylesheet / import-map injection, with the
 * isolation policy's `crossorigin` applied to every injected tag (R11.16b loader part).
 * The document is injected (`LoaderDocument`) so tests and workers stay DOM-free.
 */

/** The subset of `Document` the loader touches. */
export interface LoaderDocument {
  createElement(tag: 'link' | 'script'): LoaderElement;
  readonly head: { appendChild(node: LoaderElement): unknown };
}

export interface LoaderElement {
  setAttribute(name: string, value: string): void;
  getAttribute?(name: string): string | null;
  textContent: string | null;
}

export type CrossOriginMode = 'anonymous' | 'use-credentials';

/**
 * Isolation policy port (R11.16b). The platform/isolation unit binds the real policy
 * (isolation mode × `crossOriginIsolated` × COEP flavour); when isolation is off the
 * no-op policy below is bound and no attribute is added.
 */
export interface LoaderIsolationPolicy {
  /** `crossorigin` value for a script/preload URL, or undefined for none. */
  crossOriginFor(url: string): CrossOriginMode | undefined;
}

export const noIsolationPolicy: LoaderIsolationPolicy = Object.freeze({ crossOriginFor: () => undefined });

/**
 * A simple policy: cross-origin URLs (different origin than `origin`) get `mode`;
 * same-origin URLs get nothing (or `mode` too when `sameOrigin: true`, e.g. under
 * COEP `require-corp` with a CDN on the same site).
 */
export function crossOriginPolicy(options: {
  readonly origin: string;
  readonly mode: CrossOriginMode;
  readonly sameOrigin?: boolean;
}): LoaderIsolationPolicy {
  return {
    crossOriginFor(url) {
      if (options.sameOrigin === true) return options.mode;
      if (!/^([a-z]+:)?\/\//i.test(url)) return undefined;
      try {
        return new URL(url, options.origin).origin === new URL(options.origin).origin ? undefined : options.mode;
      } catch {
        return options.mode;
      }
    },
  };
}

export interface PreloadInjector {
  /** Inject `<link rel="modulepreload">` once per URL. Returns true when a tag was added. */
  modulepreload(url: string, integrity?: string): boolean;
  /** Inject `<link rel="stylesheet">` once per URL. */
  stylesheet(url: string): boolean;
  /** URLs injected so far (for tests/devtools). */
  readonly injected: ReadonlySet<string>;
}

export function createPreloadInjector(
  document: LoaderDocument | undefined,
  policy: LoaderIsolationPolicy = noIsolationPolicy,
): PreloadInjector {
  const injected = new Set<string>();
  const add = (rel: 'modulepreload' | 'stylesheet', url: string, integrity?: string): boolean => {
    const key = `${rel} ${url}`;
    if (document === undefined || injected.has(key)) return false;
    injected.add(key);
    const link = document.createElement('link');
    link.setAttribute('rel', rel);
    link.setAttribute('href', url);
    const crossorigin = policy.crossOriginFor(url);
    if (crossorigin !== undefined) link.setAttribute('crossorigin', crossorigin);
    if (integrity !== undefined) link.setAttribute('integrity', integrity);
    document.head.appendChild(link);
    return true;
  };
  return {
    modulepreload: (url, integrity) => add('modulepreload', url, integrity),
    stylesheet: (url) => add('stylesheet', url),
    get injected() {
      return injected;
    },
  };
}

/** Default document (feature-detected; undefined in workers / SSR-less tooling). */
export function defaultDocument(): LoaderDocument | undefined {
  const doc = (globalThis as { document?: unknown }).document;
  return doc === undefined ? undefined : (doc as LoaderDocument);
}
