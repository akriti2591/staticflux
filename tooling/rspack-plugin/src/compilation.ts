/**
 * Minimal structural view of an Rspack / webpack 5 compiler and compilation — only what the
 * plugin reads — plus the adapter from chunk groups to the loader's `BundlerOutput`.
 *
 * Mapping: every chunk group (entrypoint or `import()` group) is one candidate logical chunk.
 * Its *main* chunk (the chunk named like the group, else the last chunk — split chunks are
 * inserted before it) becomes the `BundlerChunk` whose first JS file is the entry module; the
 * group's other chunks (split vendors) are its static `imports`, so the manifest closure lists
 * every file the group needs. Matching a declaration to a group:
 * - by **name**: entry name or `/* webpackChunkName: "feature.studio" *\/` = `chunkNameFor(id)`
 *   (the default when a declaration has no `entry`), or
 * - by **request**: a declaration `entry` (`src/features/studio.ts`) whose path, without
 *   extension, ends with the group's `import()`/entry request (`./features/studio`).
 */
import type { BundlerChunk, BundlerOutput, ChunkDeclaration } from '@staticflux/loader';

export interface SourceLike {
  source(): string | Uint8Array | ArrayBuffer;
  size(): number;
}

export interface AssetLike {
  readonly name: string;
  readonly source: SourceLike;
}

export interface ChunkLike {
  readonly name?: string | null | undefined;
  readonly files: Iterable<string>;
  readonly auxiliaryFiles?: Iterable<string>;
}

export interface ChunkGroupOriginLike {
  readonly request?: string | null | undefined;
}

export interface ChunkGroupLike {
  readonly name?: string | null | undefined;
  readonly chunks: readonly ChunkLike[];
  readonly origins?: readonly ChunkGroupOriginLike[];
}

export interface TapHook<Args extends unknown[]> {
  tap(options: string | { readonly name: string; readonly stage?: number }, fn: (...args: Args) => void): void;
}

export interface CompilationLike {
  readonly hooks: { readonly processAssets: TapHook<[assets: Readonly<Record<string, unknown>>]> };
  readonly chunkGroups: readonly ChunkGroupLike[];
  /** Entrypoint chunk groups by name (`compilation.entrypoints`); the app entries' closure is boot code. */
  readonly entrypoints?: { values(): Iterable<ChunkGroupLike> };
  getAsset(name: string): AssetLike | undefined | void;
  emitAsset(name: string, source: SourceLike): void;
  readonly errors: { push(...errors: Error[]): unknown };
  readonly warnings: { push(...errors: Error[]): unknown };
  readonly outputOptions?: { readonly publicPath?: unknown };
}

export interface CompilerLike {
  readonly hooks: { readonly thisCompilation: TapHook<[compilation: CompilationLike, ...rest: unknown[]]> };
  /** `compiler.webpack` / `compiler.rspack`: the bundler's own Source class and stage constants. */
  readonly webpack?: {
    readonly sources?: { readonly RawSource: new (source: string) => SourceLike };
    readonly Compilation?: { readonly PROCESS_ASSETS_STAGE_REPORT?: number };
  };
  readonly context?: string;
  readonly options?: { readonly output?: { readonly publicPath?: unknown }; readonly context?: string };
}

/** Rspack/webpack `PROCESS_ASSETS_STAGE_REPORT`: after minification and real content hashing. */
export const STAGE_REPORT = 5000;

const isJs = (file: string): boolean => /\.m?js$/.test(file.split('?')[0] ?? file);
const isCss = (file: string): boolean => /\.css$/.test(file.split('?')[0] ?? file);

function filesOf(c: ChunkLike): string[] {
  return [...c.files, ...(c.auxiliaryFiles ?? [])];
}

/** Text of an emitted asset (for size and integrity). */
export function assetText(compilation: Pick<CompilationLike, 'getAsset'>, file: string): string {
  const asset = compilation.getAsset(file);
  if (asset === undefined || asset === null) return '';
  const raw = asset.source.source();
  if (typeof raw === 'string') return raw;
  return new TextDecoder().decode(raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw);
}

/** Path without leading `./`/`../` segments and without extension, forward slashes. */
export function normalizeRequest(request: string): string {
  return request
    .replace(/\\/g, '/')
    .replace(/^(\.{1,2}\/)+/, '')
    .replace(/\.[cm]?[jt]sx?$/, '');
}

function mainChunkOf(group: ChunkGroupLike): ChunkLike | undefined {
  const named = group.name === undefined || group.name === null ? undefined : group.chunks.find((c) => c.name === group.name);
  return named ?? group.chunks.filter((c) => [...c.files].some(isJs)).at(-1);
}

