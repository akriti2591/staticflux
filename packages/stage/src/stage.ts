/**
 * The composed stage (SF-Δ7, IF-4.5–4.7): what an editor, renderer, inspector or agent reads. It composes one root
 * asset's content (the `local` layer) with the `session` layer, the proposal-layer seam (M2) and three arcs:
 *
 *   strength: direct opinions (session > proposal/* > local) > variant > inherit > reference
 *
 * - **variant**: `variants.opinions.<set>=<value>` maps on a node, selected by the session's variant selection.
 * - **inherit**: brand-kit classes (`style.inherit`) and, with a `TokenRule`, token values.
 * - **reference**: instances. An `instance` node with `instance.ref` shows the referenced asset's root children as
 *   **instance proxies** (`<instance>/<source>`), with per-source `instance.overrides.<source>` as local opinions.
 *   Pinned references resolve to a milestone document, following ones to Latest (`StageAssets`).
 * - **final paths** (`policy.final` on a class or kit node) and **policy locks** win regardless of strength; the
 *   stronger opinions they beat are reported as `ignored` (flagged) in `read()` and `explain()`.
 *
 * **Incremental.** Every composition is cached and records what it read (raw nodes, layer entries, the variant
 * selection, resolved references, other compositions) in a dependency index. A change invalidates exactly the
 * compositions that read it, transitively; `onInvalidate` names the stage nodes to redraw and `stats()` counts
 * recompositions.
 *
 * **Locks** (`position | content | all`) apply to a node and its subtree; `checkWrite(ops, { actor })` enforces them
 * and final paths for every write (`SF-STAGE-001` ↔ IF-CS-004, `SF-STAGE-003` ↔ IF-CS-013). A policy lock can be
 * changed only by a human with `confirmPolicyUnlock` (`SF-STAGE-002`). Client gating is UX, not security.
 */
import { err, ok, type Result } from '@staticflux/core';
import type { JsonValue, NodeId, PartOp, PropertyPath } from '@staticflux/document/v2';
import { FinalPathError, LockedPathError, PolicyLockError, StageDisposedError } from './errors.js';
import { LOCAL_LAYER, type LayerId, type SessionLayer, type StageLayer, type StageNodeId } from './layers.js';
import { asJsonObject, DEFAULT_STAGE_RULES, isLockScope, type LockScope, matchesAny, type StageRules, variantKey } from './rules.js';
import { type AssetRef, isAssetRef, refKey, type StageAssets, type StageDocument } from './source.js';

export type Arc = 'local' | 'variant' | 'inherit' | 'reference';
export const PROXY_SEPARATOR = '/';

export interface Opinion {
  readonly value: JsonValue;
  readonly layer: LayerId;
  /** The arc at this level (determines strength). */
  readonly arc: Arc;
  /** Document holding the opinion (`StageDocument.key`; the session layer has no document: `session`). */
  readonly asset: string;
  /** Node holding the opinion (a class node for inherit, the instance for overrides, the source node for reference). */
  readonly node: StageNodeId;
  /** Property the opinion is stored at (`variants.opinions.format=story`, `instance.overrides.n1`, or the path itself). */
  readonly storedAt: PropertyPath;
  /** `format=story` for variant opinions. */
  readonly variant?: string;
  /** Kept regardless of strength (a final path or a policy lock). */
  readonly final?: true;
  /** Arcs inside the target, for inherit and reference opinions (`['inherit']` = the source's own class). */
  readonly through?: readonly Arc[];
  /** Where a token value came from. */
  readonly token?: { readonly asset: string; readonly node: NodeId; readonly path: PropertyPath };
}

export interface IgnoredOpinion extends Opinion {
  readonly reason: 'final' | 'policy-lock';
}

export type StageFlag =
  | { readonly kind: 'ignored'; readonly path: PropertyPath; readonly opinion: IgnoredOpinion }
  | { readonly kind: 'cycle'; readonly arc: Arc; readonly target: string }
  | { readonly kind: 'missing'; readonly arc: Arc; readonly target: string };

