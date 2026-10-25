/**
 * Handle channels (SF-Δ17): move platform handles between threads with explicit
 * ownership — `VideoFrame`, `AudioData`, `ImageBitmap` (closeable: they pin
 * decoder or GPU memory), `OffscreenCanvas` (transferable) and `FileSystemHandle`
 * (structured-cloneable, e.g. the workspace directory for the store worker).
 *
 * - **Ownership.** Every handle a thread holds is an `Owned<T>` in a ledger. After
 *   `send()` it belongs to the receiver: the sender's wrapper is released and, with
 *   dev guards on, reading `.value` throws SF-WK-037 — also over in-memory ports that
 *   pass objects by reference, so the rule is the same in one worker or two.
 * - **Close accounting.** The ledger counts live handles per kind, opens, closes,
 *   sends and receipts. A closeable handle that is garbage-collected unclosed, or
 *   still live when the ledger is disposed, is a **leak** (SF-WK-038): counted,
 *   reported to telemetry and (on dispose) closed. `limits` warn when too many
 *   frames are alive (decoders stall when frames are not closed).
 *
 * @example
 * export const Frames = defineHandleChannel<{ readonly t: number }>({ id: 'instaflow/frames', kinds: ['video-frame'] });
 * const ledger = createHandleLedger({ telemetry });
 * const frames = createHandleChannel(link, Frames, { ledger });
 * frames.send({ t }, [unwrap(ledger.own(frame))]);                // frame now belongs to the receiver
 * frames.on(({ meta, handles: [owned] }) => { draw(owned.value); owned.close(); });
 */
import { createNoopTelemetry, err, metric, ok, type Result, type SfError, type Telemetry } from '@staticflux/core';
import type { ChannelId } from './envelope.js';
import { PortClosedError } from './errors.js';
import type { Link, MessageContext } from './link.js';
import { HandleLeakError, HandleReleasedError, UnsupportedHandleError } from './pipeline-errors.js';

export const HANDLE_KINDS = ['video-frame', 'audio-data', 'image-bitmap', 'offscreen-canvas', 'file-system-handle'] as const;
export type HandleKind = (typeof HANDLE_KINDS)[number];

interface KindInfo {
  readonly kind: HandleKind;
  /** Goes in the postMessage transfer list (FileSystemHandle is cloned instead). */
  readonly transfer: boolean;
  /** Has `close()` and pins memory until closed. */
  readonly closeable: boolean;
  readonly global: string;
  /** Duck-typed fallback (fakes, other realms). */
  readonly looksLike: (v: Record<string, unknown>) => boolean;
}

const fn = (v: Record<string, unknown>, key: string): boolean => typeof v[key] === 'function';
const num = (v: Record<string, unknown>, key: string): boolean => typeof v[key] === 'number';

/** Declarative kind table (order matters: the most specific shape first). */
const KINDS: readonly KindInfo[] = [
  {
    kind: 'video-frame',
    transfer: true,
    closeable: true,
    global: 'VideoFrame',
    looksLike: (v) => fn(v, 'close') && fn(v, 'clone') && num(v, 'codedWidth') && 'timestamp' in v,
  },
  {
    kind: 'audio-data',
    transfer: true,
    closeable: true,
    global: 'AudioData',
    looksLike: (v) => fn(v, 'close') && num(v, 'numberOfFrames') && num(v, 'sampleRate'),
  },
  {
    kind: 'offscreen-canvas',
    transfer: true,
    closeable: false,
    global: 'OffscreenCanvas',
    looksLike: (v) => fn(v, 'getContext') && fn(v, 'transferToImageBitmap'),
  },
  {
    kind: 'image-bitmap',
    transfer: true,
    closeable: true,
    global: 'ImageBitmap',
    looksLike: (v) => fn(v, 'close') && num(v, 'width') && num(v, 'height') && !fn(v, 'getContext'),
  },
  {
    kind: 'file-system-handle',
    transfer: false,
    closeable: false,
    global: 'FileSystemHandle',
    looksLike: (v) => (v['kind'] === 'file' || v['kind'] === 'directory') && typeof v['name'] === 'string' && fn(v, 'isSameEntry'),
  },
];

const INFO = new Map(KINDS.map((k) => [k.kind, k]));

