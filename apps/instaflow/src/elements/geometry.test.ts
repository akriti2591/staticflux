// @vitest-environment node
import type { Result } from '@staticflux/core';
import { describe, expect, it } from 'vitest';
import { createGeometry, effectSpec, GEOMETRY_MEMO_LIMIT, type GeometryWasm, keyNumber, loadAuthoringModule, type PathData, strokeSpec, type WasmPath } from './geometry.js';
import type { Affine, ResolvedStroke } from './resolve.js';
import { authoringBuilt, loadGeometry } from './testing/fixtures.js';

const box = { x: 0, y: 0, w: 100, h: 50, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5, flipX: false, flipY: false, skewX: 0 };
const stroke = (over: Partial<ResolvedStroke> = {}): ResolvedStroke => ({ paint: { kind: 'none' }, width: 4, align: 'center', join: 'miter', cap: 'butt', miter: 4, dash: [], dashOffset: 0, opacity: 1, blend: 'normal', ...over });
const I = [1, 0, 0, 1, 0, 0] as const;

describe('geometry specs (no Wasm)', () => {
  it('flattens strokes and effects for the Wasm ABI', () => {
    expect([...strokeSpec(undefined)]).toEqual([]);
    expect([...strokeSpec(stroke({ align: 'outside', join: 'round', cap: 'square', dash: [3, 1], dashOffset: 2 }))]).toEqual([4, 2, 1, 2, 4, 2, 3, 1]);
    expect([...strokeSpec(stroke({ sides: [1, 6, 2, 3] }))][0]).toBe(6);
    expect([...effectSpec([{ kind: 'drop-shadow', x: 1, y: 2, blur: 3, spread: 4, color: [0, 0, 0, 255] }, { kind: 'layer-blur', radius: 5 }, { kind: 'background-blur', radius: 9 }])]).toEqual([1, 1, 2, 3, 4, 0, 3, 0, 0, 5, 0, 0]);
  });

  it('turns thrown Wasm errors into IF-EL-005 values', () => {
    const fake = { parse_path: () => { throw 'invalid SVG path data'; } } as unknown as GeometryWasm;
    const r = createGeometry(fake).parsePath('M0 Q');
    expect(!r.ok && r.error.code).toBe('IF-EL-005');
    expect(createGeometry(fake).parsePath('  ').ok).toBe(true);
    expect(createGeometry(fake).toSvg({ verbs: new Uint8Array(0), points: new Float64Array(0) })).toBe('');
  });

  it('the loader reports a missing manifest, a missing artifact and a version mismatch (IF-EL-006)', async () => {
    const missing = await loadAuthoringModule({ manifestUrl: 'file:///m.json', fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }) });
    expect(!missing.ok && missing.error.code).toBe('IF-EL-006');
    const empty = await loadAuthoringModule({ manifestUrl: 'file:///m.json', fetch: async () => ({ ok: true, status: 200, json: async () => ({ format: 'sf-wasm-manifest/1', artifacts: [] }) }) });
    expect(!empty.ok && empty.error.code).toBe('IF-EL-006');
    const old = await loadAuthoringModule({
      manifestUrl: 'file:///m.json',
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ format: 'sf-wasm-manifest/1', artifacts: [{ crate: 'authoring', wasm: 'a.wasm', js: 'a.js' }] }) }),
      importModule: async () => ({ default: async () => undefined, geometry_version: () => 99 }),
    });
    expect(!old.ok && old.error.message).toContain('99');
  });
});

