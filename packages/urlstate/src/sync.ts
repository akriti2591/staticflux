/**
 * URL-sync service (R7.11): binds declared `view` / `sticky` query params to
 * stores, both ways, batched to one history write per frame.
 *
 * - Store → URL: a change marks the binding dirty and schedules a flush; the flush
 *   writes every bound value at once (`push` if any dirty binding is `push`,
 *   else `replace`). Defaults are never written.
 * - URL → store: on back/forward and external navigations, values are parsed and
 *   applied in one batch. Invalid values fall back to the default and are
 *   removed from the URL.
 * - Sticky params missing after a navigation keep their store value and are put
 *   back with `replace` (carried across navigations); `decorate(href)` adds them
 *   to links before navigating.
 * - Declared `hidden` keys (and reserved keys) found in the URL are stripped.
 *
 * Only the `HistoryPort` is used — the router is never invoked; stores never see
 * the URL.
 */
import {
  batch,
  type Box,
  createNoopTelemetry,
  err,
  ok,
  type Result,
  type Scope,
  type Telemetry,
  untracked,
  watch,
} from '@staticflux/core';
import { type AnyUrlBinding, createUrlDeclarationRegistry, type UrlBinding, type UrlDeclarationRegistry } from './binding.js';
import { codecEquals } from './codec.js';
import { UnsyncableBindingError } from './errors.js';
import type { HistoryChange, HistoryPort } from './history.js';
import type { FrameScheduler } from './scheduler.js';
import { formatUrl, getParam, hasParam, parseUrl, type UrlParts, withoutParams, withParam } from './url.js';

/** What a store exposes to the sync service. `get` should be reactive (tracked). */
export interface UrlStoreAdapter<T> {
  get(): T | undefined;
  set(value: T | undefined): void;
}

/** Adapter over a core `box`. */
export function boxAdapter<T>(value: Box<T | undefined>): UrlStoreAdapter<T> {
  return { get: () => value.get(), set: (next) => value.set(next) };
}

export const URLSTATE_SOURCE = 'urlstate';

export interface UrlSyncOptions {
  readonly history: HistoryPort;
  readonly scheduler: FrameScheduler;
  readonly registry?: UrlDeclarationRegistry;
  readonly telemetry?: Telemetry;
}

export interface BoundInfo {
  readonly key: string;
  readonly kind: string;
  readonly owner: string;
  readonly value: unknown;
}

export interface UrlSync {
  bind<T>(binding: UrlBinding<string, T>, store: UrlStoreAdapter<T>, scope?: Scope): Result<() => void>;
  /** Write pending changes now (e.g. right before a router navigation). */
  flush(): void;
  readonly pending: boolean;
  /** Add current sticky params to a target URL that lacks them. */
  decorate(target: string): string;
  inspect(): readonly BoundInfo[];
  dispose(): void;
}

interface Entry {
  readonly binding: AnyUrlBinding;
  readonly store: UrlStoreAdapter<unknown>;
  dirty: boolean;
  stop: () => void;
}

const SUBSYSTEM = 'urlstate/sync';