/** Classify a value as a handle kind (platform class first, then shape). */
export function classifyHandle(value: unknown): HandleKind | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  for (const info of KINDS) {
    const ctor = (globalThis as Record<string, unknown>)[info.global];
    if (typeof ctor === 'function' && value instanceof (ctor as new () => object)) return info.kind;
  }
  const record = value as Record<string, unknown>;
  return KINDS.find((info) => info.looksLike(record))?.kind;
}

/** True for kinds that pin memory until `close()`. */
export function isCloseableKind(kind: HandleKind): boolean {
  return INFO.get(kind)?.closeable === true;
}

export interface Owned<T = unknown> extends Disposable {
  readonly kind: HandleKind;
  /** The handle. Throws SF-WK-037 after send/release/close when dev guards are on. */
  readonly value: T;
  readonly closed: boolean;
  /** Sent to another thread or released to a consumer. */
  readonly released: boolean;
  /** Close (closeable kinds) and stop tracking. Idempotent. */
  close(): void;
  /** Stop tracking and return the value; the caller now owns closing it (e.g. hand to an encoder). */
  release(): T;
}

export interface HandleLedgerTotals {
  readonly owned: number;
  readonly closed: number;
  readonly sent: number;
  readonly received: number;
  readonly released: number;
  readonly leaked: number;
}

export interface HandleLedgerInspection {
  readonly live: Readonly<Record<HandleKind, number>>;
  readonly totals: HandleLedgerTotals;
}

/** Minimal FinalizationRegistry shape (injectable for tests). */
export interface FinalizationPort {
  register(target: object, held: unknown, token: object): void;
  unregister(token: object): void;
}

export interface HandleLedgerOptions {
  readonly telemetry?: Telemetry;
  /** Throw on use after release (default true; turn off only in measured hot paths of production builds). */
  readonly devGuards?: boolean;
  /** Warn (`worker.handle-pressure`) when live handles of a kind exceed this. */
  readonly limits?: Partial<Readonly<Record<HandleKind, number>>>;
  /** Called for every leak (also reported to telemetry). */
  readonly onLeak?: (error: SfError) => void;
  /** GC hook. Default: a FinalizationRegistry when available. */
  readonly finalization?: (onCollected: (held: unknown) => void) => FinalizationPort | undefined;
}

export interface HandleLedger {
  /** Start tracking a handle this thread owns. Fails with SF-WK-039 for non-handles. */
  own<T>(value: T, kind?: HandleKind): Result<Owned<T>>;
  /** Live handles by kind. */
  readonly live: Readonly<Record<HandleKind, number>>;
  readonly totals: HandleLedgerTotals;
  inspect(): HandleLedgerInspection;
  /** Close everything still live; each closeable one is reported as a leak. */
  dispose(): readonly SfError[];
}

export const HandleMetrics = {
  live: /* @__PURE__ */ metric.gauge('worker/handles-live', { description: 'Live transferable handles per kind' }),
  leaked: /* @__PURE__ */ metric.counter('worker/handles-leaked', { description: 'Closeable handles dropped without close()' }),
} as const;

const SUBSYSTEM = 'worker/handles';

const emptyCounts = (): Record<HandleKind, number> => ({
  'video-frame': 0,
  'audio-data': 0,
  'image-bitmap': 0,
  'offscreen-canvas': 0,
  'file-system-handle': 0,
});

const defaultFinalization = (onCollected: (held: unknown) => void): FinalizationPort | undefined =>
  typeof FinalizationRegistry === 'function' ? new FinalizationRegistry<unknown>(onCollected) : undefined;

/** Internal hooks the channel uses to move ownership across the ledger boundary. */
interface LedgerInternals {
  owns(owned: Owned): boolean;
  markSent(owned: Owned): void;
  adopt(value: unknown, kind: HandleKind): Owned;
}
const internals = new WeakMap<HandleLedger, LedgerInternals>();

type FinishReason = 'closed' | 'sent' | 'released' | 'leaked';

/** Bookkeeping for one live handle. Holds the value, never the `Owned` wrapper (so the wrapper can be collected). */
interface Entry {
  readonly kind: HandleKind;
  finish(reason: FinishReason): void;
  /** Best-effort close of the underlying handle (closeable kinds). */
  closeValue(): void;
}

