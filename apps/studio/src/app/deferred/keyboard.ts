/**
 * Deferred chunk: keyboard shortcuts — the a11y shortcut registry, the shell command
 * registry, and the bindings `<sf-shell>` resolves when idle (`CommandShortcutBindingsToken`):
 * `Mod+K` opens the kit command palette over the capabilities registry (the same pipeline the
 * UI, the assistant and WebMCP use), contributed capability shortcuts invoke their capability,
 * and shell command shortcuts keep working. Loads after first paint (needs the surfaces chunk
 * for the palette dialog and the capabilities chunk for the registry).
 */
import { shortcutRegistryUnit, ShortcutRegistryToken } from '@staticflux/a11y';
import { CapabilityRegistryToken } from '@staticflux/capabilities';
import { type Registration, type Result, type SfError, unit } from '@staticflux/core';
import { bindCapabilityPalette, bindCapabilityShortcuts, CapabilityPaletteShortcut, capabilityShortcut, CapabilityShortcutsToken } from '@staticflux/kit/command-palette';
import { SurfaceManagerToken } from '@staticflux/messaging';
import { bindCommandShortcut, CommandRegistryToken, commandRegistryUnit, type CommandShortcutBindings, CommandShortcutBindingsToken } from '@staticflux/shell';
import { SummarizeCapability } from '../contracts.js';

export const keyboardBindingsUnit = unit({
  id: 'studio/keyboard-bindings-unit',
  provides: CommandShortcutBindingsToken,
  scope: 'app',
  deps: {
    required: {
      shortcuts: ShortcutRegistryToken,
      surfaces: SurfaceManagerToken,
      commands: CommandRegistryToken,
      capabilities: CapabilityRegistryToken,
      capabilityShortcuts: CapabilityShortcutsToken,
    },
  },
  create: ({ shortcuts, surfaces, commands, capabilities, capabilityShortcuts }, ctx): CommandShortcutBindings => {
    const results: { readonly id: string; readonly result: Result<() => void> }[] = [
      { id: CapabilityPaletteShortcut.id, result: bindCapabilityPalette({ shortcuts, manager: surfaces, owner: { scope: ctx.scope, level: 'app' }, scope: ctx.scope }) },
      ...bindCapabilityShortcuts({ shortcuts, registry: capabilities, entries: capabilityShortcuts, scope: ctx.scope }).map((result, i) => ({ id: capabilityShortcuts[i]?.capability ?? 'capability', result })),
    ];
    for (const command of commands.list()) {
      const result = bindCommandShortcut(shortcuts, commands, command, ctx.scope);
      if (result !== undefined) results.push({ id: command.id, result });
    }
    const errors: SfError[] = [];
    const bound: string[] = [];
    for (const { id, result } of results) {
      if (result.ok) bound.push(id);
      else errors.push(result.error);
    }
    return { bound, errors };
  },
  description: 'Mod+K → kit capability palette; capability and command shortcuts into the a11y registry.',
});

export const keyboardUnits: readonly Registration[] = [
  shortcutRegistryUnit,
  commandRegistryUnit,
  capabilityShortcut(SummarizeCapability, 'Mod+Shift+U'),
  keyboardBindingsUnit,
];
