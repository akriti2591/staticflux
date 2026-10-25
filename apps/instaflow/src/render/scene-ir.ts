/**
 * Scene IR encoder (IF-7.10): the TypeScript writer for the render module's binary batch format.
 * The format is defined in `apps/instaflow/engine/crates/render/src/ir.rs` (the decoder) and this
 * writer emits the same bytes as the Rust `IrWriter`; the test compares both on a shared fixture.
 * The editor's render projection (A7, SF-Δ25) builds batches with it; the delta stream carries them.
 *
 * ```ts
 * const w = createSceneWriter();
 * w.upsert({ id: 7, geometry: { kind: 'rect', w: 120, h: 80, radius: 8 }, fill: { kind: 'solid', color: [255, 0, 0, 255] } });
 * renderer.apply(w.finish());
 * ```
 */

export const SCENE_IR_MAGIC = [0x53, 0x46, 0x49, 0x52] as const; // "SFIR"
export const SCENE_IR_VERSION = 1;
/** Parent id of top-level nodes. */
export const SCENE_ROOT = 0;
/** `index` value that appends a node after its siblings. */
export const SCENE_APPEND = 0xffff_ffff;

export const SCENE_OPS = { clear: 1, upsert: 2, remove: 3, image: 4, dropImage: 5 } as const;

/** `peniko::Mix` order; the wire value is the index. */
export const BLEND_MODES = [
  'normal',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'color-dodge',
  'color-burn',
  'hard-light',
  'soft-light',
  'difference',
  'exclusion',
  'hue',
  'saturation',
  'color',
  'luminosity',
] as const;
export type BlendMode = (typeof BLEND_MODES)[number];

export const PATH_VERBS = { move: 0, line: 1, quad: 2, cubic: 3, close: 4 } as const;
export type PathVerb = (typeof PATH_VERBS)[keyof typeof PATH_VERBS];

export const STROKE_JOINS = ['bevel', 'miter', 'round'] as const;
export const STROKE_CAPS = ['butt', 'square', 'round'] as const;

/** Straight-alpha sRGB, 0…255. */
export type Rgba8 = readonly [number, number, number, number];
/** Affine `[a, b, c, d, e, f]` (kurbo order: x' = a·x + c·y + e, y' = b·x + d·y + f). */
export type SceneTransform = readonly [number, number, number, number, number, number];
export type SceneRect = readonly [number, number, number, number];

export interface ScenePath {
  readonly verbs: readonly PathVerb[];
  /** Flat `x, y` pairs: move/line 1 point, quad 2, cubic 3, close 0. */
  readonly points: readonly number[];
}

export type SceneClip =
  | { readonly kind: 'none' }
  | { readonly kind: 'rect'; readonly rect: SceneRect }
  | { readonly kind: 'rounded'; readonly rect: SceneRect; readonly radius: number }
  | { readonly kind: 'path'; readonly path: ScenePath };

export type SceneGeometry =
  | { readonly kind: 'group' }
  | { readonly kind: 'rect'; readonly w: number; readonly h: number; readonly radius?: number }
  | { readonly kind: 'ellipse'; readonly w: number; readonly h: number }
  | { readonly kind: 'path'; readonly path: ScenePath }
  | { readonly kind: 'image'; readonly image: number; readonly w: number; readonly h: number }
  /** Positioned glyphs (B2); drawn as nothing until fonts land. */
  | { readonly kind: 'glyphs'; readonly font: number; readonly size: number; readonly glyphs: readonly (readonly [number, number, number])[] };

export type GradientStop = readonly [offset: number, color: Rgba8];

export type ScenePaint =
  | { readonly kind: 'none' }
  | { readonly kind: 'solid'; readonly color: Rgba8 }
  | { readonly kind: 'linear'; readonly start: readonly [number, number]; readonly end: readonly [number, number]; readonly stops: readonly GradientStop[] }
  | { readonly kind: 'radial'; readonly center: readonly [number, number]; readonly radius: number; readonly stops: readonly GradientStop[] }
  /** The image stretched over the shape's `w × h` box. */
  | { readonly kind: 'image'; readonly image: number };

export interface SceneStroke {
  readonly width: number;
  readonly paint: ScenePaint;
  readonly join?: (typeof STROKE_JOINS)[number];
  readonly cap?: (typeof STROKE_CAPS)[number];
}

