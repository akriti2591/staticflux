/**
 * WebMCP model-context adapter (R19.15, R19.16).
 *
 * The WebMCP API shape is in flux (W3C CG draft, Chrome flag / origin trial),
 * so this file is the ONLY place that touches it. Detection paths:
 *
 * 1. `navigator.modelContext` (current explainer) or `document.modelContext`
 *    (document-scoped variant) — whichever exists, in `prefer` order.
 * 2. Registration styles, feature-detected per context object:
 *    - `registerTool(tool)` → returns `{ unregister() }`, or pair with `unregisterTool(name)`;
 *    - `provideContext({ tools })` (replace-all) → the adapter keeps the full set and re-provides.
 *
 * No context → a `none` adapter: registration returns SF-MCP-001 and nothing breaks.
 */
import { err, ok, type Result } from '@staticflux/core';
import type { JsonSchema } from '@staticflux/capabilities';
import { ToolRegistrationError, WebMcpUnsupportedError } from './errors.js';

export interface WebMcpContentItem {
  readonly type: 'text';
  readonly text: string;
}

/** MCP `CallToolResult` subset returned from `execute`. */
export interface WebMcpToolResult {
  readonly content: readonly WebMcpContentItem[];
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
}

/** The agent/client handle passed to `execute` (shape varies; all members optional). */
export interface WebMcpClientLike {
  requestUserInteraction?(callback: () => Promise<unknown>): Promise<unknown>;
}

export interface WebMcpToolAnnotations {
  readonly title?: string;
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
}

export interface WebMcpToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly outputSchema?: JsonSchema;
  readonly annotations?: WebMcpToolAnnotations;
  execute(input: unknown, client?: WebMcpClientLike): Promise<WebMcpToolResult>;
}

/** Structural shape of a browser model context (any of the known variants). */
export interface ModelContextLike {
  registerTool?(tool: WebMcpToolDescriptor): unknown;
  unregisterTool?(name: string): unknown;
  provideContext?(context: { readonly tools: readonly WebMcpToolDescriptor[] }): unknown;
  clearContext?(): unknown;
}

export type AdapterKind = 'navigator' | 'document' | 'none';
export type RegistrationStyle = 'register-tool' | 'provide-context' | 'none';

export interface ModelContextAdapter {
  readonly kind: AdapterKind;
  readonly style: RegistrationStyle;
  readonly supported: boolean;
  /** Register one tool; returns its unregister function. */
  registerTool(tool: WebMcpToolDescriptor): Result<() => void>;
}

export interface DetectOptions {
  readonly navigator?: unknown;
  readonly document?: unknown;
  /** Detection order. Default: navigator first, then document. */
  readonly prefer?: readonly Exclude<AdapterKind, 'none'>[];
}

function contextOf(host: unknown): ModelContextLike | undefined {
  if (typeof host !== 'object' || host === null) return undefined;
  const context = (host as { modelContext?: unknown }).modelContext;
  if (typeof context !== 'object' || context === null) return undefined;
  const candidate = context as ModelContextLike;
  return typeof candidate.registerTool === 'function' || typeof candidate.provideContext === 'function' ? candidate : undefined;
}

const NONE: ModelContextAdapter = {
  kind: 'none',
  style: 'none',
  supported: false,
  registerTool: () => err(WebMcpUnsupportedError()),
};

/** Adapter over one concrete context object. */
export function adapterFor(kind: Exclude<AdapterKind, 'none'>, context: ModelContextLike): ModelContextAdapter {
  if (typeof context.registerTool === 'function') {
    return {
      kind,
      style: 'register-tool',
      supported: true,
      registerTool(tool) {
        let handle: unknown;
        try {
          handle = context.registerTool?.(tool);
        } catch (error) {
          return err(ToolRegistrationError({ cause: error, details: { tool: tool.name } }));
        }
        let done = false;
        return ok(() => {
          if (done) return;
          done = true;
          try {
            const unregister = (handle as { unregister?: () => void } | undefined)?.unregister;
            if (typeof unregister === 'function') unregister.call(handle);
            else context.unregisterTool?.(tool.name);
          } catch {
            // already gone (page teardown / context reset)
          }
        });
      },
    };
  }
  // provideContext: replace-all semantics; keep the set and re-provide on every change.
  const tools = new Map<string, WebMcpToolDescriptor>();
  const sync = (): void => {
    if (tools.size === 0 && typeof context.clearContext === 'function') context.clearContext();
    else context.provideContext?.({ tools: [...tools.values()] });
  };
  return {
    kind,
    style: 'provide-context',
    supported: true,
    registerTool(tool) {
      if (tools.has(tool.name)) return err(ToolRegistrationError({ message: `Duplicate WebMCP tool "${tool.name}".`, details: { tool: tool.name } }));
      tools.set(tool.name, tool);
      try {
        sync();
      } catch (error) {
        tools.delete(tool.name);
        return err(ToolRegistrationError({ cause: error, details: { tool: tool.name } }));
      }
      return ok(() => {
        if (tools.get(tool.name) !== tool) return;
        tools.delete(tool.name);
        try {
          sync();
        } catch {
          // context gone
        }
      });
    },
  };
}

/** Feature-detect the WebMCP model context (navigator- or document-scoped). */
export function detectModelContext(options: DetectOptions = {}): ModelContextAdapter {
  const hosts: Record<Exclude<AdapterKind, 'none'>, unknown> = {
    navigator: 'navigator' in options ? options.navigator : (globalThis as { navigator?: unknown }).navigator,
    document: 'document' in options ? options.document : (globalThis as { document?: unknown }).document,
  };
  for (const kind of options.prefer ?? (['navigator', 'document'] as const)) {
    const context = contextOf(hosts[kind]);
    if (context !== undefined) return adapterFor(kind, context);
  }
  return NONE;
}
