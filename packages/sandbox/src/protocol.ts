/**
 * The host ⇄ plugin wire protocol: channels on a worker `Link` (envelopes over
 * a MessagePort). Everything from the plugin is untrusted: the host checks the
 * envelope, the channel allowlist, rate and size BEFORE the link sees a message,
 * and validates every payload with the guards below.
 *
 *   plugin → host  request  sandbox/hello   { plugin, protocol }        → HelloAck
 *   plugin → host  request  sandbox/invoke  { capability, input }       → capability output
 *   plugin → host  event    sandbox/resize  { height }                  (permission `resize`)
 *   host → plugin  event    sandbox/event   { event, payload }          (declared events only)
 *   host → plugin  event    sandbox/grants  { grants }                  (after grant / revoke)
 *   host → plugin  request  sandbox/ping    null → null                 (heartbeat)
 *
 * Bootstrap: the realm posts `ConnectMessage` with a transferred MessagePort to
 * the iframe window / worker; the SDK (`connectToHost`) picks it up.
 */
import type { ChannelId } from '@staticflux/worker';
import type { PluginLimits, PluginPermission } from './manifest.js';

export const SANDBOX_PROTOCOL_VERSION = 1;

export const SandboxChannels = {
  hello: 'sandbox/hello',
  invoke: 'sandbox/invoke',
  resize: 'sandbox/resize',
  event: 'sandbox/event',
  grants: 'sandbox/grants',
  ping: 'sandbox/ping',
} as const satisfies Record<string, ChannelId>;

export const CONNECT_TAG = 'sandbox/connect';

export interface ConnectMessage {
  readonly sf: typeof CONNECT_TAG;
  readonly plugin: string;
  readonly protocol: number;
}

export interface HelloPayload {
  readonly plugin: string;
  readonly protocol: number;
}

export interface HelloAck {
  readonly plugin: string;
  readonly version: string;
  readonly grants: readonly string[];
  readonly events: readonly string[];
  readonly permissions: readonly PluginPermission[];
  readonly limits: PluginLimits;
}

export interface InvokePayload {
  readonly capability: string;
  readonly input: unknown;
}

export interface EventMessage {
  readonly event: string;
  readonly payload: unknown;
}

export interface GrantsMessage {
  readonly grants: readonly string[];
}

export interface ResizeMessage {
  readonly height: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function isConnectMessage(value: unknown): value is ConnectMessage {
  const v = record(value);
  return v !== undefined && v['sf'] === CONNECT_TAG && typeof v['plugin'] === 'string' && typeof v['protocol'] === 'number';
}

export function isHelloPayload(value: unknown): value is HelloPayload {
  const v = record(value);
  return v !== undefined && typeof v['plugin'] === 'string' && typeof v['protocol'] === 'number';
}

export function isInvokePayload(value: unknown): value is InvokePayload {
  const v = record(value);
  return v !== undefined && typeof v['capability'] === 'string' && v['capability'].length <= 256 && 'input' in v;
}

export function isResizeMessage(value: unknown): value is ResizeMessage {
  const v = record(value);
  return v !== undefined && typeof v['height'] === 'number' && Number.isFinite(v['height']) && v['height'] >= 0;
}

export function isHelloAck(value: unknown): value is HelloAck {
  const v = record(value);
  return v !== undefined && typeof v['plugin'] === 'string' && Array.isArray(v['grants']) && Array.isArray(v['events']);
}

export function isEventMessage(value: unknown): value is EventMessage {
  const v = record(value);
  return v !== undefined && typeof v['event'] === 'string' && 'payload' in v;
}

export function isGrantsMessage(value: unknown): value is GrantsMessage {
  const v = record(value);
  return v !== undefined && Array.isArray(v['grants']) && (v['grants'] as unknown[]).every((g) => typeof g === 'string');
}

/** Channels a plugin may use, per envelope kind (everything else is a violation). */
export const PLUGIN_ALLOWED: Readonly<Record<'request' | 'event' | 'response' | 'cancel', ReadonlySet<string>>> = {
  request: new Set([SandboxChannels.hello, SandboxChannels.invoke]),
  event: new Set([SandboxChannels.resize]),
  response: new Set([SandboxChannels.ping]),
  cancel: new Set([SandboxChannels.invoke, SandboxChannels.hello]),
};
