/**
 * `sf wasm build <engine-dir>` — builds a Rust workspace to Wasm as part of
 * `pnpm build` (IF-2.10, SF-Δ32):
 *
 *   cargo build --target wasm32-unknown-unknown --release  (RUSTFLAGS=-C target-feature=+simd128)
 *   → wasm-bindgen --target web, CLI version = the locked `wasm-bindgen` crate version
 *     (installed into `<engine>/.tools` with `cargo install --locked` when not on PATH)
 *   → wasm-opt (binaryen from the root devDependencies)
 *   → content-hashed `<crate>.<hash>.wasm` / `.js` in `<engine>/<outDir>` + `sf-wasm-manifest.json`.
 *
 * **Caching:** the manifest records a hash of every input (engine sources,
 * Cargo.lock, rust-toolchain.toml, `sf-wasm.json`, rustc and wasm-opt versions).
 * When it matches and the artifacts exist, the build is skipped.
 *
 * **Feature builds:** a crate entry with `package` and/or `features` (e.g. the lazy `authoring-complex` chunk:
 * `{ "name": "authoring-complex", "package": "authoring", "features": ["complex-scripts"] }`) is built by its
 * own `cargo build -p <package> --features …` into `target/sf-variants/<name>`, so its features never unify
 * with the plain crates' build (cargo unifies features within one invocation).
 *
 * **No Rust locally:** a missing toolchain skips the build with a warning;
 * with `requireRust` (`SF_REQUIRE_RUST=1`, CI) it is an error (SF-TOOL-008).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import { err, ok, type Result, type SfError } from '@staticflux/core';
import { InvalidJson, RustToolchainMissing, ToolAborted, ToolStepFailed } from './errors.js';
import { listFilesRecursive, readJson, readText } from './files.js';
import type { RunOptions, Runner } from './publish.js';
import { probeRustToolchain, WASM_TARGET } from './rust-toolchain.js';
import { compressedSize } from './wasm-budgets.js';

export const WASM_CONFIG_FILE = 'sf-wasm.json';
export const WASM_CONFIG_FORMAT = 'sf-wasm/1';
export const WASM_MANIFEST_FILE = 'sf-wasm-manifest.json';
export const WASM_MANIFEST_FORMAT = 'sf-wasm-manifest/1';
/** wasm-opt flags matching what rustc's wasm32 target emits (S1 build) plus SIMD. */
export const DEFAULT_WASM_OPT_ARGS: readonly string[] = [
  '-Oz',
  '--enable-bulk-memory',
  '--enable-nontrapping-float-to-int',
  '--enable-sign-ext',
  '--enable-reference-types',
  '--enable-multivalue',
  '--enable-mutable-globals',
  '--enable-simd',
];
const HASH_LENGTH = 16;

export interface WasmCrateConfig {
  /** Artifact name (the output stem is the name with `-` → `_`); also the cargo package unless `package` is set. */
  readonly name: string;
  /** Cargo package to build when it differs from `name` (a feature build of another crate). */
  readonly package?: string;
  /** Cargo features for this artifact; built in its own cargo invocation and target dir. */
  readonly features?: readonly string[];
}

/** True when the entry needs its own cargo invocation (features or another package). */
export function isVariantCrate(crate: WasmCrateConfig): boolean {
  return (crate.features !== undefined && crate.features.length > 0) || (crate.package !== undefined && crate.package !== crate.name);
}

/** Target dir of a variant build, relative to the engine dir. */
export function variantTargetDir(crate: WasmCrateConfig): string {
  return join('target', 'sf-variants', crate.name);
}

export interface WasmBuildConfig {
  readonly format: typeof WASM_CONFIG_FORMAT;
  /** Output directory relative to the engine dir. Default `dist`. */
  readonly outDir?: string;
  /** Compile with `-C target-feature=+simd128`. Default true (S1: 4.6–7× faster strip prep, smaller modules). */
  readonly simd?: boolean;
  /** wasm-opt arguments before the input file. Default `DEFAULT_WASM_OPT_ARGS`. */
  readonly wasmOpt?: readonly string[];
  readonly crates: readonly WasmCrateConfig[];
}

export interface WasmArtifact {
  readonly crate: string;
  /** File names inside the output dir. */
  readonly wasm: string;
  readonly js: string;
  /** sha256 of the optimized `.wasm`. */
  readonly sha256: string;
  readonly bytes: { readonly raw: number; readonly gzip: number; readonly brotli: number };
}

export interface WasmManifest {
  readonly format: typeof WASM_MANIFEST_FORMAT;
  readonly inputsHash: string;
  readonly toolchain: { readonly rustc: string; readonly wasmBindgen: string; readonly wasmOpt: string };
  readonly simd: boolean;
  readonly artifacts: readonly WasmArtifact[];
}

