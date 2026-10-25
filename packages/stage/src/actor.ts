/**
 * Actor records (SF-Δ10, IF-4.12): who made a transaction, carried in every commit's `meta.actor`. Replaces the coarse
 * `'agent'` subject / CRDT origin for history, attribution badges and the per-actor undo service.
 *
 * `transactionMeta(actor, label)` builds the `TransactionMeta` a `DocumentRepo` commit takes: the actor record, the
 * readable undo label, `via`, the capability invocation id and a fresh logical transaction id (`txn`), which is also the
 * undo step key.
 */
import type { ActorRecord, JsonValue, TransactionMeta } from '@staticflux/document/v2';

export const ACTOR_KINDS = ['human', 'agent', 'flow'] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

/** The surface an edit came through (DOCUMENT-FORMAT §2). `direct` = direct manipulation on the canvas. */
export const VIAS = ['hud', 'bar', 'chat', 'webmcp', 'flow', 'shortcut', 'direct'] as const;
export type Via = (typeof VIAS)[number];

export interface Actor {
  readonly kind: ActorKind;
  /** Stable id: the guest id for humans (V1), the agent session id, the flow asset id. Undo stacks are keyed by it. */
  readonly id: string;
  readonly displayName: string;
  /** Model id for agents (`claude-…`). */
  readonly model?: string;
  readonly via: Via;
  /** The capability invocation this edit belongs to (one invocation = one undo step). */
  readonly invocationId?: string;
  /** For agents and flows: the human they act for. */
  readonly onBehalfOf?: string;
}

export interface TransactionMetaOptions {
  /** Defaults to a fresh id; commits sharing a `txn` are one logical transaction. */
  readonly txn?: string;
  readonly changeSet?: string;
}

const isString = (value: unknown): value is string => typeof value === 'string';

/** True for a well-formed actor record (from a commit's meta, a JSON payload, …). */
export function isActor(value: unknown): value is Actor {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (!(ACTOR_KINDS as readonly unknown[]).includes(v['kind']) || !isString(v['id']) || v['id'].length === 0) return false;
  if (!isString(v['displayName']) || !(VIAS as readonly unknown[]).includes(v['via'])) return false;
  for (const key of ['model', 'invocationId', 'onBehalfOf'] as const) if (v[key] !== undefined && !isString(v[key])) return false;
  return true;
}

/** The actor as a commit-meta `ActorRecord` (plain JSON, no undefined fields). */
export function actorRecord(actor: Actor): ActorRecord {
  const record: Record<string, JsonValue> = { kind: actor.kind, id: actor.id, displayName: actor.displayName, via: actor.via };
  if (actor.model !== undefined) record['model'] = actor.model;
  if (actor.invocationId !== undefined) record['invocationId'] = actor.invocationId;
  if (actor.onBehalfOf !== undefined) record['onBehalfOf'] = actor.onBehalfOf;
  return record as unknown as ActorRecord;
}

/** The actor of a commit, or undefined when the meta carries no full actor record (legacy or foreign commits). */
export function actorOf(meta: TransactionMeta): Actor | undefined {
  return isActor(meta.actor) ? meta.actor : undefined;
}

let txnCounter = 0;
/** A fresh, globally unique logical transaction id. */
export function newTransactionId(): string {
  txnCounter += 1;
  const random = crypto.getRandomValues(new Uint32Array(2));
  return `t${(random[0] as number).toString(36)}${(random[1] as number).toString(36)}-${txnCounter.toString(36)}`;
}

/** Meta for one commit by `actor` (SF-Δ10: actor record → `transact(meta)`). */
export function transactionMeta(actor: Actor, label: string, options: TransactionMetaOptions = {}): TransactionMeta {
  return {
    actor: actorRecord(actor),
    label,
    txn: options.txn ?? newTransactionId(),
    via: actor.via,
    ...(actor.invocationId === undefined ? {} : { invocation: actor.invocationId }),
    ...(options.changeSet === undefined ? {} : { changeSet: options.changeSet }),
  };
}
