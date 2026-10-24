/**
 * Layered resolution (R8.5): package default < app < workspace < remote <
 * experiment < local dev override. Every layer above the package default is
 * a `FlagLayerProvider`; several providers may share a layer (later wins).
 *
 * Providers are synchronous at evaluation time (static-context paradigm):
 * `lookup()` reads a provider-held cache; async work happens in
 * `initialize()` / `onContextChange()`.
 */
import { type Result, type SfError, ok } from '@staticflux/core';
import type { EvaluationContext } from './context.js';
import type { AnyFlag, FlagDefinition, FlagEntry, FlagKey, FlagValues } from './flag.js';
import type { FlagHook } from './hooks.js';

export const LAYERS = ['default', 'app', 'workspace', 'remote', 'experiment', 'local'] as const;
export type LayerId = (typeof LAYERS)[number];
/** Layers a provider can occupy (`default` is the declaration itself). */
export type ProviderLayer = Exclude<LayerId, 'default'>;

export function layerRank(layer: LayerId): number {
  return LAYERS.indexOf(layer);
}

/** OpenFeature resolution reasons (plus `PRE_AUTH`). */
export type EvaluationReason =
  | 'STATIC'
  | 'DEFAULT'
  | 'TARGETING_MATCH'
  | 'SPLIT'
  | 'CACHED'
  | 'DISABLED'
  | 'UNKNOWN'
  | 'STALE'
  | 'ERROR'
  | 'PRE_AUTH';

export interface LayerLookup {
  readonly value: unknown;
  readonly variant?: string;
  readonly reason?: EvaluationReason;
  readonly flagMetadata?: Readonly<Record<string, string | number | boolean>>;
}

export type LayerEvent =
  | { readonly type: 'ready' }
  | { readonly type: 'configuration-changed'; readonly keys?: readonly FlagKey[] }
  | { readonly type: 'stale' }
  | { readonly type: 'error'; readonly error: SfError; readonly fatal?: boolean };

export interface FlagLayerProvider {
  /** Namespaced id, e.g. `app/static-config`, `remote/flags-api`. */
  readonly id: string;
  readonly layer: ProviderLayer;
  /**
   * Values depend on the user's identity: skipped for non-`preAuthSafe` flags
   * before authentication. Default: true for `remote`/`experiment`, false otherwise.
   */
  readonly identityBound?: boolean;
  /** OpenFeature-style provider hooks (run on every evaluation). */
  readonly hooks?: readonly FlagHook[];
  initialize?(context: EvaluationContext, signal: AbortSignal): Promise<Result<void>>;
  onContextChange?(previous: EvaluationContext, next: EvaluationContext, signal: AbortSignal): Promise<Result<void>>;
  /** `ok(undefined)` = no opinion (fall through). */
  lookup(flag: AnyFlag, context: EvaluationContext): Result<LayerLookup | undefined>;
  /** Provider events; returns unsubscribe. */
  subscribe?(listener: (event: LayerEvent) => void): () => void;
  dispose?(): void | Promise<void>;
}

export function isIdentityBound(provider: FlagLayerProvider): boolean {
  return provider.identityBound ?? (provider.layer === 'remote' || provider.layer === 'experiment');
}

// ---------------------------------------------------------------- static (mutable) layer

export interface StaticLayer extends FlagLayerProvider {
  set<T>(flag: FlagDefinition<T>, value: T): void;
  /** Set by key (devtools); validated by the flag schema at evaluation. */
  setByKey(key: FlagKey, value: unknown): void;
  unset(flag: AnyFlag | FlagKey): void;
  /** Replace every value at once (one change event). */
  replace(values: Readonly<Record<string, unknown>>): void;
  entries(): Readonly<Record<string, unknown>>;
}

export interface StaticLayerOptions {
  readonly id: string;
  readonly layer: ProviderLayer;
  readonly values?: FlagValues;
  readonly entries?: readonly FlagEntry[];
  readonly identityBound?: boolean;
  readonly reason?: EvaluationReason;
  /** Called after every mutation (persistence hook for the local layer). */
  readonly onWrite?: (values: Readonly<Record<string, unknown>>) => void;
}