export type WasmBuildOutcome =
  | { readonly status: 'built' | 'up-to-date'; readonly manifest: WasmManifest; readonly outDir: string }
  | { readonly status: 'skipped'; readonly reason: string };

export interface WasmBuildOptions {
  /** Repo root: `node_modules/.bin/wasm-opt` is resolved here. */
  readonly root: string;
  /** Engine (Cargo workspace) directory, relative to `root` or absolute. */
  readonly engineDir: string;
  readonly runner: Runner;
  /** Missing toolchain is an error instead of a skip; cargo runs with `--locked`. */
  readonly requireRust?: boolean;
  /** Ignore the cache. */
  readonly force?: boolean;
  readonly log?: (line: string) => void;
  readonly signal?: AbortSignal;
  readonly exists?: (path: string) => boolean;
}

export function parseWasmConfig(json: unknown, source = WASM_CONFIG_FILE): Result<WasmBuildConfig> {
  if (typeof json !== 'object' || json === null) return err(InvalidJson({ message: `${source} must be an object.` }));
  const c = json as Record<string, unknown>;
  const problems: string[] = [];
  if (c['format'] !== WASM_CONFIG_FORMAT) problems.push(`"format" must be "${WASM_CONFIG_FORMAT}"`);
  if (c['outDir'] !== undefined && (typeof c['outDir'] !== 'string' || c['outDir'].length === 0 || c['outDir'].startsWith('..'))) problems.push('"outDir" must be a path inside the engine dir');
  if (c['simd'] !== undefined && typeof c['simd'] !== 'boolean') problems.push('"simd" must be a boolean');
  if (c['wasmOpt'] !== undefined && !(Array.isArray(c['wasmOpt']) && c['wasmOpt'].every((a) => typeof a === 'string'))) problems.push('"wasmOpt" must be an array of strings');
  const crates = c['crates'];
  if (!Array.isArray(crates) || crates.length === 0) problems.push('"crates" must be a non-empty array');
  else
    crates.forEach((crate: unknown, i) => {
      const entry = crate as { name?: unknown; package?: unknown; features?: unknown } | null;
      const name = entry?.name;
      if (typeof name !== 'string' || !/^[A-Za-z0-9_-]+$/.test(name)) problems.push(`crates[${i}].name must be a cargo package name`);
      if (entry?.package !== undefined && (typeof entry.package !== 'string' || !/^[A-Za-z0-9_-]+$/.test(entry.package))) problems.push(`crates[${i}].package must be a cargo package name`);
      if (entry?.features !== undefined && !(Array.isArray(entry.features) && entry.features.every((f) => typeof f === 'string' && /^[A-Za-z0-9_/-]+$/.test(f)))) {
        problems.push(`crates[${i}].features must be an array of cargo feature names`);
      }
    });
  if (problems.length > 0) return err(InvalidJson({ message: `${source}: ${problems.join('; ')}.` }));
  return ok(c as unknown as WasmBuildConfig);
}

/** Version of `name` in a Cargo.lock (first match), e.g. `0.2.129` for `wasm-bindgen`. */
export function lockedVersion(lockText: string, name: string): string | undefined {
  const blocks = lockText.split(/^\[\[package\]\]\s*$/m);
  for (const block of blocks) {
    const n = /^name\s*=\s*"([^"]+)"\s*$/m.exec(block)?.[1];
    if (n === name) return /^version\s*=\s*"([^"]+)"\s*$/m.exec(block)?.[1];
  }
  return undefined;
}

/** RUSTFLAGS for the build. */
export function wasmRustflags(config: WasmBuildConfig): string {
  return config.simd === false ? '' : '-C target-feature=+simd128';
}

/** Hex sha256, optionally truncated. */
export function contentHash(bytes: Uint8Array | string, length = 64): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, length);
}

/** Every input file of the engine (sources, manifests, lockfile, toolchain file), skipping build outputs, dot-dirs and Markdown docs. */
export function engineInputFiles(engineDir: string, outDir: string): string[] {
  const out = resolve(engineDir, outDir) + sep;
  const target = join(engineDir, 'target') + sep;
  return listFilesRecursive(engineDir)
    .filter((f) => !f.startsWith(out) && !f.startsWith(target) && !f.endsWith('.md'))
    .sort();
}

