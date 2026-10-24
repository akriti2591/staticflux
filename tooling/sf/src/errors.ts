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
