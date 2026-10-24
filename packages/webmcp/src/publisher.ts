/**
 * Publishes registered capabilities as WebMCP tools (R19.16) — automatically,
 * with no per-feature WebMCP code.
 *
 * - Every agent-exposed capability declared in the registry becomes a tool
 *   (JSON Schema from the capability schema); declarations that go away
 *   (feature scope ended) unregister their tool. Disposing the publisher (or
 *   its scope) unregisters everything.
 * - Every tool call goes through `registry.invoke(id, input, { subject: 'agent' })`,
 *   so validation, gating (agent policy subject), confirmation for destructive
 *   actions, meter reservation and tracing all apply.
 *
 * Client gating is UX, not security (R6.16): the backend re-checks every
 * request the capability implementation makes.
 */
import {
  createMachine,
  createNoopTelemetry,
  createScope,
  defineMachine,
  metric,
  type Result,
  type Scope,
  type SfError,
  type Telemetry,
} from '@staticflux/core';
import type { AnyCapability, CapabilityRegistry } from '@staticflux/capabilities';
import { toJsonSchema } from '@staticflux/capabilities';
import type { ModelContextAdapter, WebMcpClientLike, WebMcpToolDescriptor, WebMcpToolResult } from './adapter.js';

export const WEBMCP_SUBSYSTEM = 'webmcp/tools' as const;

/** Publisher lifecycle. Mirror into docs/LIFECYCLES.md §14. */
export const publisherMachine = defineMachine({
  id: 'webmcp/publisher',
  initial: 'idle',
  states: ['idle', 'publishing', 'unsupported', 'disposed'],
  transitions: {
    idle: { start: 'publishing', unsupported: 'unsupported', dispose: 'disposed' },
    publishing: { dispose: 'disposed' },
    unsupported: { dispose: 'disposed' },
  },
  terminal: ['disposed'],
});

export type PublisherState = (typeof publisherMachine.states)[number];

export const WebMcpMetrics = {
  toolCalls: /* @__PURE__ */ metric.counter('webmcp/tool-calls', { description: 'WebMCP tool calls by tool and outcome.' }),
  tools: /* @__PURE__ */ metric.gauge('webmcp/tools', { description: 'Currently registered WebMCP tools.' }),
} as const;

/** Detail payload of the `webmcp` invocation origin (read by confirm ports). */
export interface WebMcpOriginDetails {
  readonly tool: string;
  readonly client: WebMcpClientLike | undefined;
}

export const WEBMCP_CHANNEL = 'webmcp' as const;

export interface PublishedTool {
  readonly name: string;
  readonly capability: string;
}

export interface WebMcpPublisher {
  readonly state: PublisherState;
  /** Register tools for current declarations and follow registry changes. */
  start(): void;
  tools(): readonly PublishedTool[];
  dispose(): Promise<void>;
}

export interface WebMcpPublisherOptions {
  readonly registry: CapabilityRegistry;
  readonly adapter: ModelContextAdapter;
  readonly telemetry?: Telemetry;
  /** Extra filter on top of `exposeToAgents` (e.g. publish only one feature's tools). */
  readonly filter?: (capability: AnyCapability) => boolean;
  /** Tool name from capability id. Default: `agent/insert-image` → `agent.insert-image`. */
  readonly toolName?: (capability: AnyCapability) => string;
  /** Unregister everything when this scope ends. */
  readonly scope?: Scope;
  /** Reports registration failures (never thrown). */
  readonly onError?: (error: SfError, capability: AnyCapability) => void;
}

/** MCP-safe tool name (`^[A-Za-z0-9_.-]{1,128}$`). */
export function defaultToolName(capability: AnyCapability): string {
  return capability.id.replace(/\//g, '.').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 128);
}

/** Map an invoke Result to an MCP tool result. Errors carry code + fix so agents can act. */
export function toToolResult(result: Result<unknown>): WebMcpToolResult {
  if (result.ok) {
    return {
      content: [{ type: 'text', text: JSON.stringify(result.value ?? null) }],
      ...(result.value === undefined ? {} : { structuredContent: result.value }),
    };
  }
  const { code, kind, message, fix } = result.error;
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: { code, kind, message, fix } }) }],
  };
}