export function createUrlSync(options: UrlSyncOptions): UrlSync {
  const { history, scheduler } = options;
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const registry = options.registry ?? createUrlDeclarationRegistry();
  const entries = new Map<string, Entry>();
  let cancelFrame: (() => void) | undefined;
  let disposed = false;

  const hiddenKeys = (): string[] =>
    registry.declarations.flatMap((d) => (d.kind === 'url-binding' && d.urlKind === 'hidden' ? [d.key] : d.kind === 'reserved-params' ? [...d.keys] : []));

  const schedule = (): void => {
    if (cancelFrame !== undefined || disposed) return;
    cancelFrame = scheduler.request(() => {
      cancelFrame = undefined;
      flush();
    });
  };

  const isDefault = (binding: AnyUrlBinding, value: unknown): boolean =>
    value === undefined || (binding.default !== undefined && codecEquals(binding.codec, value, binding.default));

  /** Parse a binding's value from URL parts. */
  const read = (binding: AnyUrlBinding, parts: UrlParts): { value: unknown; present: boolean; invalid: boolean } => {
    const raw = getParam(parts, binding.key);
    if (raw === undefined) return { value: binding.default, present: false, invalid: false };
    const parsed = binding.codec.parse(raw);
    if (parsed.ok) return { value: parsed.value, present: true, invalid: false };
    telemetry.event('urlstate.invalid-param', { subsystem: SUBSYSTEM, attrs: { key: binding.key, code: parsed.error.code } });
    return { value: binding.default, present: true, invalid: true };
  };

  const applyUrl = (url: string, initialEntry?: Entry): void => {
    const parts = parseUrl(url);
    let needsWrite = false;
    batch(() => {
      for (const entry of initialEntry === undefined ? entries.values() : [initialEntry]) {
        const { value, present, invalid } = read(entry.binding, parts);
        if (invalid) needsWrite = true;
        if (entry.binding.urlKind === 'sticky' && !present) {
          // Carry: a navigation dropped the sticky param; keep the store value and put it back.
          if (!isDefault(entry.binding, untracked(() => entry.store.get()))) needsWrite = true;
          continue;
        }
        const current = untracked(() => entry.store.get());
        const same = current === value || (current !== undefined && value !== undefined && codecEquals(entry.binding.codec, current, value));
        if (!same) entry.store.set(value);
      }
    });
    if (hiddenKeys().some((key) => hasParam(parts, key))) needsWrite = true;
    for (const entry of entries.values()) entry.dirty = false;
    if (needsWrite) schedule();
  };

  const desiredUrl = (): { url: string; changed: string[]; push: boolean } => {
    const current = history.url;
    let parts = parseUrl(current);
    const changed: string[] = [];
    let push = false;
    for (const entry of entries.values()) {
      const value = untracked(() => entry.store.get());
      const desired = isDefault(entry.binding, value) ? undefined : entry.binding.codec.serialize(value);
      if (getParam(parts, entry.binding.key) === desired && (desired !== undefined || !hasParam(parts, entry.binding.key))) continue;
      parts = withParam(parts, entry.binding.key, desired);
      changed.push(entry.binding.key);
      if (entry.dirty && entry.binding.history === 'push') push = true;
    }
    const hidden = hiddenKeys().filter((key) => hasParam(parts, key));
    if (hidden.length > 0) {
      parts = withoutParams(parts, hidden);
      changed.push(...hidden);
      telemetry.event('urlstate.hidden-stripped', { subsystem: SUBSYSTEM, level: 'standard', attrs: { keys: hidden } });
    }
    return { url: formatUrl(parts), changed, push };
  };

  const flush = (): void => {
    cancelFrame?.();
    cancelFrame = undefined;
    if (disposed) return;
    const { url, changed, push } = desiredUrl();
    for (const entry of entries.values()) entry.dirty = false;
    if (changed.length === 0 || url === history.url) return;
    const mode = push ? 'push' : 'replace';
    if (mode === 'push') history.push(url, { source: URLSTATE_SOURCE });
    else history.replace(url, { source: URLSTATE_SOURCE });
    telemetry.event('urlstate.write', { subsystem: SUBSYSTEM, level: 'verbose', attrs: { keys: changed, mode } });
  };

  const unsubscribe = history.subscribe((change: HistoryChange) => {
    if (change.source === URLSTATE_SOURCE) return;
    cancelFrame?.();
    cancelFrame = undefined;
    applyUrl(change.url);
  });

  return {
    bind(binding, store, scope) {
      if (disposed) return err(UnsyncableBindingError({ message: 'The URL-sync service is disposed.' }));
      if (binding.urlKind === 'hidden') {
        return err(UnsyncableBindingError({ message: `"${binding.key}" is a hidden binding; hidden state never syncs to the URL (use handoff).`, details: { key: binding.key } }));
      }
      if (entries.has(binding.key)) {
        const existing = entries.get(binding.key);
        if (existing?.binding !== binding) {
          return err(UnsyncableBindingError({ message: `"${binding.key}" is already bound by ${existing?.binding.owner ?? 'another store'}.`, details: { key: binding.key } }));
        }
        return err(UnsyncableBindingError({ message: `"${binding.key}" is already bound; unbind first.`, details: { key: binding.key } }));
      }
      const registered = registry.register(binding);
      if (!registered.ok) return registered;
      const entry: Entry = { binding, store: store as UrlStoreAdapter<unknown>, dirty: false, stop: () => undefined };
      entries.set(binding.key, entry);
      applyUrl(history.url, entry);
      entry.stop = watch(
        () => store.get(),
        () => {
          entry.dirty = true;
          schedule();
        },
      );
      const unbind = (): void => {
        if (entries.get(binding.key) !== entry) return;
        entry.stop();
        entries.delete(binding.key);
      };
      scope?.defer(unbind);
      return ok(unbind);
    },
    flush,
    get pending() {
      return cancelFrame !== undefined;
    },
    decorate(target) {
      let parts = parseUrl(target);
      for (const entry of entries.values()) {
        if (entry.binding.urlKind !== 'sticky' || hasParam(parts, entry.binding.key)) continue;
        const value = untracked(() => entry.store.get());
        if (isDefault(entry.binding, value)) continue;
        parts = withParam(parts, entry.binding.key, entry.binding.codec.serialize(value));
      }
      return formatUrl(parts);
    },
    inspect() {
      return [...entries.values()].map((e) => ({ key: e.binding.key, kind: e.binding.urlKind, owner: e.binding.owner, value: untracked(() => e.store.get()) }));
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelFrame?.();
      cancelFrame = undefined;
      unsubscribe();
      for (const entry of entries.values()) entry.stop();
      entries.clear();
    },
  };
}
