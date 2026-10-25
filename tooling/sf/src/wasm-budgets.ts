/**
 * `sf wasm size` — Wasm budget categories (IF-15.1). size-limit bundles JS and
 * cannot measure `.wasm` files, so Wasm budgets live in a size-limit-shaped file
 * (default `.size-limit.wasm.json`): `{ name, category, path, limit, compression,
 * ratchet }`. `sf` measures the files itself (brotli quality 11 by default, the
 * same method as the S1 spike and research/03) and reuses `analyzeBudgets`, so
 * the report and the ratchet behave exactly like `sf budgets`.
 *
 * `path` is a glob (artifacts are content-hashed: `render.*.wasm`). Several
 * matches are summed (size-limit semantics). No match means the engine was not
 * built (no Rust locally) and is reported as missing.
 */
import { readFileSync } from 'node:fs';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import { err, ok, type Result } from '@staticflux/core';
import { analyzeBudgets, type BudgetOptions, type BudgetReport, checkName, type SizeLimitCheck, type SizeLimitResult } from './budgets.js';
import { InvalidJson } from './errors.js';
import { displayPath, expandGlob, readJson } from './files.js';

export const DEFAULT_WASM_BUDGETS = '.size-limit.wasm.json';

export const COMPRESSIONS = ['brotli', 'gzip', 'none'] as const;
export type Compression = (typeof COMPRESSIONS)[number];

export interface WasmBudgetCheck extends SizeLimitCheck {
  readonly path: string | readonly string[];
  /** Default `brotli`. */
  readonly compression?: Compression;
}

/** Size of `bytes` after compression: brotli q11 (with size hint), gzip level 9, or raw. */
export function compressedSize(bytes: Uint8Array, compression: Compression): number {
  if (compression === 'none') return bytes.length;
  if (compression === 'gzip') return gzipSync(bytes, { level: 9 }).length;
  return brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length } }).length;
}

export function parseWasmBudgetConfig(json: unknown, source = DEFAULT_WASM_BUDGETS): Result<WasmBudgetCheck[]> {
  if (!Array.isArray(json)) return err(InvalidJson({ message: `${source} must be an array of checks.` }));
  const problems: string[] = [];
  json.forEach((c: unknown, i) => {
    const check = c as Record<string, unknown> | null;
    if (typeof check !== 'object' || check === null) return void problems.push(`[${i}] must be an object`);
    const path = check['path'];
    if (!(typeof path === 'string' || (Array.isArray(path) && path.length > 0 && path.every((p) => typeof p === 'string')))) problems.push(`[${i}].path must be a glob or an array of globs`);
    if (typeof check['limit'] !== 'string') problems.push(`[${i}].limit must be a size such as "300 KB"`);
    if (check['compression'] !== undefined && !(COMPRESSIONS as readonly unknown[]).includes(check['compression'])) problems.push(`[${i}].compression must be one of ${COMPRESSIONS.join(', ')}`);
  });
  if (problems.length > 0) return err(InvalidJson({ message: `${source}: ${problems.join('; ')}.` }));
  return ok(json as WasmBudgetCheck[]);
}

export function readWasmBudgetConfig(path: string): Result<WasmBudgetCheck[]> {
  const json = readJson(path);
  return json.ok ? parseWasmBudgetConfig(json.value, path) : json;
}

export interface WasmMeasurement {
  readonly name: string;
  readonly files: readonly string[];
  /** Undefined when no file matched. */
  readonly size: number | undefined;
}

/** Measure every check's files (relative to `cwd`). */
export function measureWasmBudgets(config: readonly WasmBudgetCheck[], cwd: string): WasmMeasurement[] {
  return config.map((check, index) => {
    const patterns = typeof check.path === 'string' ? [check.path] : check.path;
    const files = [...new Set(patterns.flatMap((p) => expandGlob(p, cwd)))];
    const compression = check.compression ?? 'brotli';
    const size = files.length === 0 ? undefined : files.reduce((sum, f) => sum + compressedSize(readFileSync(f), compression), 0);
    return { name: checkName(check, index), files: files.map((f) => displayPath(f, cwd)), size };
  });
}

export interface WasmBudgetReport extends BudgetReport {
  readonly measurements: readonly WasmMeasurement[];
  /** Names of checks with no matching artifact. */
  readonly missing: readonly string[];
}

export function analyzeWasmBudgets(config: readonly WasmBudgetCheck[], cwd: string, options: BudgetOptions = {}): WasmBudgetReport {
  const measurements = measureWasmBudgets(config, cwd);
  const results: SizeLimitResult[] = measurements.flatMap((m) => (m.size === undefined ? [] : [{ name: m.name, size: m.size }]));
  const report = analyzeBudgets(config, results, options);
  return { ...report, measurements, missing: measurements.filter((m) => m.size === undefined).map((m) => m.name) };
}
