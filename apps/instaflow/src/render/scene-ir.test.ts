// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BLEND_MODES, createSceneWriter, PATH_VERBS, SCENE_APPEND, SCENE_IR_VERSION, SCENE_OPS, type SceneNode, type ScenePaint, type SceneTransform } from './scene-ir.js';

const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`../../engine/crates/render/fixtures/${name}.sfir`, import.meta.url)));

/** The `shapes` fixture as defined in engine/crates/render/src/fixtures.rs. */
const SHAPES: readonly SceneNode[] = [
  { id: 1, transform: [1, 0, 0, 1, 8, 8], geometry: { kind: 'rect', w: 48, h: 32 }, fill: { kind: 'solid', color: [220, 40, 40, 255] } },
  {
    id: 2,
    transform: [1, 0, 0, 1, 64, 8],
    geometry: { kind: 'rect', w: 56, h: 32, radius: 8 },
    fill: { kind: 'solid', color: [40, 80, 220, 255] },
    stroke: { width: 3, paint: { kind: 'solid', color: [20, 20, 20, 255] }, join: 'miter', cap: 'butt' },
  },
  { id: 3, transform: [1, 0, 0, 1, 8, 48], geometry: { kind: 'ellipse', w: 48, h: 40 }, fill: { kind: 'solid', color: [40, 180, 90, 200] } },
  {
    id: 4,
    geometry: { kind: 'path', path: { verbs: [PATH_VERBS.move, PATH_VERBS.line, PATH_VERBS.line, PATH_VERBS.close], points: [88, 52, 120, 116, 56, 116] } },
    fill: { kind: 'solid', color: [250, 200, 40, 255] },
    stroke: { width: 2, paint: { kind: 'solid', color: [120, 60, 0, 255] }, join: 'round', cap: 'round' },
  },
  { id: 5, transform: [0.8, 0.6, -0.6, 0.8, 30, 90], geometry: { kind: 'rect', w: 24, h: 24 }, fill: { kind: 'solid', color: [120, 40, 160, 255] } },
];

/** 16×16 straight-RGBA checker with a translucent half (`checker()` in fixtures.rs). */
function checker(): Uint8Array {
  const px = new Uint8Array(16 * 16 * 4);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const on = (Math.floor(x / 4) + Math.floor(y / 4)) % 2 === 0;
      const alpha = y < 8 ? 255 : 160;
      px.set(on ? [250, 120, 20, alpha] : [20, 60, 140, alpha], (y * 16 + x) * 4);
    }
  }
  return px;
}

const at = (x: number, y: number): SceneTransform => [1, 0, 0, 1, x, y];
const square = (x0: number, y0: number, x1: number, y1: number): number[] => [x0, y0, x1, y0, x1, y1, x0, y1];
const { move, line, close } = PATH_VERBS;

/** The IR v2 `elements` fixture (fixtures.rs): effects, per-corner rects, image fit, even-odd, the three masks. */
function elementsBatch(): Uint8Array {
  const w = createSceneWriter().image(1, 16, 16, checker());
  w.upsert({
    id: 1,
    transform: at(6, 6),
    geometry: { kind: 'rrect', w: 52, h: 32, radii: [12, 2, 12, 2] },
    fill: { kind: 'solid', color: [255, 92, 57, 255] },
    effects: [
      { kind: 'drop-shadow', x: 2, y: 4, blur: 6, spread: 1, color: [0, 0, 0, 110] },
      { kind: 'inner-shadow', x: 0, y: 3, blur: 4, spread: 0, color: [120, 0, 0, 200] },
    ],
  });
  w.upsert({ id: 2, transform: at(70, 6), geometry: { kind: 'rect', w: 52, h: 26, radius: 6 }, fill: { kind: 'image', image: 1, fit: 'cover' } });
  w.upsert({ id: 3, transform: at(70, 36), geometry: { kind: 'rect', w: 52, h: 20 }, fill: { kind: 'image', image: 1, fit: 'contain' } });
  w.upsert({
    id: 4,
    transform: at(6, 48),
    evenOdd: true,
    geometry: { kind: 'path', path: { verbs: [move, line, line, line, close, move, line, line, line, close], points: [...square(0, 0, 28, 28), ...square(8, 8, 20, 20)] } },
    fill: { kind: 'solid', color: [61, 90, 254, 255] },
  });
  w.upsert({ id: 5, transform: at(40, 50), geometry: { kind: 'ellipse', w: 24, h: 24 }, fill: { kind: 'solid', color: [0, 179, 126, 255] }, effects: [{ kind: 'layer-blur', radius: 4 }] });
  const masked = (id: number, x: number, mask: SceneNode['mask'], fill: ScenePaint): void => {
    w.upsert({ id, transform: at(x, 84), geometry: { kind: 'group' } });
    w.upsert({ id: id + 1, parent: id, geometry: { kind: 'ellipse', w: 36, h: 36 }, fill, ...(mask === undefined ? {} : { mask }) });
    w.upsert({ id: id + 2, parent: id, transform: at(-4, -4), geometry: { kind: 'rect', w: 22, h: 44 }, fill: { kind: 'solid', color: [255, 194, 61, 255] } });
    w.upsert({ id: id + 3, parent: id, transform: at(18, -4), geometry: { kind: 'rect', w: 22, h: 44 }, fill: { kind: 'solid', color: [214, 38, 95, 255] } });
  };
  masked(10, 4, { mode: 'clip' }, { kind: 'none' });
  masked(20, 46, { mode: 'alpha' }, { kind: 'linear', start: [0, 0], end: [36, 0], stops: [[0, [0, 0, 0, 255]], [1, [0, 0, 0, 0]]] });
  masked(30, 88, { mode: 'luminance', invert: true }, { kind: 'linear', start: [0, 0], end: [0, 36], stops: [[0, [255, 255, 255, 255]], [1, [0, 0, 0, 255]]] });
  return w.finish();
}

