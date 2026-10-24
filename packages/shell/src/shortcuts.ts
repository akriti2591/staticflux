/**
 * Shell glue over the a11y shortcut registry (R13.3, R15.2). The registry, typed
 * `KeyCombo`s, scopes, conflict detection (`SF-A11Y-002`), invalid-combo errors
 * (`SF-A11Y-003`), platform-aware labels (`comboLabel`, `registry.label`) and the CI
 * check (`checkShortcuts`) all live in `@staticflux/a11y`; this file only turns
 * commands and the command palette into a11y shortcut declarations and binds them.
 *
 *   defineCommand({ id: 'studio/export-pdf', title: 'Export as PDF', shortcut: 'Mod+Shift+E', run })
 *   // CI: checkShortcuts([CommandPaletteShortcut, ...commandShortcutDefs(commands)])
 */
import {
  defineShortcut,
  type ShortcutDef,
  type ShortcutRegistry,
} from '@staticflux/a11y';
import type { Result, Scope, SfError } from '@staticflux/core';
import type { CommandDef, CommandRegistry } from './commands.js';

/** The command palette's default shortcut (global scope, fires in text fields). */
export const CommandPaletteShortcut = defineShortcut({
  id: 'shell/command-palette',
  keys: ['Mod+K'],
  description: 'Open the command palette',
  allowInInputs: true,
});

/** The a11y declaration of a command's default shortcut (undefined when it has none). */
export function commandShortcut(command: CommandDef): ShortcutDef | undefined {
  if (command.shortcut === undefined) return undefined;
  return defineShortcut({
    id: command.id,
    keys: [command.shortcut],
    description: command.title,
    ...(command.shortcutScope === undefined ? {} : { scope: command.shortcutScope }),
  });
}

/** Declarations of every command shortcut — feed to `checkShortcuts` in CI. */
export function commandShortcutDefs(commands: readonly CommandDef[]): readonly ShortcutDef[] {
  return commands.flatMap((c) => {
    const def = commandShortcut(c);
    return def === undefined ? [] : [def];
  });
}

/** Register one command's shortcut: active while the command is available, runs it with `source: 'shortcut'`. */
export function bindCommandShortcut(
  shortcuts: ShortcutRegistry,
  commands: CommandRegistry,
  command: CommandDef,
  scope: Scope,
): Result<() => void> | undefined {
  const def = commandShortcut(command);
  if (def === undefined) return undefined;
  return shortcuts.register(
    def,
    () => {
      void commands.run(command.id, { source: 'shortcut' });
    },
    { scope, when: () => commands.available(command.id) },
  );
}

/** Register every command's default shortcut. Conflicts / invalid combos are returned as errors, not thrown. */
export function bindCommandShortcuts(
  shortcuts: ShortcutRegistry,
  commands: CommandRegistry,
  scope: Scope,
): readonly Result<() => void>[] {
  return commands.list().flatMap((command) => {
    const bound = bindCommandShortcut(shortcuts, commands, command, scope);
    return bound === undefined ? [] : [bound];
  });
}

/** Platform-aware labels of a command's shortcut (`⇧⌘E` / `Ctrl+Shift+E`). */
export function commandShortcutLabels(shortcuts: ShortcutRegistry, command: CommandDef): readonly string[] {
  const def = commandShortcut(command);
  return def === undefined ? [] : shortcuts.label(def);
}

/** Outcome of binding the palette + command shortcuts into the a11y registry. */
export interface CommandShortcutBindings {
  /** Shortcut ids bound successfully. */
  readonly bound: readonly string[];
  /** Conflicts (`SF-A11Y-002`) and invalid combos (`SF-A11Y-003`); those shortcuts are not bound. */
  readonly errors: readonly SfError[];
}