/** Synthetic name for an unnamed group (only used for matching inside one build). */
const groupKey = (index: number): string => `sf-group-${index}`;

export interface FromCompilationOptions {
  readonly sizeOf?: (fileName: string, code: string) => number;
  readonly integrityOf?: (fileName: string, code: string) => string;
}

export interface CompilationOutput extends BundlerOutput {
  /** Normalized `import()`/entry request → group name (for request matching). */
  readonly requests: ReadonlyMap<string, string>;
}

/** Entry JS file of each entrypoint group (its main chunk's first JS file). */
export function entrypointFiles(compilation: Pick<CompilationLike, 'entrypoints'>, exclude: ReadonlySet<string> = new Set()): string[] {
  const out: string[] = [];
  for (const group of compilation.entrypoints?.values() ?? []) {
    if (group.name !== undefined && group.name !== null && exclude.has(group.name)) continue;
    const main = mainChunkOf(group);
    const file = main === undefined ? undefined : [...main.files].find(isJs);
    if (file !== undefined) out.push(file);
  }
  return out;
}

/** Group name for a module path (`src/boot.ts` matches the `import('./boot')` / entry request), else undefined. */
export function groupForModule(path: string, requests: ReadonlyMap<string, string>): string | undefined {
  const wanted = normalizeRequest(path);
  let best: { request: string; name: string } | undefined;
  for (const [request, name] of requests) {
    const hit = wanted === request || wanted.endsWith(`/${request}`);
    if (hit && (best === undefined || request.length > best.request.length)) best = { request, name };
  }
  return best?.name;
}

/** Adapt chunk groups to the loader's `BundlerOutput`. */
export function fromCompilation(compilation: Pick<CompilationLike, 'chunkGroups' | 'getAsset'>, options: FromCompilationOptions = {}): CompilationOutput {
  const byFile = new Map<string, BundlerChunk>();
  const requests = new Map<string, string>();
  const measured = (file: string): Pick<BundlerChunk, 'sizeKb' | 'integrity'> => {
    if (options.sizeOf === undefined && options.integrityOf === undefined) return {};
    const code = assetText(compilation, file);
    return {
      ...(options.sizeOf === undefined ? {} : { sizeKb: options.sizeOf(file, code) }),
      ...(options.integrityOf === undefined ? {} : { integrity: options.integrityOf(file, code) }),
    };
  };
  const add = (chunk: BundlerChunk): void => {
    const existing = byFile.get(chunk.fileName);
    if (existing === undefined) {
      byFile.set(chunk.fileName, chunk);
      return;
    }
    byFile.set(chunk.fileName, {
      ...existing,
      ...(existing.name === undefined && chunk.name !== undefined ? { name: chunk.name } : {}),
      imports: [...new Set([...existing.imports, ...chunk.imports])],
      css: [...new Set([...(existing.css ?? []), ...(chunk.css ?? [])])],
    });
  };

  compilation.chunkGroups.forEach((group, index) => {
    const main = mainChunkOf(group);
    if (main === undefined) return;
    const mainJs = [...main.files].filter(isJs);
    const [entryFile, ...restMain] = mainJs;
    if (entryFile === undefined) return;
    const name = group.name ?? groupKey(index);
    const others = group.chunks.filter((c) => c !== main).flatMap((c) => [...c.files].filter(isJs));
    const css = [...new Set(group.chunks.flatMap((c) => filesOf(c).filter(isCss)))];
    for (const origin of group.origins ?? []) {
      if (typeof origin.request === 'string' && origin.request !== '') requests.set(normalizeRequest(origin.request), name);
    }
    add({ fileName: entryFile, name, imports: [...restMain, ...others], css, ...measured(entryFile) });
    for (const file of [...restMain, ...others]) add({ fileName: file, imports: [], ...measured(file) });
  });
  return { chunks: [...byFile.values()], requests };
}

/**
 * Rewrite declarations so `createManifest` matches them by group name: a module-path `entry`
 * that ends with a group's request becomes that group's name; entry-less declarations use
 * `defaultName(id)`.
 */
export function resolveDeclarations(
  declarations: readonly ChunkDeclaration[],
  requests: ReadonlyMap<string, string>,
  defaultName: (id: string) => string,
): readonly ChunkDeclaration[] {
  return declarations.map((d) => {
    if (d.entry === undefined) return { ...d, entry: defaultName(d.id) };
    const name = groupForModule(d.entry, requests);
    return name === undefined ? d : { ...d, entry: name };
  });
}