/** The IR v2 `appearance` fixture (fixtures.rs): fill and stroke stacks, conic gradient, dashes, a ring, glow, backdrop blur. */
function appearanceBatch(): Uint8Array {
  const w = createSceneWriter();
  w.upsert({
    id: 1,
    transform: at(6, 6),
    geometry: { kind: 'rect', w: 56, h: 36, radius: 6 },
    fills: [
      { paint: { kind: 'linear', start: [0, 0], end: [56, 0], stops: [[0, [61, 90, 254, 255]], [1, [0, 179, 126, 255]]] } },
      { paint: { kind: 'solid', color: [255, 194, 61, 255] }, opacity: 0.5, blend: 'multiply' },
    ],
  });
  w.upsert({
    id: 2,
    transform: at(76, 6),
    geometry: { kind: 'ellipse', w: 36, h: 36 },
    fill: { kind: 'sweep', center: [18, 18], start: 0, end: Math.PI * 2, stops: [[0, [255, 92, 57, 255]], [0.5, [61, 90, 254, 255]], [1, [255, 92, 57, 255]]] },
  });
  w.upsert({
    id: 3,
    transform: at(10, 54),
    geometry: { kind: 'rect', w: 40, h: 28 },
    fill: { kind: 'solid', color: [240, 240, 245, 255] },
    strokes: [
      { width: 3, paint: { kind: 'solid', color: [22, 21, 26, 255] }, join: 'miter', cap: 'round', dash: [6, 4] },
      {
        width: 4,
        paint: { kind: 'solid', color: [214, 38, 95, 255] },
        join: 'miter',
        cap: 'butt',
        opacity: 0.7,
        ring: { verbs: [move, line, line, line, close, move, line, line, line, close], points: [...square(-4, -4, 44, 32), 0, 0, 0, 28, 40, 28, 40, 0] },
      },
    ],
  });
  w.upsert({ id: 4, transform: at(92, 58), geometry: { kind: 'ellipse', w: 20, h: 20 }, fill: { kind: 'solid', color: [255, 194, 61, 255] }, effects: [{ kind: 'drop-shadow', x: 0, y: 0, blur: 8, spread: 2, color: [255, 92, 57, 220] }] });
  for (let i = 0; i < 8; i++) {
    const color: readonly [number, number, number, number] = i % 2 === 0 ? [22, 21, 26, 255] : [255, 255, 255, 255];
    w.upsert({ id: 10 + i, transform: at(6 + i * 14, 96), geometry: { kind: 'rect', w: 14, h: 28 }, fill: { kind: 'solid', color } });
  }
  w.upsert({ id: 30, transform: at(28, 100), geometry: { kind: 'rect', w: 70, h: 20, radius: 8 }, fill: { kind: 'solid', color: [255, 255, 255, 90] }, effects: [{ kind: 'background-blur', radius: 6 }] });
  return w.finish();
}

