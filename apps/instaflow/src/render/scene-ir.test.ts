// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BLEND_MODES, createSceneWriter, PATH_VERBS, SCENE_APPEND, SCENE_IR_VERSION, SCENE_OPS, type SceneNode } from './scene-ir.js';

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

describe('createSceneWriter', () => {
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
    for (const name of ['shapes', 'paints', 'layers', 'tiles', 'text']) {
      const bytes = fixture(name);
      expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe('SFIR');
      expect(new DataView(bytes.buffer, bytes.byteOffset).getUint16(4, true)).toBe(SCENE_IR_VERSION);
    }
  });

  it('writes font ops and glyph runs with synthesis and variation coordinates (v2, B2)', () => {
    const hash = new Uint8Array(32).fill(7);
    const w = createSceneWriter();
    w.font(4, hash, new Uint8Array([0x4f, 0x54, 0x54, 0x4f])).font(5, hash, new Uint8Array()).dropFont(4);
    w.upsert({ id: 1, geometry: { kind: 'glyphs', font: 5, size: 20, glyphs: [[3, 1, 2]], embolden: true, skew: 14, coords: [16384, -3] }, fill: { kind: 'solid', color: [0, 0, 0, 255] } });
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
    // header (1 + 4·3) + transform 48 + opacity 4 + blend/flags 2 + clip 1 → geometry tag
    const g = at + 13 + 48 + 4 + 2 + 1;
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
