// @vitest-environment node
import { createScope } from '@staticflux/core';
import type { Box } from '@staticflux/document/spatial-index';
import type { NodeId, PartOp } from '@staticflux/document/v2';
import type { AccessibleNode } from '@staticflux/surface';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { P } from '../elements/components.js';
import { elementBounds, isElement } from '../elements/layout.js';
import { authoringBuilt, loadGeometry, shape, unwrap } from '../elements/testing/fixtures.js';
import { RP } from '../repeat/components.js';
import { createRepeatFixture } from '../repeat/testing/fixtures.js';
import { createElementIndex, type ToolContext } from '../tools/hit-test.js';
import { createToolFixture } from '../tools/testing/fixtures.js';
import { createViewState } from '../tools/view-state.js';
import { a11yRoleOf, ELEMENT_A11Y_ROLES, SEMANTIC_A11Y_ROLES } from './roles.js';
import { CanvasProjectionLifecycle, createCanvasProjector, focusTargetOf, hasOwnBounds, type ProjectionInput, projectCanvas, visibleRegion } from './projection.js';

const fill = [{ paint: '#ff5c39' }];
const sq = (id: string, x: number, y: number, extra: Record<string, unknown> = {}, parent = 'p1', kind = 'shape'): PartOp =>
  shape(id, { [P.x]: x, [P.y]: y, [P.w]: 50, [P.h]: 50, [P.fills]: fill, ...extra }, parent, kind);

const flat = (nodes: readonly AccessibleNode[]): AccessibleNode[] => nodes.flatMap((n) => [n, ...flat(n.children ?? [])]);
const byId = (nodes: readonly AccessibleNode[], id: string): AccessibleNode | undefined => flat(nodes).find((n) => n.id === id);

describe('roles (data, no Wasm)', () => {
  it('maps kinds, shapes, repeat kinds and semantic roles from tables', () => {
    expect(a11yRoleOf('shape', 'rect')).toEqual({ role: 'img', roleDescription: 'rectangle' });
    expect(a11yRoleOf('shape', 'nope')).toEqual({ role: 'img', roleDescription: 'shape' });
    expect(a11yRoleOf('shape')).toEqual({ role: 'img', roleDescription: 'rectangle' });
    expect(a11yRoleOf('group', 'rect')).toEqual({ role: 'group', roleDescription: 'group' });
    expect(a11yRoleOf('group', undefined, undefined, 'radial')).toEqual({ role: 'group', roleDescription: 'radial repeat' });
    expect(a11yRoleOf('text', undefined, 'headline')).toEqual({ role: 'heading', roleDescription: 'heading', level: 1 });
    expect(a11yRoleOf('text', undefined, 'body')).toEqual(ELEMENT_A11Y_ROLES['text']);
    expect(a11yRoleOf('mystery')).toEqual({ role: 'group', roleDescription: 'element' });
    // Only name-allowing roles: never `paragraph` (WAI-ARIA prohibits a name on it).
    for (const r of [...Object.values(ELEMENT_A11Y_ROLES), ...Object.values(SEMANTIC_A11Y_ROLES)]) expect(['group', 'img', 'heading']).toContain(r.role);
    expect(CanvasProjectionLifecycle.id).toBe('instaflow/a11y-projection');
  });

  it('computes the visible region with the margin', () => {
    expect(visibleRegion({ camera: { tx: -100, ty: -20, zoom: 2 }, viewport: { width: 200, height: 100 } }, 0)).toEqual({ minX: 50, minY: 10, maxX: 150, maxY: 60 });
    expect(visibleRegion({ camera: { tx: 0, ty: 0, zoom: 1 }, viewport: { width: 200, height: 100 } }, 0.5)).toEqual({ minX: -100, minY: -50, maxX: 300, maxY: 150 });
  });
});