/** In-memory values: app config, workspace presets, snapshots replicated to workers, devtools overrides. */
export function createStaticLayer(options: StaticLayerOptions): StaticLayer {
  const values = new Map<string, unknown>(Object.entries(options.values ?? {}));
  for (const entry of options.entries ?? []) values.set(entry.flag.key, entry.value);
  const listeners = new Set<(event: LayerEvent) => void>();
  const changed = (keys?: readonly FlagKey[]): void => {
    options.onWrite?.(Object.fromEntries(values));
    for (const listener of [...listeners]) listener(keys === undefined ? { type: 'configuration-changed' } : { type: 'configuration-changed', keys });
  };
  return {
    id: options.id,
    layer: options.layer,
    ...(options.identityBound === undefined ? {} : { identityBound: options.identityBound }),
    lookup(flag) {
      if (!values.has(flag.key)) return ok(undefined);
      return ok({ value: values.get(flag.key), reason: options.reason ?? 'STATIC' });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(flag, value) {
      values.set(flag.key, value);
      changed([flag.key]);
    },
    setByKey(key, value) {
      values.set(key, value);
      changed([key]);
    },
    unset(flag) {
      const key = typeof flag === 'string' ? flag : flag.key;
      if (values.delete(key)) changed([key]);
    },
    replace(next) {
      values.clear();
      for (const [key, value] of Object.entries(next)) values.set(key, value);
      changed();
    },
    entries() {
      return Object.fromEntries(values);
    },
    dispose() {
      listeners.clear();
    },
  };
}

// ---------------------------------------------------------------- local dev override layer

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface LocalOverrideLayerOptions {
  readonly id?: string;
  /** Persist overrides (e.g. `localStorage`). Access errors are swallowed (Safari private mode). */
  readonly storage?: StorageLike;
  readonly storageKey?: string;
  /** `location.search`; `?sf-flag=studio/ai-suggestions:true&sf-flag=onboarding/variant:B`. */
  readonly search?: string;
  readonly urlParam?: string;
}

export const DEFAULT_LOCAL_STORAGE_KEY = 'sf-flags';
export const DEFAULT_FLAG_URL_PARAM = 'sf-flag';

/** Parse a URL/dev value: JSON when possible (`true`, `3`, `{"a":1}`), otherwise the raw string. */
export function parseDevValue(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

/** `key:value` pairs from `?sf-flag=…` (repeatable). */
export function parseFlagParams(search: string, param: string = DEFAULT_FLAG_URL_PARAM): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const entry of new URLSearchParams(search).getAll(param)) {
    const index = entry.indexOf(':');
    if (index <= 0) continue;
    out[entry.slice(0, index)] = parseDevValue(entry.slice(index + 1));
  }
  return out;
}

/**
 * Local dev override layer (highest precedence). Values come from storage
 * and the URL (URL wins); `set()` persists to storage.
 */
export function createLocalOverrideLayer(options: LocalOverrideLayerOptions = {}): StaticLayer {
  const storageKey = options.storageKey ?? DEFAULT_LOCAL_STORAGE_KEY;
  let stored: Record<string, unknown> = {};
  try {
    const raw = options.storage?.getItem(storageKey);
    if (raw !== null && raw !== undefined) {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) stored = parsed as Record<string, unknown>;
    }
  } catch {
    stored = {};
  }
  const fromUrl = options.search === undefined ? {} : parseFlagParams(options.search, options.urlParam);
  return createStaticLayer({
    id: options.id ?? 'config/local-override',
    layer: 'local',
    identityBound: false,
    values: { ...stored, ...fromUrl } as FlagValues,
    onWrite: (values) => {
      try {
        if (Object.keys(values).length === 0) options.storage?.removeItem(storageKey);
        else options.storage?.setItem(storageKey, JSON.stringify(values));
      } catch {
        // Storage unavailable: overrides stay in memory for this page.
      }
    },
  });
}
