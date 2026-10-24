/**
 * The shortcut registry unit, in its own module so apps can defer the keyboard stack
 * (registry + command bindings) out of the boot chunk.
 */
import { unit } from '@staticflux/core';
import { createShortcutRegistry } from './shortcuts.js';
import { A11yEnvironmentToken, ShortcutRegistryToken } from './tokens.js';

/** Registry attached to the environment's document for the app lifetime. */
export const shortcutRegistryUnit = unit({
  id: 'a11y/shortcuts-unit',
  provides: ShortcutRegistryToken,
  scope: 'app',
  deps: { required: { env: A11yEnvironmentToken } },
  create: ({ env }, ctx) => {
    const registry = createShortcutRegistry({ isMac: env.isMac, telemetry: ctx.telemetry });
    if (env.document !== undefined) registry.attach(env.document, ctx.scope);
    return registry;
  },
  description: 'Typed keyboard shortcuts with scopes and conflict detection.',
});
