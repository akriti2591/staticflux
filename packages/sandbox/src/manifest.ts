/**
 * Plugin manifests (R3.4): what an untrusted plugin is, where its code lives,
 * and the ceiling of what it may do — capabilities it may call (the host grants
 * a subset at runtime), events it may receive, permissions and resource limits.
 *
 * A manifest from a third party is untrusted input: `validateManifest` checks
 * every field before the host loads anything.
 */
import type { CapabilityId } from '@staticflux/capabilities';
import { err, ok, type Result } from '@staticflux/core';
import { ManifestInvalidError } from './errors.js';

export type PluginId = `${string}/${string}`;

/** Permissions beyond capabilities. `render`: visible in the host slot (iframe); `resize`: may ask for a slot height. */
export const PLUGIN_PERMISSIONS = ['render', 'resize'] as const;
export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number];

export type PluginEntry =
  /** Sandboxed iframe loading a module script from `url` (https or app-relative). */
  | { readonly kind: 'iframe'; readonly url: string }
  /** Sandboxed iframe running inline module code (CSP nonce). */
  | { readonly kind: 'iframe'; readonly code: string }
  /** Dedicated module worker (no DOM). See `workerRealm` for the same-origin caveat. */
  | { readonly kind: 'worker'; readonly url: string };

export type PluginEntryKind = PluginEntry['kind'];

export interface PluginLimits {
  /** Messages per second from the plugin (token bucket, burst = the same number). */
  readonly maxMessagesPerSecond: number;
  /** Estimated size of one message from the plugin. */
  readonly maxPayloadBytes: number;
  /** One capability call, end to end. */
  readonly callTimeoutMs: number;
  /** Concurrent capability calls. */
  readonly maxConcurrentCalls: number;
}

export const DEFAULT_PLUGIN_LIMITS: PluginLimits = Object.freeze({
  maxMessagesPerSecond: 50,
  maxPayloadBytes: 256 * 1024,
  callTimeoutMs: 10_000,
  maxConcurrentCalls: 8,
});

export interface PluginManifest {
  readonly id: PluginId;
  /** Semver. */
  readonly version: string;
  /** Human name (iframe title, devtools). */
  readonly name?: string;
  readonly entry: PluginEntry;
  /** Capabilities the plugin may be granted (the ceiling; grants are decided by the host). */
  readonly capabilities: readonly CapabilityId[];
  /** Event ids the plugin wants to receive. */
  readonly events: readonly string[];
  readonly permissions: readonly PluginPermission[];
  /** Requested limits; the host clamps them to its own ceiling. */
  readonly limits?: Partial<PluginLimits>;
}

/** Typed identity for authored manifests (validated again at load). */
export function definePluginManifest<const M extends PluginManifest>(manifest: M): M {
  return Object.freeze(manifest);
}

declare const eventPayload: unique symbol;

/** A host event a plugin may subscribe to (declared in its manifest). */
export interface PluginEvent<P = unknown, Id extends string = string> {
  readonly kind: 'plugin-event';
  readonly id: Id;
  readonly [eventPayload]?: P;
}

export type PluginEventPayload<E> = E extends PluginEvent<infer P, string> ? P : never;

/** @example export const SelectionChanged = definePluginEvent('studio/selection-changed').type<{ ids: string[] }>(); */
export function definePluginEvent<const Id extends `${string}/${string}`>(id: Id): { type<P>(): PluginEvent<P, Id> } {
  return { type: <P>() => Object.freeze({ kind: 'plugin-event', id }) as PluginEvent<P, Id> };
}

// ---------------------------------------------------------------- validation (untrusted input)

const NAMESPACED = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._/-]*$/i;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?(?:\+[0-9a-z.-]+)?$/i;
const MAX_LIST = 256;
const MAX_CODE = 512 * 1024;

/** https/http(s) for localhost, blob:, or an app-relative path. Never javascript:/data:. */
export function isAllowedEntryUrl(url: string): boolean {
  if (url.length === 0 || url.length > 2048) return false;
  if (url.startsWith('/') && !url.startsWith('//')) return true;
  if (url.startsWith('./') || url.startsWith('../')) return true;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === 'https:' || parsed.protocol === 'blob:') return true;
  return parsed.protocol === 'http:' && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
}

function isStringList(value: unknown, test: (item: string) => boolean): value is readonly string[] {
  return Array.isArray(value) && value.length <= MAX_LIST && value.every((item) => typeof item === 'string' && test(item));
}

