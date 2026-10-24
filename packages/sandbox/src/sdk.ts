/**
 * Plugin-side SDK: runs INSIDE the isolated realm (iframe or worker).
 *
 * @example
 * // plugin entry (bundled by the plugin author)
 * const host = await connectToHost({ pluginId: 'acme/word-count' });
 * if (host.ok) {
 *   host.value.on(SelectionChanged, ({ ids }) => render(ids));
 *   const result = await host.value.invoke(InsertText, { text: 'hello' });
 * }
 *
 * The SDK only gives the plugin what the host granted; it pre-checks grants for
 * a fast error, but the host enforces everything again (never trust the realm).
 */
import type { AnyCapability, CapabilityInput, CapabilityOutput } from '@staticflux/capabilities';
import { box, createNoopTelemetry, err, ok, type Result, type Telemetry } from '@staticflux/core';
import { createLink, fromMessagePort, type Link, type Port } from '@staticflux/worker';
import { CapabilityNotGrantedError, PluginHandshakeError, PluginNotRunningError, PluginPermissionError } from './errors.js';
import type { PluginEvent, PluginEventPayload, PluginLimits, PluginPermission } from './manifest.js';
import {
  type HelloAck,
  type HelloPayload,
  isConnectMessage,
  isEventMessage,
  isGrantsMessage,
  isHelloAck,
  SANDBOX_PROTOCOL_VERSION,
  SandboxChannels,
} from './protocol.js';

export interface ConnectTarget {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void, options?: AddEventListenerOptions): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  /** Window realms: only messages from `parent` are accepted. */
  readonly parent?: unknown;
}

export interface ConnectOptions {
  /** Must equal the manifest id. */
  readonly pluginId: string;
  /** Use this port instead of waiting for the realm's connect message (tests, custom transports). */
  readonly port?: Port;
  /** Where the connect message arrives. Default `globalThis` (window or worker scope). */
  readonly target?: ConnectTarget;
  /** Connect + handshake budget. Default 10 s. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly telemetry?: Telemetry;
}

export interface InvokeCallOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface PluginClient {
  readonly pluginId: string;
  readonly version: string;
  /** Reactive. */
  readonly grants: readonly string[];
  readonly events: readonly string[];
  readonly permissions: readonly PluginPermission[];
  readonly limits: PluginLimits;
  readonly closed: boolean;
  invoke<C extends AnyCapability>(capability: C, input: CapabilityInput<C>, options?: InvokeCallOptions): Promise<Result<CapabilityOutput<C>>>;
  invoke(capability: string, input: unknown, options?: InvokeCallOptions): Promise<Result<unknown>>;
  on<E extends PluginEvent>(event: E, listener: (payload: PluginEventPayload<E>) => void): () => void;
  onGrantsChange(listener: (grants: readonly string[]) => void): () => void;
  /** Ask the host for a slot height (permission `resize`). */
  resize(height: number): Result<void>;
  onClose(listener: () => void): () => void;
  close(): void;
}

function waitForPort(target: ConnectTarget, pluginId: string, signal: AbortSignal): Promise<Result<Port>> {
  return new Promise((resolve) => {
    const controller = new AbortController();
    const done = (result: Result<Port>): void => {
      controller.abort();
      resolve(result);
    };
    const parent = target.parent;
    const checkSource = parent !== undefined && parent !== null && parent !== target;
    target.addEventListener(
      'message',
      (event) => {
        if (checkSource && event.source !== parent) return;
        const data: unknown = event.data;
        const port = event.ports?.[0];
        if (!isConnectMessage(data) || data.plugin !== pluginId || port === undefined) return;
        done(ok(fromMessagePort(port)));
      },
      { signal: controller.signal },
    );
    signal.addEventListener('abort', () => done(err(PluginHandshakeError({ cause: signal.reason, details: { plugin: pluginId } }))), {
      once: true,
      signal: controller.signal,
    });
  });
}

