/**
 * An in-memory file system implementing the `DirectoryHandleLike` port with
 * the Chromium OPFS semantics S6 probed, so the OPFS and folder backends run
 * unchanged under Vitest:
 *
 * - `move()` overwrites the target and the source disappears; moving a file
 *   that has (or onto one that has) an open sync handle throws
 *   `NoModificationAllowedError`.
 * - `createWritable()` buffers and applies on `close()` (like `.crswap`);
 *   sync access handles write in place and are exclusive.
 * - A `File` snapshot read after the file changed throws `NotReadableError`.
 * - Permission (`queryPermission`/`requestPermission`) gates every write with
 *   `NotAllowedError`; an optional quota throws `QuotaExceededError`.
 * - `inject()` adds faults (a DOMException thrown on a matching operation).
 *
 * Test utility: never use it as a production backend.
 */
import type {
  DirectoryHandleLike,
  FileHandleLike,
  FileLike,
  PermissionStateLike,
  SyncAccessHandleLike,
  WritableLike,
} from './fs.js';

export type MemoryFsOp = 'create' | 'write' | 'move' | 'remove' | 'read' | 'list';

export interface MemoryFsFault {
  readonly op: MemoryFsOp;
  /** Match on the file or directory name (default: every name). */
  readonly name?: RegExp;
  /** DOMException name to throw (default `InvalidStateError`). */
  readonly error?: string;
  /** Remove the fault after it fired once (default true). */
  readonly once?: boolean;
}

export interface MemoryDirectoryOptions {
  readonly name?: string;
  /** Sync access handles available (true in a dedicated worker on OPFS). Default true. */
  readonly syncHandles?: boolean;
  /** `move()` available (default true). */
  readonly move?: boolean;
  /** Total stored bytes allowed (default unlimited). */
  readonly quota?: number;
  readonly now?: () => number;
}

export interface MemoryFileSystem {
  readonly root: DirectoryHandleLike;
  /** Set the permission every handle reports; non-`granted` makes writes throw `NotAllowedError`. */
  setPermission(state: PermissionStateLike, onRequest?: PermissionStateLike): void;
  inject(fault: MemoryFsFault): void;
  clearFaults(): void;
  /** Bytes stored in all files. */
  usage(): number;
  /** Every file path (`a/b/c`), sorted. */
  paths(): string[];
  /** Raw content of a file by path, or undefined. */
  read(path: string): Uint8Array | undefined;
  /** Overwrite a file's bytes in place by path (simulates outside edits and torn writes). */
  write(path: string, bytes: Uint8Array): void;
  /** Total move() calls (tests assert batching). */
  readonly moves: number;
}

interface FileNode {
  kind: 'file';
  bytes: Uint8Array;
  modified: number;
  version: number;
  syncOpen: boolean;
}

interface DirNode {
  kind: 'directory';
  entries: Map<string, FileNode | DirNode>;
}

function domError(name: string, message: string): DOMException {
  return new DOMException(message, name);
}