function validateEntry(value: unknown, issues: string[]): PluginEntry | undefined {
  if (typeof value !== 'object' || value === null) {
    issues.push('entry: expected an object');
    return undefined;
  }
  const v = value as Record<string, unknown>;
  if (v['kind'] === 'iframe' && typeof v['code'] === 'string') {
    if (v['code'].length > MAX_CODE) issues.push('entry.code: too large');
    return { kind: 'iframe', code: v['code'] };
  }
  if ((v['kind'] === 'iframe' || v['kind'] === 'worker') && typeof v['url'] === 'string') {
    if (!isAllowedEntryUrl(v['url'])) issues.push('entry.url: must be https, blob: or app-relative');
    return v['kind'] === 'iframe' ? { kind: 'iframe', url: v['url'] } : { kind: 'worker', url: v['url'] };
  }
  issues.push("entry: expected { kind: 'iframe', url | code } or { kind: 'worker', url }");
  return undefined;
}

function validateLimits(value: unknown, issues: string[]): Partial<PluginLimits> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null) {
    issues.push('limits: expected an object');
    return undefined;
  }
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!(key in DEFAULT_PLUGIN_LIMITS)) {
      issues.push(`limits.${key}: unknown limit`);
      continue;
    }
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
      issues.push(`limits.${key}: expected a positive number`);
      continue;
    }
    out[key] = raw;
  }
  return out as Partial<PluginLimits>;
}

/** Validate an (untrusted) manifest. Unknown top-level keys are rejected. */
export function validateManifest(value: unknown): Result<PluginManifest> {
  const issues: string[] = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return err(ManifestInvalidError({ details: { issues: 'manifest: expected an object' } }));
  }
  const v = value as Record<string, unknown>;
  const known = new Set(['id', 'version', 'name', 'entry', 'capabilities', 'events', 'permissions', 'limits']);
  for (const key of Object.keys(v)) if (!known.has(key)) issues.push(`${key}: unknown field`);
  const id = v['id'];
  if (typeof id !== 'string' || !NAMESPACED.test(id) || id.length > 128) issues.push('id: expected a namespaced id (vendor/name)');
  if (typeof v['version'] !== 'string' || !SEMVER.test(v['version'])) issues.push('version: expected semver');
  if (v['name'] !== undefined && (typeof v['name'] !== 'string' || v['name'].length > 128)) issues.push('name: expected a short string');
  const entry = validateEntry(v['entry'], issues);
  if (!isStringList(v['capabilities'], (item) => NAMESPACED.test(item))) issues.push('capabilities: expected namespaced capability ids');
  if (!isStringList(v['events'], (item) => NAMESPACED.test(item))) issues.push('events: expected namespaced event ids');
  if (!isStringList(v['permissions'], (item) => (PLUGIN_PERMISSIONS as readonly string[]).includes(item))) {
    issues.push(`permissions: expected a subset of ${PLUGIN_PERMISSIONS.join(', ')}`);
  }
  const limits = validateLimits(v['limits'], issues);
  if (issues.length > 0 || entry === undefined) {
    return err(ManifestInvalidError({ details: { issues: issues.join('; '), plugin: typeof id === 'string' ? id : 'unknown' } }));
  }
  const manifest: PluginManifest = {
    id: id as PluginId,
    version: v['version'] as string,
    ...(typeof v['name'] === 'string' ? { name: v['name'] } : {}),
    entry,
    capabilities: [...new Set(v['capabilities'] as CapabilityId[])],
    events: [...new Set(v['events'] as string[])],
    permissions: [...new Set(v['permissions'] as PluginPermission[])],
    ...(limits === undefined ? {} : { limits }),
  };
  return ok(Object.freeze(manifest));
}

/** The manifest's requested limits clamped to the host ceiling. */
export function effectiveLimits(manifest: PluginManifest, ceiling: PluginLimits = DEFAULT_PLUGIN_LIMITS): PluginLimits {
  const requested = manifest.limits ?? {};
  const pick = (key: keyof PluginLimits): number => Math.min(requested[key] ?? ceiling[key], ceiling[key]);
  return Object.freeze({
    maxMessagesPerSecond: pick('maxMessagesPerSecond'),
    maxPayloadBytes: pick('maxPayloadBytes'),
    callTimeoutMs: pick('callTimeoutMs'),
    maxConcurrentCalls: pick('maxConcurrentCalls'),
  });
}