describe('createSceneWriter', () => {
  it('writes fill and stroke stacks, conic gradients, dashes, rings and backdrop blur like Rust (`appearance` fixture)', () => {
    expect(appearanceBatch()).toEqual(fixture('appearance'));
  });

  it('writes the IR v2 features byte-identically with the Rust IrWriter (`elements` fixture)', () => {
    expect(elementsBatch()).toEqual(fixture('elements'));
  });

  it('writes the same bytes as the Rust IrWriter (shared `shapes` fixture)', () => {
    const w = createSceneWriter();
    for (const node of SHAPES) w.upsert(node);
    expect(w.ops).toBe(5);
    expect(w.finish()).toEqual(fixture('shapes'));
  });

  it('writes the header, op count and every op kind', () => {
    const w = createSceneWriter();
    w.clear()
      .image(9, 1, 1, new Uint8Array([1, 2, 3, 4]), { premultiplied: true })
      .upsert(
        {
          id: 3,
          parent: 1,
          opacity: 0.5,
          blend: 'luminosity',
          visible: false,
          clip: { kind: 'rounded', rect: [0, 0, 10, 10], radius: 2 },
          geometry: { kind: 'glyphs', font: 1, size: 12, glyphs: [[65, 0, 12]] },
          fill: { kind: 'radial', center: [1, 2], radius: 3, stops: [[0, [0, 0, 0, 255]]] },
        },
        0,
      )
      .remove(3)
      .dropImage(9);
    const bytes = w.finish();
    const view = new DataView(bytes.buffer);
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe('SFIR');
    expect(view.getUint16(4, true)).toBe(SCENE_IR_VERSION);
    expect(view.getUint32(8, true)).toBe(5);
    expect(bytes[12]).toBe(SCENE_OPS.clear);
    expect(bytes[13]).toBe(SCENE_OPS.image);
    expect(bytes.at(-5)).toBe(SCENE_OPS.dropImage);
    expect(BLEND_MODES.indexOf('luminosity')).toBe(15);
    expect(SCENE_APPEND).toBe(0xffffffff);
  });

  it('every fixture batch starts with a valid header', () => {
    for (const name of ['shapes', 'paints', 'layers', 'tiles', 'elements', 'appearance', 'text']) {
      const bytes = fixture(name);
      expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe('SFIR');
      expect(new DataView(bytes.buffer, bytes.byteOffset).getUint16(4, true)).toBe(SCENE_IR_VERSION);
    }
  });

  it('writes font ops and glyph runs with synthesis and variation coordinates (v3, B2)', () => {
    const hash = new Uint8Array(32).fill(7);
    const w = createSceneWriter();
    w.font(4, hash, new Uint8Array([0x4f, 0x54, 0x54, 0x4f])).font(5, hash, new Uint8Array()).dropFont(4);
    w.upsert({ id: 1, geometry: { kind: 'glyphs', font: 5, size: 20, glyphs: [[3, 1, 2]], embolden: true, skew: 14, coords: [16384, -3] } });
    const bytes = w.finish();
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(8, true)).toBe(4);
    let at = 12;
    expect(bytes[at]).toBe(SCENE_OPS.font);
    expect(view.getUint32(at + 1, true)).toBe(4);
    expect(bytes.subarray(at + 5, at + 37)).toEqual(hash);
    expect(view.getUint32(at + 37, true)).toBe(4);
    at += 1 + 4 + 32 + 4 + 4;
    expect([bytes[at], view.getUint32(at + 37, true)]).toEqual([SCENE_OPS.font, 0]);
    at += 1 + 4 + 32 + 4;
    expect(bytes[at]).toBe(SCENE_OPS.dropFont);
    at += 5;
    expect(bytes[at]).toBe(SCENE_OPS.upsert);
    // op tag + id/parent/index (13) + transform 48 + opacity 4 + blend, flags, mask 3 + clip 1 → geometry tag
    const g = at + 13 + 48 + 4 + 3 + 1;
    expect(bytes[g]).toBe(5);
    expect([view.getUint32(g + 1, true), view.getFloat32(g + 5, true), bytes[g + 9], view.getFloat32(g + 10, true), bytes[g + 14]]).toEqual([5, 20, 1, 14, 2]);
    expect([view.getInt16(g + 15, true), view.getInt16(g + 17, true), view.getUint32(g + 19, true)]).toEqual([16384, -3, 1]);
    expect(() => createSceneWriter().font(1, new Uint8Array(3), new Uint8Array())).toThrow(/sha-256/);
  });

  it('rejects invalid input instead of writing a broken batch', () => {
    const w = createSceneWriter();
    expect(() => w.upsert({ id: 0, geometry: { kind: 'group' } })).toThrow(RangeError);
    expect(() => w.upsert({ id: 1, transform: [1, 0, 0, 1, Number.NaN, 0], geometry: { kind: 'group' } })).toThrow(/finite/);
    expect(() => w.upsert({ id: 1, geometry: { kind: 'path', path: { verbs: [0], points: [1] } } })).toThrow(/pairs/);
    expect(() => w.image(1, 2, 2, new Uint8Array(4))).toThrow(/bytes/);
    w.finish();
    expect(() => w.clear()).toThrow(/finished/);
  });

  it('grows its buffer for large batches and writes paints and clips of every kind', () => {
    const w = createSceneWriter();
    const big = new Uint8Array(64 * 64 * 4).fill(7);
    w.image(1, 64, 64, big);
    w.upsert({ id: 1, clip: { kind: 'rect', rect: [0, 0, 1, 1] }, geometry: { kind: 'image', image: 1, w: 10, h: 10 }, fill: { kind: 'image', image: 1 } });
    w.upsert({ id: 2, clip: { kind: 'path', path: { verbs: [0, 1, 4], points: [0, 0, 1, 1] } }, geometry: { kind: 'group' }, fill: { kind: 'linear', start: [0, 0], end: [1, 1], stops: [] } });
    w.upsert({ id: 3, geometry: { kind: 'rect', w: 1, h: 1 }, stroke: { width: 0, paint: { kind: 'none' } } });
    const bytes = w.finish();
    expect(bytes.length).toBeGreaterThan(64 * 64 * 4);
  });
});
