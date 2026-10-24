/**
 * Generic JSON patches `{ op, path, value }` — the shape shared with
 * `@staticflux/data` stores so any store can be replicated. Paths are arrays
 * of keys (array indices as numbers). `applyPatches` is immutable with
 * structural sharing: untouched subtrees keep their identity.
 */
import { err, ok, type Result } from '@staticflux/core';
import { InvalidPatchError } from './errors.js';

export type PatchPath = readonly (string | number)[];

export type PatchOp = 'add' | 'replace' | 'remove';

export interface Patch {
  readonly op: PatchOp;
  readonly path: PatchPath;
  readonly value?: unknown;
}

/** Deeply readonly view type for replica state. */
export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? readonly DeepReadonly<U>[]
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

type Container = Record<string, unknown> | unknown[];

function isContainer(value: unknown): value is Container {
  return typeof value === 'object' && value !== null;
}

function shallowCopy(value: Container): Container {
  return Array.isArray(value) ? [...value] : { ...value };
}

function applyOne(root: unknown, patch: Patch): Result<unknown> {
  if (patch.path.length === 0) {
    if (patch.op === 'remove') return ok(undefined);
    return ok(patch.value);
  }
  if (!isContainer(root)) return err(InvalidPatchError({ details: { path: patch.path.join('/'), reason: 'root is not a container' } }));
  const nextRoot = shallowCopy(root);
  let cursor: Container = nextRoot;
  for (let i = 0; i < patch.path.length - 1; i += 1) {
    const key = patch.path[i] as string | number;
    const child = (cursor as Record<string | number, unknown>)[key];
    if (!isContainer(child)) {
      return err(InvalidPatchError({ details: { path: patch.path.join('/'), reason: `missing container at "${String(key)}"` } }));
    }
    const copy = shallowCopy(child);
    (cursor as Record<string | number, unknown>)[key] = copy;
    cursor = copy;
  }
  const last = patch.path[patch.path.length - 1] as string | number;
  if (Array.isArray(cursor)) {
    const index = last === '-' ? cursor.length : Number(last);
    if (!Number.isInteger(index) || index < 0) {
      return err(InvalidPatchError({ details: { path: patch.path.join('/'), reason: 'invalid array index' } }));
    }
    if (patch.op === 'add') {
      if (index > cursor.length) return err(InvalidPatchError({ details: { path: patch.path.join('/'), reason: 'index out of range' } }));
      cursor.splice(index, 0, patch.value);
    } else if (patch.op === 'replace') {
      if (index >= cursor.length) return err(InvalidPatchError({ details: { path: patch.path.join('/'), reason: 'index out of range' } }));
      cursor[index] = patch.value;
    } else {
      if (index >= cursor.length) return err(InvalidPatchError({ details: { path: patch.path.join('/'), reason: 'index out of range' } }));
      cursor.splice(index, 1);
    }
    return ok(nextRoot);
  }
  const record = cursor as Record<string, unknown>;
  const key = String(last);
  if (patch.op === 'remove') delete record[key];
  else record[key] = patch.value;
  return ok(nextRoot);
}

/** Apply patches in order, returning a new state (or an error; the input is never mutated). */
export function applyPatches<T>(state: T, patches: readonly Patch[]): Result<T> {
  let current: unknown = state;
  for (const patch of patches) {
    const next = applyOne(current, patch);
    if (!next.ok) return next;
    current = next.value;
  }
  return ok(current as T);
}

export function isPatch(value: unknown): value is Patch {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (v['op'] === 'add' || v['op'] === 'replace' || v['op'] === 'remove') && Array.isArray(v['path']);
}