export interface SceneNode {
  /** Non-zero, unique per scene. */
  readonly id: number;
  /** Default root (0). */
  readonly parent?: number;
  readonly transform?: SceneTransform;
  /** 0…1, default 1. */
  readonly opacity?: number;
  readonly blend?: BlendMode;
  readonly visible?: boolean;
  readonly clip?: SceneClip;
  readonly geometry: SceneGeometry;
  readonly fill?: ScenePaint;
  readonly stroke?: SceneStroke;
}

export interface SceneWriter {
  /** Ops written so far. */
  readonly ops: number;
  clear(): SceneWriter;
  /** Insert or replace a node at `index` among its parent's children (default: append). */
  upsert(node: SceneNode, index?: number): SceneWriter;
  /** Remove a node and its subtree. */
  remove(id: number): SceneWriter;
  /** Add or replace image pixels (RGBA8, straight unless `premultiplied`). */
  image(id: number, width: number, height: number, rgba: Uint8Array, options?: { readonly premultiplied?: boolean }): SceneWriter;
  dropImage(id: number): SceneWriter;
  /** The batch bytes. The writer must not be used afterwards. */
  finish(): Uint8Array;
}

const IDENTITY: SceneTransform = [1, 0, 0, 1, 0, 0];

/** Little-endian growable byte buffer. */
class Bytes {
  buf = new Uint8Array(256);
  view = new DataView(this.buf.buffer);
  length = 0;

  private reserve(n: number): number {
    if (this.length + n > this.buf.length) {
      let size = this.buf.length * 2;
      while (size < this.length + n) size *= 2;
      const next = new Uint8Array(size);
      next.set(this.buf.subarray(0, this.length));
      this.buf = next;
      this.view = new DataView(next.buffer);
    }
    const at = this.length;
    this.length += n;
    return at;
  }
  // `reserve` may replace `buf` and `view`: always call it before reading them.
  u8(v: number): void {
    const at = this.reserve(1);
    this.view.setUint8(at, v);
  }
  u16(v: number): void {
    const at = this.reserve(2);
    this.view.setUint16(at, v, true);
  }
  u32(v: number): void {
    const at = this.reserve(4);
    this.view.setUint32(at, v >>> 0, true);
  }
  f32(v: number): void {
    const at = this.reserve(4);
    this.view.setFloat32(at, v, true);
  }
  f64(v: number): void {
    const at = this.reserve(8);
    this.view.setFloat64(at, v, true);
  }
  bytes(data: Uint8Array): void {
    const at = this.reserve(data.length);
    this.buf.set(data, at);
  }
}

function finite(v: number, what: string): number {
  if (!Number.isFinite(v)) throw new RangeError(`scene IR: ${what} must be finite, got ${v}`);
  return v;
}

