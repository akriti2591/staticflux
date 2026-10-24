/**
 * Deferred chunk: keyboard shortcuts — the a11y shortcut registry, the shell command
 * registry and the palette/command bindings. `<sf-shell>` resolves the bindings when idle,
 * which loads this chunk after first paint (it needs the surfaces chunk for the palette).
 */
import type { Registration } from '@staticflux/core';
import { shortcutRegistryUnit } from '@staticflux/a11y';
import { commandRegistryUnit, shellKeyboardUnits } from '@staticflux/shell';

export const keyboardUnits: readonly Registration[] = [shortcutRegistryUnit, commandRegistryUnit, ...shellKeyboardUnits];