export function createHandleLedger(options: HandleLedgerOptions = {}): HandleLedger {
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const devGuards = options.devGuards ?? true;
  const live = emptyCounts();
  const totals = { owned: 0, closed: 0, sent: 0, received: 0, released: 0, leaked: 0 };
  const entries = new Set<Entry>();
  const entryOf = new WeakMap<Owned, Entry>();
  const reportLeak = (kinds: readonly HandleKind[]): SfError => {
    totals.leaked += kinds.length;
    telemetry.record(HandleMetrics.leaked, kinds.length, { kinds: kinds.join(',') });
    telemetry.event('worker.handle-leak', { subsystem: SUBSYSTEM, level: 'critical', attrs: { kinds: kinds.join(','), count: kinds.length } });
    const error = HandleLeakError({ details: { kinds } });
    options.onLeak?.(error);
    return error;
  };
  // The wrapper was collected while live: nobody can close the handle any more. Close it here and report.
  const finalization = (options.finalization ?? defaultFinalization)((held) => {
    const entry = held as Entry;
    if (!entries.has(entry)) return;
    entry.closeValue();
    entry.finish('leaked');
    reportLeak([entry.kind]);
  });
  const gauge = (kind: HandleKind): void => {
    telemetry.record(HandleMetrics.live, live[kind], { kind });
    const limit = options.limits?.[kind];
    if (limit !== undefined && live[kind] > limit) {
      telemetry.event('worker.handle-pressure', { subsystem: SUBSYSTEM, level: 'standard', attrs: { kind, live: live[kind], limit } });
    }
  };

  const track = <T>(value: T, kind: HandleKind): Owned<T> => {
    const info = INFO.get(kind) as KindInfo;
    let state: 'live' | 'closed' | 'sent' | 'released' = 'live';
    const token = {};
    const entry: Entry = {
      kind,
      closeValue() {
        if (!info.closeable) return;
        try {
          (value as { close(): void }).close();
        } catch {
          // Closed elsewhere already.
        }
      },
      finish(reason) {
        if (state !== 'live') return;
        state = reason === 'leaked' ? 'closed' : reason;
        entries.delete(entry);
        finalization?.unregister(token);
        live[kind] -= 1;
        if (reason === 'closed') totals.closed += 1;
        else if (reason === 'sent') totals.sent += 1;
        else if (reason === 'released') totals.released += 1;
        gauge(kind);
      },
    };
    entries.add(entry);
    live[kind] += 1;
    gauge(kind);
    const owned: Owned<T> = {
      kind,
      get value() {
        if (state !== 'live' && devGuards) throw HandleReleasedError({ details: { kind, state } });
        return value;
      },
      get closed() {
        return state === 'closed';
      },
      get released() {
        return state === 'sent' || state === 'released';
      },
      close() {
        if (state !== 'live') return;
        entry.closeValue();
        entry.finish('closed');
      },
      release() {
        if (state !== 'live' && devGuards) throw HandleReleasedError({ details: { kind, state } });
        entry.finish('released');
        return value;
      },
      [Symbol.dispose]() {
        owned.close();
      },
    };
    entryOf.set(owned, entry);
    if (info.closeable) finalization?.register(owned, entry, token);
    return owned;
  };

  const ledger: HandleLedger = {
    own(value, kind) {
      const detected = kind ?? classifyHandle(value);
      if (detected === undefined || (kind !== undefined && classifyHandle(value) !== kind)) {
        return err(UnsupportedHandleError({ details: { kind: kind ?? 'unknown', got: classifyHandle(value) ?? typeof value } }));
      }
      totals.owned += 1;
      return ok(track(value, detected));
    },
    get live() {
      return { ...live };
    },
    get totals() {
      return { ...totals };
    },
    inspect: () => ({ live: { ...live }, totals: { ...totals } }),
    dispose() {
      const leaked: HandleKind[] = [];
      for (const entry of [...entries]) {
        if (isCloseableKind(entry.kind)) leaked.push(entry.kind);
        entry.closeValue();
        entry.finish('leaked');
      }
      return leaked.length === 0 ? [] : [reportLeak(leaked)];
    },
  };
  internals.set(ledger, {
    owns: (owned) => entryOf.has(owned),
    markSent: (owned) => entryOf.get(owned)?.finish('sent'),
    adopt(value, kind) {
      totals.received += 1;
      return track(value, kind);
    },
  });
  return ledger;
}

// ---------------------------------------------------------------- channel

export interface HandleChannelDefinition<M, Id extends ChannelId = ChannelId> {
  readonly kind: 'handle-channel';
  readonly id: Id;
  readonly kinds: readonly HandleKind[];
  readonly guard: ((meta: unknown) => meta is M) | undefined;
}