export function createSceneWriter(): SceneWriter {
  const out = new Bytes();
  out.bytes(Uint8Array.from(SCENE_IR_MAGIC));
  out.u16(SCENE_IR_VERSION);
  out.u16(0);
  out.u32(0); // op count, patched in finish()
  let ops = 0;
  let done = false;

  const live = (): void => {
    if (done) throw new Error('scene IR: the writer was finished');
  };
  const rgba = (c: Rgba8): void => {
    for (const v of c) out.u8(Math.max(0, Math.min(255, Math.round(v))));
  };
  const rect = (r: SceneRect): void => {
    for (const v of r) out.f64(finite(v, 'rect'));
  };
  const path = (p: ScenePath): void => {
    out.u32(p.verbs.length);
    for (const v of p.verbs) out.u8(v);
    if (p.points.length % 2 !== 0) throw new RangeError('scene IR: path points come in x, y pairs');
    out.u32(p.points.length / 2);
    for (const v of p.points) out.f64(finite(v, 'path point'));
  };
  const stops = (list: readonly GradientStop[]): void => {
    out.u8(list.length);
    for (const [offset, color] of list) {
      out.f32(offset);
      rgba(color);
    }
  };
  const paint = (p: ScenePaint): void => {
    switch (p.kind) {
      case 'none':
        out.u8(0);
        break;
      case 'solid':
        out.u8(1);
        rgba(p.color);
        break;
      case 'linear':
        out.u8(2);
        for (const v of [...p.start, ...p.end]) out.f64(finite(v, 'gradient point'));
        stops(p.stops);
        break;
      case 'radial':
        out.u8(3);
        for (const v of [...p.center, p.radius]) out.f64(finite(v, 'gradient point'));
        stops(p.stops);
        break;
      case 'image':
        out.u8(4);
        out.u32(p.image);
        break;
    }
  };
  const clip = (c: SceneClip): void => {
    switch (c.kind) {
      case 'none':
        out.u8(0);
        break;
      case 'rect':
        out.u8(1);
        rect(c.rect);
        break;
      case 'rounded':
        out.u8(2);
        rect(c.rect);
        out.f64(finite(c.radius, 'clip radius'));
        break;
      case 'path':
        out.u8(3);
        path(c.path);
        break;
    }
  };
  const geometry = (g: SceneGeometry): void => {
    switch (g.kind) {
      case 'group':
        out.u8(0);
        break;
      case 'rect':
        out.u8(1);
        out.f64(finite(g.w, 'w'));
        out.f64(finite(g.h, 'h'));
        out.f64(finite(g.radius ?? 0, 'radius'));
        break;
      case 'ellipse':
        out.u8(2);
        out.f64(finite(g.w, 'w'));
        out.f64(finite(g.h, 'h'));
        break;
      case 'path':
        out.u8(3);
        path(g.path);
        break;
      case 'image':
        out.u8(4);
        out.u32(g.image);
        out.f64(finite(g.w, 'w'));
        out.f64(finite(g.h, 'h'));
        break;
      case 'glyphs':
        out.u8(5);
        out.u32(g.font);
        out.f32(g.size);
        out.u32(g.glyphs.length);
        for (const [glyph, x, y] of g.glyphs) {
          out.u32(glyph);
          out.f32(x);
          out.f32(y);
        }
        break;
    }
  };

  const writer: SceneWriter = {
    get ops() {
      return ops;
    },
    clear() {
      live();
      ops += 1;
      out.u8(SCENE_OPS.clear);
      return writer;
    },
    upsert(node, index = SCENE_APPEND) {
      live();
      if (!Number.isInteger(node.id) || node.id <= 0 || node.id > 0xffff_ffff) throw new RangeError(`scene IR: node id must be a positive u32, got ${node.id}`);
      ops += 1;
      out.u8(SCENE_OPS.upsert);
      out.u32(node.id);
      out.u32(node.parent ?? SCENE_ROOT);
      out.u32(index);
      for (const v of node.transform ?? IDENTITY) out.f64(finite(v, 'transform'));
      out.f32(node.opacity ?? 1);
      out.u8(BLEND_MODES.indexOf(node.blend ?? 'normal'));
      out.u8(node.visible === false ? 0 : 1);
      clip(node.clip ?? { kind: 'none' });
      geometry(node.geometry);
      paint(node.fill ?? { kind: 'none' });
      const stroke = node.stroke;
      if (stroke === undefined || !(stroke.width > 0)) {
        out.f32(0);
      } else {
        out.f32(stroke.width);
        paint(stroke.paint);
        out.u8(STROKE_JOINS.indexOf(stroke.join ?? 'miter'));
        out.u8(STROKE_CAPS.indexOf(stroke.cap ?? 'butt'));
      }
      return writer;
    },
    remove(id) {
      live();
      ops += 1;
      out.u8(SCENE_OPS.remove);
      out.u32(id);
      return writer;
    },
    image(id, width, height, data, options = {}) {
      live();
      if (data.length !== width * height * 4) throw new RangeError(`scene IR: image ${id} has ${data.length} bytes for ${width}×${height}`);
      ops += 1;
      out.u8(SCENE_OPS.image);
      out.u32(id);
      out.u32(width);
      out.u32(height);
      out.u8(options.premultiplied === true ? 1 : 0);
      out.bytes(data);
      return writer;
    },
    dropImage(id) {
      live();
      ops += 1;
      out.u8(SCENE_OPS.dropImage);
      out.u32(id);
      return writer;
    },
    finish() {
      live();
      done = true;
      out.view.setUint32(8, ops, true);
      return out.buf.slice(0, out.length);
    },
  };
  return writer;
}
