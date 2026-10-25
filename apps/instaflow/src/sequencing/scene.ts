/**
 * Scene helpers for the sequencing modules: element bounds for the spatial index, paint order,
 * and the S2 benchmark scene (a grid of shapes in groups of 100) used by the oracle and the bench.
 * Real documents come from the DocumentRepo; the editor module only needs a `DocumentCRDTv2` part.
 */
import { ok, type Result } from '@staticflux/core';
import { type Box, inkBox } from '@staticflux/document/spatial-index';
import type { CrdtEngine, DocumentCRDTv2, NodeId, NodeRecord, PartOp, PeerId, TransactionMeta } from '@staticflux/document/v2';
import { SceneProjection } from './protocol.js';

const projectedKinds = new Set(SceneProjection.kinds);

const num = (value: unknown, fallback = 0): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);

/** Ink bounds of a projected element: its spatial box grown by half the stroke width (IF-7.8). */
export function elementBounds(node: NodeRecord): Box | undefined {
  if (!projectedKinds.has(node.kind)) return undefined;
  const x = num(node.props['spatial.x']);
  const y = num(node.props['spatial.y']);
  const box: Box = { minX: x, minY: y, maxX: x + num(node.props['spatial.w']), maxY: y + num(node.props['spatial.h']) };
  return inkBox(box, num(node.props['style.stroke.width']) / 2);
}

/** Paint-order key: fractional order keys from the root down (later = drawn on top). */
export function paintKey(part: DocumentCRDTv2, node: NodeId): readonly string[] {
  const path: string[] = [];
  for (let current = part.node(node); current !== undefined; current = current.parent === null ? undefined : part.node(current.parent)) path.unshift(current.order);
  return path;
}

/** Compare paint-order keys (-1: a below b). */
export function comparePaintKeys(a: readonly string[], b: readonly string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i] as string;
    const y = b[i] as string;
    if (x !== y) return x < y ? -1 : 1;
  }
  return a.length - b.length;
}

export interface GridSceneOptions {
  /** Elements (S2: 10 000; CI oracle: 2 000). */
  readonly elements: number;
  /** Elements per group (G-4 drags one group). Default 100. */
  readonly groupSize?: number;
  readonly columns?: number;
  readonly pitch?: number;
  readonly size?: number;
}

export const SCENE_AUTHOR: TransactionMeta = { actor: { kind: 'system', id: 'instaflow/scene' }, label: 'Create scene' };

/** Ops for the benchmark scene: `g<k>` groups of `e<i>` shapes on a grid (S2 layout: pitch 60, size 40, 100 columns). */
export function gridSceneOps(options: GridSceneOptions): PartOp[] {
  const groupSize = options.groupSize ?? 100;
  const columns = options.columns ?? 100;
  const pitch = options.pitch ?? 60;
  const size = options.size ?? 40;
  const ops: PartOp[] = [];
  for (let i = 0; i < options.elements; i++) {
    if (i % groupSize === 0) ops.push({ op: 'create', node: `g${i / groupSize}`, kind: 'group', parent: null });
    ops.push({
      op: 'create',
      node: `e${i}`,
      kind: 'shape',
      parent: `g${Math.floor(i / groupSize)}`,
      props: { 'spatial.x': (i % columns) * pitch, 'spatial.y': Math.floor(i / columns) * pitch, 'spatial.w': size, 'spatial.h': size },
    });
  }
  return ops;
}

/** Build the benchmark scene once and return its snapshot (every module loads the same bytes). */
export function gridSceneSnapshot(engine: CrdtEngine, options: GridSceneOptions, peer: PeerId = '1'): Result<Uint8Array> {
  const part = engine.create({ peer });
  try {
    const created = part.transact(SCENE_AUTHOR, gridSceneOps(options));
    return created.ok ? ok(part.exportSnapshot()) : created;
  } finally {
    part.dispose();
  }
}
