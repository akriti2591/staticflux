// @vitest-environment node
// #69: Flatten (Mod+E) bakes a group, a nested group, a repeat (grid, radial, mirror; the owner's repeat of an
// Intersect) and a mask group into one vector path: its page bounds are the container's visible bounds, it takes the
// topmost visible child's appearance, hidden children are left out, the container (a repeat's source too) goes, one
// undo step restores everything, and the path resizes like any path (#75). The capability is offered for these kinds
// in the HUD More menu, the context menu and on Mod+E.
import { ok } from '@staticflux/core';
import type { Box } from '@staticflux/document/spatial-index';
import type { NodeId, PartOp } from '@staticflux/document/v2';
import { describe, expect, it } from 'vitest';
import { booleanGroup, commitEdit, group, useAsMask } from '../elements/actions.js';
import { ELEMENT_ACTIONS, elementActionId, type ElementEditEnv, runElementAction, selectionFacts } from '../elements/capabilities.js';
import { P } from '../elements/components.js';
import { elementBounds, intersectBox, unionBox } from '../elements/layout.js';
import { commitRepeatEdit, makeRepeat, newRepeatParams } from '../repeat/actions.js';
import type { RepeatKind } from '../repeat/components.js';
import { REPEAT_ACTIONS, repeatActionId, repeatSelectionFacts } from '../repeat/capabilities.js';
import { contextMenuGroups } from '../studio/context-menu.js';
import { captureTransform, resizedBounds, resizeValues, valuesToOps } from '../tools/transform.js';
import { type SceneReader, selectionSummary } from './scene-summary.js';
import { STUDIO_KEY_COMMANDS, keyCommandInput } from './studio-commands.js';
import { authoringBuilt, createStudioFixture, person, unwrap } from './test-helpers.js';

const WASM = { timeout: 60_000 };
const RED = [{ paint: '#ff0000' }];
const BLUE = [{ paint: '#0000ff' }];
const GREEN = [{ paint: '#00ff00' }];
const create = (node: string, props: Record<string, unknown>, kind = 'shape', parent = 'p1'): PartOp => ({ op: 'create', node, kind, parent, props }) as PartOp;
const rect = (node: string, x: number, y: number, w: number, h: number, fills: unknown = RED, extra: Record<string, unknown> = {}): PartOp =>
  create(node, { [P.x]: x, [P.y]: y, [P.w]: w, [P.h]: h, [P.fills]: fills, ...extra });
const circle = (node: string, x: number, y: number, d: number, fills: unknown = RED): PartOp => rect(node, x, y, d, d, fills, { [P.shape]: 'ellipse' });

type Fixture = Awaited<ReturnType<typeof createStudioFixture>>;

/** The id an action created (its first create op). */
const created = (ops: readonly PartOp[]): NodeId => (ops.find((op) => op.op === 'create') as { node: NodeId }).node;

function seed(f: Fixture, ops: readonly PartOp[]): void {
  unwrap(commitEdit(f.document.target('p1'), person, 'Seed', ok(ops)));
}
function wrap(f: Fixture, make: (ctx: ReturnType<Fixture['document']['context']>) => ReturnType<typeof group>): NodeId {
  const ops = unwrap(make(f.document.context()));
  unwrap(commitEdit(f.document.target('p1'), person, 'Wrap', ok(ops)));
  return created(ops);
}
function repeat(f: Fixture, source: NodeId, kind: RepeatKind): NodeId {
  const ops = unwrap(makeRepeat(f.document.context(), [source], newRepeatParams(kind)));
  unwrap(commitRepeatEdit(f.document.target('p1'), person, 'Repeat', ok(ops)));
  return created(ops);
}

/** Every stored node of the page with its props (what undo must restore). */
function snapshot(f: Fixture): unknown {
  const part = f.document.part('p1');
  const out: [NodeId, unknown][] = [];
  const walk = (parent: NodeId): void => {
    for (const child of f.document.base.children(parent)) {
      out.push([child, part?.node(child)?.props]);
      walk(child);
    }
  };
  walk('p1');
  return out;
}

function expectBox(actual: Box, expected: Box, digits: number, label: string): void {
  for (const k of ['minX', 'minY', 'maxX', 'maxY'] as const) expect(actual[k], `${label}: ${k}`).toBeCloseTo(expected[k], digits);
}

const env = (f: Fixture): ElementEditEnv => ({ context: () => f.document.context(), target: () => f.document.target('p1'), actorFor: () => ok(person) });

