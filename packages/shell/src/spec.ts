/**
 * `@staticflux/shell/spec` — the layout spec runtime (R13.25–R13.30): declarative specs over a closed
 * vocabulary of registered contributions, validated and gated, changed by minimal animated diffs that
 * never remove pinned slots. Its own entry point: apps that compose editors load it; the shell boot
 * path does not. Errors: SF-SHELL-009…015 (`spec-errors.ts`).
 */
export {
  SpecContextMismatchError,
  SpecContributionDeniedError,
  SpecInvalidError,
  SpecMountError,
  SpecRuntimeDisposedError,
  SpecSlotError,
  UnknownSpecContributionError,
} from './spec-errors.js';
export * from './spec-model.js';
export * from './spec-validate.js';
export * from './spec-diff.js';
export * from './spec-motion.js';
export * from './spec-runtime.js';
export * from './spec-layout-port.js';