export interface ComposedNode {
  readonly id: StageNodeId;
  readonly kind: string;
  readonly parent: StageNodeId | null;
  /** The content node this stage node shows (a proxy shows a node of the referenced asset). */
  readonly source: { readonly asset: string; readonly node: NodeId };
  readonly values: Readonly<Record<PropertyPath, JsonValue>>;
  readonly provenance: Readonly<Record<PropertyPath, Opinion>>;
  readonly flags: readonly StageFlag[];
}

export interface Explanation {
  readonly node: StageNodeId;
  readonly path: PropertyPath;
  readonly value: JsonValue | undefined;
  readonly winner: Opinion | undefined;
  /** Weaker opinions, strongest first. */
  readonly overridden: readonly Opinion[];
  /** Stronger opinions beaten by a final path or a policy lock (flagged). */
  readonly ignored: readonly IgnoredOpinion[];
}

export interface EffectiveLock {
  readonly position: boolean;
  readonly content: boolean;
  /** A policy lock applies (from this node or an ancestor). */
  readonly policy: boolean;
  /** Nodes whose `lock.scope` contributes (this node first, then ancestors). */
  readonly from: readonly StageNodeId[];
}

export interface WriteContext {
  /** Who writes (only `kind` matters here). */
  readonly actor: { readonly kind: string };
  /** A human confirmed removing or changing a policy lock. */
  readonly confirmPolicyUnlock?: boolean;
}

export interface StageStats {
  /** Compositions computed since creation (cache misses). */
  readonly recomposed: number;
  readonly cached: number;
  readonly dependencies: number;
}

export interface StageOptions {
  /** The root asset's content (the local layer). */
  readonly root: StageDocument;
  readonly session: SessionLayer;
  /** Resolver for referenced assets (instances, cross-asset classes). Default: nothing resolves. */
  readonly assets?: StageAssets;
  readonly rules?: Partial<StageRules>;
}

export interface Stage {
  readonly session: SessionLayer;
  read(node: StageNodeId): ComposedNode | undefined;
  value(node: StageNodeId, path: PropertyPath): JsonValue | undefined;
  explain(node: StageNodeId, path: PropertyPath): Explanation;
  /** Ordered stage children (`null` = top level), instance proxies included. */
  children(parent: StageNodeId | null): readonly StageNodeId[];
  lockOf(node: StageNodeId): EffectiveLock;
  /** Validate writes (root-asset ops) against locks and final paths. */
  checkWrite(ops: readonly PartOp[], context: WriteContext): Result<void>;
  /** The set op that overrides `path` on an instance proxy (written to the instance node of the root asset). */
  overrideOp(proxy: StageNodeId, path: PropertyPath, value: JsonValue | null): Result<Extract<PartOp, { op: 'set' }>>;
  /** Add a layer between session and local (M2: `proposal/<id>`); the newest added is the strongest. */
  addLayer(layer: StageLayer): () => void;
  layers(): readonly LayerId[];
  /** Stage nodes whose composition was invalidated (redraw them). */
  onInvalidate(listener: (nodes: readonly StageNodeId[]) => void): () => void;
  stats(): StageStats;
  dispose(): void;
  readonly disposed: boolean;
}

// ---------------------------------------------------------------- implementation

interface Composition {
  readonly kind: string;
  readonly parent: StageNodeId | null;
  readonly source: { readonly asset: string; readonly node: NodeId };
  readonly candidates: ReadonlyMap<PropertyPath, readonly Opinion[]>;
  readonly values: Readonly<Record<PropertyPath, JsonValue>>;
  readonly provenance: Readonly<Record<PropertyPath, Opinion>>;
  readonly ignored: ReadonlyMap<PropertyPath, readonly IgnoredOpinion[]>;
  readonly flags: readonly StageFlag[];
}

const SESSION_ASSET = 'session';
const VARIANTS_DEP = 'v:';
const rawKey = (doc: string, node: NodeId): string => `r:${doc}#${node}`;
const docKey = (doc: string, node: NodeId): string => `c:d:${doc}#${node}`;
const stageKey = (node: StageNodeId): string => `c:s:${node}`;
const lockKey = (node: StageNodeId): string => `c:l:${node}`;
const layerKey = (layer: LayerId, node: StageNodeId): string => `L:${layer}#${node}`;
const assetKey = (ref: string): string => `a:${ref}`;

