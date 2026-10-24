/**
 * Loading strategies (R12.5): dynamic `import()` (default), import maps, and a
 * Module-Federation-style remote container adapter (no MF dependency — the host
 * owns shared singletons; version mismatch → SF-LOAD-004).
 */
import { err, ok, type Result, toSfError } from '@staticflux/core';
import type { LoaderDocument } from './dom.js';
import { ChunkFetchError, ImportMapUnsupportedError, RemoteContainerError, SharedVersionMismatchError } from './errors.js';
import { chunkSpecifier, fileUrl, type ManifestChunk, type SfManifest, toImportMap } from './manifest.js';

/** Dynamic import, injected (`(url) => import(/* @vite-ignore *\/ url)` in the app). */
export type Importer = (specifier: string) => Promise<unknown>;

/** Default importer: native dynamic import. */
export const nativeImporter: Importer = (specifier) => import(/* @vite-ignore */ specifier);

export interface LoadRequest {
  readonly chunk: ManifestChunk;
  readonly manifest: SfManifest;
  /** 1-based attempt (retries bust the module-map failure cache with a query param). */
  readonly attempt: number;
  readonly signal: AbortSignal;
}

export interface LoadStrategy {
  readonly kind: string;
  load(request: LoadRequest): Promise<Result<unknown>>;
}

function entryUrl(request: LoadRequest): string {
  const [first] = request.chunk.files;
  const url = fileUrl(request.manifest, first ?? '');
  if (request.attempt <= 1) return url;
  return `${url}${url.includes('?') ? '&' : '?'}sf-retry=${request.attempt - 1}`;
}

async function guarded(request: LoadRequest, run: () => Promise<unknown>): Promise<Result<unknown>> {
  try {
    return ok(await run());
  } catch (error) {
    const sf = toSfError(error);
    if (sf.kind === 'aborted') return err(sf);
    return err(ChunkFetchError({ cause: error, message: `Chunk "${request.chunk.id}" failed to load: ${sf.message}`, details: { chunk: request.chunk.id, attempt: request.attempt } }));
  }
}

/** `import(url)` of the chunk's hashed entry file. */
export function dynamicImportStrategy(importer: Importer = nativeImporter): LoadStrategy {
  return {
    kind: 'dynamic-import',
    load: (request) => guarded(request, () => importer(entryUrl(request))),
  };
}

/**
 * `import('@sf/chunk/<id>')` resolved by an installed import map (stable specifiers in
 * code). Retries fall back to the hashed URL (a failed bare import is cached by the module map).
 */
export function importMapStrategy(importer: Importer = nativeImporter): LoadStrategy {
  return {
    kind: 'import-map',
    load: (request) =>
      guarded(request, () => importer(request.attempt <= 1 ? chunkSpecifier(request.chunk.id) : entryUrl(request))),
  };
}

export interface InstallImportMapOptions {
  /** Feature detection; default `HTMLScriptElement.supports('importmap')`. */
  readonly supports?: () => boolean;
}

/** Inject the manifest as one `<script type="importmap">` (install before any module script). */
export function installImportMap(
  document: LoaderDocument,
  manifest: SfManifest,
  options: InstallImportMapOptions = {},
): Result<void> {
  const supports =
    options.supports ??
    (() => {
      const ctor = (globalThis as { HTMLScriptElement?: { supports?: (type: string) => boolean } }).HTMLScriptElement;
      return typeof ctor?.supports === 'function' && ctor.supports('importmap');
    });
  if (!supports()) return err(ImportMapUnsupportedError());
  const script = document.createElement('script');
  script.setAttribute('type', 'importmap');
  script.textContent = JSON.stringify(toImportMap(manifest));
  document.head.appendChild(script);
  return ok();
}

// ---------------------------------------------------------------- federation

/** A host-owned shared singleton (one version per app, P9). */
export interface SharedSingleton {
  readonly version: string;
  get(): unknown;
}

export type ShareScope = Readonly<Record<string, SharedSingleton>>;

/** Module-Federation-style container (the shape MF remote entries expose). */
export interface RemoteContainer {
  /** Shared versions the remote requires (merged with the manifest's `remote.shared`). */
  readonly requiredShared?: Readonly<Record<string, string>>;
  init(shareScope: ShareScope): void | Promise<void>;
  get(module: string): Promise<() => unknown>;
}

export interface FederationOptions {
  /** Host singletons offered to every remote. */
  readonly shared: ShareScope;
  /** Load the remote entry. Default: `importer(url)` whose namespace exports `init`/`get`. */
  readonly loadContainer?: (url: string, signal: AbortSignal) => Promise<RemoteContainer>;
  readonly importer?: Importer;
}

