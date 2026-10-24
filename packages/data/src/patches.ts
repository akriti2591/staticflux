/**
 * Patch engine for schema-first stores (research §13, Replicache-style replication).
 *
 * State is immutable plain data with structural sharing. An action mutates a
 * *draft* (a Proxy); every mutation is recorded as a patch op and applied
 * copy-on-write to a working tree. Committing freezes only the nodes that were
 * copied, so cost is O(changed path), never O(state). Rolling back is free
 * (the original tree was never touched).
 *
 * ## Patch op format (stable, PATCH_FORMAT_VERSION = 1)
 *
 *   { op: 'replace', path, value }   set an existing object key / array index; `path: []` replaces the root
 *   { op: 'add',     path, value }   add an object key, or INSERT into an array at index (shifting the tail)
 *   { op: 'remove',  path }          delete an object key, or splice one array element out
 *
 * `path` is an array of object keys (string) and array indices (number).
 * Values are plain, structured-clone-safe data. Ops apply strictly in order.
 *
 * Draft caveats: draft objects are addressed by path, so do not hold an
 * element draft across a structural change of its array (splice/shift/sort)
 * in the same action; and identity comparisons (`indexOf(rawValue)`) see drafts.
 */
import { err, ok, type Result, SfError, toSfError } from '@staticflux/core';
import { clonePlain, deepFreeze } from './clone.js';
import { DraftRevokedError, InvalidPatchError, SchemaValidationError } from './errors.js';
import { isRemovable, type Path, type PathSegment, type Schema, schemaAt } from './schema.js';

export const PATCH_FORMAT_VERSION = 1;

export type PatchOp =
  | { readonly op: 'replace'; readonly path: Path; readonly value: unknown }
  | { readonly op: 'add'; readonly path: Path; readonly value: unknown }
  | { readonly op: 'remove'; readonly path: Path };

type Container = Record<string, unknown> | unknown[];

function isContainer(value: unknown): value is Container {
  return typeof value === 'object' && value !== null;
}

function invalid(op: PatchOp, reason: string): SfError {
  return InvalidPatchError({ message: `Cannot ${op.op} at ${op.path.join('.') || '<root>'}: ${reason}.`, details: { op: op.op, path: [...op.path], reason } });
}

function toIndex(segment: PathSegment): number {
  return typeof segment === 'number' ? segment : /^\d+$/.test(segment) ? Number(segment) : Number.NaN;
}

/** Copy-on-write working tree for one transaction. */
class WorkingTree {
  root: unknown;
  private readonly fresh = new Set<object>();

  constructor(root: unknown) {
    this.root = root;
  }

  read(path: Path): unknown {
    let node = this.root;
    for (const segment of path) {
      if (!isContainer(node)) return undefined;
      node = (node as Record<string, unknown>)[segment as string];
    }
    return node;
  }

  private copy(node: Container): Container {
    const copied: Container = Array.isArray(node) ? node.slice() : { ...node };
    this.fresh.add(copied);
    return copied;
  }

  /** Make every node along `path` mutable and return the container at `path`. */
  private writable(path: Path, op: PatchOp): Container {
    if (!isContainer(this.root)) throw invalid(op, 'root is not a container');
    if (!this.fresh.has(this.root)) this.root = this.copy(this.root);
    let node = this.root as Container;
    for (const segment of path) {
      const child = (node as Record<string, unknown>)[segment as string];
      if (!isContainer(child)) throw invalid(op, `no container at "${String(segment)}"`);
      if (this.fresh.has(child)) {
        node = child;
        continue;
      }
      const copied = this.copy(child);
      (node as Record<string, unknown>)[segment as string] = copied;
      node = copied;
    }
    return node;
  }

  /** Apply one op. `value` must already be plain + frozen. Throws InvalidPatchError. */
  apply(op: PatchOp): void {
    if (op.path.length === 0) {
      if (op.op !== 'replace') throw invalid(op, 'only replace may target the root');
      this.root = op.value;
      return;
    }
    const container = this.writable(op.path.slice(0, -1), op);
    const key = op.path[op.path.length - 1] as PathSegment;
    if (Array.isArray(container)) {
      const index = toIndex(key);
      const length = container.length;
      if (!Number.isInteger(index) || index < 0) throw invalid(op, 'array index expected');
      if (op.op === 'add') {
        if (index > length) throw invalid(op, 'index out of range');
        container.splice(index, 0, op.value);
      } else if (op.op === 'replace') {
        if (index >= length) throw invalid(op, 'index out of range');
        container[index] = op.value;
      } else {
        if (index >= length) throw invalid(op, 'index out of range');
        container.splice(index, 1);
      }
      return;
    }
    const name = String(key);
    if (op.op === 'remove') {
      if (!Object.hasOwn(container, name)) throw invalid(op, 'key does not exist');
      delete container[name];
    } else {
      container[name] = op.value;
    }
  }

