/**
 * Command registry + keyboard glue units (`shellKeyboardUnits`). Separate from `units.ts` so an
 * app can load them after first paint (e.g. `deferredUnits`): the shell element only asks for
 * `CommandShortcutBindingsToken` when idle.
 */
import { ShortcutRegistryToken } from '@staticflux/a11y';
import { type Result, type SfError, unit } from '@staticflux/core';
import { SurfaceManagerToken } from '@staticflux/messaging';
import { DecideToken } from '@staticflux/ui';
import { createCommandRegistry } from './commands.js';
import { bindCommandPalette } from './palette.js';
import { bindCommandShortcut, CommandPaletteShortcut, type CommandShortcutBindings } from './shortcuts.js';
import { SHELL_SUBSYSTEM } from './telemetry.js';
import { CommandRegistryToken, CommandShortcutBindingsToken, CommandsToken } from './tokens.js';

export const commandRegistryUnit = unit({
  id: 'shell/command-registry-unit',
  provides: CommandRegistryToken,
  scope: 'app',
  deps: { required: { commands: CommandsToken, decide: DecideToken } },
  create: ({ commands, decide }, ctx) => {
    const created = createCommandRegistry({ commands, decide, telemetry: ctx.telemetry });
    if (!created.ok) throw created.error;
    return created.value;
  },
  refreshOn: ['epoch'],
  refresh: async (registry, ctx) => {
    await registry.refreshDecisions(ctx.signal);
    return { ok: true, value: undefined };
  },
  description: 'Command registry (palette, shortcuts, agents); gate decisions refresh with the app epoch.',
});

/**
 * Binds the command palette (`Mod+K`) and every contributed command's `shortcut` into the
 * a11y shortcut registry for the app lifetime. Resolved by `<sf-shell>` (idle) or on demand.
 */
export const commandShortcutsUnit = unit({
  id: 'shell/command-shortcuts-unit',
  provides: CommandShortcutBindingsToken,
  scope: 'app',
  deps: { required: { shortcuts: ShortcutRegistryToken, commands: CommandRegistryToken, surfaces: SurfaceManagerToken } },
  create: ({ shortcuts, commands, surfaces }, ctx): CommandShortcutBindings => {
    const results: { readonly id: string; readonly result: Result<() => void> }[] = [
      {
        id: CommandPaletteShortcut.id,
        result: bindCommandPalette({ shortcuts, manager: surfaces, registry: commands, owner: { scope: ctx.scope, level: 'app' }, scope: ctx.scope }),
      },
    ];
    for (const command of commands.list()) {
      const result = bindCommandShortcut(shortcuts, commands, command, ctx.scope);
      if (result !== undefined) results.push({ id: command.id, result });
    }
    const errors: SfError[] = [];
    const bound: string[] = [];
    for (const { id, result } of results) {
      if (result.ok) bound.push(id);
      else {
        errors.push(result.error);
        ctx.telemetry.event('shell.shortcut-error', { subsystem: SHELL_SUBSYSTEM, level: 'standard', attrs: { id, code: result.error.code } });
      }
    }
    return { bound, errors };
  },
  description: 'Binds the command palette and command shortcuts into the a11y shortcut registry (conflicts reported as SF-A11Y-002).',
});

/** Keyboard glue; requires the a11y shortcut registry and the messaging surface manager. */
export const shellKeyboardUnits = [commandShortcutsUnit] as const;
