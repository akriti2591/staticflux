/**
 * Rust toolchain detection shared by `sf wasm build` and `sf licenses`.
 *
 * Developers who only touch TypeScript may not have Rust. Commands therefore
 * detect the toolchain and either **skip with a warning** (local default) or
 * **fail** (`SF_REQUIRE_RUST=1`, set in CI) — see `requireRustFrom`.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Runner } from './publish.js';

/** Environment variable that turns a missing Rust toolchain from a warning into an error. */
export const REQUIRE_RUST_ENV = 'SF_REQUIRE_RUST';

export const WASM_TARGET = 'wasm32-unknown-unknown';

export interface RustToolchain {
  /** `rustc -V` output, e.g. `rustc 1.97.0 (2d8144b78 2026-07-07)`. */
  readonly rustc: string;
  /** `cargo -V` output. */
  readonly cargo: string;
}

export type ToolchainProbe = { readonly ok: true; readonly toolchain: RustToolchain } | { readonly ok: false; readonly missing: string };

export interface ProbeOptions {
  /** Also require the `wasm32-unknown-unknown` standard library. Default true. */
  readonly wasmTarget?: boolean;
  /** File-existence check (injectable for tests). */
  readonly exists?: (path: string) => boolean;
  readonly signal?: AbortSignal;
}

/** True when `SF_REQUIRE_RUST` is `1` or `true` (any case). */
export function requireRustFrom(env: Readonly<Record<string, string | undefined>>): boolean {
  const value = env[REQUIRE_RUST_ENV]?.trim().toLowerCase();
  return value === '1' || value === 'true';
}

/**
 * Probe cargo, rustc and (optionally) the Wasm target in `cwd`, so a
 * `rust-toolchain.toml` there selects the pinned toolchain. The target check
 * looks for `<sysroot>/lib/rustlib/wasm32-unknown-unknown` (works with or
 * without rustup).
 */
export async function probeRustToolchain(runner: Runner, cwd: string, options: ProbeOptions = {}): Promise<ToolchainProbe> {
  const exists = options.exists ?? existsSync;
  const signal = options.signal === undefined ? {} : { signal: options.signal };
  const cargo = await runner.run('cargo', ['-V'], cwd, signal);
  if (cargo.code !== 0) return { ok: false, missing: `cargo is not installed or not runnable (${firstLine(cargo.stderr) || `exit ${cargo.code}`})` };
  const rustc = await runner.run('rustc', ['-V'], cwd, signal);
  if (rustc.code !== 0) return { ok: false, missing: `rustc is not runnable (${firstLine(rustc.stderr) || `exit ${rustc.code}`})` };
  if (options.wasmTarget !== false) {
    const sysroot = await runner.run('rustc', ['--print', 'sysroot'], cwd, signal);
    const root = sysroot.stdout.trim();
    if (sysroot.code !== 0 || root.length === 0 || !exists(join(root, 'lib', 'rustlib', WASM_TARGET))) {
      return { ok: false, missing: `the ${WASM_TARGET} target is not installed (run \`rustup target add ${WASM_TARGET}\`)` };
    }
  }
  return { ok: true, toolchain: { rustc: rustc.stdout.trim(), cargo: cargo.stdout.trim() } };
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0] ?? '';
}
