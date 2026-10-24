/**
 * Build manifest (`sf-manifest.json`, format `sf-manifest/1`): logical chunk id →
 * hashed files, css, deps, tier, budget, profiles. Manifests survive deploys: ids
 * are stable, files change (R12.2). Pure functions only — usable at build time,
 * in the service worker and at runtime.
 */
import { err, ok, type Result } from '@staticflux/core';
import type { ChunkIdShape, WarmupTier } from './chunk.js';
import { WARMUP_TIERS } from './chunk.js';
import { InvalidManifestError, UnknownChunkError } from './errors.js';

export const MANIFEST_FORMAT = 'sf-manifest/1' as const;
export const MANIFEST_FILE_NAME = 'sf-manifest.json' as const;

/** Module-Federation-style remote: the chunk is served by a remote container. */
export interface ManifestRemote {
  /** Remote entry (container) URL, relative to `base` or absolute. */
  readonly entry: string;
  /** Exposed module name, e.g. `./Panel`. */
  readonly module: string;
  /** Shared singletons the remote needs: name → semver range (`^7.0.0`). */
  readonly shared?: Readonly<Record<string, string>>;
}

export interface ManifestChunk {
  readonly id: ChunkIdShape;
  /** Hashed JS files; the first one is the entry module, the rest are its static imports. */
  readonly files: readonly string[];
  readonly css: readonly string[];
  /** Logical chunk dependencies. */
  readonly deps: readonly ChunkIdShape[];
  readonly tier: WarmupTier;
  readonly load: 'lazy' | 'eager';
  /** Mandatory for eager chunks (R12.12). */
  readonly reason?: string;
  readonly eagerProfiles?: readonly string[];
  /** Gzip size of `files` in KB, when the bundler reported it. */
  readonly sizeKb?: number;
  readonly budgetKb?: number;
  readonly profiles?: readonly string[];
  /** Subresource integrity per file (`sha384-…`). */
  readonly integrity?: Readonly<Record<string, string>>;
  readonly remote?: ManifestRemote;
}

