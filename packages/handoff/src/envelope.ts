/**
 * The shared snapshot envelope (R19.3): one format for handoff entries, feature
 * archives (R5.3), guest-slice migration (R9.11) and anything else persisted
 * across a boundary.
 *
 *   { v: 1, key: 'studio/guest-draft', version: 2, createdAt: 1761300000000, expiresAt?: …, data: … }
 *
 * `v` is the envelope format; `version` is the payload schema version owned by
 * the slot. Reading validates the shape, the key, runs migrations up to the
 * expected version and validates the payload (schema). Every failure is a typed
 * error, never a throw.
 */
import { defineError, err, ok, type Result } from '@staticflux/core';

export const ENVELOPE_FORMAT = 1;

export interface SnapshotEnvelope<T = unknown> {
  readonly v: typeof ENVELOPE_FORMAT;
  readonly key: string;
  readonly version: number;
  /** Epoch ms (wall clock). */
  readonly createdAt: number;
  /** Epoch ms after which the envelope is stale. */
  readonly expiresAt?: number;
  readonly data: T;
}

export const MalformedEnvelopeError = defineError(
  'SF-HANDOFF-001',
  'validation',
  'Stored data is not a valid snapshot envelope.',
  'The entry was written by something else or is corrupted; it is discarded. Write entries only through the handoff store / createEnvelope().',
);

export const EnvelopeKeyMismatchError = defineError(
  'SF-HANDOFF-002',
  'validation',
  'A snapshot envelope belongs to a different key.',
  'Each slot key must map to exactly one storage key; check for two slots sharing a key.',
);

export const EnvelopeVersionError = defineError(
  'SF-HANDOFF-003',
  'validation',
  'A snapshot envelope has a version that cannot be migrated to the expected version.',
  'Add a migration for every version step (`migrations: { 1: v1 => v2 }`); envelopes from newer app versions are discarded.',
);

export const EnvelopeExpiredError = defineError(
  'SF-HANDOFF-004',
  'not-found',
  'A snapshot envelope has expired.',
  'Expected for TTL entries; write a fresh entry or raise the TTL with a reason.',
);

export const EnvelopeSchemaError = defineError(
  'SF-HANDOFF-005',
  'validation',
  'A snapshot payload failed schema validation.',
  'The payload shape changed without a version bump; bump `version` and add a migration.',
);

/** Payload validation: either a `parse` returning a Result, or a type guard. */
export type HandoffSchema<T> = { readonly parse: (input: unknown) => Result<T> } | ((input: unknown) => input is T);

/** `migrations[n]` upgrades a payload from version n to n + 1. */
export type Migrations = Readonly<Record<number, (data: unknown) => unknown>>;

export interface CreateEnvelopeInput<T> {
  readonly key: string;
  readonly version: number;
  readonly data: T;
  readonly now: number;
  readonly ttlMs?: number | undefined;
}

export function createEnvelope<T>(input: CreateEnvelopeInput<T>): SnapshotEnvelope<T> {
  const base = { v: ENVELOPE_FORMAT, key: input.key, version: input.version, createdAt: input.now, data: input.data } as const;
  return input.ttlMs === undefined ? base : { ...base, expiresAt: input.now + input.ttlMs };
}

/** Structural check only (no key/version/schema). */
export function isEnvelope(value: unknown): value is SnapshotEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v['v'] === ENVELOPE_FORMAT &&
    typeof v['key'] === 'string' &&
    typeof v['version'] === 'number' &&
    Number.isInteger(v['version']) &&
    typeof v['createdAt'] === 'number' &&
    (v['expiresAt'] === undefined || typeof v['expiresAt'] === 'number') &&
    'data' in v
  );
}

export interface ParseEnvelopeOptions<T> {
  readonly key: string;
  readonly version: number;
  readonly schema?: HandoffSchema<T> | undefined;
  readonly migrations?: Migrations | undefined;
  /** When given, expired envelopes are rejected with SF-HANDOFF-004. */
  readonly now?: number | undefined;
}

export function validateWith<T>(schema: HandoffSchema<T> | undefined, data: unknown): Result<T> {
  if (schema === undefined) return ok(data as T);
  if (typeof schema === 'function') {
    return schema(data) ? ok(data) : err(EnvelopeSchemaError());
  }
  const parsed = schema.parse(data);
  return parsed.ok ? parsed : err(EnvelopeSchemaError({ cause: parsed.error, message: parsed.error.message }));
}

/** Validate, migrate and type a raw stored value. */
export function parseEnvelope<T>(raw: unknown, options: ParseEnvelopeOptions<T>): Result<SnapshotEnvelope<T>> {
  if (!isEnvelope(raw)) return err(MalformedEnvelopeError({ details: { key: options.key } }));
  if (raw.key !== options.key) {
    return err(EnvelopeKeyMismatchError({ details: { expected: options.key, actual: raw.key } }));
  }
  if (options.now !== undefined && raw.expiresAt !== undefined && raw.expiresAt <= options.now) {
    return err(EnvelopeExpiredError({ details: { key: raw.key, expiresAt: raw.expiresAt } }));
  }
  if (raw.version > options.version) {
    return err(EnvelopeVersionError({ message: `Envelope "${raw.key}" has version ${raw.version}, newer than ${options.version}.`, details: { key: raw.key, version: raw.version } }));
  }
  let data: unknown = raw.data;
  for (let version = raw.version; version < options.version; version += 1) {
    const migrate = options.migrations?.[version];
    if (migrate === undefined) {
      return err(EnvelopeVersionError({ message: `No migration from version ${version} for "${raw.key}".`, details: { key: raw.key, from: version } }));
    }
    try {
      data = migrate(data);
    } catch (error) {
      return err(EnvelopeVersionError({ message: `Migration from version ${version} for "${raw.key}" threw.`, cause: error, details: { key: raw.key, from: version } }));
    }
  }
  const valid = validateWith(options.schema, data);
  if (!valid.ok) return valid;
  return ok({ ...raw, version: options.version, data: valid.value });
}
