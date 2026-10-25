/** Test helpers for the lenses (not built): a composition's root part on the Loro engine. */
import type { Result } from '@staticflux/core';
import { createLoroEngine } from '@staticflux/document/loro-crdt';
import { createDocumentRepo, createMemoryDocumentStore, type DocumentCRDTv2, type JsonValue, type OpenDocument, type PartOp } from '@staticflux/document/v2';
import type { Actor } from '@staticflux/stage';
import { STRUCTURE_PATHS } from './structure.js';

export const signal: AbortSignal = new AbortController().signal;
export const priya: Actor = { kind: 'human', id: 'guest-priya', displayName: 'Priya', via: 'direct' };

export function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

export interface PageSeed {
  readonly id: string;
  readonly name?: string;
  readonly size?: readonly [number, number];
  readonly canvas?: readonly [number, number];
}

export interface LooseSeed {
  readonly id: string;
  readonly box: readonly [number, number, number, number];
}

/** A composition (`comp`, format 1080×1350 unless given) with page stubs and loose elements in its root part. */
export async function compositionDoc(pages: readonly PageSeed[], loose: readonly LooseSeed[] = [], format: { width: number; height: number } = { width: 1080, height: 1350 }): Promise<{ doc: OpenDocument; root: DocumentCRDTv2 }> {
  const repo = createDocumentRepo({ store: createMemoryDocumentStore(), engine: createLoroEngine(), compactAfterBytes: Number.POSITIVE_INFINITY });
  const doc = unwrap(await repo.create('as_flyer', { treeSchema: 1, parts: ['root'] }, signal));
  const root = unwrap(await doc.part('root', signal));
  const ops: PartOp[] = [
    { op: 'create', node: 'comp', kind: 'composition', parent: null, props: { [STRUCTURE_PATHS.format]: format as unknown as JsonValue } },
    ...pages.map(
      (p): PartOp => ({
        op: 'create',
        node: p.id,
        kind: 'page',
        parent: 'comp',
        props: {
          ...(p.name === undefined ? {} : { name: p.name }),
          ...(p.size === undefined ? {} : { [STRUCTURE_PATHS.pageSize]: [...p.size] }),
          ...(p.canvas === undefined ? {} : { [STRUCTURE_PATHS.pageCanvas]: [...p.canvas] }),
        },
      }),
    ),
    ...loose.map((l): PartOp => ({ op: 'create', node: l.id, kind: 'shape', parent: 'comp', props: { [STRUCTURE_PATHS.x]: l.box[0], [STRUCTURE_PATHS.y]: l.box[1], [STRUCTURE_PATHS.w]: l.box[2], [STRUCTURE_PATHS.h]: l.box[3] } })),
  ];
  unwrap(doc.commit({ actor: { kind: 'human', id: priya.id }, label: 'Seed' }, { root: ops }));
  return { doc, root };
}