describe('derived geometry is memoized by its inputs (#68, no Wasm)', () => {
  /** A fake module: every export returns a fresh path and counts its calls. */
  const fakeWasm = () => {
    const calls: Record<string, number> = {};
    const path = (n: number): WasmPath => ({ verbs: Uint8Array.of(0, 1, 4), points: Float64Array.of(0, 0, n, n), svg: () => '', free: () => undefined });
    const count = (name: string, n = 1): WasmPath => {
      calls[name] = (calls[name] ?? 0) + 1;
      return path(n);
    };
    const wasm = {
      shape_outline: (_k: number, w: number) => count('shape_outline', w),
      parse_path: () => count('parse_path'),
      round_path: () => count('round_path'),
      transform_path: () => count('transform_path'),
      boolean_op: () => count('boolean_op'),
      outline_stroke: () => count('outline_stroke'),
    } as unknown as GeometryWasm;
    return { wasm, calls };
  };
  const ellipse = { geometry: { kind: 'ellipse' as const }, box };
  const unwrapPath = (r: Result<PathData>): PathData => {
    if (!r.ok) throw r.error;
    return r.value;
  };

  it('the same outline inputs return the same path without calling the module; other inputs derive', () => {
    const { wasm, calls } = fakeWasm();
    const g = createGeometry(wasm);
    const a = unwrapPath(g.outline(ellipse));
    expect(unwrapPath(g.outline({ geometry: { kind: 'ellipse' }, box: { ...box, x: 300, rotation: 45 } }))).toBe(a); // transform only
    expect(calls['shape_outline']).toBe(1);
    expect(unwrapPath(g.outline({ ...ellipse, box: { ...box, w: 120 } }))).not.toBe(a); // the size is an input
    expect(unwrapPath(g.outline({ geometry: { kind: 'rect', radii: [0, 0, 0, 0], smoothing: 0 }, box }))).not.toBe(a);
    expect(calls['shape_outline']).toBe(3);
    const d = { kind: 'path' as const, d: 'M0 0 L1 1', evenOdd: false, radii: [2], smoothing: 0 };
    unwrapPath(g.outline({ geometry: d, box }));
    unwrapPath(g.outline({ geometry: d, box }));
    unwrapPath(g.outline({ geometry: { ...d, d: 'M0 0 L2 2' }, box }));
    expect([calls['parse_path'], calls['round_path']]).toEqual([2, 2]);
  });

  it('a boolean is keyed by its op, its operand paths, their transforms and fill rules', () => {
    const { wasm, calls } = fakeWasm();
    const g = createGeometry(wasm);
    const a = unwrapPath(g.outline(ellipse));
    const b = unwrapPath(g.outline({ ...ellipse, box: { ...box, w: 50 } }));
    const operands = (t: Affine = I, evenOdd = false) => [{ path: a, transform: I }, { path: b, transform: t, evenOdd }];
    const first = unwrapPath(g.boolean('intersect', operands()));
    expect(unwrapPath(g.boolean('intersect', operands()))).toBe(first);
    expect(calls['boolean_op']).toBe(1);
    // A nested boolean of a memoized result hits as well (a repeat's copies, booleans of booleans).
    const nested = unwrapPath(g.boolean('union', [{ path: first, transform: I }, { path: a, transform: [1, 0, 0, 1, 5, 0] }]));
    expect(unwrapPath(g.boolean('union', [{ path: first, transform: I }, { path: a, transform: [1, 0, 0, 1, 5, 0] }]))).toBe(nested);
    expect(calls['boolean_op']).toBe(2);
    g.boolean('union', operands());
    g.boolean('intersect', operands([1, 0, 0, 1, 10, 0]));
    g.boolean('intersect', operands(I, true));
    // An operand with other content is another path object (an edited operand): derived again.
    g.boolean('intersect', [{ path: a, transform: I }, { path: unwrapPath(g.outline({ ...ellipse, box: { ...box, w: 60 } })), transform: I }]);
    expect(calls['boolean_op']).toBe(6);
  });

  it('keys ignore rounding noise below 12 significant digits (a rotation preview re-places operands)', () => {
    expect([keyNumber(100.00000000000006), keyNumber(149.99999999999997), keyNumber(-0), keyNumber(0.1 + 0.2)]).toEqual([100, 150, 0, 0.3]);
    expect([keyNumber(100.001), keyNumber(1e-15), keyNumber(2e-9)]).toEqual([100.001, 0, 2e-9]);
    expect(keyNumber(Number.NaN)).toBeNaN();
    const { wasm, calls } = fakeWasm();
    const g = createGeometry(wasm);
    const a = unwrapPath(g.outline(ellipse));
    const first = unwrapPath(g.boolean('subtract', [{ path: a, transform: I }, { path: a, transform: [1, 0, 0, 1, 100, 150] }]));
    expect(unwrapPath(g.boolean('subtract', [{ path: a, transform: [1, 0, 0, 1, 1e-15, 0] }, { path: a, transform: [1, 0, 0, 1, 100.00000000000006, 149.99999999999997] }]))).toBe(first);
    expect(unwrapPath(g.outline({ ...ellipse, box: { ...box, w: 100.00000000000001 } }))).toBe(a);
    g.boolean('subtract', [{ path: a, transform: I }, { path: a, transform: [1, 0, 0, 1, 100.5, 150] }]);
    expect(calls['boolean_op']).toBe(2);
  });

  it('stroke outlines are keyed by path and stroke; failures are not cached; the memo is bounded', () => {
    const { wasm, calls } = fakeWasm();
    const g = createGeometry(wasm);
    const a = unwrapPath(g.outline(ellipse));
    const inside = stroke({ align: 'inside' });
    expect(unwrapPath(g.outlineStroke(a, inside))).toBe(unwrapPath(g.outlineStroke(a, { ...inside })));
    g.outlineStroke(a, stroke({ align: 'inside', width: 9 }));
    expect(calls['outline_stroke']).toBe(2);

    let throws = 0;
    const failing = createGeometry({ ...wasm, shape_outline: () => { throws += 1; throw 'bad shape'; } } as GeometryWasm);
    expect(failing.outline(ellipse).ok).toBe(false);
    expect(failing.outline(ellipse).ok).toBe(false);
    expect(throws).toBe(2);

    for (let w = 1; w <= GEOMETRY_MEMO_LIMIT; w++) g.outline({ ...ellipse, box: { ...box, w: 1000 + w } });
    const before = calls['shape_outline'];
    g.outline(ellipse); // the oldest entry was evicted
    expect(calls['shape_outline']).toBe((before ?? 0) + 1);
  });
});