/** One hash over input file paths + contents and the given extra strings (tool versions, flags). */
export function fingerprintInputs(engineDir: string, files: readonly string[], extra: readonly string[]): string {
  const hash = createHash('sha256');
  for (const value of extra) hash.update(`extra\0${value}\0`);
  for (const file of files) {
    hash.update(`file\0${relative(engineDir, file).split(sep).join('/')}\0`);
    hash.update(readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** Point wasm-bindgen's `--target web` glue at the hashed file name. Returns the input unchanged when the name is absent. */
export function rewriteGlue(js: string, fromWasm: string, toWasm: string): string {
  return js.split(`'${fromWasm}'`).join(`'${toWasm}'`).split(`"${fromWasm}"`).join(`"${toWasm}"`);
}

export function readWasmManifest(path: string): WasmManifest | undefined {
  const json = readJson(path);
  if (!json.ok) return undefined;
  const m = json.value as Partial<WasmManifest> | null;
  return m?.format === WASM_MANIFEST_FORMAT && typeof m.inputsHash === 'string' && Array.isArray(m.artifacts) ? (m as WasmManifest) : undefined;
}

function failed(command: string, args: readonly string[], cwd: string, output: string): SfError {
  const tail = output.trim().split('\n').slice(-8).join('\n');
  return ToolStepFailed({ message: `\`${command} ${args.join(' ')}\` failed in ${cwd}:\n${tail}`, details: { command, cwd } });
}

/** Find a wasm-bindgen CLI of exactly `version` (engine `.tools`, then PATH) or install it into `.tools`. */
export async function resolveWasmBindgen(runner: Runner, engineDir: string, version: string, options: RunOptions & { log?: (line: string) => void } = {}): Promise<Result<string>> {
  const run = { ...(options.signal === undefined ? {} : { signal: options.signal }) };
  const local = join(engineDir, '.tools', 'bin', 'wasm-bindgen');
  for (const candidate of [local, 'wasm-bindgen']) {
    const probe = await runner.run(candidate, ['--version'], engineDir, run);
    if (probe.code === 0 && probe.stdout.trim().split(/\s+/).includes(version)) return ok(candidate);
  }
  options.log?.(`installing wasm-bindgen-cli ${version} into ${join(engineDir, '.tools')} (matches the locked wasm-bindgen crate)`);
  const args = ['install', 'wasm-bindgen-cli', '--version', version, '--locked', '--root', join(engineDir, '.tools')];
  const install = await runner.run('cargo', args, engineDir, run);
  if (install.code !== 0) return err(failed('cargo', args, engineDir, install.stderr));
  return ok(local);
}

export async function buildWasm(options: WasmBuildOptions): Promise<Result<WasmBuildOutcome>> {
  const { runner } = options;
  const log = options.log ?? ((): void => undefined);
  const exists = options.exists ?? existsSync;
  const run = { ...(options.signal === undefined ? {} : { signal: options.signal }) };
  const aborted = (): boolean => options.signal?.aborted === true;
  const engineDir = resolve(options.root, options.engineDir);

  const configJson = readJson(join(engineDir, WASM_CONFIG_FILE));
  if (!configJson.ok) return configJson;
  const parsed = parseWasmConfig(configJson.value, join(options.engineDir, WASM_CONFIG_FILE));
  if (!parsed.ok) return parsed;
  const config = parsed.value;
  const outDir = resolve(engineDir, config.outDir ?? 'dist');

  const probe = await probeRustToolchain(runner, engineDir, { exists, ...run });
  if (aborted()) return err(ToolAborted());
  if (!probe.ok) {
    if (options.requireRust === true) return err(RustToolchainMissing({ message: `Cannot build ${options.engineDir}: ${probe.missing}.` }));
    return ok({ status: 'skipped', reason: probe.missing });
  }

  const wasmOptBin = join(options.root, 'node_modules', '.bin', 'wasm-opt');
  const wasmOptVersion = await runner.run(wasmOptBin, ['--version'], engineDir, run);
  if (wasmOptVersion.code !== 0) return err(failed(wasmOptBin, ['--version'], engineDir, wasmOptVersion.stderr || 'wasm-opt not found; run `pnpm install`'));

  const wasmOptArgs = config.wasmOpt ?? DEFAULT_WASM_OPT_ARGS;
  const rustflags = wasmRustflags(config);
  const inputsHash = fingerprintInputs(engineDir, engineInputFiles(engineDir, config.outDir ?? 'dist'), [
    probe.toolchain.rustc,
    wasmOptVersion.stdout.trim(),
    rustflags,
    wasmOptArgs.join(' '),
  ]);
  const manifestPath = join(outDir, WASM_MANIFEST_FILE);
  const previous = readWasmManifest(manifestPath);
  if (options.force !== true && previous !== undefined && previous.inputsHash === inputsHash && previous.artifacts.every((a) => exists(join(outDir, a.wasm)) && exists(join(outDir, a.js)))) {
    return ok({ status: 'up-to-date', manifest: previous, outDir });
  }

  const locked = options.requireRust === true ? ['--locked'] : [];
  const plain = config.crates.filter((c) => !isVariantCrate(c));
  const invocations: string[][] = [];
  if (plain.length > 0) invocations.push(['build', '--target', WASM_TARGET, '--release', ...plain.flatMap((c) => ['-p', c.name]), ...locked]);
  for (const crate of config.crates.filter(isVariantCrate)) {
    const features = crate.features ?? [];
    invocations.push(['build', '--target', WASM_TARGET, '--release', '-p', crate.package ?? crate.name, ...(features.length > 0 ? ['--features', features.join(',')] : []), '--target-dir', variantTargetDir(crate), ...locked]);
  }
  for (const cargoArgs of invocations) {
    log(`cargo ${cargoArgs.join(' ')}  (RUSTFLAGS="${rustflags}")`);
    const cargo = await runner.run('cargo', cargoArgs, engineDir, { ...run, env: { RUSTFLAGS: rustflags } });
    if (aborted()) return err(ToolAborted());
    if (cargo.code !== 0) return err(failed('cargo', cargoArgs, engineDir, cargo.stderr));
  }

  const lock = readText(join(engineDir, 'Cargo.lock'));
  if (!lock.ok) return lock;
  const bindgenVersion = lockedVersion(lock.value, 'wasm-bindgen');
  if (bindgenVersion === undefined) return err(InvalidJson({ message: `${options.engineDir}/Cargo.lock has no wasm-bindgen package; every Wasm crate must depend on wasm-bindgen.` }));
  const bindgen = await resolveWasmBindgen(runner, engineDir, bindgenVersion, { ...run, log });
  if (!bindgen.ok) return bindgen;
  if (aborted()) return err(ToolAborted());

  const scratch = join(engineDir, 'target', 'sf-wasm');
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  mkdirSync(outDir, { recursive: true });
  const artifacts: WasmArtifact[] = [];
  for (const crate of config.crates) {
    const stem = crate.name.replace(/-/g, '_');
    const packageStem = (crate.package ?? crate.name).replace(/-/g, '_');
    const input = isVariantCrate(crate) ? join(engineDir, variantTargetDir(crate), WASM_TARGET, 'release', `${packageStem}.wasm`) : join(engineDir, 'target', WASM_TARGET, 'release', `${stem}.wasm`);
    const bindgenArgs = ['--target', 'web', '--no-typescript', '--out-dir', scratch, '--out-name', stem, input];
    const bg = await runner.run(bindgen.value, bindgenArgs, engineDir, run);
    if (aborted()) return err(ToolAborted());
    if (bg.code !== 0) return err(failed('wasm-bindgen', bindgenArgs, engineDir, bg.stderr));
    const bgWasm = join(scratch, `${stem}_bg.wasm`);
    const optWasm = join(scratch, `${stem}_bg.opt.wasm`);
    const optArgs = [...wasmOptArgs, bgWasm, '-o', optWasm];
    const opt = await runner.run(wasmOptBin, optArgs, engineDir, run);
    if (aborted()) return err(ToolAborted());
    if (opt.code !== 0) return err(failed('wasm-opt', optArgs, engineDir, opt.stderr));

    const wasmBytes = readFileSync(optWasm);
    const sha256 = contentHash(wasmBytes);
    const wasmName = `${stem}.${sha256.slice(0, HASH_LENGTH)}.wasm`;
    const js = rewriteGlue(readFileSync(join(scratch, `${stem}.js`), 'utf8'), `${stem}_bg.wasm`, wasmName);
    const jsName = `${stem}.${contentHash(js, HASH_LENGTH)}.js`;
    writeFileSync(join(outDir, wasmName), wasmBytes);
    writeFileSync(join(outDir, jsName), js);
    const bytes = { raw: wasmBytes.length, gzip: gzipSync(wasmBytes, { level: 9 }).length, brotli: compressedSize(wasmBytes, 'brotli') };
    artifacts.push({ crate: crate.name, wasm: wasmName, js: jsName, sha256, bytes });
    log(`${wasmName}  ${(bytes.raw / 1000).toFixed(1)} kB raw, ${(bytes.brotli / 1000).toFixed(1)} kB brotli`);
  }

  // Remove artifacts of earlier builds (same crate stem, other hash).
  const keep = new Set(artifacts.flatMap((a) => [a.wasm, a.js]));
  const stems = config.crates.map((c) => c.name.replace(/-/g, '_'));
  for (const file of readdirSync(outDir)) {
    const stale = stems.some((s) => new RegExp(`^${s}\\.[0-9a-f]{${HASH_LENGTH}}\\.(wasm|js)$`).test(file));
    if (stale && !keep.has(file)) rmSync(join(outDir, file));
  }

  const manifest: WasmManifest = {
    format: WASM_MANIFEST_FORMAT,
    inputsHash,
    toolchain: { rustc: probe.toolchain.rustc, wasmBindgen: bindgenVersion, wasmOpt: wasmOptVersion.stdout.trim() },
    simd: config.simd !== false,
    artifacts,
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return ok({ status: 'built', manifest, outDir });
}