function parseVersion(version: string): [number, number, number] | undefined {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(version.trim());
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

function compare(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < 3; i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Minimal semver range check: `*`, exact `1.2.3`, partial `1` / `1.2`, `^`, `~`,
 * `>=`, `<`, space-separated AND, `||` alternatives. Enough for singleton checks.
 */
export function satisfiesRange(version: string, range: string): boolean {
  const v = parseVersion(version);
  if (v === undefined) return false;
  return range.split('||').some((alternative) =>
    alternative
      .trim()
      .split(/\s+/)
      .filter((part) => part !== '')
      .every((part) => {
        if (part === '*' || part === 'x') return true;
        const op = /^(\^|~|>=|<=|>|<|=)?(.*)$/.exec(part);
        const operator = op?.[1] ?? '';
        const target = parseVersion(op?.[2] ?? '');
        if (target === undefined) return false;
        const c = compare(v, target);
        const segments = (op?.[2] ?? '').replace(/^v/, '').split('.').length;
        switch (operator) {
          case '^':
            if (c < 0) return false;
            if (target[0] !== 0) return v[0] === target[0];
            if (target[1] !== 0) return v[0] === 0 && v[1] === target[1];
            return v[0] === 0 && v[1] === 0 && v[2] === target[2];
          case '~':
            return c >= 0 && v[0] === target[0] && v[1] === target[1];
          case '>=':
            return c >= 0;
          case '<=':
            return c <= 0;
          case '>':
            return c > 0;
          case '<':
            return c < 0;
          default:
            if (segments === 1) return v[0] === target[0];
            if (segments === 2) return v[0] === target[0] && v[1] === target[1];
            return c === 0;
        }
      }),
  );
}

/** Check a remote's required singletons against the host share scope. */
export function checkShared(
  chunkId: string,
  shared: ShareScope,
  required: Readonly<Record<string, string>>,
): Result<void> {
  for (const [name, range] of Object.entries(required)) {
    const host = shared[name];
    if (host === undefined || !satisfiesRange(host.version, range)) {
      return err(
        SharedVersionMismatchError({
          message: `Remote "${chunkId}" requires ${name}@${range}; host provides ${host === undefined ? 'nothing' : host.version}.`,
          details: { chunk: chunkId, shared: name, required: range, provided: host?.version ?? null },
        }),
      );
    }
  }
  return ok();
}

function isContainer(value: unknown): value is RemoteContainer {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { init?: unknown }).init === 'function' &&
    typeof (value as { get?: unknown }).get === 'function'
  );
}

/** Federation strategy for chunks with `remote` in the manifest. Containers are initialized once. */
export function federationStrategy(options: FederationOptions): LoadStrategy {
  const importer = options.importer ?? nativeImporter;
  const loadContainer =
    options.loadContainer ??
    (async (url: string): Promise<RemoteContainer> => {
      const namespace = await importer(url);
      if (!isContainer(namespace)) throw RemoteContainerError({ message: `"${url}" is not a remote container (no init/get).` });
      return namespace;
    });
  const containers = new Map<string, Promise<Result<RemoteContainer>>>();

  const containerFor = (chunk: ManifestChunk, url: string, signal: AbortSignal): Promise<Result<RemoteContainer>> => {
    let pending = containers.get(url);
    if (pending === undefined) {
      pending = (async (): Promise<Result<RemoteContainer>> => {
        let container: RemoteContainer;
        try {
          container = await loadContainer(url, signal);
        } catch (error) {
          const sf = toSfError(error);
          return err(sf.code === RemoteContainerError.code ? sf : RemoteContainerError({ cause: error, details: { chunk: chunk.id, url } }));
        }
        const checked = checkShared(chunk.id, options.shared, { ...chunk.remote?.shared, ...container.requiredShared });
        if (!checked.ok) return err(checked.error);
        try {
          await container.init(options.shared);
        } catch (error) {
          return err(RemoteContainerError({ cause: error, message: `Remote container init failed for "${chunk.id}".`, details: { chunk: chunk.id, url } }));
        }
        return ok(container);
      })();
      containers.set(url, pending);
      // Failed containers can be retried.
      void pending.then((result) => {
        if (!result.ok) containers.delete(url);
      });
    }
    return pending;
  };

  return {
    kind: 'federation',
    async load(request) {
      const remote = request.chunk.remote;
      if (remote === undefined) return err(RemoteContainerError({ message: `Chunk "${request.chunk.id}" has no remote.`, details: { chunk: request.chunk.id } }));
      // Version check even when the container is cached (another remote may share it with other needs).
      const declared = checkShared(request.chunk.id, options.shared, remote.shared ?? {});
      if (!declared.ok) return declared;
      const container = await containerFor(request.chunk, fileUrl(request.manifest, remote.entry), request.signal);
      if (!container.ok) return err(container.error);
      try {
        const factory = await container.value.get(remote.module);
        return ok(factory());
      } catch (error) {
        return err(RemoteContainerError({ cause: error, message: `Remote "${request.chunk.id}" does not expose "${remote.module}".`, details: { chunk: request.chunk.id, module: remote.module } }));
      }
    },
  };
}
