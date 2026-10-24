/**
 * DI units of @staticflux/shell. Apps register `shellUnits` (+ `uiUnits`, `messagingUnits`),
 * contribute slots / workspaces / commands, and bind a preset per profile
 * (`shellPresetUnit(shellPresets.compact)` with app precedence).
 */
import { unit } from '@staticflux/core';
import { DecideToken } from '@staticflux/ui';
import { CommandRegistryToken, CommandsToken, createCommandRegistry } from './commands.js';
import { expandedPreset, shellPresetUnit } from './presets.js';
import { createShortcutRegistry, type ShortcutRegistry } from './shortcuts.js';
import { createThemeController, ThemeControllerToken, ThemePreferenceStoreToken } from './theme.js';
import { createWorkspaceManager, WorkspaceManagerToken, WorkspacePreferenceStoreToken, WorkspacesToken } from './workspace.js';
import { type DepHandle, ok, token } from '@staticflux/core';
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

export const ShortcutRegistryToken = token('shell/shortcut-registry').type<ShortcutRegistry>();

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

export const shortcutRegistryUnit = unit({
  id: 'shell/shortcut-registry-unit',
  provides: ShortcutRegistryToken,
  scope: 'app',
  create: (_deps, ctx) => createShortcutRegistry({ scope: ctx.scope }),
  description: 'Keyboard shortcuts with conflict detection; one keydown listener on document.',
});

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
  shortcutRegistryUnit,
  themeControllerUnit,
  defaultShellPresetUnit,
] as const;
