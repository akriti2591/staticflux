/**
 * Errors raised by the `sf` CLI itself. Every one has a stable code and a
 * concrete fix so agents can act on CLI output without guessing (§13).
 */
import { defineError } from '@staticflux/core';

export const ModuleLoadFailed = defineError(
  'SF-TOOL-001',
  'not-found',
  'A module given to `sf` could not be imported.',
  'Build the package first (`pnpm build`) and pass a path to an ES module (.js/.mjs) relative to the working directory.',
);

export const InvalidGraphModule = defineError(
  'SF-TOOL-002',
  'validation',
  'The graph entry module does not export a valid `units` array.',
  'Export `units` (an array of `unit({...})` declarations) or `module` (a `defineModule({...})` result); optional `external` is an array of tokens or token ids.',
);

export const FileReadFailed = defineError(
  'SF-TOOL-003',
  'not-found',
  'A file needed by `sf` could not be read.',
  'Check the path (relative paths resolve against the working directory) and that the file exists.',
);

export const InvalidJson = defineError(
  'SF-TOOL-004',
  'validation',
  'A JSON file needed by `sf` could not be parsed or has the wrong shape.',
  'Fix the JSON syntax; `.size-limit.json` must be an array of `{ name, path, limit }` and size-limit results an array of `{ name, size }` (`size-limit --json`).',
);

export const UsageError = defineError(
  'SF-TOOL-005',
  'validation',
  'Unknown `sf` command or invalid arguments.',
  'Run `sf help` for the list of commands and their flags.',
);

export const ErrorCatalogConflict = defineError(
  'SF-TOOL-006',
  'conflict',
  'Two error definitions share a code but differ in kind, summary or fix.',
  'Give each `defineError` call a unique `SF-<AREA>-NNN` code; codes are stable identifiers and must never be reused.',
);

export const RustToolchainMissing = defineError(
  'SF-TOOL-008',
  'unavailable',
  'The Rust toolchain (cargo, rustc or the wasm32-unknown-unknown target) is missing, and this run requires it.',
  'Install Rust with rustup (https://rustup.rs), then run `rustup toolchain install` in the engine directory (it reads rust-toolchain.toml and adds wasm32-unknown-unknown). Locally, unset SF_REQUIRE_RUST to skip the Wasm build with a warning.',
);

export const ToolStepFailed = defineError(
  'SF-TOOL-009',
  'unknown',
  'An external build or metadata step run by `sf` (cargo, wasm-bindgen, wasm-opt, pnpm) exited with an error.',
  'Read the step output printed above; rerun the shown command by hand in the shown directory to reproduce. Missing `wasm-opt` means `pnpm install` has not run (binaryen is a root devDependency).',
);

export const WasmArtifactMissing = defineError(
  'SF-TOOL-010',
  'not-found',
  'A Wasm budget check matched no built artifact, and this run requires every artifact to be measured.',
  'Run `pnpm build` with the Rust toolchain installed (SF_REQUIRE_RUST=1 makes a missing toolchain an error), and check that the budget `path` glob matches the content-hashed file name in the engine `dist/`.',
);

export const ToolAborted = defineError('SF-TOOL-011', 'aborted', 'The `sf` command was cancelled before it finished.', 'Nothing to fix; rerun the command. Partial outputs are not recorded in the manifest, so the next run rebuilds.');

export const InvalidRoutesModule = defineError(
  'SF-TOOL-007',
  'validation',
  'The `sf routes` entry module does not export valid `routes`, `features` and profiles.',
  'Export `routes` (defineRoute results), `features` (defineFeature manifests) and `profiles` ("web:expanded" strings or AppProfile-like objects) — or `hostModes` + `formFactors` arrays.',
);
