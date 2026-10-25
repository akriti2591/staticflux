/**
 * The geometry service (IF-7.8, IF-7.9, IF-20.10–20.13): TypeScript over the authoring Wasm's geometry exports
 * (`engine/crates/authoring/src/geometry`, kurbo + linesweeper). Editor worker only. Every call returns a `Result`
 * (`IF-EL-005` for rejected input); Wasm-side objects are freed before returning.
 *
 * - `outline(element)` — an element's outline in its local box (rect with per-corner radii, ellipse, polygon, star,
 *   line, SVG path, image and frame boxes). Boolean groups are derived by `booleanOf` from their children.
 * - `boolean(op, operands)` — union / subtract / intersect / exclude (derived, non-destructive geometry).
 * - `outlineStroke`, `bounds`, `inkBounds`, `hit`, `intersects` — flatten and outline-stroke actions, exact bounds
 *   for align/distribute/snapping, ink bounds for the spatial index, precise hit tests and marquee tests for tools.
 */
import { err, ok, type Result, toSfError } from '@staticflux/core';
import type { Box } from '@staticflux/document/spatial-index';
import { GeometryError, GeometryModuleError } from './errors.js';
import type { Affine, ResolvedEffect, ResolvedElement, ResolvedStroke } from './resolve.js';

/** Flat path data (`PATH_VERBS` encoding, shared with the scene IR). */
export interface PathData {
  readonly verbs: Uint8Array;
  readonly points: Float64Array;
}

export const EMPTY_PATH: PathData = { verbs: new Uint8Array(0), points: new Float64Array(0) };

/** A path object owned by the Wasm module. */
export interface WasmPath {
  readonly verbs: Uint8Array;
  readonly points: Float64Array;
  svg(): string;
  free(): void;
}

/** The authoring module's geometry exports (version `GEOMETRY_VERSION`). */
export interface GeometryWasm {
  geometry_version(): number;
  parse_path(d: string): WasmPath;
  shape_outline(kind: number, w: number, h: number, a: number, b: number, radii: Float64Array, smoothing: number): WasmPath;
  transform_path(verbs: Uint8Array, points: Float64Array, transform: Float64Array): WasmPath;
  round_path(verbs: Uint8Array, points: Float64Array, radii: Float64Array, smoothing: number): WasmPath;
  boolean_op(op: number, verbs: Uint8Array, points: Float64Array, verbCounts: Uint32Array, fillRules: Uint8Array): WasmPath;
  outline_stroke(verbs: Uint8Array, points: Float64Array, stroke: Float64Array): WasmPath;
  path_bounds(verbs: Uint8Array, points: Float64Array, transform: Float64Array): Float64Array;
  ink_bounds_of(verbs: Uint8Array, points: Float64Array, transform: Float64Array, stroke: Float64Array, effects: Float64Array): Float64Array;
  hit_test(verbs: Uint8Array, points: Float64Array, transform: Float64Array, x: number, y: number, tolerance: number, fill: number, strokeWidth: number): number;
  intersects(verbs: Uint8Array, points: Float64Array, transform: Float64Array, rect: Float64Array, contain: boolean, filled: boolean): boolean;
}

/** `GEOMETRY_VERSION` in `crates/authoring/src/geometry/mod.rs`. */
export const GEOMETRY_VERSION = 1;
/** Codes shared with Rust (`ShapeKind`, `BooleanOp`, stroke align). */
export const SHAPE_CODES = { rect: 0, ellipse: 1, polygon: 2, star: 3, line: 4 } as const;
export const BOOLEAN_CODES = { union: 0, subtract: 1, intersect: 2, exclude: 3 } as const;
const ALIGN_CODES = { center: 0, inside: 1, outside: 2 } as const;
const JOIN_CODES = { miter: 0, round: 1, bevel: 2 } as const;
const CAP_CODES = { butt: 0, round: 1, square: 2 } as const;
const EFFECT_CODES = { 'drop-shadow': 1, 'inner-shadow': 2, 'layer-blur': 3 } as const;
const unionBoxes = (a: Box, b: Box): Box => ({ minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) });

export type HitKind = 'none' | 'fill' | 'stroke';
const HITS: readonly HitKind[] = ['none', 'fill', 'stroke'];

export interface BooleanOperand {
  readonly path: PathData;
  /** Operand local → boolean group space. */
  readonly transform: Affine;
  readonly evenOdd?: boolean;
}

