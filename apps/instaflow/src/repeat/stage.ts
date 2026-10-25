/**
 * The repeat view (IF-26.6, IF-26.10–26.13): a read-only view over the composed stage in which every live repeat
 * group shows its **derived instances** as ordinary nodes, so everything that reads the stage — B1's render
 * projection, bounds, booleans, masks and hit testing, B3's tools — sees instances without them being stored.
 *
 * Shape of the view (ids are stable and deterministic):
 * - a repeat group `R` (a `group` with `repeat.kind`) has one **instance wrapper** child per instance, `R~0 … R~n−1`:
 *   a zero-size `group` whose spatial values are the instance placement (`instances.ts`); `R~0` is the identity;
 * - `R~0` holds the **source**: `R`'s real children, unchanged (their view parent is `R~0`), so editing the source
 *   is editing the document;
 * - `R~k` (k ≥ 1) holds **copies** of the `R~0` subtree: the copy of view node `x` is `R~k^x`, with `x`'s composed
 *   values (classes and tokens resolved as for `x`) and match key `<key of x>~k`. Nested repeats nest naturally
 *   (`R~2^S~1^dot`).
 *
 * Wrappers keep masks per instance (a mask masks the later siblings in its parent only) and let a boolean repeat
 * combine its instances (B1 booleans take groups as operands). Derived nodes are locked in the view: `lockOf`
 * reports them locked and `checkWrite` refuses any op on them (IF-REP-004); `resolveInstance` maps one back to its
 * editable source and instance path.
 *
 * Invalidation: a change to a node invalidates its derived copies and the wrappers of every repeat above it (their
 * placements depend on the source bounds); a repeat whose count shrinks invalidates the wrappers it no longer has.
 * Reads are cached until the next invalidation.
 */
import type { Scope } from '@staticflux/core';
import { err, type Result } from '@staticflux/core';
import type { Box } from '@staticflux/document/spatial-index';
import type { JsonValue, NodeId, PartOp, PropertyPath } from '@staticflux/document/v2';
import type { ComposedNode, EffectiveLock, Explanation, Stage, StageNodeId } from '@staticflux/stage';
import type { BrandKitView } from '../elements/brand-kit.js';
import { P } from '../elements/components.js';
import type { GeometryService } from '../elements/geometry.js';
import { type ElementContext, isElement, localOutline, unionBox } from '../elements/layout.js';
import { type Affine, IDENTITY, multiply, resolveElement } from '../elements/resolve.js';
import { COPY_SEPARATOR, INSTANCE_SEPARATOR } from './components.js';
import { DerivedInstanceError } from './errors.js';
import { instancePlacements, type Placement } from './instances.js';
import { readRepeat, type RepeatParams } from './params.js';

/** What the view needs from the composed stage. */
export type RepeatBaseStage = Pick<Stage, 'read' | 'children' | 'value' | 'explain' | 'lockOf' | 'checkWrite' | 'onInvalidate'>;

export interface RepeatStageOptions {
  readonly stage: RepeatBaseStage;
  readonly geometry: GeometryService;
  readonly kit?: BrandKitView;
  /** Disposes the view with the scope (rule 5). */
  readonly scope?: Pick<Scope, 'defer'>;
}

/** One level of a derived node's instance path: the repeat (a view id) and the instance index. */
export interface InstanceStep {
  readonly repeat: StageNodeId;
  readonly index: number;
}

export interface InstanceRef {
  readonly node: StageNodeId;
  /** The editable document node it shows (for a wrapper: the repeat group). */
  readonly source: NodeId;
  /** True for wrappers and copies (they exist only in the view). */
  readonly derived: boolean;
  /** True for an instance wrapper. */
  readonly wrapper: boolean;
  /** The innermost instance index (0 for the source itself and outside any repeat). */
  readonly index: number;
  /** Every repeat level, outermost first (empty outside any repeat). */
  readonly path: readonly InstanceStep[];
}

export interface RepeatLayout {
  readonly params: RepeatParams;
  /** The source's geometry bounds in the repeat's local space. */
  readonly content: Box;
  readonly placements: readonly Placement[];
}

export interface RepeatStage extends RepeatBaseStage {
  readonly base: RepeatBaseStage;
  /** The repeat parameters of a view node (undefined: not a repeat). */
  params(node: StageNodeId): RepeatParams | undefined;
  /** Parameters, source bounds and placements of a repeat (real or copied). */
  layout(node: StageNodeId): RepeatLayout | undefined;
  isDerived(node: StageNodeId): boolean;
  resolveInstance(node: StageNodeId): InstanceRef | undefined;
  /** The document children of a real node (a repeat's source, without wrappers). */
  sourceChildren(node: NodeId): readonly NodeId[];
  dispose(): void;
}