describe.skipIf(!authoringBuilt)('canvas projection', () => {
  it('projects roles, names (name, text, role) and the document reading order; offscreen elements get no node', async () => {
    const f = await createToolFixture([
      sq('f', 0, 0, { name: 'Hero', [P.w]: 400, [P.h]: 300 }, 'p1', 'frame'),
      sq('a', 10, 10, { name: 'Button bg' }, 'f'),
      sq('b', 100, 10, { [P.shape]: 'ellipse' }, 'f'),
      sq('h', 300, 400, { role: 'headline' }),
      sq('far', 5000, 5000, { name: 'Far away' }),
    ]);
    const texts: Record<string, string> = { h: 'Big sale\nToday only' };
    const input: ProjectionInput = { ...f.tools, text: (n) => texts[n] };
    const snap = unwrap(projectCanvas(input));
    expect(snap.ids).toEqual(['f', 'a', 'b', 'h']);
    expect(snap.label).toBe('Canvas: p1');
    expect(snap.nodes.map((n) => n.id)).toEqual(['f', 'h']);
    expect(byId(snap.nodes, 'f')).toMatchObject({ role: 'group', roleDescription: 'frame', label: 'Hero', focusable: true, tabIndex: -1 });
    expect(byId(snap.nodes, 'a')).toMatchObject({ role: 'img', roleDescription: 'rectangle', label: 'Button bg', bounds: { x: 10, y: 10, width: 50, height: 50 } });
    expect(byId(snap.nodes, 'b')).toMatchObject({ roleDescription: 'ellipse', label: 'Ellipse' });
    expect(byId(snap.nodes, 'h')).toMatchObject({ role: 'heading', level: 1, label: 'Big sale', text: 'Big sale\nToday only' });
    expect(snap.focus).toBeUndefined();

    // Camera moves: the far element comes into view, the others leave (bounds in surface pixels).
    unwrap(f.view.setCamera({ tx: -4900, ty: -4900, zoom: 1 }));
    const moved = unwrap(projectCanvas(input));
    expect(moved.ids).toEqual(['far']);
    expect(byId(moved.nodes, 'far')?.bounds).toEqual({ x: 100, y: 100, width: 50, height: 50 });
    // A selected element stays projected out of view (the focus path is never cut).
    f.view.select(['a']);
    expect(unwrap(projectCanvas(input)).ids).toEqual(['f', 'a', 'far']);
  });

  it('puts the last selected element (or the entered container) on the focus path, alone in the tab order', async () => {
    const f = await createToolFixture([shape('g', { name: 'Card' }, 'p1', 'group'), sq('c', 0, 0, {}, 'g'), sq('d', 60, 0, {}, 'g'), sq('z', 200, 0, { [P.lockScope]: 'all' })]);
    f.view.select(['c', 'd']);
    let snap = unwrap(projectCanvas(f.tools));
    expect(snap.focus).toBe('d');
    expect(flat(snap.nodes).filter((n) => n.tabIndex === 0).map((n) => n.id)).toEqual(['d']);
    expect(byId(snap.nodes, 'z')).toMatchObject({ focusable: false, description: 'locked' });
    expect(byId(snap.nodes, 'z')?.tabIndex).toBeUndefined();
    f.view.clear();
    f.view.setContext('g');
    snap = unwrap(projectCanvas(f.tools));
    expect(snap.focus).toBe('g');
    expect(focusTargetOf({ root: 'p1', selection: [], context: 'p1' })).toBeUndefined();
  });

  it('announces repeat instances as "instance k of n" of their source and never projects derived nodes', async () => {
    const g = await loadGeometry();
    const f = await createRepeatFixture(g, [
      shape('r', { name: 'Petals', [RP.kind]: 'radial', [RP.count]: 4, [RP.radius]: 50 }, 'p1', 'group'),
      sq('a', 100, 100, { name: 'Petal' }, 'r'),
      sq('plain', 0, 0),
    ]);
    const ctx: ToolContext = { stage: f.view, geometry: g, kit: f.kit };
    const view = createViewState({ tab: 't', root: 'p1', viewport: { width: 1000, height: 800 } });
    const index = createElementIndex(ctx, 'p1');
    const input: ProjectionInput = { ctx, index, view, instances: f.view };
    let snap = unwrap(projectCanvas(input));
    expect(snap.ids).toEqual(['r', 'a', 'plain']);
    expect(byId(snap.nodes, 'r')).toMatchObject({ roleDescription: 'radial repeat', label: 'Petals', description: '4 instances' });
    view.select(['r~2^a']);
    snap = unwrap(projectCanvas(input));
    expect(snap.focus).toBe('a');
    expect(byId(snap.nodes, 'a')?.description).toBe('instance 3 of 4');
    expect(snap.ids.some((id) => id.includes('~'))).toBe(false);
  });

  it('stays equal to a brute-force reference under random edits and camera moves (fast-check)', { timeout: 60_000 }, async () => {
    /** Reference: every element (document order) whose ink meets the region, plus ancestors and the selection. */
    const reference = (ctx: ToolContext, region: Box, selection: readonly NodeId[]): NodeId[] => {
      const keep = new Set<NodeId>();
      const add = (n: NodeId): void => {
        for (let at: NodeId | null = n; at !== null && at !== 'p1'; at = ctx.stage.read(at)?.parent ?? null) keep.add(at);
      };
      const all: NodeId[] = [];
      const walk = (n: NodeId): void => {
        for (const c of ctx.stage.children(n)) {
          if (!isElement(ctx.stage.read(c)?.kind)) continue;
          all.push(c);
          walk(c);
        }
      };
      walk('p1');
      for (const n of all.filter((m) => hasOwnBounds(ctx, m))) {
        const b = elementBounds(ctx, n);
        if (b.ok && b.value.ink.minX <= region.maxX && b.value.ink.maxX >= region.minX && b.value.ink.minY <= region.maxY && b.value.ink.maxY >= region.minY) add(n);
      }
      for (const n of selection) add(n);
      return all.filter((n) => keep.has(n));
    };
    let serial = 0;
    const step = fc.oneof(
      fc.record({ kind: fc.constant('add' as const), x: fc.integer({ min: -3000, max: 3000 }), y: fc.integer({ min: -3000, max: 3000 }), group: fc.boolean() }),
      fc.record({ kind: fc.constant('move' as const), pick: fc.nat(), dx: fc.integer({ min: -2000, max: 2000 }), dy: fc.integer({ min: -2000, max: 2000 }) }),
      fc.record({ kind: fc.constant('delete' as const), pick: fc.nat() }),
      fc.record({ kind: fc.constant('camera' as const), tx: fc.integer({ min: -3000, max: 3000 }), ty: fc.integer({ min: -3000, max: 3000 }), zoom: fc.constantFrom(0.25, 0.5, 1, 2, 4) }),
      fc.record({ kind: fc.constant('select' as const), pick: fc.nat() }),
    );
    await fc.assert(
      fc.asyncProperty(fc.array(step, { minLength: 1, maxLength: 12 }), async (steps) => {
        const f = await createToolFixture([sq('seed', 0, 0)]);
        const ctx = f.ctx;
        const scope = createScope('projection-property');
        const projector = createCanvasProjector({ ...f.tools, scope, margin: 0.25, schedule: () => undefined });
        for (const s of steps) {
          const existing = [...reference(ctx, { minX: -1e9, minY: -1e9, maxX: 1e9, maxY: 1e9 }, [])];
          const picked = existing.length === 0 ? undefined : existing[('pick' in s ? s.pick : 0) % existing.length];
          if (s.kind === 'add') {
            serial += 1;
            const groups = existing.filter((n) => ctx.stage.read(n)?.kind === 'group');
            const parent = s.group && groups.length > 0 ? (groups[serial % groups.length] as NodeId) : 'p1';
            f.seed([serial % 3 === 0 ? shape(`n${serial}`, {}, parent, 'group') : sq(`n${serial}`, s.x, s.y, {}, parent)]);
            if (serial % 3 === 0) f.seed([sq(`n${serial}c`, s.x, s.y, {}, `n${serial}`)]);
          } else if (s.kind === 'move' && picked !== undefined) {
            f.seed([{ op: 'set', node: picked, path: P.x, value: Number(ctx.stage.value(picked, P.x) ?? 0) + s.dx }, { op: 'set', node: picked, path: P.y, value: Number(ctx.stage.value(picked, P.y) ?? 0) + s.dy }]);
          } else if (s.kind === 'delete' && picked !== undefined) {
            f.seed([{ op: 'delete', node: picked }]);
            // Prune like B3: whatever is no longer in the page tree (deleted, or under a deleted group) leaves the selection.
            const remaining = new Set(reference(ctx, { minX: -1e9, minY: -1e9, maxX: 1e9, maxY: 1e9 }, []));
            f.view.select(f.view.selection.filter((n) => remaining.has(n)));
          } else if (s.kind === 'camera') {
            unwrap(f.view.setCamera({ tx: s.tx, ty: s.ty, zoom: s.zoom }));
          } else if (s.kind === 'select' && picked !== undefined) {
            f.view.select([picked]);
          }
          const snap = unwrap(projector.flush());
          expect(projector.state).toBe('clean');
          expect(snap.ids).toEqual(reference(ctx, visibleRegion(f.view, 0.25), f.view.selection));
          expect(snap.focus).toBe(f.view.selection.at(-1));
        }
        await scope.dispose();
        expect(projector.state).toBe('disposed');
      }),
      { numRuns: 40 },
    );
  });

  it('coalesces bursts into one scheduled flush and fails clearly without a root or after dispose', async () => {
    const f = await createToolFixture([sq('a', 0, 0)]);
    const queue: (() => void)[] = [];
    const projector = createCanvasProjector({ ...f.tools, schedule: (fn) => queue.push(fn) });
    const seen: number[] = [];
    projector.onChange((s) => seen.push(s.ids.length));
    unwrap(projector.flush());
    f.view.select(['a']);
    unwrap(f.view.panBy(5, 0));
    f.seed([sq('b', 10, 10)]);
    expect(queue).toHaveLength(1);
    queue.shift()?.();
    expect(seen).toEqual([1, 2]);
    expect(projector.stats.flushes).toBe(2);
    expect(projector.snapshot()).toMatchObject({ ok: true });
    projector.dispose();
    const after = projector.flush();
    expect(!after.ok && after.error.code).toBe('IF-A11Y-002');
    const missing = projectCanvas({ ...f.tools, view: createViewState({ tab: 'x', root: 'nope' }) });
    expect(!missing.ok && missing.error.code).toBe('IF-A11Y-001');
  });

  it('does not announce hidden elements or anything inside them (B12, A-2)', async () => {
    const f = await createToolFixture([sq('a', 0, 0), sq('g', 0, 0, {}, 'p1', 'group'), sq('b', 100, 0, {}, 'g'), sq('c', 200, 0)]);
    expect(unwrap(projectCanvas(f.tools)).ids).toEqual(['a', 'g', 'b', 'c']);
    f.seed([
      { op: 'set', node: 'a', path: P.hidden, value: true },
      { op: 'set', node: 'g', path: P.hidden, value: true },
    ]);
    expect(unwrap(projectCanvas(f.tools)).ids).toEqual(['c']);
  });
});
