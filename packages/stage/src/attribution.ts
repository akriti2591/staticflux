/**
 * Attribution port (SF-Δ10): turns a capability run (`RunContext` of `@staticflux/capabilities`: invocation id,
 * subject, origin channel) into an `Actor`, which then goes into `transact(meta)` via `transactionMeta`.
 *
 * The port is structural: any object with `{ invocationId, subject, origin }` works, so this package does not depend
 * on capabilities (a capabilities `RunContext` is assignable to `RunSource`).
 *
 * @example
 *   const attribution = createAttributionPort({ human: () => ({ id: guestId, displayName: 'You' }) });
 *   implementCapability(alignLeft, async (input, run) => {
 *     const meta = metaForRun(attribution, run, 'Align left');
 *     if (!meta.ok) return meta;
 *     return doc.commit(meta.value, { [part]: ops });
 *   });
 */
import { err, ok, type Result, token } from '@staticflux/core';
import type { TransactionMeta } from '@staticflux/document/v2';
import { type Actor, type ActorKind, type TransactionMetaOptions, transactionMeta, type Via } from './actor.js';
import { ActorUnavailableError } from './errors.js';

/** What the port reads from a run (structurally a capabilities `RunContext`). */
export interface RunSource {
  readonly invocationId?: string;
  /** Capability subject: `user | guest | agent | plugin | system`. */
  readonly subject: string;
  readonly origin?: { readonly channel: string; readonly details?: unknown } | undefined;
}

export interface Identity {
  readonly id: string;
  readonly displayName: string;
  readonly model?: string;
}

export interface AttributionPort {
  /** The actor behind a run. A run without an invocation (a direct gesture) passes `{ subject: 'user', origin }`. */
  actorFor(source: RunSource): Result<Actor>;
}

export interface AttributionPortOptions {
  /** The local human (V1: the guest identity). */
  readonly human: () => Identity;
  /** Agent identity for a run; default reads `origin.details.agent`, then a WebMCP client's `name`. */
  readonly agent?: (source: RunSource) => Identity | undefined;
  /** Flow identity for a `system` run; default reads `origin.details.flow`. */
  readonly flow?: (source: RunSource) => Identity | undefined;
  /** Origin channel → via; default `CHANNEL_VIA`, then a per-kind fallback (`direct`, `chat`, `flow`). */
  readonly via?: (channel: string | undefined, kind: ActorKind) => Via | undefined;
}

/** Well-known origin channels (capabilities `InvocationOrigin.channel`) and the via they mean. */
export const CHANNEL_VIA: Readonly<Record<string, Via>> = {
  webmcp: 'webmcp',
  'ui/hud': 'hud',
  'shell/palette': 'bar',
  'ui/bar': 'bar',
  'ui/chat': 'chat',
  chat: 'chat',
  flow: 'flow',
  'a11y/shortcut': 'shortcut',
  shortcut: 'shortcut',
  'ui/canvas': 'direct',
};

const FALLBACK_VIA: Readonly<Record<ActorKind, Via>> = { human: 'direct', agent: 'chat', flow: 'flow' };

/** Capability subject → actor kind. */
export const SUBJECT_KIND: Readonly<Record<string, ActorKind>> = { user: 'human', guest: 'human', agent: 'agent', plugin: 'agent', system: 'flow' };

const field = (value: unknown, key: string): unknown => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined);

function identityAt(value: unknown): Identity | undefined {
  const id = field(value, 'id');
  const displayName = field(value, 'displayName');
  const model = field(value, 'model');
  if (typeof id !== 'string' || id.length === 0) return undefined;
  return { id, displayName: typeof displayName === 'string' ? displayName : id, ...(typeof model === 'string' ? { model } : {}) };
}

/** Default agent identity: `origin.details.agent`, or the WebMCP client's name (`origin.details.client.name`). */
export function defaultAgentIdentity(source: RunSource): Identity | undefined {
  const details = source.origin?.details;
  const explicit = identityAt(field(details, 'agent'));
  if (explicit !== undefined) return explicit;
  const name = field(field(details, 'client'), 'name');
  return typeof name === 'string' && name.length > 0 ? { id: `${source.origin?.channel ?? 'agent'}:${name}`, displayName: name } : undefined;
}

export function createAttributionPort(options: AttributionPortOptions): AttributionPort {
  const agentOf = options.agent ?? defaultAgentIdentity;
  const flowOf = options.flow ?? ((source: RunSource) => identityAt(field(source.origin?.details, 'flow')));
  const viaOf = (channel: string | undefined, kind: ActorKind): Via =>
    options.via?.(channel, kind) ?? (channel === undefined ? undefined : CHANNEL_VIA[channel]) ?? FALLBACK_VIA[kind];
  return {
    actorFor(source) {
      const kind = SUBJECT_KIND[source.subject];
      if (kind === undefined) return err(ActorUnavailableError({ message: `Unknown capability subject "${source.subject}".`, details: { subject: source.subject } }));
      const human = options.human();
      const identity = kind === 'human' ? human : kind === 'agent' ? agentOf(source) : flowOf(source);
      if (identity === undefined) return err(ActorUnavailableError({ details: { subject: source.subject, channel: source.origin?.channel } }));
      return ok({
        kind,
        id: identity.id,
        displayName: identity.displayName,
        ...(identity.model === undefined ? {} : { model: identity.model }),
        via: viaOf(source.origin?.channel, kind),
        ...(source.invocationId === undefined ? {} : { invocationId: source.invocationId }),
        ...(kind === 'human' ? {} : { onBehalfOf: human.id }),
      });
    },
  };
}

/** Resolve the run's actor and build the commit meta in one step. */
export function metaForRun(port: AttributionPort, source: RunSource, label: string, options?: TransactionMetaOptions): Result<TransactionMeta> {
  const actor = port.actorFor(source);
  return actor.ok ? ok(transactionMeta(actor.value, label, options)) : actor;
}

export const AttributionPortToken = /* @__PURE__ */ token('stage/attribution-port').type<AttributionPort>();