const EMPTY_BOX: Box = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
const MAX_DEPTH = 1024;

/** A wrapper id: `<repeat>~<index>`. */
export function wrapperId(repeat: StageNodeId, index: number): StageNodeId {
  return `${repeat}${INSTANCE_SEPARATOR}${index}`;
}

/** A copy id: `<wrapper>^<view id>`. */
export function copyId(wrapper: StageNodeId, of: StageNodeId): StageNodeId {
  return `${wrapper}${COPY_SEPARATOR}${of}`;
}

/** The match key of instance `index` of a node whose key is `key`. */
export function instanceKey(key: string, index: number): string {
  return `${key}${INSTANCE_SEPARATOR}${index}`;
}

/** The spatial values (and name, key) of instance `index`'s wrapper group — shared by the live view and expand. */
export function wrapperProps(placement: Placement, index: number, key: string | undefined): Record<PropertyPath, JsonValue> {
  return {
    name: `Instance ${index + 1}`,
    [P.x]: placement.x,
    [P.y]: placement.y,
    [P.w]: 0,
    [P.h]: 0,
    [P.anchorX]: 0,
    [P.anchorY]: 0,
    [P.rotation]: placement.rotation,
    [P.flipY]: placement.flipY,
    ...(key === undefined ? {} : { [P.matchKey]: instanceKey(key, index) }),
  };
}

type Parsed = { readonly kind: 'wrapper'; readonly repeat: NodeId; readonly index: number } | { readonly kind: 'copy'; readonly repeat: NodeId; readonly index: number; readonly wrapper: StageNodeId; readonly of: StageNodeId };

/** Parse a derived id syntactically (`R~k` or `R~k^x`, `R` a document node); validity is checked on read. */
function parse(id: StageNodeId): Parsed | undefined {
  const at = id.indexOf(COPY_SEPARATOR);
  const head = at < 0 ? id : id.slice(0, at);
  const t = head.lastIndexOf(INSTANCE_SEPARATOR);
  if (t <= 0) return undefined;
  const digits = head.slice(t + 1);
  const index = Number(digits);
  if (!Number.isInteger(index) || index < 0 || String(index) !== digits) return undefined;
  const repeat = head.slice(0, t);
  return at < 0 ? { kind: 'wrapper', repeat, index } : { kind: 'copy', repeat, index, wrapper: head, of: id.slice(at + 1) };
}

