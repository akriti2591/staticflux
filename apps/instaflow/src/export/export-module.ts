/**
 * The export Wasm (`apps/instaflow/engine/crates/export`, ABI 1) as TypeScript sees it, and its loader. Loaded lazily
 * by the export worker, only for SVG and PDF (and selection exports): ≤ 400 KB brotli (IF-15.1 "export extras"),
 * never at boot. Hashed names come from `sf-wasm-manifest.json`.
 */
import { err, ok, type Result, toSfError } from '@staticflux/core';
import { ExportModuleError } from './errors.js';

/** ABI this TypeScript expects (`ABI_VERSION` in the export crate). */
export const EXPORT_ABI_VERSION = 1;
/** The manifest's crate name. */
export const EXPORT_CRATE = 'export';

/** One export job's state in the Wasm (`Exporter` in wasm.rs). */
export interface ExporterWasm {
  apply(batch: Uint8Array): void;
  isolate(nodes: Uint32Array): Uint8Array;
  bounds(nodes: Uint32Array): Float64Array;
  plan(format: number, x0: number, y0: number, x1: number, y1: number, scale: number): Uint8Array;
  patch(node: number, width: number, height: number, rgba: Uint8Array): void;
  svg(x0: number, y0: number, x1: number, y1: number, width: number, height: number, background: Uint8Array, title: string): string;
  pdf_page(x0: number, y0: number, x1: number, y1: number, width: number, height: number, background: Uint8Array): void;
  pdf_finish(title: string): Uint8Array;
  free(): void;
}

export interface ExportWasm {
  abi_version(): number;
  ir_version(): number;
  Exporter: new () => ExporterWasm;
}

interface WasmManifest {
  readonly format: string;
  readonly artifacts: readonly { readonly crate: string; readonly wasm: string; readonly js: string }[];
}

export interface LoadExportModuleOptions {
  /** URL of `sf-wasm-manifest.json`. */
  readonly manifestUrl: string | URL;
  readonly signal?: AbortSignal;
  /** Injected for tests and Node. */
  readonly fetch?: (url: string, init?: { readonly signal?: AbortSignal }) => Promise<{ readonly ok: boolean; readonly status: number; json(): Promise<unknown> }>;
  readonly importModule?: (url: string) => Promise<unknown>;
  /** Default: the glue fetches the Wasm itself. Node passes the bytes. */
  readonly wasmSource?: (url: string) => Promise<unknown>;
}

/** Load and instantiate the export module named in the Wasm manifest, checking its ABI (IF-EXP-004). */
export async function loadExportModule(options: LoadExportModuleOptions): Promise<Result<ExportWasm>> {
  const doFetch = options.fetch ?? ((url, init) => fetch(url, init as RequestInit));
  const doImport = options.importModule ?? ((url) => import(/* @vite-ignore */ url));
  try {
    const manifestUrl = new URL(String(options.manifestUrl), globalThis.location?.href);
    const response = await doFetch(manifestUrl.href, options.signal === undefined ? {} : { signal: options.signal });
    if (!response.ok) return err(ExportModuleError({ message: `Export Wasm manifest: HTTP ${response.status}.`, details: { url: manifestUrl.href } }));
    const manifest = (await response.json()) as WasmManifest;
    const entry = manifest.artifacts?.find((a) => a.crate === EXPORT_CRATE);
    if (manifest.format !== 'sf-wasm-manifest/1' || entry === undefined) {
      return err(ExportModuleError({ message: 'The Wasm manifest has no export artifact (run `pnpm build`).', details: { url: manifestUrl.href } }));
    }
    options.signal?.throwIfAborted();
    const glue = (await doImport(new URL(entry.js, manifestUrl).href)) as ExportWasm & { default(input: { module_or_path: unknown }): Promise<unknown> };
    const wasmUrl = new URL(entry.wasm, manifestUrl).href;
    await glue.default({ module_or_path: options.wasmSource === undefined ? wasmUrl : await options.wasmSource(wasmUrl) });
    if (glue.abi_version() !== EXPORT_ABI_VERSION) {
      return err(ExportModuleError({ message: `Export Wasm ABI ${glue.abi_version()} does not match ${EXPORT_ABI_VERSION}.`, details: { expected: EXPORT_ABI_VERSION, got: glue.abi_version() } }));
    }
    return ok(glue);
  } catch (cause) {
    const error = toSfError(cause);
    return err(error.kind === 'aborted' ? error : ExportModuleError({ cause, message: `Loading the export Wasm failed: ${String((cause as Error)?.message ?? cause)}` }));
  }
}

/** One planned raster patch (`plan::encode` in the export crate). */
export interface PlannedPatch {
  readonly node: number;
  readonly world: { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number };
  /** A full scene IR batch (CLEAR, nodes, images, fonts) the render module draws. */
  readonly ir: Uint8Array;
}

/** Decode `count:u32 (node:u32 x0 y0 x1 y1:f64 len:u32 ir[len])*` (little-endian). */
export function decodePlan(bytes: Uint8Array): PlannedPatch[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: PlannedPatch[] = [];
  if (bytes.length < 4) return out;
  const count = view.getUint32(0, true);
  let at = 4;
  for (let i = 0; i < count && at + 40 <= bytes.length; i++) {
    const node = view.getUint32(at, true);
    const [x0, y0, x1, y1] = [0, 1, 2, 3].map((k) => view.getFloat64(at + 4 + k * 8, true)) as [number, number, number, number];
    const len = view.getUint32(at + 36, true);
    at += 40;
    out.push({ node, world: { x0, y0, x1, y1 }, ir: bytes.slice(at, at + len) });
    at += len;
  }
  return out;
}