class Builder {
  readonly candidates = new Map<PropertyPath, Opinion[]>();
  readonly flags: StageFlag[] = [];
  push(path: PropertyPath, opinion: Opinion): void {
    let list = this.candidates.get(path);
    if (list === undefined) this.candidates.set(path, (list = []));
    list.push(opinion);
  }
  /** Winner among what is pushed so far (direct opinions decide arc fields such as variant maps). */
  first(path: PropertyPath): Opinion | undefined {
    return this.candidates.get(path)?.[0];
  }
}

function sameValue(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

class StageImpl implements Stage {
  readonly session: SessionLayer;
  private readonly root: StageDocument;
  private readonly assets: StageAssets | undefined;
  private readonly rules: StageRules;
  private readonly extraLayers: StageLayer[] = [];
  private readonly cache = new Map<string, Composition | EffectiveLock | null>();
  /** dep key → cache keys that read it */
  private readonly dependents = new Map<string, Set<string>>();
  /** cache key → dep keys it read */
  private readonly readsOf = new Map<string, Set<string>>();
  private readonly frames: string[] = [];
  private readonly composing = new Set<string>();
  private readonly listeners = new Set<(nodes: readonly StageNodeId[]) => void>();
  private readonly subscriptions = new Map<string, () => void>();
  private readonly stops: (() => void)[] = [];
  private recomposed = 0;
  private isDisposed = false;

  constructor(options: StageOptions) {
    this.root = options.root;
    this.session = options.session;
    this.assets = options.assets;
    this.rules = { ...DEFAULT_STAGE_RULES, ...options.rules };
    this.watchDocument(this.root);
    this.stops.push(this.session.subscribe((nodes) => this.invalidate(nodes.map((n) => layerKey(this.session.id, n)))));
    this.stops.push(this.session.onSelection(() => this.invalidate([VARIANTS_DEP])));
    const unsubscribeAssets = this.assets?.subscribe?.((key) => this.invalidate([assetKey(key)]));
    if (unsubscribeAssets !== undefined) this.stops.push(unsubscribeAssets);
  }

  get disposed(): boolean {
    return this.isDisposed;
  }

  // ------------------------------------------------------------ dependency index

  private watchDocument(doc: StageDocument): void {
    if (this.subscriptions.has(doc.key)) return;
    this.subscriptions.set(
      doc.key,
      // Root-document nodes nothing has read yet (created since) are named too, so consumers that index the tree
      // (hit testing, the accessibility projection) learn about new nodes; known nodes go through the dependency index.
      doc.subscribe((change) => {
        const unread = doc === this.root ? [...new Set(change.nodes)].filter((n) => !this.dependents.has(rawKey(doc.key, n))) : [];
        this.invalidate(change.nodes.map((n) => rawKey(doc.key, n)), unread);
      }),
    );
  }

  private track(dep: string): void {
    const frame = this.frames[this.frames.length - 1];
    if (frame === undefined) return;
    let set = this.dependents.get(dep);
    if (set === undefined) this.dependents.set(dep, (set = new Set()));
    set.add(frame);
    let reads = this.readsOf.get(frame);
    if (reads === undefined) this.readsOf.set(frame, (reads = new Set()));
    reads.add(dep);
  }

  private cached<T extends Composition | EffectiveLock>(key: string, compute: () => T | null): T | null {
    this.track(key);
    if (this.cache.has(key)) return this.cache.get(key) as T | null;
    this.frames.push(key);
    this.composing.add(key);
    try {
      this.recomposed += 1;
      const value = compute();
      this.cache.set(key, value);
      return value;
    } finally {
      this.composing.delete(key);
      this.frames.pop();
    }
  }

  private invalidate(deps: readonly string[], appeared: readonly StageNodeId[] = []): void {
    if (this.isDisposed) return;
    const queue = [...deps];
    const nodes: StageNodeId[] = [];
    const seen = new Set<string>(appeared.map(stageKey));
    nodes.push(...appeared);
    while (queue.length > 0) {
      const dep = queue.pop() as string;
      const dependents = this.dependents.get(dep);
      if (dependents === undefined) continue;
      this.dependents.delete(dep);
      for (const key of dependents) {
        if (seen.has(key)) continue;
        seen.add(key);
        this.cache.delete(key);
        for (const read of this.readsOf.get(key) ?? []) this.dependents.get(read)?.delete(key);
        this.readsOf.delete(key);
        if (key.startsWith('c:s:')) nodes.push(key.slice(4));
        queue.push(key);
      }
    }
    if (nodes.length > 0) for (const listener of [...this.listeners]) listener(nodes);
  }

  // ------------------------------------------------------------ reads

  private resolve(ref: AssetRef): StageDocument | undefined {
    this.track(assetKey(refKey(ref)));
    const doc = this.assets?.resolve(ref);
    if (doc !== undefined) this.watchDocument(doc);
    return doc;
  }

  private raw(doc: StageDocument, node: NodeId) {
    this.track(rawKey(doc.key, node));
    return doc.node(node);
  }

  private layerOpinions(layer: StageLayer, node: StageNodeId): Readonly<Record<PropertyPath, JsonValue>> | undefined {
    this.track(layerKey(layer.id, node));
    return layer.opinions(node);
  }

  /** Strongest first: session, then proposal layers (newest first). */
  private stack(): StageLayer[] {
    return [this.session, ...[...this.extraLayers].reverse()];
  }

  private composeStage(id: StageNodeId): Composition | null {
    return this.cached(stageKey(id), () => {
      const cut = id.lastIndexOf(PROXY_SEPARATOR);
      if (cut < 0) return this.composeNode(this.root, id, id, this.stack());
      return this.composeProxy(id, id.slice(0, cut), id.slice(cut + 1));
    });
  }

  private composeInDoc(doc: StageDocument, node: NodeId): Composition | null {
    return this.cached(docKey(doc.key, node), () => this.composeNode(doc, node, node, []));
  }

  private composeNode(doc: StageDocument, node: NodeId, stageId: StageNodeId, layers: readonly StageLayer[]): Composition | null {
    const record = this.raw(doc, node);
    if (record === undefined) return null;
    const b = new Builder();
    for (const layer of layers) {
      const opinions = this.layerOpinions(layer, stageId);
      for (const [path, value] of Object.entries(opinions ?? {})) b.push(path, { value, layer: layer.id, arc: 'local', asset: SESSION_ASSET, node: stageId, storedAt: path });
    }
    for (const [path, value] of Object.entries(record.props)) b.push(path, { value, layer: LOCAL_LAYER, arc: 'local', asset: doc.key, node, storedAt: path });
    this.addVariants(b, doc.key, node);
    this.addInherits(b, doc);
    const parent = record.parent;
    return this.finish(b, { kind: record.kind, parent, source: { asset: doc.key, node } }, doc);
  }

  private addVariants(b: Builder, asset: string, node: StageNodeId): void {
    const prefix = this.rules.variantPrefix;
    let any = false;
    for (const path of b.candidates.keys()) if (path.startsWith(prefix)) any = true;
    if (!any) return;
    this.track(VARIANTS_DEP);
    for (const [set, value] of this.session.selection()) {
      const key = variantKey(set, value);
      const holder = b.first(`${prefix}${key}`);
      const map = asJsonObject(holder?.value);
      if (holder === undefined || map === undefined) continue;
      for (const [path, v] of Object.entries(map)) {
        b.push(path, { value: v, layer: holder.layer, arc: 'variant', asset: holder.asset === SESSION_ASSET ? SESSION_ASSET : asset, node, storedAt: holder.storedAt, variant: key });
      }
    }
  }

  private addInherits(b: Builder, doc: StageDocument): void {
    for (const rule of this.rules.inherit) {
      const holder = this.winnerOf(b, rule.path);
      if (holder === undefined) continue;
      const target = rule.target(holder.value);
      if (target === undefined) continue;
      const targetDoc = target.ref === undefined ? doc : this.resolve(target.ref);
      const label = `${target.ref === undefined ? doc.key : refKey(target.ref)}#${target.node}`;
      if (targetDoc === undefined) {
        b.flags.push({ kind: 'missing', arc: 'inherit', target: label });
        continue;
      }
      if (this.composing.has(docKey(targetDoc.key, target.node))) {
        b.flags.push({ kind: 'cycle', arc: 'inherit', target: label });
        continue;
      }
      const inner = this.composeInDoc(targetDoc, target.node);
      if (inner === null) {
        b.flags.push({ kind: 'missing', arc: 'inherit', target: label });
        continue;
      }
      this.addFrom(b, inner, 'inherit', targetDoc.key, target.node);
    }
  }

  /** Push the target composition's winners as opinions of `arc` (finals included, arcs/identity excluded). */
  private addFrom(b: Builder, inner: Composition, arc: Arc, asset: string, node: StageNodeId): void {
    // Broken arcs inside the target (cycles, missing targets) are reported on every node that reads through them.
    for (const flag of inner.flags) if (flag.kind !== 'ignored' && !b.flags.some((f) => f.kind === flag.kind && f.target === flag.target)) b.flags.push(flag);
    const finals = this.finalPatterns(inner);
    for (const [path, winner] of Object.entries(inner.provenance)) {
      if (matchesAny(path, this.rules.notInherited)) continue;
      const final = winner.final === true || matchesAny(path, finals);
      b.push(path, {
        ...winner,
        layer: LOCAL_LAYER,
        arc,
        through: winner.arc === 'local' ? [...(winner.through ?? [])] : [winner.arc, ...(winner.through ?? [])],
        ...(winner.arc === 'local' ? { asset, node } : {}),
        ...(final ? { final: true as const } : {}),
      });
    }
  }

  private finalPatterns(c: Composition): string[] {
    const list = c.values[this.rules.finalPaths];
    return Array.isArray(list) ? list.filter((p): p is string => typeof p === 'string') : [];
  }

  private winnerOf(b: Builder, path: PropertyPath): Opinion | undefined {
    return b.candidates.get(path)?.[0];
  }

  private composeProxy(id: StageNodeId, instanceId: StageNodeId, sourceNode: NodeId): Composition | null {
    const instance = this.composeStage(instanceId);
    if (instance === null) return null;
    const ref = instance.values[this.rules.instanceRef];
    if (!isAssetRef(ref)) return null;
    const target = this.resolve(ref);
    if (target === undefined) return null;
    if (this.composing.has(docKey(target.key, sourceNode))) return null;
    const inner = this.composeInDoc(target, sourceNode);
    if (inner === null) return null;
    const b = new Builder();
    for (const layer of this.stack()) {
      const opinions = this.layerOpinions(layer, id);
      for (const [path, value] of Object.entries(opinions ?? {})) b.push(path, { value, layer: layer.id, arc: 'local', asset: SESSION_ASSET, node: id, storedAt: path });
    }
    const overridesAt = `${this.rules.overridesPrefix}${sourceNode}`;
    const holder = instance.provenance[overridesAt];
    const overrides = asJsonObject(instance.values[overridesAt]);
    for (const [path, value] of Object.entries(overrides ?? {})) {
      b.push(path, { value, layer: holder?.layer ?? LOCAL_LAYER, arc: 'local', asset: holder?.asset ?? this.root.key, node: instanceId, storedAt: overridesAt });
    }
    // The source's identity, arc and lock fields (its own instance ref, variants, locks) are part of what the proxy shows.
    for (const [path, winner] of Object.entries(inner.provenance)) {
      if (!matchesAny(path, this.rules.notInherited)) continue;
      b.push(path, { ...winner, layer: LOCAL_LAYER, arc: 'reference', through: [winner.arc, ...(winner.through ?? [])] });
    }
    this.addFrom(b, inner, 'reference', target.key, sourceNode);
    const sourceParent = inner.parent;
    const targetRoot = target.root();
    const parent = sourceParent === null || sourceParent === targetRoot ? instanceId : `${instanceId}${PROXY_SEPARATOR}${sourceParent}`;
    return this.finish(b, { kind: inner.kind, parent, source: inner.source }, target);
  }

  private finish(b: Builder, base: Pick<Composition, 'kind' | 'parent' | 'source'>, doc: StageDocument): Composition {
    const policy = this.ownPolicyScope(b);
    const values: Record<PropertyPath, JsonValue> = {};
    const provenance: Record<PropertyPath, Opinion> = {};
    const ignored = new Map<PropertyPath, IgnoredOpinion[]>();
    const sorted = new Map<PropertyPath, Opinion[]>();
    for (const [path, list] of b.candidates) {
      const ordered = [...list].sort((x, y) => strength(x) - strength(y));
      let index = ordered.findIndex((o) => o.final === true);
      let reason: IgnoredOpinion['reason'] = 'final';
      if (index < 0 && policy !== undefined && this.covers(policy, path)) {
        index = ordered.findIndex((o) => o.layer === LOCAL_LAYER);
        reason = 'policy-lock';
      }
      if (index < 0) index = 0;
      const winner = ordered[index] as Opinion;
      const beaten = ordered.slice(0, index).map((o) => ({ ...o, reason }));
      if (beaten.length > 0) {
        ignored.set(path, beaten);
        for (const opinion of beaten) b.flags.push({ kind: 'ignored', path, opinion });
      }
      const resolved = this.resolveToken(winner, doc);
      values[path] = resolved.value;
      provenance[path] = resolved;
      sorted.set(path, ordered);
    }
    return { ...base, candidates: sorted, values, provenance, ignored, flags: b.flags };
  }

  /** The node's own policy-lock scope (from its local content), if any. */
  private ownPolicyScope(b: Builder): LockScope | undefined {
    const local = (path: PropertyPath): Opinion | undefined => b.candidates.get(path)?.find((o) => o.layer === LOCAL_LAYER && o.arc === 'local');
    const policy = local(this.rules.lockPolicy);
    if (policy === undefined || policy.value === null) return undefined;
    const scope = local(this.rules.lockScope)?.value;
    return isLockScope(scope) ? scope : 'all';
  }

  private covers(scope: LockScope, path: PropertyPath): boolean {
    if (path === this.rules.lockScope || path === this.rules.lockPolicy) return true;
    if (scope === 'all') return true;
    const position = matchesAny(path, this.rules.positionPaths);
    return scope === 'position' ? position : !position;
  }

  private resolveToken(winner: Opinion, doc: StageDocument): Opinion {
    const rule = this.rules.token;
    if (rule === undefined) return winner;
    const target = rule.match(winner.value);
    if (target === undefined) return winner;
    const targetDoc = target.ref === undefined ? doc : this.resolve(target.ref);
    if (targetDoc === undefined || this.composing.has(docKey(targetDoc.key, target.node))) return winner;
    const inner = this.composeInDoc(targetDoc, target.node);
    const value = inner?.values[target.path];
    if (value === undefined) return winner;
    return { ...winner, value, token: { asset: targetDoc.key, node: target.node, path: target.path } };
  }

  // ------------------------------------------------------------ public API

  read(node: StageNodeId): ComposedNode | undefined {
    if (this.isDisposed) return undefined;
    const c = this.composeStage(node);
    if (c === null) return undefined;
    return { id: node, kind: c.kind, parent: c.parent, source: c.source, values: c.values, provenance: c.provenance, flags: c.flags };
  }

  value(node: StageNodeId, path: PropertyPath): JsonValue | undefined {
    return this.read(node)?.values[path];
  }

  explain(node: StageNodeId, path: PropertyPath): Explanation {
    const c = this.isDisposed ? null : this.composeStage(node);
    const ordered = c?.candidates.get(path) ?? [];
    const winner = c?.provenance[path];
    const ignored = c?.ignored.get(path) ?? [];
    const at = winner === undefined ? -1 : ordered.findIndex((o) => sameOpinion(o, winner));
    return { node, path, value: winner?.value, winner, overridden: at < 0 ? [] : ordered.slice(at + 1), ignored };
  }

  children(parent: StageNodeId | null): readonly StageNodeId[] {
    if (this.isDisposed) return [];
    if (parent === null) return this.root.children(null);
    const proxy = parent.includes(PROXY_SEPARATOR);
    const own: StageNodeId[] = [];
    if (!proxy) own.push(...this.root.children(parent));
    else {
      const c = this.composeStage(parent);
      const cut = parent.lastIndexOf(PROXY_SEPARATOR);
      const instanceId = parent.slice(0, cut);
      const instance = this.composeStage(instanceId);
      const ref = instance?.values[this.rules.instanceRef];
      const doc = c !== null && isAssetRef(ref) ? this.assets?.resolve(ref) : undefined;
      if (doc !== undefined && c !== null) own.push(...doc.children(c.source.node).map((child) => `${instanceId}${PROXY_SEPARATOR}${child}`));
    }
    const self = this.composeStage(parent);
    const ref = self?.values[this.rules.instanceRef];
    if (isAssetRef(ref)) {
      const doc = this.assets?.resolve(ref);
      const root = doc?.root();
      if (doc !== undefined && root !== undefined) own.push(...doc.children(root).map((child) => `${parent}${PROXY_SEPARATOR}${child}`));
    }
    return own;
  }

  lockOf(node: StageNodeId): EffectiveLock {
    const none: EffectiveLock = { position: false, content: false, policy: false, from: [] };
    if (this.isDisposed) return none;
    return (
      this.cached<EffectiveLock>(lockKey(node), () => {
        const c = this.composeStage(node);
        if (c === null) return none;
        const inherited = c.parent === null ? none : this.lockOf(c.parent);
        const scope = c.values[this.rules.lockScope];
        const policyValue = c.values[this.rules.lockPolicy];
        const hasPolicy = policyValue !== undefined && policyValue !== null;
        const own = isLockScope(scope) ? scope : hasPolicy ? 'all' : undefined;
        if (own === undefined) return inherited;
        return {
          position: inherited.position || own === 'position' || own === 'all',
          content: inherited.content || own === 'content' || own === 'all',
          policy: inherited.policy || hasPolicy,
          from: [node, ...inherited.from],
        };
      }) ?? none
    );
  }

  checkWrite(ops: readonly PartOp[], context: WriteContext): Result<void> {
    if (this.isDisposed) return err(StageDisposedError());
    for (let i = 0; i < ops.length; i += 1) {
      const op = ops[i] as PartOp;
      const fail = this.checkOp(op, i, context);
      if (fail !== undefined) return err(fail);
    }
    return ok();
  }

  private checkOp(op: PartOp, index: number, context: WriteContext) {
    const locked = (node: StageNodeId, scope: string, path?: PropertyPath) => {
      const lock = this.lockOf(node);
      return LockedPathError({
        message: `Op ${index}: "${node}"${path === undefined ? '' : ` ${path}`} is locked (${scope}).`,
        details: { node, op: index, scope, from: lock.from, policy: lock.policy, ...(path === undefined ? {} : { path }) },
      });
    };
    const containerLocked = (parent: NodeId | null): boolean => parent !== null && this.lockOf(parent).content;
    switch (op.op) {
      case 'create':
        return containerLocked(op.parent) ? locked(op.parent as NodeId, 'content') : undefined;
      case 'delete': {
        const lock = this.lockOf(op.node);
        return lock.position || lock.content ? locked(op.node, lock.content ? 'content' : 'position') : undefined;
      }
      case 'move': {
        if (this.lockOf(op.node).position) return locked(op.node, 'position');
        const from = this.read(op.node)?.parent ?? null;
        if (containerLocked(from)) return locked(from as NodeId, 'content');
        return containerLocked(op.parent) ? locked(op.parent as NodeId, 'content') : undefined;
      }
      default: {
        const { node, path } = op;
        if (path === this.rules.lockScope || path === this.rules.lockPolicy) {
          const own = this.read(node);
          const policy = own?.values[this.rules.lockPolicy];
          if (policy === undefined || policy === null) return undefined; // UX lock: anyone with edit rights
          if (context.actor.kind !== 'human') {
            return PolicyLockError({ message: `Op ${index}: only a human can change the policy lock on "${node}".`, details: { node, path, op: index, actor: context.actor.kind } });
          }
          return context.confirmPolicyUnlock === true ? undefined : PolicyLockError({ message: `Op ${index}: changing the policy lock on "${node}" needs an explicit confirmation.`, details: { node, path, op: index, needs: 'confirmation' } });
        }
        const lock = this.lockOf(node);
        const position = op.op === 'set' && matchesAny(path, this.rules.positionPaths);
        if (position ? lock.position : lock.content) return locked(node, position ? 'position' : 'content', path);
        const winner = this.explain(node, path).winner;
        if (winner?.final === true && winner.arc !== 'local') {
          return FinalPathError({ message: `Op ${index}: ${path} on "${node}" is final in ${winner.asset}#${winner.node}.`, details: { node, path, op: index, source: `${winner.asset}#${winner.node}` } });
        }
        return undefined;
      }
    }
  }

  overrideOp(proxy: StageNodeId, path: PropertyPath, value: JsonValue | null): Result<Extract<PartOp, { op: 'set' }>> {
    const cut = proxy.lastIndexOf(PROXY_SEPARATOR);
    const instanceId = proxy.slice(0, cut);
    if (cut < 0 || instanceId.includes(PROXY_SEPARATOR)) {
      return err(LockedPathError({ message: `"${proxy}" is not a proxy of an instance in the root asset; edit the referenced asset instead.`, details: { node: proxy } }));
    }
    const at = `${this.rules.overridesPrefix}${proxy.slice(cut + 1)}`;
    const current = asJsonObject(this.read(instanceId)?.values[at]) ?? {};
    const next: Record<string, JsonValue> = { ...current };
    if (value === null) delete next[path];
    else next[path] = value;
    return ok({ op: 'set', node: instanceId, path: at, value: Object.keys(next).length === 0 ? null : next });
  }

  addLayer(layer: StageLayer): () => void {
    this.extraLayers.push(layer);
    const stop = layer.subscribe((nodes) => this.invalidate(nodes.map((n) => layerKey(layer.id, n))));
    this.resetAll();
    return () => {
      const index = this.extraLayers.indexOf(layer);
      if (index < 0) return;
      this.extraLayers.splice(index, 1);
      stop();
      this.resetAll();
    };
  }

  private resetAll(): void {
    const nodes = [...this.cache.keys()].filter((k) => k.startsWith('c:s:')).map((k) => k.slice(4));
    this.cache.clear();
    this.dependents.clear();
    this.readsOf.clear();
    if (nodes.length > 0) for (const listener of [...this.listeners]) listener(nodes);
  }

  layers(): readonly LayerId[] {
    return [...this.stack().map((l) => l.id), LOCAL_LAYER];
  }

  onInvalidate(listener: (nodes: readonly StageNodeId[]) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  stats(): StageStats {
    let dependencies = 0;
    for (const set of this.dependents.values()) dependencies += set.size;
    return { recomposed: this.recomposed, cached: this.cache.size, dependencies };
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    for (const stop of this.stops) stop();
    for (const stop of this.subscriptions.values()) stop();
    this.subscriptions.clear();
    this.cache.clear();
    this.dependents.clear();
    this.readsOf.clear();
    this.listeners.clear();
  }
}

const ARC_RANK: Readonly<Record<Arc, number>> = { local: 0, variant: 1, inherit: 2, reference: 3 };

/** Sort key: arc first (local > variant > inherit > reference), then layer order is the push order (stable sort). */
function strength(o: Opinion): number {
  return ARC_RANK[o.arc];
}

function sameOpinion(a: Opinion, b: Opinion): boolean {
  return a.layer === b.layer && a.arc === b.arc && a.asset === b.asset && a.node === b.node && a.storedAt === b.storedAt && a.variant === b.variant;
}

/** Create a composed stage over a root asset (see the module comment). */
export function createStage(options: StageOptions): Stage {
  return new StageImpl(options);
}