  /** Freeze copied nodes and return the new root. */
  commit(): unknown {
    for (const node of this.fresh) Object.freeze(node);
    this.fresh.clear();
    return this.root;
  }
}

function validateOp(schema: Schema<unknown> | undefined, op: PatchOp): void {
  if (schema === undefined) return;
  if (op.op === 'remove') {
    const parent = schemaAt(schema, op.path.slice(0, -1));
    if (!isRemovable(parent, op.path[op.path.length - 1] as PathSegment)) {
      throw SchemaValidationError({ message: `Cannot remove required ${op.path.join('.')}.`, details: { path: [...op.path], expected: 'removable key' } });
    }
    return;
  }
  const target = schemaAt(schema, op.path);
  if (target === undefined) {
    throw SchemaValidationError({ message: `Path ${op.path.join('.')} is not part of the schema.`, details: { path: [...op.path], expected: 'schema path' } });
  }
  const result = target.validate(op.value, op.path);
  if (!result.ok) throw result.error;
}

/** Apply ops to an immutable state (copy-on-write). Values are cloned and frozen. */
export function applyPatchOps<T>(state: T, ops: readonly PatchOp[], schema?: Schema<unknown>): Result<T> {
  const tree = new WorkingTree(state);
  try {
    for (const op of ops) {
      const owned: PatchOp = op.op === 'remove' ? op : { ...op, value: deepFreeze(clonePlain(op.value)) };
      validateOp(schema, owned);
      tree.apply(owned);
    }
  } catch (error) {
    return err(toSfError(error));
  }
  return ok(tree.commit() as T);
}

const ARRAY_MUTATORS = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin']);

export interface Transaction<T> {
  /** The mutable view handed to actions. */
  readonly draft: T;
  readonly patches: readonly PatchOp[];
  /** Record + apply one op (validated against the schema). Throws SfError. */
  emit(op: PatchOp): void;
  /** Finish: revoke drafts, freeze, return the new state. */
  commit(): T;
  /** Abandon: revoke drafts; the original state is untouched. */
  revoke(): void;
}

