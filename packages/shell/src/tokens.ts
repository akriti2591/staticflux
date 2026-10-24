/**
 * Keyboard/command tokens of @staticflux/shell, apart from their implementations so the shell
 * element (boot) can name them while apps defer the command registry and shortcut bindings.
 */
import { token } from '@staticflux/core';
import type { CommandDef, CommandRegistry } from './commands.js';
import type { CommandShortcutBindings } from './shortcuts.js';

export const CommandsToken = /* @__PURE__ */ token('shell/commands').multi<CommandDef>();
export const CommandRegistryToken = /* @__PURE__ */ token('shell/command-registry').type<CommandRegistry>();
export const CommandShortcutBindingsToken = /* @__PURE__ */ token('shell/command-shortcuts').type<CommandShortcutBindings>();
