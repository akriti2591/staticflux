/**
 * DI units of @staticflux/shell. Apps register `shellUnits` (+ `uiUnits`, `messagingUnits`),
 * contribute slots / workspaces / commands, and bind a preset per profile
 * (`shellPresetUnit(shellPresets.compact)` with app precedence).
 *
 * Keyboard: the a11y units (`browserA11yEnvironmentUnit`, `shortcutRegistryUnit`,
 * `focusManagerUnit`) are the source of truth; register `shellKeyboardUnits` on top to
 * bind the palette and command shortcuts into the a11y registry.
 */
import { ShortcutRegistryToken } from '@staticflux/a11y';
import { type Result, type SfError, unit } from '@staticflux/core';
import { SurfaceManagerToken } from '@staticflux/messaging';
import { DecideToken } from '@staticflux/ui';
import { CommandRegistryToken, CommandsToken, createCommandRegistry } from './commands.js';
import { bindCommandPalette } from './palette.js';
import { expandedPreset, shellPresetUnit } from './presets.js';
import { bindCommandShortcut, CommandPaletteShortcut, type CommandShortcutBindings, CommandShortcutBindingsToken } from './shortcuts.js';
import { SHELL_SUBSYSTEM } from './telemetry.js';
import { createThemeController, ThemeControllerToken, ThemePreferenceStoreToken } from './theme.js';
import { createWorkspaceManager, WorkspaceManagerToken, WorkspacePreferenceStoreToken, WorkspacesToken } from './workspace.js';
import { type DepHandle, ok } from '@staticflux/core';
import type { KeyValuePort } from '@staticflux/messaging';

/** A KV port over an optional (lazy) binding: unbound → reads nothing, writes are no-ops. */
function optionalStore<V>(handle: DepHandle<KeyValuePort<V>>, signal: AbortSignal): KeyValuePort<V> {
  const resolve = async (): Promise<KeyValuePort<V> | undefined> => {
    const s = await handle.whenReady(signal);
    return s.ok ? s.value : undefined;
  };
  return {
    get: async (key, o) => (await resolve())?.get(key, o) ?? ok(undefined),
    set: async (key, value, o) => (await resolve())?.set(key, value, o) ?? ok(),
    delete: async (key) => (await resolve())?.delete(key) ?? ok(),
  };
}


export const workspaceManagerUnit = unit({
  id: 'shell/workspace-manager-unit',
  provides: WorkspaceManagerToken,
  scope: 'app',
  deps: { required: { workspaces: WorkspacesToken, decide: DecideToken }, lazy: { store: WorkspacePreferenceStoreToken } },
  create: ({ workspaces, decide, store }, ctx) => {
    const created = createWorkspaceManager({
      workspaces,
      decide,
      telemetry: ctx.telemetry,
      // The preference store is optional: bound → persisted, unbound → session only.
      store: optionalStore(store, ctx.signal),
    });
    if (!created.ok) throw created.error;
    return created.value;
  },
  init: async (manager, ctx) => {
    await manager.restore(ctx.signal);
    return { ok: true, value: undefined };
  },
  description: 'Workspace manager over contributed workspaces (gated switch, persisted preference).',
});

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

export const themeControllerUnit = unit({
  id: 'shell/theme-controller-unit',
  provides: ThemeControllerToken,
  scope: 'app',
  deps: { lazy: { store: ThemePreferenceStoreToken } },
  create: ({ store }, ctx) =>
    createThemeController({
      telemetry: ctx.telemetry,
      store: optionalStore(store, ctx.signal),
    }),
  init: async (controller, ctx) => {
    await controller.restore(ctx.signal);
    return { ok: true, value: undefined };
  },
  description: 'Theme controller: light/dark/high-contrast, system preferences, persisted choice.',
});

export const defaultShellPresetUnit = shellPresetUnit(expandedPreset);

export const shellUnits = [
  workspaceManagerUnit,
  commandRegistryUnit,
  themeControllerUnit,
  defaultShellPresetUnit,
] as const;