/** Create the repeat view over a composed stage (see the module header). */
export function createRepeatStage(options: RepeatStageOptions): RepeatStage {
  const base = options.stage;
  const reads = new Map<StageNodeId, ComposedNode | null>();
  const layouts = new Map<NodeId, RepeatLayout | null>();
  /** Derived ids handed out, by the document node they derive from (for invalidation). */
  const derived = new Map<NodeId, Set<StageNodeId>>();
  /** Last known document parent (walks ancestors of deleted nodes). */
  const lastParent = new Map<NodeId, NodeId | null>();
  const listeners = new Set<(nodes: readonly StageNodeId[]) => void>();
  let disposed = false;

  const remember = (from: NodeId, id: StageNodeId): void => {
    let set = derived.get(from);
    if (set === undefined) derived.set(from, (set = new Set()));
    set.add(id);
  };

  const realRepeat = (node: NodeId): RepeatParams | undefined => {
    const composed = base.read(node);
    return composed === undefined ? undefined : readRepeat(composed.values);
  };

  /** The document node a view id shows (wrappers show their repeat). */
  const sourceOf = (id: StageNodeId): NodeId => {
    let at = id;
    for (let depth = 0; depth < MAX_DEPTH && base.read(at) === undefined; depth++) {
      const p = parse(at);
      if (p === undefined) return at;
      at = p.kind === 'copy' ? p.of : p.repeat;
    }
    return at;
  };

  const ctx: ElementContext = {
    stage: {
      read: (id) => read(id),
      children: (id) => children(id),
      value: (id, path) => value(id, path),
    },
    geometry: options.geometry,
    ...(options.kit === undefined ? {} : { kit: options.kit }),
  };

  const subtreeBox = (id: StageNodeId, outer: Affine): Box | undefined => {
    const el = resolveElement(ctx.stage, id, ctx.kit);
    if (el === undefined || !isElement(el.kind)) return undefined;
    const t = multiply(outer, el.transform);
    if (el.geometry.kind === 'group') {
      let box: Box | undefined;
      for (const child of children(id)) {
        const b = subtreeBox(child, t);
        if (b !== undefined) box = unionBox(box, b);
      }
      return box;
    }
    const outline = localOutline(ctx, el);
    if (!outline.ok) return undefined;
    const b = ctx.geometry.bounds(outline.value, t);
    return b.ok ? b.value : undefined;
  };

  const layoutOf = (repeat: NodeId): RepeatLayout | undefined => {
    const hit = layouts.get(repeat);
    if (hit !== undefined) return hit ?? undefined;
    const params = realRepeat(repeat);
    if (params === undefined) {
      layouts.set(repeat, null);
      return undefined;
    }
    let content: Box | undefined;
    for (const child of base.children(repeat)) {
      const b = subtreeBox(child, IDENTITY);
      if (b !== undefined) content = unionBox(content, b);
    }
    const layout: RepeatLayout = { params, content: content ?? EMPTY_BOX, placements: instancePlacements(params, content ?? EMPTY_BOX) };
    layouts.set(repeat, layout);
    return layout;
  };

  /** Is view node `x` inside instance 0 of document repeat `repeat`? */
  const inSource = (x: ComposedNode, repeat: NodeId): boolean => {
    const zero = wrapperId(repeat, 0);
    let parent = x.parent;
    for (let depth = 0; parent !== null && depth < MAX_DEPTH; depth++) {
      if (parent === zero) return true;
      if (parent === repeat) return false;
      parent = read(parent)?.parent ?? null;
    }
    return false;
  };

  const compute = (id: StageNodeId): ComposedNode | undefined => {
    const real = base.read(id);
    if (real !== undefined) {
      lastParent.set(id, real.parent);
      return real.parent !== null && realRepeat(real.parent) !== undefined ? { ...real, parent: wrapperId(real.parent, 0) } : real;
    }
    const p = parse(id);
    if (p === undefined) return undefined;
    const repeat = base.read(p.repeat);
    if (repeat === undefined) return undefined;
    const layout = layoutOf(p.repeat);
    if (layout === undefined || p.index >= layout.placements.length) return undefined;
    if (p.kind === 'wrapper') {
      const key = repeat.values[P.matchKey];
      remember(p.repeat, id);
      return {
        id,
        kind: 'group',
        parent: p.repeat,
        source: repeat.source,
        values: wrapperProps(layout.placements[p.index] as Placement, p.index, typeof key === 'string' ? key : undefined),
        provenance: {},
        flags: [],
      };
    }
    if (p.index === 0) return undefined; // instance 0 is the source itself, never a copy
    const of = read(p.of);
    if (of === undefined || !inSource(of, p.repeat)) return undefined;
    remember(sourceOf(p.of), id);
    const zero = wrapperId(p.repeat, 0);
    const parent = of.parent === zero ? p.wrapper : copyId(p.wrapper, of.parent as StageNodeId);
    const key = of.values[P.matchKey];
    if (typeof key !== 'string') return { ...of, id, parent };
    const next = instanceKey(key, p.index);
    const winner = of.provenance[P.matchKey];
    return {
      ...of,
      id,
      parent,
      values: { ...of.values, [P.matchKey]: next },
      provenance: winner === undefined ? of.provenance : { ...of.provenance, [P.matchKey]: { ...winner, value: next } },
    };
  };

  function read(id: StageNodeId): ComposedNode | undefined {
    const hit = reads.get(id);
    if (hit !== undefined) return hit ?? undefined;
    const node = compute(id);
    reads.set(id, node ?? null);
    return node;
  }

  function children(parent: StageNodeId | null): readonly StageNodeId[] {
    if (parent === null) return base.children(null);
    if (base.read(parent) !== undefined) {
      const layout = realRepeat(parent) === undefined ? undefined : layoutOf(parent);
      return layout === undefined ? base.children(parent) : layout.placements.map((_, k) => wrapperId(parent, k));
    }
    const p = parse(parent);
    if (p === undefined || read(parent) === undefined) return [];
    if (p.kind === 'copy') return children(p.of).map((c) => copyId(p.wrapper, c));
    return p.index === 0 ? base.children(p.repeat) : children(wrapperId(p.repeat, 0)).map((c) => copyId(parent, c));
  }

  function value(node: StageNodeId, path: PropertyPath): JsonValue | undefined {
    return base.read(node) !== undefined ? base.value(node, path) : read(node)?.values[path];
  }

  const isDerived = (node: StageNodeId): boolean => base.read(node) === undefined && read(node) !== undefined;

  const explain = (node: StageNodeId, path: PropertyPath): Explanation => {
    if (!isDerived(node)) return base.explain(node, path);
    const p = parse(node) as Parsed;
    const own = read(node)?.values[path];
    if (p.kind === 'wrapper') return { node, path, value: own, winner: undefined, overridden: [], ignored: [] };
    const inner = explain(p.of, path);
    return { ...inner, node, value: own, ...(inner.winner === undefined ? {} : { winner: { ...inner.winner, value: own ?? inner.winner.value } }) };
  };

  const lockOf = (node: StageNodeId): EffectiveLock => {
    if (!isDerived(node)) return base.lockOf(node);
    return { ...base.lockOf(sourceOf(node)), position: true, content: true };
  };

  const checkWrite = (ops: readonly PartOp[], context: Parameters<Stage['checkWrite']>[1]): Result<void> => {
    for (const op of ops) {
      const targets = [op.node, 'parent' in op ? op.parent : null].filter((t): t is string => typeof t === 'string');
      const hit = targets.find((t) => isDerived(t));
      if (hit !== undefined) {
        return err(DerivedInstanceError({ message: `"${hit}" is a repeat instance; edit its source "${sourceOf(hit)}".`, details: { node: hit, source: sourceOf(hit), op: op.op } }));
      }
    }
    return base.checkWrite(ops, context);
  };

  const wrapperOf = (id: StageNodeId): InstanceStep | undefined => {
    if (!isDerived(id)) return undefined;
    const p = parse(id) as Parsed;
    if (p.kind === 'wrapper') return { repeat: p.repeat, index: p.index };
    const inner = wrapperOf(p.of);
    return inner === undefined ? undefined : { repeat: copyId(p.wrapper, inner.repeat), index: inner.index };
  };

  const resolveInstance = (node: StageNodeId): InstanceRef | undefined => {
    if (read(node) === undefined) return undefined;
    const path: InstanceStep[] = [];
    for (let at: StageNodeId | null = node, depth = 0; at !== null && depth < MAX_DEPTH; depth++) {
      const step = wrapperOf(at);
      if (step !== undefined) path.unshift(step);
      at = read(at)?.parent ?? null;
    }
    const own = wrapperOf(node);
    return { node, source: sourceOf(node), derived: isDerived(node), wrapper: own !== undefined, index: path[path.length - 1]?.index ?? 0, path };
  };

  const stop = base.onInvalidate((nodes) => {
    if (disposed) return;
    const out = new Set<StageNodeId>();
    const visit = (n: NodeId): void => {
      out.add(n);
      for (const d of derived.get(n) ?? []) out.add(d);
    };
    for (const node of nodes) {
      visit(node);
      // Every repeat above the node lays out from the source bounds: invalidate its wrappers (old and new).
      let at: NodeId | null = base.read(node)?.parent ?? lastParent.get(node) ?? null;
      for (let depth = 0; at !== null && depth < MAX_DEPTH; depth++) {
        if ((layouts.get(at) ?? undefined) !== undefined || realRepeat(at) !== undefined) visit(at);
        at = base.read(at)?.parent ?? lastParent.get(at) ?? null;
      }
    }
    reads.clear();
    layouts.clear();
    const list = [...out];
    for (const listener of [...listeners]) listener(list);
    // Forget derived ids that no longer exist.
    for (const id of list) {
      if (base.read(id) !== undefined || read(id) !== undefined) continue;
      for (const set of derived.values()) set.delete(id);
    }
    for (const [from, set] of derived) if (set.size === 0) derived.delete(from);
  });

  const view: RepeatStage = {
    base,
    read,
    children,
    value,
    explain,
    lockOf,
    checkWrite,
    onInvalidate(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    params: (node) => {
      const composed = read(node);
      return composed === undefined ? undefined : readRepeat(composed.values);
    },
    layout: (node) => (read(node) === undefined ? undefined : layoutOf(sourceOf(node))),
    isDerived,
    resolveInstance,
    sourceChildren: (node) => base.children(node),
    dispose() {
      if (disposed) return;
      disposed = true;
      stop();
      listeners.clear();
      reads.clear();
      layouts.clear();
      derived.clear();
    },
  };
  options.scope?.defer(() => view.dispose());
  return view;
}
