/**
 * DI units of @staticflux/shell. Apps register `shellUnits` (+ `uiUnits`, `messagingUnits`),
 * contribute slots / workspaces / commands, and bind a preset per profile
 * (`shellPresetUnit(shellPresets.compact)` with app precedence).
 *
 * Keyboard: the a11y units (`browserA11yEnvironmentUnit`, `shortcutRegistryUnit`,
 * `focusManagerUnit`) are the source of truth; register `shellKeyboardUnits` on top to
 * bind the palette and command shortcuts into the a11y registry. The keyboard units live in
 * `keyboard-units.ts` (no other unit's implementation), so apps can defer them out of boot.
 */
import { unit } from '@staticflux/core';
import { DecideToken } from '@staticflux/ui';
import { commandRegistryUnit } from './keyboard-units.js';
import { expandedPreset, shellPresetUnit } from './presets.js';
import { createThemeController } from './theme.js';
import { ThemeControllerToken, ThemePreferenceStoreToken } from './tokens.js';
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