export function defineHandleChannel<M, const Id extends ChannelId = ChannelId>(declaration: {
  readonly id: Id;
  readonly kinds: readonly HandleKind[];
  readonly guard?: (meta: unknown) => meta is M;
}): HandleChannelDefinition<M, Id> {
  return Object.freeze({ kind: 'handle-channel', id: declaration.id, kinds: Object.freeze([...declaration.kinds]), guard: declaration.guard });
}

export interface HandleMessage<M> {
  readonly meta: M;
  /** Handles now owned by this side (tracked in the receiving ledger). */
  readonly handles: readonly Owned[];
}

export interface HandleChannelStats {
  readonly sent: number;
  readonly received: number;
  /** Incoming messages dropped (wrong kind, failed guard); their closeable handles were closed. */
  readonly rejected: number;
}

export interface HandleChannel<M> {
  readonly id: ChannelId;
  /** Send handles (all or nothing). On success every `Owned` is released on this side. */
  send(meta: M, handles: readonly Owned[]): Result<void>;
  on(listener: (message: HandleMessage<M>, context: MessageContext) => void): () => void;
  readonly stats: HandleChannelStats;
  close(): void;
}

interface WireHandle {
  readonly kind: HandleKind;
  readonly value: unknown;
}

export function createHandleChannel<M>(
  link: Link,
  definition: HandleChannelDefinition<M>,
  options: { readonly ledger: HandleLedger; readonly telemetry?: Telemetry },
): HandleChannel<M> {
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const hooks = internals.get(options.ledger);
  if (hooks === undefined) throw UnsupportedHandleError({ message: 'The ledger was not created by createHandleLedger().' });
  const allowed = new Set(definition.kinds);
  const unsubscribers = new Set<() => void>();
  const stats = { sent: 0, received: 0, rejected: 0 };
  let closed = false;

  const reject = (handles: readonly WireHandle[], reason: string): void => {
    stats.rejected += 1;
    for (const handle of handles) {
      if (INFO.get(handle.kind)?.closeable === true) {
        try {
          (handle.value as { close(): void }).close();
        } catch {
          // ignore: not a real handle
        }
      }
    }
    telemetry.event('worker.handle-rejected', { subsystem: SUBSYSTEM, level: 'critical', attrs: { channel: definition.id, reason } });
  };

  return {
    id: definition.id,
    send(meta, handles) {
      if (closed) return err(PortClosedError({ message: 'The handle channel is closed.', details: { channel: definition.id } }));
      const wire: WireHandle[] = [];
      const transfer: Transferable[] = [];
      for (const owned of handles) {
        if (owned.closed || owned.released) return err(HandleReleasedError({ details: { channel: definition.id, kind: owned.kind } }));
        if (!hooks.owns(owned)) {
          return err(UnsupportedHandleError({ message: 'The handle is tracked by another ledger than this channel.', details: { channel: definition.id } }));
        }
        if (!allowed.has(owned.kind)) return err(UnsupportedHandleError({ details: { channel: definition.id, kind: owned.kind } }));
        const value = owned.value;
        if (wire.some((w) => w.value === value)) return err(UnsupportedHandleError({ message: 'A handle is listed twice.', details: { channel: definition.id } }));
        wire.push({ kind: owned.kind, value });
        if (INFO.get(owned.kind)?.transfer === true) transfer.push(value as Transferable);
      }
      link.send(definition.id, { meta, handles: wire }, { transfer });
      for (const owned of handles) hooks.markSent(owned);
      stats.sent += 1;
      return ok();
    },
    on(listener) {
      const unsubscribe = link.on(definition.id, (payload, context) => {
        if (closed) return;
        const message = payload as { meta?: unknown; handles?: unknown } | null;
        const wire = Array.isArray(message?.handles) ? (message.handles as WireHandle[]) : [];
        if (wire.some((w) => !allowed.has(w.kind) || classifyHandle(w.value) !== w.kind)) return reject(wire, 'kind');
        if (definition.guard !== undefined && !definition.guard(message?.meta)) return reject(wire, 'meta');
        stats.received += 1;
        const handles = wire.map((w) => hooks.adopt(w.value, w.kind));
        listener({ meta: message?.meta as M, handles }, context);
      });
      unsubscribers.add(unsubscribe);
      return () => {
        unsubscribe();
        unsubscribers.delete(unsubscribe);
      };
    },
    get stats() {
      return { ...stats };
    },
    close() {
      closed = true;
      for (const unsubscribe of unsubscribers) unsubscribe();
      unsubscribers.clear();
    },
  };
}
