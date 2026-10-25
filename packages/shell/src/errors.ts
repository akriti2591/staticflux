/**
 * Error catalog of @staticflux/shell.
 */
import { defineError } from '@staticflux/core';

export const UnknownWorkspaceError = defineError(
  'SF-SHELL-001',
  'not-found',
  'No workspace with this id is registered.',
  'Declare it with `defineWorkspace({ id })` and contribute it (`workspaceContribution(def)`) or pass it to `createWorkspaceManager`.',
);

export const WorkspaceDeniedError = defineError(
  'SF-SHELL-002',
  'forbidden',
  'The workspace is gated out for this user.',
  'Expected for premium/expert workspaces. Check the gate decision; offer the upsell instead of switching.',
);

// SF-SHELL-003 / SF-SHELL-004 are retired: shortcut conflicts and invalid combos are
// `SF-A11Y-002` / `SF-A11Y-003` from @staticflux/a11y's registry.

export const UnknownCommandError = defineError(
  'SF-SHELL-005',
  'not-found',
  'No command with this id is registered.',
  'Contribute the command (`commandContribution(defineCommand({ id, … }))`) from the feature that owns it.',
);

export const CommandUnavailableError = defineError(
  'SF-SHELL-006',
  'unavailable',
  'The command is not available right now (its `when` is false or it is gated out).',
  'Check `registry.available(id)` before running; palettes only list available commands.',
);

export const CommandFailedError = defineError(
  'SF-SHELL-007',
  'unknown',
  'The command threw while running.',
  'Commands return a `Result`; wrap fallible work and return a typed error instead of throwing.',
);

export const DuplicateContributionError = defineError(
  'SF-SHELL-008',
  'invariant',
  'Two shell contributions (slot contributions, commands or workspaces) share an id.',
  'Ids are app-unique (`<package>/<name>`); rename one of them.',
);

// SF-SHELL-009…015 (spec runtime) live in `spec-errors.ts`, exported from `@staticflux/shell/spec` only.
