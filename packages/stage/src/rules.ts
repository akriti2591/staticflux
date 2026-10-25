/**
 * Where the stage finds arcs, finals and locks in node properties. Defaults follow DOCUMENT-FORMAT §3.2–3.3; every
 * path is a value here (no string literals in composition code), and an editor can replace any rule.
 *
 * Storage shapes (one LWW register per entry, so concurrent edits to different entries merge):
 * - variant opinions: `variants.opinions.<set>=<value>` → `{ [path]: value }`         (Variants.opinions)
 * - instance:         `instance.ref` → `AssetRef`; `instance.overrides.<sourceNode>` → `{ [path]: value }`
 * - inherit:          `style.inherit` → `{ kit: AssetRef, class: string }` (BrandClassRef); the class is a node of the kit
 * - final paths:      `policy.final` on a class / kit node → path patterns kept regardless of strength
 * - locks:            `lock.scope` → `position | content | all`; `lock.policy` → `{ by: AssetRef, reason }` (humans only)
 *
 * A path pattern ending in `.` is a prefix (`spatial.`); otherwise it matches the path itself and its sub-paths
 * (`style.fill` matches `style.fill.color`).
 */
import type { JsonObject, JsonValue, NodeId, PropertyPath } from '@staticflux/document/v2';
import { type AssetRef, isAssetRef } from './source.js';

export interface ArcTarget {
  /** Another asset; omitted = the same asset. */
  readonly ref?: AssetRef;
  readonly node: NodeId;
}

export interface InheritRule {
  /** The property naming the target (e.g. `style.inherit`). */
  readonly path: PropertyPath;
  target(value: JsonValue): ArcTarget | undefined;
}

export interface TokenRule {
  /** A value that is a token reference (`{ token: 'color.primary', kit? }`) → where its value lives. */
  match(value: JsonValue): (ArcTarget & { readonly path: PropertyPath }) | undefined;
}

export const LOCK_SCOPES = ['position', 'content', 'all'] as const;
export type LockScope = (typeof LOCK_SCOPES)[number];

export interface StageRules {
  readonly variantPrefix: string;
  readonly inherit: readonly InheritRule[];
  readonly instanceRef: PropertyPath;
  readonly overridesPrefix: string;
  readonly finalPaths: PropertyPath;
  readonly lockScope: PropertyPath;
  readonly lockPolicy: PropertyPath;
  /** Paths a `position` lock covers (moves are always covered). Everything else is content. */
  readonly positionPaths: readonly string[];
  /** Paths never taken from an inherit or reference target (identity, arcs, locks). */
  readonly notInherited: readonly string[];
  readonly token?: TokenRule;
}

export const BRAND_CLASS_INHERIT: InheritRule = {
  path: 'style.inherit',
  target(value) {
    const object = asJsonObject(value);
    if (object === undefined) return undefined;
    const kit = object['kit'];
    const cls = object['class'];
    if (typeof cls !== 'string' || cls.length === 0) return undefined;
    return isAssetRef(kit) ? { ref: kit, node: cls } : { node: cls };
  },
};

export const DEFAULT_STAGE_RULES: StageRules = {
  variantPrefix: 'variants.opinions.',
  inherit: [BRAND_CLASS_INHERIT],
  instanceRef: 'instance.ref',
  overridesPrefix: 'instance.overrides.',
  finalPaths: 'policy.final',
  lockScope: 'lock.scope',
  lockPolicy: 'lock.policy',
  positionPaths: ['spatial.x', 'spatial.y', 'spatial.w', 'spatial.h', 'spatial.rotation', 'spatial.scaleX', 'spatial.scaleY', 'spatial.anchorX', 'spatial.anchorY', 'spatial.flipX', 'spatial.flipY', 'temporal.'],
  notInherited: ['name', 'role', 'variants.', 'instance.', 'lock.', 'policy.', 'style.inherit'],
};

/** Path pattern match (see the module comment). */
export function matchesPath(path: PropertyPath, pattern: string): boolean {
  if (pattern.endsWith('.')) return path.startsWith(pattern);
  return path === pattern || path.startsWith(`${pattern}.`);
}

export function matchesAny(path: PropertyPath, patterns: readonly string[]): boolean {
  return patterns.some((p) => matchesPath(path, p));
}

/** The variant key `<set>=<value>`. */
export function variantKey(set: string, value: string): string {
  return `${set}=${value}`;
}

export function isLockScope(value: unknown): value is LockScope {
  return (LOCK_SCOPES as readonly unknown[]).includes(value);
}

/** The value as a JSON object (not an array), or undefined. */
export function asJsonObject(value: JsonValue | undefined): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonObject) : undefined;
}