export interface GeometryService {
  parsePath(d: string): Result<PathData>;
  toSvg(path: PathData): string;
  /** The element's outline in its local box (boolean groups: use `boolean`). */
  outline(element: Pick<ResolvedElement, 'geometry' | 'box'>): Result<PathData>;
  transform(path: PathData, transform: Affine): Result<PathData>;
  boolean(op: keyof typeof BOOLEAN_CODES, operands: readonly BooleanOperand[]): Result<PathData>;
  /** The filled outline of a stroke (center, inside or outside). */
  outlineStroke(path: PathData, stroke: ResolvedStroke): Result<PathData>;
  bounds(path: PathData, transform: Affine): Result<Box>;
  /** Geometry ∪ every stroke ∪ effects (shadows, glows and blur reach 3σ), under `transform`. */
  inkBounds(path: PathData, transform: Affine, strokes: readonly ResolvedStroke[], effects: readonly ResolvedEffect[]): Result<Box>;
  hit(path: PathData, transform: Affine, x: number, y: number, options: { readonly tolerance?: number; readonly fill?: 'nonzero' | 'evenodd'; readonly strokeWidth?: number }): Result<HitKind>;
  intersects(path: PathData, transform: Affine, rect: Box, options?: { readonly contain?: boolean; readonly filled?: boolean }): Result<boolean>;
}

const f64 = (values: readonly number[]): Float64Array => Float64Array.from(values);
const boxOf = (v: Float64Array): Box => ({ minX: v[0] as number, minY: v[1] as number, maxX: v[2] as number, maxY: v[3] as number });

/** `[width, align, join, cap, miter, dashOffset, dash…]` (per-side strokes use their widest side). */
export function strokeSpec(stroke: ResolvedStroke | undefined): Float64Array {
  if (stroke === undefined) return new Float64Array(0);
  const width = stroke.sides === undefined ? stroke.width : Math.max(...stroke.sides);
  return f64([width, ALIGN_CODES[stroke.align], JOIN_CODES[stroke.join], CAP_CODES[stroke.cap], stroke.miter, stroke.dashOffset, ...stroke.dash]);
}

export function effectSpec(effects: readonly ResolvedEffect[]): Float64Array {
  const out: number[] = [];
  for (const e of effects) {
    if (e.kind === 'background-blur') continue; // paints only inside the shape
    if ('radius' in e) out.push(EFFECT_CODES['layer-blur'], 0, 0, e.radius, 0, 0);
    else out.push(EFFECT_CODES[e.kind], e.x, e.y, e.blur, e.spread, 0);
  }
  return f64(out);
}

/** Wrap the Wasm exports (see the module header). */
export function createGeometry(wasm: GeometryWasm): GeometryService {
  const call = <T>(what: string, run: () => T): Result<T> => {
    try {
      return ok(run());
    } catch (cause) {
      return err(GeometryError({ message: `${what}: ${typeof cause === 'string' ? cause : String((cause as Error)?.message ?? cause)}`, details: { op: what } }));
    }
  };
  const take = (path: WasmPath): PathData => {
    try {
      return { verbs: path.verbs, points: path.points };
    } finally {
      path.free();
    }
  };
  const geometry: GeometryService = {
    parsePath: (d) => (d.trim() === '' ? ok(EMPTY_PATH) : call('parse path', () => take(wasm.parse_path(d)))),
    toSvg(path) {
      if (path.verbs.length === 0) return '';
      const r = call('svg', () => {
        const p = wasm.transform_path(path.verbs, path.points, new Float64Array(0));
        try {
          return p.svg();
        } finally {
          p.free();
        }
      });
      return r.ok ? r.value : '';
    },
    outline({ geometry: g, box }) {
      const shape = (kind: number, a = 0, b = 0, radii: readonly number[] = [], smoothing = 0): Result<PathData> =>
        call('outline', () => take(wasm.shape_outline(kind, box.w, box.h, a, b, f64(radii), smoothing)));
      switch (g.kind) {
        case 'rect':
        case 'frame':
        case 'image':
          return shape(SHAPE_CODES.rect, 0, 0, g.radii, g.smoothing);
        case 'ellipse':
          return shape(SHAPE_CODES.ellipse);
        case 'polygon':
          return shape(SHAPE_CODES.polygon, g.sides, 0, [g.radius], g.smoothing);
        case 'star':
          return shape(SHAPE_CODES.star, g.points, g.ratio, [g.radius, g.inner], g.smoothing);
        case 'line':
          return shape(SHAPE_CODES.line);
        case 'path': {
          const parsed = geometry.parsePath(g.d);
          if (!parsed.ok || !g.radii.some((r) => r > 0)) return parsed;
          return call('round corners', () => take(wasm.round_path(parsed.value.verbs, parsed.value.points, f64(g.radii), g.smoothing)));
        }
        case 'boolean':
        case 'group':
          return ok(EMPTY_PATH);
      }
    },
    transform: (path, t) => call('transform', () => take(wasm.transform_path(path.verbs, path.points, f64(t)))),
    boolean(op, operands) {
      return call('boolean', () => {
        const placed: PathData[] = operands.map((o) => take(wasm.transform_path(o.path.verbs, o.path.points, f64(o.transform))));
        const verbs = new Uint8Array(placed.reduce((n, p) => n + p.verbs.length, 0));
        const points = new Float64Array(placed.reduce((n, p) => n + p.points.length, 0));
        let v = 0;
        let q = 0;
        for (const p of placed) {
          verbs.set(p.verbs, v);
          points.set(p.points, q);
          v += p.verbs.length;
          q += p.points.length;
        }
        const counts = Uint32Array.from(placed.map((p) => p.verbs.length));
        const rules = Uint8Array.from(operands.map((o) => (o.evenOdd === true ? 1 : 0)));
        return take(wasm.boolean_op(BOOLEAN_CODES[op], verbs, points, counts, rules));
      });
    },
    outlineStroke: (path, stroke) => call('outline stroke', () => take(wasm.outline_stroke(path.verbs, path.points, strokeSpec(stroke)))),
    bounds: (path, t) => call('bounds', () => boxOf(wasm.path_bounds(path.verbs, path.points, f64(t)))),
    inkBounds: (path, t, strokes, effects) =>
      call('ink bounds', () => {
        const fx = effectSpec(effects);
        let box = boxOf(wasm.ink_bounds_of(path.verbs, path.points, f64(t), new Float64Array(0), fx));
        // Effects follow the outermost stroke too (a shadow of a thick stroke reaches further).
        for (const s of strokes) box = unionBoxes(box, boxOf(wasm.ink_bounds_of(path.verbs, path.points, f64(t), strokeSpec(s), fx)));
        return box;
      }),
    hit: (path, t, x, y, options) =>
      call('hit test', () => {
        const fill = options.fill === undefined ? -1 : options.fill === 'evenodd' ? 1 : 0;
        return HITS[wasm.hit_test(path.verbs, path.points, f64(t), x, y, options.tolerance ?? 0, fill, options.strokeWidth ?? 0)] ?? 'none';
      }),
    intersects: (path, t, rect, options = {}) =>
      call('intersects', () => wasm.intersects(path.verbs, path.points, f64(t), f64([rect.minX, rect.minY, rect.maxX, rect.maxY]), options.contain === true, options.filled !== false)),
  };
  return geometry;
}

