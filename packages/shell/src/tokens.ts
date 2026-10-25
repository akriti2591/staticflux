/**
 * Keyboard/command and theme tokens of @staticflux/shell, apart from their implementations so the
 * shell element (boot) can name them while apps defer (or replace) the implementations.
 */
import { token } from '@staticflux/core';
import type { KeyValuePort } from '@staticflux/messaging';
import type { CommandDef, CommandRegistry } from './commands.js';
import type { CommandShortcutBindings } from './shortcuts.js';
import type { ThemeController } from './theme.js';

export const CommandsToken = /* @__PURE__ */ token('shell/commands').multi<CommandDef>();
export const CommandRegistryToken = /* @__PURE__ */ token('shell/command-registry').type<CommandRegistry>();
export const CommandShortcutBindingsToken = /* @__PURE__ */ token('shell/command-shortcuts').type<CommandShortcutBindings>();
export const ThemeControllerToken = /* @__PURE__ */ token('shell/theme-controller').type<ThemeController>();
export const ThemePreferenceStoreToken = /* @__PURE__ */ token('shell/theme-preference-store').type<KeyValuePort<string>>();
