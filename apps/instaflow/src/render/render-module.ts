/**
 * The render Wasm module (`apps/instaflow/engine/crates/render`, ABI 2) as TypeScript sees it, and
 * its loader. The module is built by `pnpm build` (`sf wasm build`) into content-hashed files listed
 * in `engine/dist/sf-wasm-manifest.json`; never hard-code a hashed name.
 */
import { err, ok, type Result, toSfError } from '@staticflux/core';
import { RasterBackendError } from '@staticflux/surface/raster';

/** ABI this TypeScript expects (`abi_version()` in lib.rs). */
export const RENDER_ABI_VERSION = 2;

/** The engine object (`Engine` in gpu.rs): the retained scene plus an optional device. */
export interface RenderEngineWasm {
  tile_size(): number;
  apply(batch: Uint8Array): Float64Array;
  bounds(): Float64Array;
  set_layer(layer: number, nodes: Uint32Array): Float64Array;
  release_layer(layer: number): void;
  has_layer(layer: number): boolean;
  install_gpu(gpu: RenderGpuWasm): void;
  drop_gpu(): void;
  has_gpu(): boolean;
  raw_device(): unknown;
  max_target(): number;
  resize(width: number, height: number): void;
  render_tile(slot: number, level: number, tx: number, ty: number, background: Float32Array): number;
  release_tile(slot: number): void;
  render_layer(layer: number, zoom: number): Float64Array;
  upload_snapshot(width: number, height: number, rgba: Uint8Array): void;
  composite(clear: Float32Array, quads: Float32Array, sources: Uint32Array, present: boolean): void;
  warm_up(): Promise<unknown>;
  begin_read_frame(): Promise<unknown>;
  begin_region(x0: number, y0: number, x1: number, y1: number, width: number, height: number, background: Float32Array): Promise<unknown>;
  finish_readback(): Uint8Array;
  cancel_readback(): void;
  stats(): Float64Array;
  free(): void;
}

/** Device-bound state from `create_gpu`, consumed by `install_gpu`. */
export interface RenderGpuWasm {
  free(): void;
}

export interface RenderWasm {
  abi_version(): number;
  ir_version(): number;
  take_errors(): string[];
  create_gpu(canvas: unknown, width: number, height: number): Promise<RenderGpuWasm>;
  Engine: new () => RenderEngineWasm;
}

/** One entry of `sf-wasm-manifest/1`. */
interface WasmManifest {
  readonly format: string;
  readonly artifacts: readonly { readonly crate: string; readonly wasm: string; readonly js: string }[];
}

export interface LoadRenderModuleOptions {
  /** URL of `sf-wasm-manifest.json` (the engine's dist directory). */
  readonly manifestUrl: string | URL;
  readonly signal?: AbortSignal;
  /** Injected for tests: `fetch` and dynamic `import`. */
  readonly fetch?: (url: string, init?: { readonly signal?: AbortSignal }) => Promise<{ readonly ok: boolean; readonly status: number; json(): Promise<unknown> }>;
  readonly importModule?: (url: string) => Promise<unknown>;
}

/** Load and instantiate the render module named in the Wasm manifest, checking its ABI. */
export async function loadRenderModule(options: LoadRenderModuleOptions): Promise<Result<RenderWasm>> {
  const doFetch = options.fetch ?? ((url, init) => fetch(url, init as RequestInit));
  const doImport = options.importModule ?? ((url) => import(/* @vite-ignore */ url));
  try {
    const manifestUrl = new URL(String(options.manifestUrl), globalThis.location?.href);
    const response = await doFetch(manifestUrl.href, options.signal === undefined ? {} : { signal: options.signal });
    if (!response.ok) return err(RasterBackendError({ message: `Render Wasm manifest: HTTP ${response.status}.`, details: { url: manifestUrl.href } }));
    const manifest = (await response.json()) as WasmManifest;
    const entry = manifest.artifacts?.find((a) => a.crate === 'render');
    if (manifest.format !== 'sf-wasm-manifest/1' || entry === undefined) {
      return err(RasterBackendError({ message: 'The Wasm manifest has no render artifact (run `pnpm build`).', details: { url: manifestUrl.href } }));
    }
    const glue = (await doImport(new URL(entry.js, manifestUrl).href)) as RenderWasm & { default(input: { module_or_path: string }): Promise<unknown> };
    await glue.default({ module_or_path: new URL(entry.wasm, manifestUrl).href });
    if (glue.abi_version() !== RENDER_ABI_VERSION) {
      return err(RasterBackendError({ message: `Render Wasm ABI ${glue.abi_version()} does not match ${RENDER_ABI_VERSION}.`, details: { expected: RENDER_ABI_VERSION, got: glue.abi_version() } }));
    }
    return ok(glue);
  } catch (cause) {
    const error = toSfError(cause);
    return err(error.kind === 'aborted' ? error : RasterBackendError({ cause, message: `Loading the render Wasm failed: ${String((cause as Error)?.message ?? cause)}` }));
  }
}