/** Connect to the plugin host and complete the handshake. */
export async function connectToHost(options: ConnectOptions): Promise<Result<PluginClient>> {
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const timeoutMs = options.timeoutMs ?? 10_000;
  const budget = new AbortController();
  const timer = setTimeout(() => budget.abort(new DOMException('connect timed out', 'TimeoutError')), timeoutMs);
  const onAbort = (): void => budget.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', onAbort, { once: true, signal: budget.signal });
  try {
    let port = options.port;
    if (port === undefined) {
      const target = options.target ?? (globalThis as unknown as ConnectTarget);
      const waited = await waitForPort(target, options.pluginId, budget.signal);
      if (!waited.ok) return waited;
      port = waited.value;
    }
    const link = createLink({ port, name: `plugin:${options.pluginId}`, telemetry });
    link.handle(SandboxChannels.ping, () => ok(null));
    const hello: HelloPayload = { plugin: options.pluginId, protocol: SANDBOX_PROTOCOL_VERSION };
    const ack = await link.request(SandboxChannels.hello, hello, { signal: budget.signal, timeoutMs });
    if (!ack.ok) {
      link.close();
      return err(PluginHandshakeError({ cause: ack.error, message: ack.error.message, details: { plugin: options.pluginId } }));
    }
    if (!isHelloAck(ack.value)) {
      link.close();
      return err(PluginHandshakeError({ message: 'Malformed handshake answer.', details: { plugin: options.pluginId } }));
    }
    return ok(createClient(link, ack.value));
  } finally {
    clearTimeout(timer);
    budget.abort();
  }
}

function createClient(link: Link, ack: HelloAck): PluginClient {
  const grants = box<readonly string[]>([...ack.grants]);
  const grantListeners = new Set<(grants: readonly string[]) => void>();
  const eventListeners = new Map<string, Set<(payload: unknown) => void>>();
  const events = new Set(ack.events);

  link.on(SandboxChannels.grants, (payload) => {
    if (!isGrantsMessage(payload)) return;
    grants.set([...payload.grants]);
    for (const listener of [...grantListeners]) listener(grants.get());
  });
  link.on(SandboxChannels.event, (payload) => {
    if (!isEventMessage(payload)) return;
    for (const listener of [...(eventListeners.get(payload.event) ?? [])]) listener(payload.payload);
  });

  const invoke = async (capability: AnyCapability | string, input: unknown, options: InvokeCallOptions = {}): Promise<Result<unknown>> => {
    const id = typeof capability === 'string' ? capability : capability.id;
    if (link.closed) return err(PluginNotRunningError({ details: { plugin: ack.plugin } }));
    if (!grants.get().includes(id)) return err(CapabilityNotGrantedError({ details: { plugin: ack.plugin, capability: id } }));
    return link.request(SandboxChannels.invoke, { capability: id, input }, { signal: options.signal, timeoutMs: options.timeoutMs ?? ack.limits.callTimeoutMs + 1000 });
  };

  return {
    pluginId: ack.plugin,
    version: ack.version,
    get grants() {
      return grants.get();
    },
    events: ack.events,
    permissions: ack.permissions,
    limits: ack.limits,
    get closed() {
      return link.closed;
    },
    invoke: invoke as PluginClient['invoke'],
    on(event, listener) {
      if (!events.has(event.id)) return () => undefined;
      let set = eventListeners.get(event.id);
      if (set === undefined) {
        set = new Set();
        eventListeners.set(event.id, set);
      }
      const entry = listener as (payload: unknown) => void;
      set.add(entry);
      return () => set.delete(entry);
    },
    onGrantsChange(listener) {
      grantListeners.add(listener);
      return () => grantListeners.delete(listener);
    },
    resize(height) {
      if (!ack.permissions.includes('resize')) return err(PluginPermissionError({ details: { plugin: ack.plugin, permission: 'resize' } }));
      if (link.closed) return err(PluginNotRunningError({ details: { plugin: ack.plugin } }));
      link.send(SandboxChannels.resize, { height });
      return ok();
    },
    onClose(listener) {
      return link.onClose(() => listener());
    },
    close: () => link.close(),
  };
}