describe.skipIf(!authoringBuilt)('geometry service on the authoring Wasm', () => {
  it('outlines every shape kind (rounded and smooth corners included) and parses paths', async () => {
    const g = await loadGeometry();
    const bounds = (path: Parameters<typeof g.bounds>[0]) => {
      const b = g.bounds(path, I);
      if (!b.ok) throw b.error;
      return b.value;
    };
    for (const geometry of [
      { kind: 'rect', radii: [10, 0, 10, 0], smoothing: 0.6 },
      { kind: 'ellipse' },
      { kind: 'polygon', sides: 6, radius: 5, smoothing: 0 },
      { kind: 'star', points: 5, ratio: 0.4, radius: 0, inner: 0, smoothing: 0 },
      { kind: 'frame', radii: [0, 0, 0, 0], clip: true, smoothing: 0 },
    ] as const) {
      const o = g.outline({ geometry, box });
      expect(o.ok, geometry.kind).toBe(true);
      if (o.ok) expect(bounds(o.value).maxX, geometry.kind).toBeCloseTo(100, 0);
    }
    const rounded = g.outline({ geometry: { kind: 'path', d: 'M0 0 L40 0 L40 40 L0 40 Z', evenOdd: false, radii: [8], smoothing: 0 }, box });
    expect(rounded.ok && [...rounded.value.verbs].includes(3)).toBe(true);
    const vec = g.outline({ geometry: { kind: 'path', d: 'M0 0 L40 0 L40 40 Z', evenOdd: false, radii: [], smoothing: 0 }, box });
    expect(vec.ok && g.toSvg(vec.value)).toBe('M0,0 L40,0 L40,40 Z');
    expect(g.outline({ geometry: { kind: 'group' }, box }).ok).toBe(true);
    expect(g.parsePath('M0 Q').ok).toBe(false);
  });

  it('booleans: exact areas on squares, and a property test on random polygons', async () => {
    const g = await loadGeometry();
    const square = (x: number, y: number, s: number) => {
      const p = g.parsePath(`M${x} ${y} L${x + s} ${y} L${x + s} ${y + s} L${x} ${y + s} Z`);
      if (!p.ok) throw p.error;
      return p.value;
    };
    const area = (path: Parameters<typeof g.bounds>[0]): number => {
      // Shoelace over line-only output.
      let a = 0;
      let start = 0;
      for (let i = 0, v = 0; v < path.verbs.length; v++) {
        if (path.verbs[v] === 0) start = i;
        if (path.verbs[v] === 4) continue;
        const next = v + 1 < path.verbs.length && path.verbs[v + 1] !== 0 && path.verbs[v + 1] !== 4 ? i + 2 : start;
        a += (path.points[i] as number) * (path.points[next + 1] as number) - (path.points[next] as number) * (path.points[i + 1] as number);
        i += 2;
      }
      return Math.abs(a) / 2;
    };
    const a = square(0, 0, 10);
    const b = square(5, 5, 10);
    const ops = { union: 175, subtract: 75, intersect: 25, exclude: 150 } as const;
    for (const [op, expected] of Object.entries(ops)) {
      const r = g.boolean(op as keyof typeof ops, [{ path: a, transform: I }, { path: b, transform: I }]);
      expect(r.ok && area(r.value), op).toBeCloseTo(expected, 6);
    }
    const moved = g.boolean('union', [{ path: a, transform: I }, { path: a, transform: [1, 0, 0, 1, 20, 0] }]);
    expect(moved.ok && area(moved.value)).toBeCloseTo(200, 6);
    let seed = 7;
    const rand = (): number => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let n = 0; n < 40; n++) {
      const poly = (cx: number) => {
        const count = 3 + Math.floor(rand() * 6);
        const pts = Array.from({ length: count }, (_, k) => {
          const t = (k / count) * Math.PI * 2;
          const r = 10 + rand() * 20;
          return `${cx + Math.cos(t) * r} ${50 + Math.sin(t) * r}`;
        });
        const p = g.parsePath(`M${pts.join(' L')} Z`);
        if (!p.ok) throw p.error;
        return p.value;
      };
      const p = poly(40 + rand() * 10);
      const q = poly(50 + rand() * 10);
      const u = g.boolean('union', [{ path: p, transform: I }, { path: q, transform: I }]);
      const i = g.boolean('intersect', [{ path: p, transform: I }, { path: q, transform: I }]);
      const x = g.boolean('exclude', [{ path: p, transform: I }, { path: q, transform: I }]);
      expect(u.ok && i.ok && x.ok, `case ${n}`).toBe(true);
      if (u.ok && i.ok && x.ok) {
        expect(area(u.value) + area(i.value), `case ${n}: |A∪B| + |A∩B| = |A| + |B|`).toBeCloseTo(area(p) + area(q), 4);
        expect(area(x.value), `case ${n}: xor`).toBeCloseTo(area(u.value) - area(i.value), 4);
      }
    }
  });

  it('bounds, ink bounds, stroke outlines, hits and marquee tests', async () => {
    const g = await loadGeometry();
    const o = g.outline({ geometry: { kind: 'rect', radii: [0, 0, 0, 0], smoothing: 0 }, box });
    if (!o.ok) throw o.error;
    expect(g.bounds(o.value, [0, 1, -1, 0, 0, 0])).toEqual({ ok: true, value: { minX: -50, minY: 0, maxX: 0, maxY: 100 } });
    const ink = g.inkBounds(o.value, I, [stroke(), stroke({ width: 10, align: 'outside' })], [{ kind: 'drop-shadow', x: 0, y: 10, blur: 4, spread: 0, color: [0, 0, 0, 255] }]);
    // the outside stroke reaches 10 px; the shadow (3σ = 6) moves 10 px down
    expect(ink.ok && ink.value).toEqual({ minX: -16, minY: -10, maxX: 116, maxY: 76 });
    const ring = g.outlineStroke(o.value, stroke({ align: 'inside' }));
    expect(ring.ok && g.bounds(ring.value, I)).toEqual({ ok: true, value: { minX: 0, minY: 0, maxX: 100, maxY: 50 } });
    expect(g.hit(o.value, I, 50, 25, { fill: 'nonzero' })).toEqual({ ok: true, value: 'fill' });
    expect(g.hit(o.value, I, 101, 25, { strokeWidth: 4 })).toEqual({ ok: true, value: 'stroke' });
    expect(g.hit(o.value, I, 150, 25, { fill: 'evenodd', tolerance: 1 })).toEqual({ ok: true, value: 'none' });
    expect(g.intersects(o.value, I, { minX: 90, minY: 40, maxX: 120, maxY: 60 })).toEqual({ ok: true, value: true });
    expect(g.intersects(o.value, I, { minX: 90, minY: 40, maxX: 120, maxY: 60 }, { contain: true })).toEqual({ ok: true, value: false });
    const moved = g.transform(o.value, [1, 0, 0, 1, 5, 5]);
    expect(moved.ok && g.bounds(moved.value, I)).toEqual({ ok: true, value: { minX: 5, minY: 5, maxX: 105, maxY: 55 } });
  });
});