export function createWebMcpPublisher(options: WebMcpPublisherOptions): WebMcpPublisher {
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const toolName = options.toolName ?? defaultToolName;
  const machine = createMachine(publisherMachine);
  const scope = (options.scope ?? createScope('webmcp/publisher')).child('webmcp/publisher');
  const registered = new Map<string, { name: string; unregister: () => void }>();
  let stopListening: (() => void) | undefined;

  machine.onTransition((record) =>
    telemetry.event(`lifecycle.${publisherMachine.id}.${record.from}→${record.to}`, {
      subsystem: WEBMCP_SUBSYSTEM,
      level: 'verbose',
    }),
  );

  const gauge = (): void => telemetry.record(WebMcpMetrics.tools, registered.size);

  const describe = (capability: AnyCapability, name: string): WebMcpToolDescriptor => ({
    name,
    description: capability.description,
    inputSchema: toJsonSchema(capability.input),
    outputSchema: toJsonSchema(capability.output),
    annotations: {
      title: capability.title,
      destructiveHint: capability.destructive,
      readOnlyHint: false,
    },
    async execute(input, client) {
      const span = telemetry.span('webmcp.tool-call', { subsystem: WEBMCP_SUBSYSTEM, attrs: { tool: name, capability: capability.id } });
      const details: WebMcpOriginDetails = { tool: name, client };
      const result = await options.registry.invoke(capability.id, input ?? {}, {
        subject: 'agent',
        signal: scope.signal,
        origin: { channel: WEBMCP_CHANNEL, details },
        parent: span,
      });
      const outcome = result.ok ? 'ok' : result.error.code;
      telemetry.record(WebMcpMetrics.toolCalls, 1, { tool: name, outcome }, span);
      if (result.ok) span.end('ok');
      else span.end(result.error.kind === 'aborted' ? 'cancelled' : 'error', result.error);
      return toToolResult(result);
    },
  });

  const publish = (capability: AnyCapability): void => {
    if (!capability.exposeToAgents || registered.has(capability.id)) return;
    if (options.filter !== undefined && !options.filter(capability)) return;
    const name = toolName(capability);
    const result = options.adapter.registerTool(describe(capability, name));
    if (!result.ok) {
      options.onError?.(result.error, capability);
      telemetry.event('webmcp.register-failed', {
        subsystem: WEBMCP_SUBSYSTEM,
        level: 'critical',
        attrs: { tool: name, code: result.error.code },
      });
      return;
    }
    registered.set(capability.id, { name, unregister: result.value });
    telemetry.event('webmcp.registered', { subsystem: WEBMCP_SUBSYSTEM, level: 'verbose', attrs: { tool: name } });
    gauge();
  };

  const unpublish = (capabilityId: string): void => {
    const entry = registered.get(capabilityId);
    if (entry === undefined) return;
    registered.delete(capabilityId);
    entry.unregister();
    telemetry.event('webmcp.unregistered', { subsystem: WEBMCP_SUBSYSTEM, level: 'verbose', attrs: { tool: entry.name } });
    gauge();
  };

  /** Synchronous teardown; also the scope cleanup (must not await its own scope). */
  const teardown = (): void => {
    if (machine.state === 'disposed') return;
    stopListening?.();
    stopListening = undefined;
    for (const id of [...registered.keys()]) unpublish(id);
    machine.send('dispose');
  };
  scope.defer(teardown);
  const dispose = async (): Promise<void> => {
    teardown();
    await scope.dispose();
  };

  return {
    get state() {
      return machine.state;
    },
    start() {
      if (machine.state !== 'idle') return;
      if (!options.adapter.supported) {
        machine.send('unsupported');
        return;
      }
      machine.send('start');
      for (const capability of options.registry.list()) publish(capability);
      stopListening = options.registry.onChange((change) => {
        if (change.type === 'declared') publish(change.capability);
        else if (change.type === 'undeclared') unpublish(change.capability.id);
      });
    },
    tools: () => [...registered.entries()].map(([capability, entry]) => ({ name: entry.name, capability })),
    dispose,
  };
}