/** The selection summary as the editor builds it (`applicable` as in `workers/editor-module.ts`). */
function summaryOf(f: Fixture, node: NodeId): ReturnType<typeof selectionSummary> {
  const reader: SceneReader = {
    stage: f.document.view,
    kit: f.document.kit,
    text: () => undefined,
    repeat: (n) => {
      const params = f.document.view.params(n);
      return params === undefined ? undefined : { kind: params.kind, count: f.document.view.children(n).length };
    },
    applicable: (nodes) => [
      ...ELEMENT_ACTIONS.filter((a) => a.applies(selectionFacts(f.document.context(), nodes))).map((a) => elementActionId(a.name)),
      ...REPEAT_ACTIONS.filter((a) => a.applies(repeatSelectionFacts(f.document.context(), nodes))).map((a) => repeatActionId(a.name)),
    ],
  };
  return selectionSummary(reader, [node]);
}

const FLATTEN_KEY = STUDIO_KEY_COMMANDS.find((k) => k.def.keys.includes('Mod+E'));

/**
 * Flatten `node` the way Mod+E does (the key's capability with the key's input) and check the result: one vector in
 * the container's place whose page bounds are `expected` (default: the container's bounds before), with `fills`; the
 * container and its children are gone; one undo step restores every stored value. Returns the vector.
 */
function flattenAndCheck(f: Fixture, node: NodeId, fills: unknown, label: string, options: { readonly expected?: Box; readonly digits?: number } = {}): NodeId {
  const ctx = f.document.context();
  const expected = options.expected ?? unwrap(elementBounds(ctx, node)).geometry;
  const parent = f.document.view.read(node)?.parent as NodeId;
  const siblings = f.document.base.children(parent).length;
  const stored = snapshot(f);
  const depth = f.document.undo.history(person.id).undo.length;
  const inside: NodeId[] = [];
  const walk = (n: NodeId): void => f.document.base.children(n).forEach((c) => (inside.push(c), walk(c)));
  walk(node);
  expect(FLATTEN_KEY?.capability, label).toBe('instaflow/flatten');
  const input = keyCommandInput(FLATTEN_KEY as NonNullable<typeof FLATTEN_KEY>, [node]) as { nodes: string[] };
  unwrap(runElementAction(env(f), 'flatten', input, person));
  expect(f.document.undo.history(person.id).undo.length, `${label}: one undo step`).toBe(depth + 1);
  expect(f.document.base.read(node), `${label}: the container is gone`).toBeUndefined();
  for (const n of inside) expect(f.document.part('p1')?.node(n), `${label}: ${n} (inside) is gone`).toBeUndefined();
  const kids = f.document.base.children(parent);
  expect(kids.length, `${label}: one path in its place`).toBe(siblings);
  const vector = kids.find((n) => f.document.base.read(n)?.kind === 'vector' && !(stored as [NodeId][]).some(([id]) => id === n)) as NodeId;
  expect(vector, label).toBeDefined();
  expect(f.document.base.children(vector), `${label}: a path has no children`).toEqual([]);
  expectBox(unwrap(elementBounds(f.document.context(), vector)).geometry, expected, options.digits ?? 4, label);
  expect(f.document.view.value(vector, P.fills), `${label}: the topmost child's fill`).toEqual(fills);
  return vector;
}

async function undoAndCheck(f: Fixture, stored: unknown, label: string): Promise<void> {
  unwrap(await f.document.undo.undo(person, f.signal));
  expect(snapshot(f), `${label}: undo restores everything`).toEqual(stored);
}