export function createMemoryDirectory(options: MemoryDirectoryOptions = {}): MemoryFileSystem {
  const now = options.now ?? Date.now;
  const syncHandles = options.syncHandles ?? true;
  const moveSupported = options.move ?? true;
  const rootNode: DirNode = { kind: 'directory', entries: new Map() };
  let permission: PermissionStateLike = 'granted';
  let onRequest: PermissionStateLike = 'granted';
  let faults: MemoryFsFault[] = [];
  let moves = 0;

  const usage = (dir: DirNode = rootNode): number => {
    let total = 0;
    for (const node of dir.entries.values()) total += node.kind === 'file' ? node.bytes.length : usage(node);
    return total;
  };

  const check = (op: MemoryFsOp, name: string): void => {
    const fault = faults.find((f) => f.op === op && (f.name === undefined || f.name.test(name)));
    if (fault !== undefined) {
      if (fault.once !== false) faults = faults.filter((f) => f !== fault);
      throw domError(fault.error ?? 'InvalidStateError', `injected ${op} fault on ${name}`);
    }
    if (op !== 'read' && op !== 'list' && permission !== 'granted') throw domError('NotAllowedError', `permission ${permission}`);
  };

  const checkQuota = (delta: number): void => {
    if (options.quota !== undefined && usage() + delta > options.quota) throw domError('QuotaExceededError', 'quota exceeded');
  };

  const snapshot = (node: FileNode): FileLike => {
    const version = node.version;
    const bytes = node.bytes.slice();
    const guard = (): void => {
      if (node.version !== version) throw domError('NotReadableError', 'file changed after the snapshot was taken');
    };
    const view = (start: number, end: number) => ({
      arrayBuffer: () => {
        try {
          guard();
        } catch (error) {
          return Promise.reject(error);
        }
        return Promise.resolve(bytes.slice(start, end).buffer as ArrayBuffer);
      },
    });
    return {
      size: bytes.length,
      lastModified: node.modified,
      slice: (start = 0, end = bytes.length) => view(start, end),
      arrayBuffer: () => view(0, bytes.length).arrayBuffer(),
    };
  };

  const touch = (node: FileNode, bytes: Uint8Array): void => {
    node.bytes = bytes;
    node.modified = now();
    node.version += 1;
  };

  const fileHandle = (parent: DirNode, initialName: string): FileHandleLike => {
    let dir = parent;
    let name = initialName;
    const node = (): FileNode => {
      const found = dir.entries.get(name);
      if (found === undefined || found.kind !== 'file') throw domError('NotFoundError', `file ${name} not found`);
      return found;
    };
    const handle: FileHandleLike = {
      kind: 'file',
      get name() {
        return name;
      },
      getFile() {
        try {
          check('read', name);
          return Promise.resolve(snapshot(node()));
        } catch (error) {
          return Promise.reject(error);
        }
      },
      createWritable(writableOptions) {
        try {
          check('write', name);
          const target = node();
          if (target.syncOpen) throw domError('NoModificationAllowedError', `${name} has an open sync handle`);
          let buffer = writableOptions?.keepExistingData === true ? target.bytes.slice() : new Uint8Array(0);
          let closed = false;
          const writable: WritableLike = {
            write(data) {
              if (closed) return Promise.reject(domError('InvalidStateError', 'writable closed'));
              const next = new Uint8Array(buffer.length + data.length);
              next.set(buffer);
              next.set(data, buffer.length);
              buffer = next;
              return Promise.resolve();
            },
            close() {
              if (closed) return Promise.reject(domError('InvalidStateError', 'writable closed'));
              closed = true;
              try {
                check('write', name);
                checkQuota(buffer.length - target.bytes.length);
                touch(target, buffer);
                return Promise.resolve();
              } catch (error) {
                return Promise.reject(error);
              }
            },
            abort() {
              closed = true;
              return Promise.resolve();
            },
          };
          return Promise.resolve(writable);
        } catch (error) {
          return Promise.reject(error);
        }
      },
      move(destination, newName) {
        try {
          if (!moveSupported) throw domError('NotSupportedError', 'move unsupported');
          check('move', newName);
          const source = node();
          const targetDir = dirNodes.get(destination);
          if (targetDir === undefined) throw domError('NotFoundError', 'destination directory not found');
          const existing = targetDir.entries.get(newName);
          if (source.syncOpen || (existing?.kind === 'file' && existing.syncOpen)) {
            throw domError('NoModificationAllowedError', `cannot move ${name}: a sync handle is open`);
          }
          if (existing?.kind === 'directory') throw domError('TypeMismatchError', `${newName} is a directory`);
          dir.entries.delete(name);
          if (existing?.kind === 'file') existing.version += 1;
          targetDir.entries.set(newName, source);
          source.modified = now();
          dir = targetDir;
          name = newName;
          moves += 1;
          return Promise.resolve();
        } catch (error) {
          return Promise.reject(error);
        }
      },
    };
    if (syncHandles) {
      handle.createSyncAccessHandle = () => {
        try {
          check('write', name);
          const target = node();
          if (target.syncOpen) throw domError('NoModificationAllowedError', `${name} already has an open sync handle`);
          target.syncOpen = true;
          let open = true;
          const ensure = (): void => {
            if (!open) throw domError('InvalidStateError', 'sync handle closed');
          };
          const access: SyncAccessHandleLike = {
            read(buffer, at) {
              ensure();
              const offset = at?.at ?? 0;
              const piece = target.bytes.subarray(offset, offset + buffer.length);
              buffer.set(piece);
              return piece.length;
            },
            write(buffer, at) {
              ensure();
              check('write', name);
              const offset = at?.at ?? 0;
              const end = offset + buffer.length;
              checkQuota(Math.max(0, end - target.bytes.length));
              const next = end > target.bytes.length ? new Uint8Array(end) : target.bytes.slice();
              if (end > target.bytes.length) next.set(target.bytes);
              next.set(buffer, offset);
              touch(target, next);
              return buffer.length;
            },
            truncate(size) {
              ensure();
              const next = new Uint8Array(size);
              next.set(target.bytes.subarray(0, size));
              touch(target, next);
            },
            getSize() {
              ensure();
              return target.bytes.length;
            },
            flush() {
              ensure();
            },
            close() {
              if (!open) return;
              open = false;
              target.syncOpen = false;
            },
          };
          return Promise.resolve(access);
        } catch (error) {
          return Promise.reject(error);
        }
      };
    }
    return handle;
  };

  const dirNodes = new WeakMap<DirectoryHandleLike, DirNode>();

  const dirHandle = (node: DirNode, name: string): DirectoryHandleLike => {
    const handle: DirectoryHandleLike = {
      kind: 'directory',
      name,
      getDirectoryHandle(child, childOptions) {
        try {
          const existing = node.entries.get(child);
          if (existing?.kind === 'file') throw domError('TypeMismatchError', `${child} is a file`);
          if (existing !== undefined) return Promise.resolve(dirHandle(existing, child));
          if (childOptions?.create !== true) throw domError('NotFoundError', `directory ${child} not found`);
          check('create', child);
          const created: DirNode = { kind: 'directory', entries: new Map() };
          node.entries.set(child, created);
          return Promise.resolve(dirHandle(created, child));
        } catch (error) {
          return Promise.reject(error);
        }
      },
      getFileHandle(child, childOptions) {
        try {
          const existing = node.entries.get(child);
          if (existing?.kind === 'directory') throw domError('TypeMismatchError', `${child} is a directory`);
          if (existing === undefined) {
            if (childOptions?.create !== true) throw domError('NotFoundError', `file ${child} not found`);
            check('create', child);
            node.entries.set(child, { kind: 'file', bytes: new Uint8Array(0), modified: now(), version: 0, syncOpen: false });
          }
          return Promise.resolve(fileHandle(node, child));
        } catch (error) {
          return Promise.reject(error);
        }
      },
      removeEntry(child, removeOptions) {
        try {
          check('remove', child);
          const existing = node.entries.get(child);
          if (existing === undefined) throw domError('NotFoundError', `${child} not found`);
          if (existing.kind === 'directory' && existing.entries.size > 0 && removeOptions?.recursive !== true) {
            throw domError('InvalidModificationError', `${child} is not empty`);
          }
          if (existing.kind === 'file' && existing.syncOpen) throw domError('NoModificationAllowedError', `${child} has an open sync handle`);
          node.entries.delete(child);
          if (existing.kind === 'file') existing.version += 1;
          return Promise.resolve();
        } catch (error) {
          return Promise.reject(error);
        }
      },
      async *values() {
        check('list', name);
        for (const [child, entry] of [...node.entries]) {
          if (!node.entries.has(child)) continue;
          yield entry.kind === 'file' ? fileHandle(node, child) : dirHandle(entry, child);
        }
      },
      queryPermission() {
        return Promise.resolve(permission);
      },
      requestPermission() {
        permission = onRequest;
        return Promise.resolve(permission);
      },
    };
    dirNodes.set(handle, node);
    return handle;
  };

  const lookup = (path: string): { parent: DirNode; name: string; node: FileNode | DirNode | undefined } | undefined => {
    const parts = path.split('/').filter((p) => p.length > 0);
    const name = parts.pop();
    if (name === undefined) return undefined;
    let dir = rootNode;
    for (const part of parts) {
      const next = dir.entries.get(part);
      if (next === undefined || next.kind !== 'directory') return undefined;
      dir = next;
    }
    return { parent: dir, name, node: dir.entries.get(name) };
  };

  const collect = (dir: DirNode, prefix: string, out: string[]): void => {
    for (const [name, node] of dir.entries) {
      const path = prefix === '' ? name : `${prefix}/${name}`;
      if (node.kind === 'file') out.push(path);
      else collect(node, path, out);
    }
  };

  return {
    root: dirHandle(rootNode, options.name ?? 'memory-root'),
    setPermission(state, request = 'granted') {
      permission = state;
      onRequest = request;
    },
    inject(fault) {
      faults.push(fault);
    },
    clearFaults() {
      faults = [];
    },
    usage: () => usage(),
    paths() {
      const out: string[] = [];
      collect(rootNode, '', out);
      return out.sort();
    },
    read(path) {
      const found = lookup(path)?.node;
      return found?.kind === 'file' ? found.bytes.slice() : undefined;
    },
    write(path, bytes) {
      const found = lookup(path);
      if (found === undefined) return;
      if (found.node?.kind === 'file') touch(found.node, bytes.slice());
      else if (found.node === undefined) found.parent.entries.set(found.name, { kind: 'file', bytes: bytes.slice(), modified: now(), version: 0, syncOpen: false });
    },
    get moves() {
      return moves;
    },
  };
}
