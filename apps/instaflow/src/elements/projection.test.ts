// @vitest-environment node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRenderProjector, createSceneStore } from '@staticflux/document/render-projection';
import { describe, expect, it } from 'vitest';
import { createSceneWriter } from '../render/scene-ir.js';
import { P } from './components.js';
import { createElementRenderSource, createResourceTable, type ElementField, ElementProjection, lookOf, MASK_INVERT_BIT } from './projection.js';
import { resolveElement } from './resolve.js';
import { createElementSceneEncoder, createSceneResources, sceneIdOf } from './scene.js';
import { authoringBuilt, createFixture, loadGeometry, shape } from './testing/fixtures.js';
import { checkerPixels, elementSceneOps } from './testing/scene-fixture.js';

const FIXTURES = new URL('./__fixtures__/', import.meta.url);
const update = ['1', 'true'].includes(String(process.env['SF_UPDATE_GOLDENS']).toLowerCase());

function snapshot(name: string, bytes: Uint8Array): void {
  const url = new URL(name, FIXTURES);
  if (update || !existsSync(url)) {
    mkdirSync(FIXTURES, { recursive: true });
    writeFileSync(url, bytes);
    return;
  }
  expect(Buffer.from(bytes).equals(readFileSync(url)), `${name} changed: run SF_UPDATE_GOLDENS=1 pnpm vitest run apps/instaflow/src/elements/projection.test.ts`).toBe(true);
}

describe('resource table', () => {
  it('interns, ref-counts, batches defines before drops and snapshots', () => {
    const t = createResourceTable();
    const look = { kind: 'path', value: { verbs: [0, 1, 4], points: [0, 0, 1, 1] } } as const;
    const a = t.intern(look);
    expect(t.intern(look)).toBe(a);
    const b = t.intern({ kind: 'path', value: { verbs: [], points: [] } });
    const first = JSON.parse(new TextDecoder().decode(t.take()));
    expect(first.define.map((d: unknown[]) => d[0])).toEqual([a, b]);
    expect(t.take()).toBeUndefined();
    t.release(a);
    expect(t.take()).toBeUndefined(); // still one user
    t.release(a);
    t.release(b);
    expect(JSON.parse(new TextDecoder().decode(t.take())).drop).toEqual([a, b]);
    const c = t.intern(look);
    t.release(c); // defined and dropped before a take: never sent
    expect(t.take()).toBeUndefined();
    expect(t.size).toBe(0);
    const d = t.intern(look);
    expect(JSON.parse(new TextDecoder().decode(t.snapshot())).define).toHaveLength(1);
    const r = createSceneResources();
    expect(r.apply(t.snapshot())).toBe(true);
    expect(r.path(d)).toEqual(look.value);
    expect(r.apply(new TextEncoder().encode('nope'))).toBe(false);
    expect(r.apply(new TextEncoder().encode('{"format":"other"}'))).toBe(false);
    r.clear();
    expect(r.size).toBe(0);
  });
});

describe.skipIf(!authoringBuilt)('element render projection → scene IR', () => {
  it('projects the composed stage, encodes scene IR, and the bytes match the committed snapshot', async () => {
    const g = await loadGeometry();
    const f = await createFixture(elementSceneOps());
    const source = createElementRenderSource({ stage: f.stage, geometry: g, kit: f.kit, root: 'p1' });
    const projector = createRenderProjector(ElementProjection, source);
    const payload = projector.snapshot();
    // boolean operands are not drawn on their own; the masked group's children are
    expect(projector.slotOf('b1')).toBeUndefined();
    expect(projector.slotOf('bool')).toBeDefined();
    expect(projector.slotOf('m')).toBeDefined();
    expect(source.issues('card')).toEqual([]);
    const store = createSceneStore(ElementProjection);
    const resources = createSceneResources();
    expect(resources.apply(source.takeResources() as Uint8Array)).toBe(true);
    expect(store.apply(payload).ok).toBe(true);
    const encoder = createElementSceneEncoder({ images: (asset, variant) => (asset === 'as_photo' && variant === 'rgba' ? 1 : undefined) });
    const ir = encoder.encode(store, resources, { full: true }) as Uint8Array;
    snapshot('elements-images.sfir', createSceneWriter().image(1, 16, 16, checkerPixels()).finish());
    snapshot('elements-scene.sfir', ir);
    expect(encoder.encode(store, resources)).toBeUndefined(); // nothing changed
    const maskSlot = projector.slotOf('m') as number;
    expect((store.column('mask' as ElementField)[maskSlot] as number) & ~MASK_INVERT_BIT).toBe(3);
    expect(encoder.sceneId(maskSlot)).toBe(sceneIdOf(maskSlot));
    source.dispose();
  });

  it('a move re-encodes only the moved element; a boolean operand edit re-derives its group; deletes remove', async () => {
    const g = await loadGeometry();
    const f = await createFixture([
      shape('a', { [P.w]: 10, [P.h]: 10, [P.fills]: [{ paint: '#f00' }] }),
      shape('b', { [P.x]: 20, [P.w]: 10, [P.h]: 10, [P.fills]: [{ paint: '#f00' }] }),
      shape('bool', { [P.boolean]: 'union' }, 'p1', 'group'),
      shape('o1', { [P.w]: 10, [P.h]: 10 }, 'bool'),
    ]);
    const source = createElementRenderSource({ stage: f.stage, geometry: g, kit: f.kit, root: 'p1', orderOf: (id) => f.part.node(id)?.order });
    const projector = createRenderProjector(ElementProjection, source);
    const store = createSceneStore(ElementProjection);
    const resources = createSceneResources();
    const encoder = createElementSceneEncoder();
    store.apply(projector.snapshot());
    resources.apply(source.takeResources() as Uint8Array);
    encoder.encode(store, resources, { full: true });
    const step = (): { change: ReturnType<typeof source.changes>; ir: Uint8Array | undefined } => {
      const change = source.changes();
      const res = source.takeResources();
      if (res !== undefined) resources.apply(res);
      const payload = change === undefined ? undefined : projector.project(change);
      if (payload !== undefined) store.apply(payload);
      return { change, ir: encoder.encode(store, resources) };
    };
    expect(step().change).toBeUndefined();
    f.seed([{ op: 'set', node: 'a', path: P.x, value: 5 }]);
    const moved = step();
    expect(moved.change?.updated.get('a')).toEqual(['render.e']);
    expect([...(moved.change?.updated.keys() ?? [])]).toEqual(['a']);
    expect(new DataView((moved.ir as Uint8Array).buffer).getUint32(8, true)).toBe(1); // one upsert
    f.seed([{ op: 'set', node: 'o1', path: P.w, value: 30 }]);
    const derived = step();
    expect([...(derived.change?.updated.keys() ?? [])]).toContain('bool');
    f.seed([{ op: 'delete', node: 'b' }]);
    const removed = step();
    expect(removed.change?.deleted).toEqual(['b']);
    f.seed([{ op: 'set', node: 'bool', path: P.boolean, value: null }]);
    const plain = step();
    expect(plain.change?.created).toEqual(['o1']); // no longer an operand: drawn on its own
    expect(lookOf(resolveElement(f.stage, 'a', f.kit)!).fills).toHaveLength(1);
    source.dispose();
  });
});