// ---------------------------------------------------------------- loader

interface WasmManifest {
  readonly format: string;
  readonly artifacts: readonly { readonly crate: string; readonly wasm: string; readonly js: string }[];
}

type Glue = GeometryWasm & { default(input: { module_or_path: unknown }): Promise<unknown>; initSync?(input: { module: unknown }): unknown };

export interface LoadAuthoringModuleOptions {
  /** URL of `sf-wasm-manifest.json` (the engine's dist directory). */
  readonly manifestUrl: string | URL;
  readonly signal?: AbortSignal;
  /** Injected for tests: `fetch` and dynamic `import`. */
  readonly fetch?: (url: string, init?: { readonly signal?: AbortSignal }) => Promise<{ readonly ok: boolean; readonly status: number; json(): Promise<unknown> }>;
  readonly importModule?: (url: string) => Promise<unknown>;
  /** Bytes of the `.wasm` file instead of fetching it (Node). */
  readonly wasmBytes?: (url: string) => Promise<Uint8Array>;
}

function checkVersion(glue: GeometryWasm): Result<GeometryWasm> {
  const version = glue.geometry_version();
  return version === GEOMETRY_VERSION
    ? ok(glue)
    : err(GeometryModuleError({ message: `Geometry version ${version} does not match ${GEOMETRY_VERSION}.`, details: { expected: GEOMETRY_VERSION, got: version } }));
}

/** Load the authoring module named in the Wasm manifest and check its geometry version. */
export async function loadAuthoringModule(options: LoadAuthoringModuleOptions): Promise<Result<GeometryWasm>> {
  const doFetch = options.fetch ?? ((url, init) => fetch(url, init as RequestInit));
  const doImport = options.importModule ?? ((url) => import(/* @vite-ignore */ url));
  try {
    const manifestUrl = new URL(String(options.manifestUrl), globalThis.location?.href);
    const response = await doFetch(manifestUrl.href, options.signal === undefined ? {} : { signal: options.signal });
    if (!response.ok) return err(GeometryModuleError({ message: `Wasm manifest: HTTP ${response.status}.`, details: { url: manifestUrl.href } }));
    const manifest = (await response.json()) as WasmManifest;
    const entry = manifest.artifacts?.find((a) => a.crate === 'authoring');
    if (manifest.format !== 'sf-wasm-manifest/1' || entry === undefined) {
      return err(GeometryModuleError({ message: 'The Wasm manifest has no authoring artifact (run `pnpm build`).', details: { url: manifestUrl.href } }));
    }
    const glue = (await doImport(new URL(entry.js, manifestUrl).href)) as Glue;
    const wasmUrl = new URL(entry.wasm, manifestUrl).href;
    if (options.wasmBytes !== undefined && glue.initSync !== undefined) glue.initSync({ module: await options.wasmBytes(wasmUrl) });
    else await glue.default({ module_or_path: wasmUrl });
    return checkVersion(glue);
  } catch (cause) {
    const error = toSfError(cause);
    return err(error.kind === 'aborted' ? error : GeometryModuleError({ cause, message: `Loading the authoring Wasm failed: ${String((cause as Error)?.message ?? cause)}` }));
  }
}
