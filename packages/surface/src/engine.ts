/**
 * Engine-agnostic rendering contract (R11.21). StaticFlux hosts any engine
 * (hand-written Canvas2D, Three.js, Babylon, a Wasm/wgpu renderer…) behind
 * `RenderEngine`; it depends on none of them. The same engine runs on the main
 * thread or in a render worker — it only sees a `RenderContext`.
 */
import { err, ok, type Result } from '@staticflux/core';
import { SurfaceContextError } from './errors.js';
import type { FrameInfo } from './frame-loop.js';
import type { HtmlInCanvasAdapter } from './html-in-canvas.js';
import type { CompactInputEvent } from './input.js';

export const SURFACE_KINDS = ['dom', 'canvas2d', 'webgl', 'webgpu', 'html-in-canvas'] as const;
export type SurfaceKind = (typeof SURFACE_KINDS)[number];
/** Kinds that draw into a canvas (html-in-canvas draws DOM into a 2D canvas, main thread only). */
export type CanvasSurfaceKind = Exclude<SurfaceKind, 'dom'>;
/** Kinds that can render in a worker through a transferred OffscreenCanvas. */
export type WorkerSurfaceKind = Exclude<CanvasSurfaceKind, 'html-in-canvas'>;

/** CSS size plus device pixel ratio; the backing store is `round(css * dpr)`. */
export interface SurfaceSize {
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
}

export function backingSize(size: SurfaceSize): { readonly width: number; readonly height: number } {
  return { width: Math.max(1, Math.round(size.width * size.dpr)), height: Math.max(1, Math.round(size.height * size.dpr)) };
}

/** Structural canvas: HTMLCanvasElement or OffscreenCanvas. */
export interface CanvasLike {
  width: number;
  height: number;
  getContext(contextId: string, options?: unknown): unknown;
}

/** Minimal WebGPU canvas context (avoids depending on @webgpu/types). */
export interface WebGpuCanvasContextLike {
  configure(configuration: unknown): void;
  getCurrentTexture(): unknown;
  unconfigure?(): void;
}

export type ContextFor<K extends CanvasSurfaceKind> = K extends 'canvas2d' | 'html-in-canvas'
  ? CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D
  : K extends 'webgl'
    ? WebGL2RenderingContext | WebGLRenderingContext
    : WebGpuCanvasContextLike;

export interface RenderContext<K extends CanvasSurfaceKind = CanvasSurfaceKind> {
  readonly surfaceId: string;
  readonly kind: K;
  readonly canvas: CanvasLike;
  readonly context: ContextFor<K>;
  readonly size: SurfaceSize;
  /** Where the engine runs. */
  readonly thread: 'main' | 'worker';
  /** Aborted when the surface detaches. */
  readonly signal: AbortSignal;
  /** `html-in-canvas` surfaces (main thread): the drawable-DOM adapter. */
  readonly htmlInCanvas?: HtmlInCanvasAdapter;
}

export interface RenderEngine<State = unknown, K extends CanvasSurfaceKind = CanvasSurfaceKind> {
  init(context: RenderContext<K>): Result<void> | Promise<Result<void>>;
  /** Draw one frame of `state`; `dt` is ms since the previous frame. */
  frame(state: State, dt: number, info: FrameInfo): void;
  resize(size: SurfaceSize): void;
  /** Optional: raw input batch (already timestamped) before intents are derived. */
  input?(events: readonly CompactInputEvent[]): void;
  dispose(): void;
}

export type RenderEngineFactory<State = unknown, K extends CanvasSurfaceKind = CanvasSurfaceKind> = () => RenderEngine<State, K>;

const CONTEXT_IDS: Readonly<Record<CanvasSurfaceKind, readonly string[]>> = {
  canvas2d: ['2d'],
  'html-in-canvas': ['2d'],
  webgl: ['webgl2', 'webgl'],
  webgpu: ['webgpu'],
};

/** Get the context for a surface kind (WebGL2 → WebGL1 fallback). */
export function acquireContext<K extends CanvasSurfaceKind>(canvas: CanvasLike, kind: K, options?: unknown): Result<ContextFor<K>> {
  for (const id of CONTEXT_IDS[kind]) {
    let context: unknown;
    try {
      context = canvas.getContext(id, options);
    } catch {
      context = null;
    }
    if (context !== null && context !== undefined) return ok(context as ContextFor<K>);
  }
  return err(SurfaceContextError({ message: `No "${kind}" context available.`, details: { kind, tried: [...CONTEXT_IDS[kind]] } }));
}

export interface CanvasFeatureGlobals {
  readonly HTMLCanvasElement?: { readonly prototype: object };
  readonly OffscreenCanvas?: unknown;
  readonly navigator?: { readonly gpu?: unknown };
}

/** OffscreenCanvas transfer (render workers) is available. */
export function supportsOffscreenCanvas(globals: CanvasFeatureGlobals = globalThis as CanvasFeatureGlobals): boolean {
  const proto = globals.HTMLCanvasElement?.prototype as { transferControlToOffscreen?: unknown } | undefined;
  return typeof globals.OffscreenCanvas === 'function' && typeof proto?.transferControlToOffscreen === 'function';
}

/** WebGPU entry point is present (an adapter may still be unavailable — engines report that from `init`). */
export function supportsWebGpu(globals: CanvasFeatureGlobals = globalThis as CanvasFeatureGlobals): boolean {
  return globals.navigator?.gpu !== undefined;
}
