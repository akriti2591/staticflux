/**
 * Persistent user-data slices (R9.8–R9.12). One user-data document holds typed
 * per-feature slices; features only ever get a handle to the slice definition
 * they own, so they never read each other's data.
 *
 * @example
 * export const ThemeSlice = defineSlice({
 *   key: 'settings/theme', scope: 'user', version: 2,
 *   schema: s.object({ mode: s.enum(['light', 'dark', 'system']) }),
 *   default: () => ({ mode: 'system' }),
 *   migrations: { 2: (v1) => ({ mode: (v1 as { dark: boolean }).dark ? 'dark' : 'light' }) },
 * });
 */
import { defineMachine, err, ok, type Result, type TokenId, toSfError } from '@staticflux/core';
import { SliceMigrationError } from './errors.js';
import type { Schema } from './schema.js';

/** device: this browser · user: follows the user (synced) · workspace: per user+workspace (synced) · session: memory only. */
export type SliceScope = 'device' | 'user' | 'workspace' | 'session';

export type ConflictPolicy<T> = 'lww' | { readonly merge: (local: T, remote: T) => T };

/** `migrations[n]` migrates a value from version n-1 to version n. */
export type Migrations = Readonly<Record<number, (value: unknown) => unknown>>;

export interface SliceDefinition<T> {
  readonly kind: 'slice';
  readonly key: TokenId;
  readonly scope: SliceScope;
  readonly version: number;
  readonly schema: Schema<T>;
  readonly default: () => T;
  readonly migrations: Migrations;
  readonly conflict: ConflictPolicy<T>;
  /** Max persisted size (UTF-8 JSON bytes). Default 16 KiB. */
  readonly budgetBytes: number;
}

export interface SliceInit<T> {
  readonly key: TokenId;
  readonly scope: SliceScope;
  readonly version: number;
  readonly schema: Schema<T>;
  readonly default: () => T;
  readonly migrations?: Migrations;
  readonly conflict?: ConflictPolicy<T>;
  readonly budgetBytes?: number;
}

export const DEFAULT_SLICE_BUDGET = 16 * 1024;

/* @__NO_SIDE_EFFECTS__ */
export function defineSlice<T>(init: SliceInit<T>): SliceDefinition<T> {
  return Object.freeze({
    kind: 'slice',
    key: init.key,
    scope: init.scope,
    version: init.version,
    schema: init.schema,
    default: init.default,
    migrations: init.migrations ?? {},
    conflict: init.conflict ?? 'lww',
    budgetBytes: init.budgetBytes ?? DEFAULT_SLICE_BUDGET,
  });
}

/** What a backend stores per slice. Stable format. */
export interface SliceRecord {
  /** Slice schema version of `value`. */
  readonly v: number;
  readonly value: unknown;
  /** Wall-clock ms of the last local write (LWW clock). */
  readonly updatedAt: number;
}

/** Persistent slice lifecycle (docs/LIFECYCLES.md §10). */
export const SliceMachine = defineMachine({
  id: 'data/slice',
  initial: 'unloaded',
  states: ['unloaded', 'loading', 'migrating', 'ready', 'saving', 'conflicted', 'failed', 'flushed', 'cleared'],
  transitions: {
    unloaded: { load: 'loading' },
    loading: { migrate: 'migrating', loaded: 'ready', fail: 'failed' },
    migrating: { migrated: 'ready', fail: 'failed' },
    failed: { recover: 'ready' },
    ready: { save: 'saving', conflict: 'conflicted', flush: 'flushed' },
    saving: { saved: 'ready', saveFailed: 'ready' },
    conflicted: { resolve: 'ready' },
    flushed: { clear: 'cleared' },
    cleared: { load: 'loading' },
  },
});

export type SliceState = (typeof SliceMachine.states)[number];

/** Migrate + validate a stored record to the definition's version. Never throws. */
export function migrateRecord<T>(definition: SliceDefinition<T>, record: SliceRecord): Result<T> {
  if (record.v > definition.version) {
    return err(
      SliceMigrationError({
        message: `Stored slice "${definition.key}" has version ${record.v}, newer than ${definition.version}.`,
        details: { key: definition.key, from: record.v, to: definition.version },
      }),
    );
  }
  let value = record.value;
  for (let v = record.v + 1; v <= definition.version; v += 1) {
    const step = definition.migrations[v];
    if (step === undefined) {
      return err(SliceMigrationError({ message: `No migration to version ${v} for "${definition.key}".`, details: { key: definition.key, from: v - 1, to: v } }));
    }
    try {
      value = step(value);
    } catch (error) {
      return err(SliceMigrationError({ cause: toSfError(error), details: { key: definition.key, from: v - 1, to: v } }));
    }
  }
  const validated = definition.schema.validate(value);
  if (!validated.ok) {
    return err(SliceMigrationError({ cause: validated.error, details: { key: definition.key, from: record.v, to: definition.version, ...validated.error.details } }));
  }
  return ok(validated.value);
}