/** Start a recording transaction over `state`. */
export function createTransaction<T>(state: T, schema?: Schema<unknown>): Transaction<T> {
  const tree = new WorkingTree(state);
  const patches: PatchOp[] = [];
  const proxies = new Map<string, object>();
  const proxyPaths = new WeakMap<object, Path>();
  let revoked = false;

  const guard = (): void => {
    if (revoked) throw DraftRevokedError();
  };

  const own = (value: unknown): unknown => {
    if (isContainer(value)) {
      const path = proxyPaths.get(value);
      if (path !== undefined) return deepFreeze(clonePlain(tree.read(path)));
    }
    return deepFreeze(clonePlain(value));
  };

  const emit = (op: PatchOp): void => {
    guard();
    validateOp(schema, op);
    tree.apply(op);
    patches.push(op);
  };

  const draftFor = (path: Path): object => {
    const key = JSON.stringify(path);
    const cached = proxies.get(key);
    if (cached !== undefined) return cached;
    const initial = tree.read(path);
    const isArray = Array.isArray(initial);
    const current = (): Container => {
      guard();
      const node = tree.read(path);
      if (!isContainer(node)) throw DraftRevokedError({ message: `Draft at ${path.join('.') || '<root>'} no longer exists.` });
      return node;
    };
    const child = (segment: PathSegment): Path => [...path, segment];

    const mutator = (name: string) =>
      (...args: unknown[]): unknown => {
        const arr = current() as unknown[];
        const length = arr.length;
        switch (name) {
          case 'push':
            args.forEach((item, i) => emit({ op: 'add', path: child(length + i), value: own(item) }));
            return length + args.length;
          case 'pop': {
            if (length === 0) return undefined;
            const last = arr[length - 1];
            emit({ op: 'remove', path: child(length - 1) });
            return last;
          }
          case 'shift': {
            if (length === 0) return undefined;
            const first = arr[0];
            emit({ op: 'remove', path: child(0) });
            return first;
          }
          case 'unshift':
            args.forEach((item, i) => emit({ op: 'add', path: child(i), value: own(item) }));
            return length + args.length;
          case 'splice': {
            const relative = Math.trunc(Number(args[0] ?? 0));
            const start = relative < 0 ? Math.max(length + relative, 0) : Math.min(relative, length);
            const deleteCount = args.length < 2 ? length - start : Math.min(Math.max(Math.trunc(Number(args[1])), 0), length - start);
            const removed = arr.slice(start, start + deleteCount);
            for (let i = 0; i < deleteCount; i += 1) emit({ op: 'remove', path: child(start) });
            args.slice(2).forEach((item, i) => emit({ op: 'add', path: child(start + i), value: own(item) }));
            return removed;
          }
          default: {
            // sort / reverse / fill / copyWithin: compute on a copy, record one replace of the array.
            const copy = arr.slice();
            (Array.prototype as unknown as Record<string, (...a: unknown[]) => unknown>)[name]?.apply(copy, args);
            emit({ op: 'replace', path, value: own(copy) });
            return proxy;
          }
        }
      };

    const handler: ProxyHandler<Container> = {
      get(_target, prop) {
        const node = current();
        if (typeof prop === 'symbol') return (node as unknown as Record<symbol, unknown>)[prop];
        if (Array.isArray(node) && ARRAY_MUTATORS.has(prop)) return mutator(prop);
        const value = (node as Record<string, unknown>)[prop];
        if (Object.hasOwn(node, prop) && isContainer(value)) {
          return draftFor(child(Array.isArray(node) ? toIndex(prop) : prop));
        }
        return value;
      },
      set(_target, prop, value) {
        const node = current();
        if (typeof prop === 'symbol') throw DraftRevokedError({ message: 'Symbol keys are not plain data.' });
        if (Array.isArray(node)) {
          if (prop === 'length') {
            const next = Number(value);
            if (next > node.length) throw invalid({ op: 'add', path: child(prop), value: value as unknown }, 'cannot grow an array by length; use push');
            for (let i = node.length - 1; i >= next; i -= 1) emit({ op: 'remove', path: child(i) });
            return true;
          }
          const index = toIndex(prop);
          if (!Number.isInteger(index)) throw invalid({ op: 'add', path: child(prop), value: value as unknown }, 'arrays only accept index keys');
          emit({ op: index === node.length ? 'add' : 'replace', path: child(index), value: own(value) });
          return true;
        }
        emit({ op: Object.hasOwn(node, prop) ? 'replace' : 'add', path: child(prop), value: own(value) });
        return true;
      },
      deleteProperty(_target, prop) {
        const node = current();
        if (typeof prop === 'symbol') return true;
        if (Array.isArray(node)) throw invalid({ op: 'remove', path: child(prop) }, 'use splice to remove array elements');
        if (Object.hasOwn(node, prop)) emit({ op: 'remove', path: child(prop) });
        return true;
      },
      has(_target, prop) {
        return prop in current();
      },
      ownKeys() {
        return Reflect.ownKeys(current());
      },
      getOwnPropertyDescriptor(_target, prop) {
        const node = current();
        if (Array.isArray(node) && prop === 'length') return { value: node.length, writable: true, enumerable: false, configurable: false };
        if (!Object.hasOwn(node, prop)) return undefined;
        return { value: handler.get?.(node, prop, undefined), writable: true, enumerable: true, configurable: true };
      },
      defineProperty() {
        throw DraftRevokedError({ message: 'defineProperty is not supported on store drafts; assign instead.' });
      },
      setPrototypeOf() {
        return false;
      },
    };
    const proxy = new Proxy<Container>(isArray ? [] : {}, handler);
    proxies.set(key, proxy);
    proxyPaths.set(proxy, path);
    return proxy;
  };

  const draft = (isContainer(state) ? draftFor([]) : state) as T;

  return {
    draft,
    patches,
    emit,
    commit() {
      revoked = true;
      return tree.commit() as T;
    },
    revoke() {
      revoked = true;
    },
  };
}

/**
 * Immer-style helper: run `recipe` against a draft of `state` and return the
 * new state plus the recorded patches. Throws are captured as `Result` errors.
 */
export function produceWithPatches<T, R>(
  state: T,
  recipe: (draft: T) => R,
  schema?: Schema<unknown>,
): Result<{ readonly state: T; readonly patches: readonly PatchOp[]; readonly result: R }> {
  const transaction = createTransaction(state, schema);
  try {
    const result = recipe(transaction.draft);
    return ok({ state: transaction.commit(), patches: transaction.patches, result });
  } catch (error) {
    transaction.revoke();
    return err(error instanceof SfError ? error : toSfError(error));
  }
}