export interface SfManifest {
  readonly format: typeof MANIFEST_FORMAT;
  /** Build id (e.g. git sha); doubles as the precache revision for unhashed files. */
  readonly buildId: string;
  /** URL prefix for files (e.g. `/assets/`). */
  readonly base: string;
  readonly chunks: Readonly<Record<string, ManifestChunk>>;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/** Validate untrusted JSON (fetched manifest) into a typed manifest. */
export function parseManifest(json: unknown): Result<SfManifest> {
  const bad = (reason: string, details: Record<string, unknown> = {}): Result<SfManifest> =>
    err(InvalidManifestError({ message: `Invalid build manifest: ${reason}.`, details }));
  if (typeof json !== 'object' || json === null) return bad('not an object');
  const raw = json as Record<string, unknown>;
  if (raw['format'] !== MANIFEST_FORMAT) return bad('unsupported format', { format: String(raw['format']) });
  if (typeof raw['buildId'] !== 'string' || typeof raw['base'] !== 'string') return bad('missing buildId/base');
  const chunks = raw['chunks'];
  if (typeof chunks !== 'object' || chunks === null) return bad('missing chunks');
  for (const [id, value] of Object.entries(chunks as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) return bad('chunk is not an object', { chunk: id });
    const c = value as Record<string, unknown>;
    if (c['id'] !== id) return bad('chunk id does not match its key', { chunk: id });
    if (!isStringArray(c['files']) || c['files'].length === 0) return bad('chunk has no files', { chunk: id });
    if (!isStringArray(c['css']) || !isStringArray(c['deps'])) return bad('chunk css/deps malformed', { chunk: id });
    if (!(WARMUP_TIERS as readonly unknown[]).includes(c['tier'])) return bad('unknown tier', { chunk: id });
    if (c['load'] !== 'lazy' && c['load'] !== 'eager') return bad('unknown load mode', { chunk: id });
    if (c['load'] === 'eager' && (typeof c['reason'] !== 'string' || c['reason'] === '')) {
      return bad('eager chunk without reason', { chunk: id });
    }
    for (const dep of c['deps']) {
      if (!(dep in (chunks as Record<string, unknown>))) return bad('unknown dependency', { chunk: id, dep });
    }
  }
  return ok(json as SfManifest);
}

export function getChunk(manifest: SfManifest, id: ChunkIdShape): Result<ManifestChunk> {
  const found = manifest.chunks[id];
  if (found === undefined) return err(UnknownChunkError({ message: `Chunk "${id}" is not in the build manifest.`, details: { chunk: id } }));
  return ok(found);
}

/** Absolute-ish URL of a manifest file (`base` + file unless the file is already absolute). */
export function fileUrl(manifest: SfManifest, file: string): string {
  if (/^([a-z]+:)?\/\//i.test(file) || file.startsWith('/')) return file;
  return `${manifest.base}${file}`;
}

/**
 * Dependency closure of `ids` in load order (dependencies first, each once).
 * Cycles are tolerated (a chunk is visited once). Unknown ids → SF-LOAD-001.
 */
export function chunkClosure(manifest: SfManifest, ids: readonly ChunkIdShape[]): Result<readonly ManifestChunk[]> {
  const out: ManifestChunk[] = [];
  const seen = new Set<string>();
  const visit = (id: ChunkIdShape): Result<void> => {
    if (seen.has(id)) return ok();
    seen.add(id);
    const found = getChunk(manifest, id);
    if (!found.ok) return err(found.error);
    for (const dep of found.value.deps) {
      const visited = visit(dep);
      if (!visited.ok) return visited;
    }
    out.push(found.value);
    return ok();
  };
  for (const id of ids) {
    const visited = visit(id);
    if (!visited.ok) return err(visited.error);
  }
  return ok(out);
}

export interface ChunkUrls {
  /** Entry module URL of each chunk, dependencies first. */
  readonly entries: readonly string[];
  /** Every JS file URL (for `modulepreload`), deduplicated, dependencies first. */
  readonly modules: readonly string[];
  readonly stylesheets: readonly string[];
}

/** URLs needed for `ids` and their dependencies. */
export function urlsFor(manifest: SfManifest, ids: readonly ChunkIdShape[]): Result<ChunkUrls> {
  const closure = chunkClosure(manifest, ids);
  if (!closure.ok) return err(closure.error);
  const modules = new Set<string>();
  const stylesheets = new Set<string>();
  const entries: string[] = [];
  for (const c of closure.value) {
    const [first] = c.files;
    if (first !== undefined) entries.push(fileUrl(manifest, first));
    for (const file of c.files) modules.add(fileUrl(manifest, file));
    for (const file of c.css) stylesheets.add(fileUrl(manifest, file));
  }
  return ok({ entries, modules: [...modules], stylesheets: [...stylesheets] });
}

export interface PrecacheEntry {
  readonly url: string;
  /** `null` for hashed files (the hash is the revision), Workbox-compatible. */
  readonly revision: string | null;
}

export interface PrecacheOptions {
  /** Restrict to chunks serving this profile key. */
  readonly profile?: string;
  /** Additional tiers to precache (default: critical only). */
  readonly tiers?: readonly WarmupTier[];
  /** Recognize hashed file names (default: `name.<8+ hex/base64url chars>.ext`). */
  readonly isHashed?: (file: string) => boolean;
}

const HASHED = /[.-][A-Za-z0-9_-]{8,}\.(m?js|css|wasm)$/;

export function servesProfile(c: ManifestChunk, profile: string | undefined): boolean {
  return profile === undefined || c.profiles === undefined || c.profiles.includes(profile);
}

/**
 * Service-worker precache list for the critical tier (Workbox `{ url, revision }` shape),
 * including the dependency closure of critical chunks.
 */
export function precacheList(manifest: SfManifest, options: PrecacheOptions = {}): readonly PrecacheEntry[] {
  const tiers = new Set<WarmupTier>(['critical', ...(options.tiers ?? [])]);
  const isHashed = options.isHashed ?? ((file: string) => HASHED.test(file));
  const roots = Object.values(manifest.chunks)
    .filter((c) => tiers.has(c.tier) && servesProfile(c, options.profile))
    .map((c) => c.id);
  const closure = chunkClosure(manifest, roots);
  if (!closure.ok) return [];
  const seen = new Set<string>();
  const out: PrecacheEntry[] = [];
  for (const c of closure.value) {
    for (const file of [...c.files, ...c.css]) {
      const url = fileUrl(manifest, file);
      if (seen.has(url)) continue;
      seen.add(url);
      out.push({ url, revision: isHashed(file) ? null : manifest.buildId });
    }
  }
  return out;
}

/** Bare specifier a chunk gets in an import map (`@sf/chunk/feature:studio`). */
export function chunkSpecifier(id: ChunkIdShape): string {
  return `@sf/chunk/${id}`;
}

export interface ImportMap {
  readonly imports: Readonly<Record<string, string>>;
  readonly integrity?: Readonly<Record<string, string>>;
}

/** The manifest as an import map: stable specifiers in code, hashed files in deployment. */
export function toImportMap(manifest: SfManifest): ImportMap {
  const imports: Record<string, string> = {};
  const integrity: Record<string, string> = {};
  for (const c of Object.values(manifest.chunks)) {
    const [first] = c.files;
    if (first === undefined || c.remote !== undefined) continue;
    const url = fileUrl(manifest, first);
    imports[chunkSpecifier(c.id)] = url;
    for (const [file, hash] of Object.entries(c.integrity ?? {})) integrity[fileUrl(manifest, file)] = hash;
  }
  return Object.keys(integrity).length > 0 ? { imports, integrity } : { imports };
}

/**
 * URL → owning chunk id (first chunk listing the file). Feeds perf's long-frame
 * attribution (LoAF `scripts[].sourceURL` → chunk → feature).
 */
export function urlToChunkMap(manifest: SfManifest): ReadonlyMap<string, ChunkIdShape> {
  const map = new Map<string, ChunkIdShape>();
  const chunks = Object.values(manifest.chunks);
  // Entry files and css first: a shared vendor file is attributed to the first chunk importing it.
  for (const c of chunks) {
    for (const file of [...c.files.slice(0, 1), ...c.css]) map.set(fileUrl(manifest, file), c.id);
  }
  for (const c of chunks) {
    for (const file of c.files.slice(1)) {
      const url = fileUrl(manifest, file);
      if (!map.has(url)) map.set(url, c.id);
    }
  }
  return map;
}

/** Attribution function for a script URL (absolute URLs are matched by path suffix). */
export function chunkAttributor(manifest: SfManifest): (url: string) => ChunkIdShape | undefined {
  const map = urlToChunkMap(manifest);
  return (url) => {
    const direct = map.get(url);
    if (direct !== undefined) return direct;
    for (const [known, id] of map) if (url.endsWith(known)) return id;
    return undefined;
  };
}