describe.skipIf(!authoringBuilt)('Flatten bakes containers into one path (#69)', () => {
  it('a group of two shapes: one path over both, the top shape’s fill, one undo step', WASM, async () => {
    const f = await createStudioFixture();
    seed(f, [rect('a', 100, 100, 200, 100, RED), circle('b', 250, 150, 120, BLUE)]);
    const g = wrap(f, (ctx) => group(ctx, ['a', 'b']));
    const stored = snapshot(f);
    // A circle's union is exact to the Wasm's curve tolerance.
    flattenAndCheck(f, g, BLUE, 'group', { expected: { minX: 100, minY: 100, maxX: 370, maxY: 270 }, digits: 1 });
    await undoAndCheck(f, stored, 'group');
  });

  it('a nested group, rotated: the innermost topmost shape’s appearance (fill, stroke, opacity), the union of all', WASM, async () => {
    const f = await createStudioFixture();
    const stroke = [{ paint: '#111111', width: 4 }];
    seed(f, [rect('a', 100, 100, 100, 100, RED, { [P.opacity]: 0.3 }), rect('b', 180, 180, 80, 80, BLUE), rect('c', 240, 120, 60, 200, GREEN, { [P.strokes]: stroke, [P.opacity]: 0.5 })]);
    const inner = wrap(f, (ctx) => group(ctx, ['b', 'c']));
    const outer = wrap(f, (ctx) => group(ctx, ['a', inner]));
    seed(f, [{ op: 'set', node: outer, path: P.rotation, value: 20 }]);
    const stored = snapshot(f);
    const vector = flattenAndCheck(f, outer, GREEN, 'nested group');
    expect(f.document.view.value(vector, P.strokes)).toEqual(stroke);
    expect(f.document.view.value(vector, P.opacity)).toBe(0.5);
    await undoAndCheck(f, stored, 'nested group');
  });

  for (const kind of ['grid', 'radial', 'mirror'] as const) {
    it(`a ${kind} repeat: the source and every copy, each in its place; the source goes too`, WASM, async () => {
      const f = await createStudioFixture();
      seed(f, [rect('r', 200, 300, 100, 50, BLUE)]);
      const rep = repeat(f, 'r', kind);
      expect(f.document.view.children(rep).length, kind).toBeGreaterThan(1);
      const stored = snapshot(f);
      flattenAndCheck(f, rep, BLUE, kind);
      // The part, not the composed stage: it still answers for a deleted container's descendants (noted in #69).
      expect(f.document.part('p1')?.node('r'), `${kind}: the source is consumed`).toBeUndefined();
      await undoAndCheck(f, stored, kind);
      expect(f.document.view.children(rep).length, `${kind}: the live repeat is back`).toBeGreaterThan(1);
    });
  }

  it('the owner’s case: a circle with a smaller circle inside, Intersect, Grid repeat', WASM, async () => {
    const f = await createStudioFixture();
    seed(f, [circle('outer', 200, 300, 200, RED), circle('inner', 250, 350, 100, BLUE)]);
    const intersect = wrap(f, (ctx) => booleanGroup(ctx, ['outer', 'inner'], 'intersect'));
    const rep = repeat(f, intersect, 'grid');
    const stored = snapshot(f);
    // The boolean takes the bottom operand's style; Flatten keeps the boolean's (the repeat source's topmost child).
    const fills = f.document.view.value(intersect, P.fills);
    flattenAndCheck(f, rep, fills, 'repeat of an intersect', { digits: 1 });
    for (const n of [intersect, 'outer', 'inner']) expect(f.document.part('p1')?.node(n), n).toBeUndefined();
    await undoAndCheck(f, stored, 'repeat of an intersect');
  });

  it('a mask group: the mask outline ∩ the union of what it masks; the mask itself is not drawn', WASM, async () => {
    const f = await createStudioFixture();
    seed(f, [rect('m', 0, 0, 100, 100, GREEN), rect('a', 50, 50, 100, 100, RED), rect('b', -20, 20, 60, 40, BLUE)]);
    const masked = wrap(f, (ctx) => useAsMask(ctx, ['m', 'a', 'b'], 'clip'));
    expect(summaryOf(f, masked).kind).toBe('mask');
    const stored = snapshot(f);
    const content = unionBox(unwrap(elementBounds(f.document.context(), 'a')).geometry, unwrap(elementBounds(f.document.context(), 'b')).geometry);
    const expected = intersectBox(unwrap(elementBounds(f.document.context(), 'm')).geometry, content);
    expect(expected).toEqual({ minX: 0, minY: 20, maxX: 100, maxY: 100 });
    flattenAndCheck(f, masked, BLUE, 'mask', { expected });
    await undoAndCheck(f, stored, 'mask');
  });

  it('hidden children are left out (of a group, and of a repeat’s source); the fill is the topmost visible one’s', WASM, async () => {
    const f = await createStudioFixture();
    seed(f, [rect('a', 100, 100, 100, 100, RED), rect('b', 400, 400, 100, 100, BLUE, { [P.hidden]: true })]);
    const g = wrap(f, (ctx) => group(ctx, ['a', 'b']));
    flattenAndCheck(f, g, RED, 'hidden in a group', { expected: { minX: 100, minY: 100, maxX: 200, maxY: 200 } });

    const h = await createStudioFixture();
    seed(h, [rect('a', 100, 100, 100, 100, RED), rect('b', 150, 150, 300, 300, BLUE, { [P.hidden]: true })]);
    const source = wrap(h, (ctx) => group(ctx, ['a', 'b']));
    const rep = repeat(h, source, 'grid');
    const visible = unwrap(elementBounds(h.document.context(), rep)).geometry;
    flattenAndCheck(h, rep, RED, 'hidden in a repeat source', { expected: visible });
  });

  it('the flattened path resizes like any path: it follows its box (#75)', WASM, async () => {
    const f = await createStudioFixture();
    seed(f, [rect('r', 200, 300, 100, 50, BLUE)]);
    const rep = repeat(f, 'r', 'grid');
    const vector = flattenAndCheck(f, rep, BLUE, 'grid for resize');
    for (const g of [{ handle: 'se', dx: 60, dy: 40 }, { handle: 'nw', dx: -30, dy: 20 }] as const) {
      const from = unwrap(elementBounds(f.document.context(), vector)).geometry;
      const s = unwrap(captureTransform(f.document.context(), [vector]));
      unwrap(commitEdit(f.document.target('p1'), person, 'Resize', ok(valuesToOps(s, resizeValues(s, g.handle, g.dx, g.dy, {})))));
      expectBox(unwrap(elementBounds(f.document.context(), vector)).geometry, resizedBounds(from, g.handle, g.dx, g.dy), 6, `resize ${g.handle}`);
      // The box hugs the path (#54): its local bounds are 0…w × 0…h.
      const geometry = f.document.geometry;
      const local = unwrap(geometry.bounds(unwrap(geometry.parsePath(f.document.view.value(vector, P.path) as string)), [1, 0, 0, 1, 0, 0]));
      expectBox(local, { minX: 0, minY: 0, maxX: f.document.view.value(vector, P.w) as number, maxY: f.document.view.value(vector, P.h) as number }, 6, `box ${g.handle}`);
    }
  });

  it('is offered for a group, a repeat (also of an Intersect) and a mask: HUD More, the context menu and Mod+E', WASM, async () => {
    const f = await createStudioFixture();
    seed(f, [rect('a', 0, 0, 100, 100), rect('b', 200, 0, 100, 100), rect('c', 0, 200, 100, 100), circle('o', 400, 400, 200), circle('i', 450, 450, 100), rect('m', 600, 0, 100, 100), rect('d', 650, 50, 100, 100)]);
    const g = wrap(f, (ctx) => group(ctx, ['a', 'b']));
    const rep = repeat(f, 'c', 'radial');
    const intersect = wrap(f, (ctx) => booleanGroup(ctx, ['o', 'i'], 'intersect'));
    const repOfBoolean = repeat(f, intersect, 'grid');
    const masked = wrap(f, (ctx) => useAsMask(ctx, ['m', 'd'], 'clip'));
    const cases: readonly (readonly [NodeId, string])[] = [
      [g, 'group'],
      [rep, 'repeat'],
      [repOfBoolean, 'repeat'],
      [masked, 'mask'],
    ];
    for (const [node, kind] of cases) {
      const s = summaryOf(f, node);
      expect(s.kind, node).toBe(kind);
      // HUD More lists the applicable capabilities the pill does not show (hud.ts moreMenuGroups); Flatten is in More.
      expect(s.actions, `${kind}: applicable`).toContain('instaflow/flatten');
      const menu = contextMenuGroups({ kind: 'selection', summary: s }, { canPaste: false, styleCopied: false, pages: 1 }).flat();
      expect(menu.map((e) => e.value), `${kind}: context menu`).toContain('cap:instaflow/flatten');
      expect(menu.find((e) => e.value === 'cap:instaflow/flatten')?.shortcut).toBe('Mod+E');
    }
    expect(FLATTEN_KEY?.capability).toBe('instaflow/flatten');
    // Mod+E on the owner's case runs (the full checks are above).
    unwrap(runElementAction(env(f), 'flatten', keyCommandInput(FLATTEN_KEY as NonNullable<typeof FLATTEN_KEY>, [repOfBoolean]) as { nodes: string[] }, person));
    expect(f.document.base.read(repOfBoolean)).toBeUndefined();
  });

  it('an empty or all-hidden group is not flattened (nothing visible); nothing changes', WASM, async () => {
    const f = await createStudioFixture();
    seed(f, [rect('a', 0, 0, 100, 100, RED, { [P.hidden]: true })]);
    const g = wrap(f, (ctx) => group(ctx, ['a']));
    const stored = snapshot(f);
    const r = runElementAction(env(f), 'flatten', { nodes: [g] }, person);
    expect(r.ok).toBe(false);
    expect(snapshot(f)).toEqual(stored);
  });
});
