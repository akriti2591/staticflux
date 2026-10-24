/**
 * Keyboard shortcut registry (R13.3, R15.2): `Mod+K` style combos (Mod = ⌘ on Apple
 * platforms, Ctrl elsewhere), conflict detection, contexts (`when`), scope-bound
 * registrations, and a single keydown listener. Ignores typing in inputs unless a
 * shortcut opts in.
 */
import { err, ok, type Result, type Scope } from '@staticflux/core';
import type { CommandRegistry } from './commands.js';
import { InvalidShortcutError, ShortcutConflictError } from './errors.js';

export type KeyPlatform = 'apple' | 'other';

export interface KeyCombo {
  /** Lower-cased `KeyboardEvent.key` (e.g. `k`, `enter`, `escape`, `arrowup`, `/`). */
  readonly key: string;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
}

const MODIFIERS = new Set(['mod', 'ctrl', 'control', 'meta', 'cmd', 'alt', 'option', 'shift']);

export function parseShortcut(text: string, platform: KeyPlatform): Result<KeyCombo> {
  const parts = text.split('+').map((p) => p.trim().toLowerCase()).filter((p) => p !== '');
  const keys = parts.filter((p) => !MODIFIERS.has(p));
  if (keys.length !== 1) return err(InvalidShortcutError({ details: { shortcut: text } }));
  const has = (...names: readonly string[]): boolean => parts.some((p) => names.includes(p));
  const mod = has('mod');
  return ok({
    key: keys[0] as string,
    ctrl: has('ctrl', 'control') || (mod && platform === 'other'),
    meta: has('meta', 'cmd') || (mod && platform === 'apple'),
    alt: has('alt', 'option'),
    shift: has('shift'),
  });
}

export function comboKey(combo: KeyCombo): string {
  return `${combo.ctrl ? 'C' : ''}${combo.meta ? 'M' : ''}${combo.alt ? 'A' : ''}${combo.shift ? 'S' : ''}+${combo.key}`;
}

export function comboOfEvent(event: KeyboardEvent): KeyCombo {
  return { key: event.key.toLowerCase(), ctrl: event.ctrlKey, meta: event.metaKey, alt: event.altKey, shift: event.shiftKey };
}

/** Human label: `⌘K` / `Ctrl+K`. */
export function formatShortcut(combo: KeyCombo, platform: KeyPlatform): string {
  const key = combo.key.length === 1 ? combo.key.toUpperCase() : combo.key[0]?.toUpperCase() + combo.key.slice(1);
  if (platform === 'apple') return `${combo.ctrl ? '⌃' : ''}${combo.alt ? '⌥' : ''}${combo.shift ? '⇧' : ''}${combo.meta ? '⌘' : ''}${key}`;
  return [combo.ctrl ? 'Ctrl' : '', combo.alt ? 'Alt' : '', combo.shift ? 'Shift' : '', combo.meta ? 'Meta' : '', key].filter((s) => s !== '').join('+');
}

export interface ShortcutDef {
  readonly id: `${string}/${string}`;
  readonly keys: string;
  /** Context in which it is active; two shortcuts with the same combo conflict unless both declare different contexts. */
  readonly context?: `${string}/${string}`;
  /** Reactive activity (the context is active). */
  readonly when?: () => boolean;
  /** Fire even when focus is in an input/textarea/contenteditable. */
  readonly allowInInputs?: boolean;
  run(event: KeyboardEvent): void;
}

export interface RegisteredShortcut {
  readonly def: ShortcutDef;
  readonly combo: KeyCombo;
  readonly label: string;
}

export interface ShortcutRegistry {
  readonly platform: KeyPlatform;
  register(def: ShortcutDef, scope?: Scope): Result<() => void>;
  list(): readonly RegisteredShortcut[];
  /** Dispatch a keydown (the registry also listens on its target). Returns true if handled. */
  handle(event: KeyboardEvent): boolean;
}

export function detectPlatform(): KeyPlatform {
  const nav = (globalThis as { navigator?: { platform?: string; userAgentData?: { platform?: string } } }).navigator;
  const name = nav?.userAgentData?.platform ?? nav?.platform ?? '';
  return /mac|iphone|ipad|ipod/i.test(name) ? 'apple' : 'other';
}

function isEditable(event: KeyboardEvent): boolean {
  const target = event.composedPath()[0];
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.localName === 'input' || target.localName === 'textarea' || target.localName === 'select';
}

export function createShortcutRegistry(options: {
  readonly target?: EventTarget;
  readonly scope: Scope;
  readonly platform?: KeyPlatform;
}): ShortcutRegistry {
  const platform = options.platform ?? detectPlatform();
  const entries: RegisteredShortcut[] = [];

  const registry: ShortcutRegistry = {
    platform,
    register(def, scope) {
      const parsed = parseShortcut(def.keys, platform);
      if (!parsed.ok) return parsed;
      const key = comboKey(parsed.value);
      const conflict = entries.find(
        (e) => comboKey(e.combo) === key && (e.def.context === undefined || def.context === undefined || e.def.context === def.context),
      );
      if (conflict !== undefined) {
        return err(ShortcutConflictError({ details: { shortcut: def.id, keys: def.keys, conflictsWith: conflict.def.id } }));
      }
      const entry: RegisteredShortcut = { def, combo: parsed.value, label: formatShortcut(parsed.value, platform) };
      entries.push(entry);
      const remove = (): void => {
        const index = entries.indexOf(entry);
        if (index >= 0) entries.splice(index, 1);
      };
      scope?.defer(remove);
      return ok(remove);
    },
    list: () => [...entries],
    handle(event) {
      if (event.defaultPrevented) return false;
      const key = comboKey(comboOfEvent(event));
      const editable = isEditable(event);
      // Most specific (contextual) first.
      const candidates = entries
        .filter((e) => comboKey(e.combo) === key && (e.def.when?.() ?? true) && (!editable || e.def.allowInInputs === true))
        .sort((a, b) => Number(b.def.context !== undefined) - Number(a.def.context !== undefined));
      const match = candidates[0];
      if (match === undefined) return false;
      event.preventDefault();
      match.def.run(event);
      return true;
    },
  };
  const target = options.target ?? (typeof document === 'undefined' ? undefined : document);
  if (target !== undefined) options.scope.listen(target, 'keydown', (event) => registry.handle(event as KeyboardEvent));
  return registry;
}

/** Register every command's default `shortcut` (conflicts are returned, not thrown). */
export function bindCommandShortcuts(
  shortcuts: ShortcutRegistry,
  commands: CommandRegistry,
  scope: Scope,
): readonly Result<() => void>[] {
  return commands
    .list()
    .filter((c) => c.shortcut !== undefined)
    .map((command) =>
      shortcuts.register(
        {
          id: command.id,
          keys: command.shortcut as string,
          when: () => commands.available(command.id),
          run: () => {
            void commands.run(command.id, { source: 'shortcut' });
          },
        },
        scope,
      ),
    );
}
