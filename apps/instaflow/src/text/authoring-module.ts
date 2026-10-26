/**
 * The authoring Wasm module (`apps/instaflow/engine/crates/authoring`, ABI 2) as TypeScript sees it, and its
 * loader (plus the lazy web font decoder build, B12: `loadWebfontModule`). Two text builds share the exports: `authoring` (loaded by the editor worker at boot, ≤ 350 KB brotli) and
 * `authoring-complex` (Parley `complex-scripts`, ≈ 2.2 MB brotli, loaded only when text needs dictionary line
 * breaking: Thai, Lao, Khmer, Myanmar; S3). Hashed names come from `sf-wasm-manifest.json`; never hard-code them.
 */
import { err, ok, type Result, toSfError } from '@staticflux/core';
import { AuthoringModuleError } from './errors.js';

/** ABI this TypeScript expects (`abi_version()` in the crate's lib.rs). */
export const AUTHORING_ABI_VERSION = 2;

export const AUTHORING_BUILDS = { base: 'authoring-text', complex: 'authoring-text-complex', webfont: 'authoring-webfont' } as const;
export type AuthoringBuild = keyof typeof AUTHORING_BUILDS;

/** `TextEngine` in `crates/authoring/src/wasm.rs`. Rect arrays are flat `[x0, y0, x1, y1, …]`. */
export interface TextEngineWasm {
  add_font(bytes: Uint8Array): Uint32Array;
  family_names(): string;
  set_fallbacks(script: string, families: string): void;
  set_generic(generic: string, families: string): void;
  layout(id: number, spec: Uint8Array): Float32Array;
  drop_block(id: number): boolean;
  block_count(): number;
  hit_test(id: number, x: number, y: number): Float32Array;
  caret(id: number, offset: number, upstream: boolean, width: number): Float32Array;
  selection_rects(id: number, a: number, b: number): Float32Array;
  char_bounds(id: number, a: number, b: number): Float32Array;
  word_at(id: number, offset: number): Uint32Array;
  move_caret(id: number, offset: number, upstream: boolean, motion: number, xHint: number): Float32Array;
  free(): void;
}

export interface AuthoringWasm {
  abi_version(): number;
  complex_scripts(): boolean;
  TextEngine: new () => TextEngineWasm;
}

/** The lazy `authoring-webfont` build (B12, T-7): WOFF2 / WOFF → OpenType (`crates/authoring/src/webfont.rs`). */
export interface WebfontWasm {
  abi_version(): number;
  /** OpenType bytes; throws the reason for a file that is not a (valid) WOFF2 or WOFF. */
  decode_webfont(bytes: Uint8Array): Uint8Array;
}

/** Load the web font decoder build (fetched only when someone adds a WOFF2 or WOFF font). */
export async function loadWebfontModule(options: Omit<LoadAuthoringModuleOptions, 'build'>): Promise<Result<WebfontWasm>> {
  const loaded = await loadAuthoringModule({ ...options, build: 'webfont' });
  return loaded.ok ? ok(loaded.value as unknown as WebfontWasm) : loaded;
}

interface WasmManifest {
  readonly format: string;
  readonly artifacts: readonly { readonly crate: string; readonly wasm: string; readonly js: string }[];
}

export interface LoadAuthoringModuleOptions {
  /** URL of `sf-wasm-manifest.json` (the engine's dist directory). */
  readonly manifestUrl: string | URL;
  /** Which build (default `base`). */
  readonly build?: AuthoringBuild;
  readonly signal?: AbortSignal;
  /** Injected for tests and Node: `fetch`, dynamic `import`, and how the glue gets its Wasm bytes. */
  readonly fetch?: (url: string, init?: { readonly signal?: AbortSignal }) => Promise<{ readonly ok: boolean; readonly status: number; json(): Promise<unknown> }>;
  readonly importModule?: (url: string) => Promise<unknown>;
  /** Default: the glue fetches the Wasm URL itself. Node passes the bytes (`{ module_or_path: bytes }`). */
  readonly wasmSource?: (url: string) => Promise<unknown>;
}

/** Load and instantiate an authoring build named in the Wasm manifest, checking its ABI. */
export async function loadAuthoringModule(options: LoadAuthoringModuleOptions): Promise<Result<AuthoringWasm>> {
  const doFetch = options.fetch ?? ((url, init) => fetch(url, init as RequestInit));
  const doImport = options.importModule ?? ((url) => import(/* @vite-ignore */ url));
  const crate = AUTHORING_BUILDS[options.build ?? 'base'];
  try {
    const manifestUrl = new URL(String(options.manifestUrl), globalThis.location?.href);
    const response = await doFetch(manifestUrl.href, options.signal === undefined ? {} : { signal: options.signal });
    if (!response.ok) return err(AuthoringModuleError({ message: `Authoring Wasm manifest: HTTP ${response.status}.`, details: { url: manifestUrl.href } }));
    const manifest = (await response.json()) as WasmManifest;
    const entry = manifest.artifacts?.find((a) => a.crate === crate);
    if (manifest.format !== 'sf-wasm-manifest/1' || entry === undefined) {
      return err(AuthoringModuleError({ message: `The Wasm manifest has no ${crate} artifact (run \`pnpm build\`).`, details: { url: manifestUrl.href } }));
    }
    options.signal?.throwIfAborted();
    const glue = (await doImport(new URL(entry.js, manifestUrl).href)) as AuthoringWasm & { default(input: { module_or_path: unknown }): Promise<unknown> };
    const wasmUrl = new URL(entry.wasm, manifestUrl).href;
    await glue.default({ module_or_path: options.wasmSource === undefined ? wasmUrl : await options.wasmSource(wasmUrl) });
    if (glue.abi_version() !== AUTHORING_ABI_VERSION) {
      return err(AuthoringModuleError({ message: `Authoring Wasm ABI ${glue.abi_version()} does not match ${AUTHORING_ABI_VERSION}.`, details: { expected: AUTHORING_ABI_VERSION, got: glue.abi_version() } }));
    }
    return ok(glue);
  } catch (cause) {
    const error = toSfError(cause);
    return err(error.kind === 'aborted' ? error : AuthoringModuleError({ cause, message: `Loading the authoring Wasm failed: ${String((cause as Error)?.message ?? cause)}` }));
  }
}
