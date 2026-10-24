/**
 * Keyboard shortcut registry (R15.2, R13.3) with typed declarations, scopes and
 * conflict detection.
 *
 *   export const EditorScope = defineShortcutScope('studio/editor');
 *   export const SaveShortcut = defineShortcut({
 *     id: 'studio/save', keys: ['Mod+S'], scope: EditorScope, description: 'Save document',
 *   });
 *   registry.register(SaveShortcut, () => store.save(), { scope });
 *
 * Combos are typed (`Mod+Shift+K`, modifiers in canonical order Mod, Ctrl, Alt,
 * Shift, Meta). `Mod` is ⌘ on Apple platforms and Ctrl elsewhere.
 *
 * Dispatch order: the most recently activated scope first, then its ancestors,
 * then the global scope. A handler returning `false` passes the event on.
 * Registering a second handler for the same combo in the same scope is a
 * conflict error; a child scope re-binding an ancestor's combo is a reported
 * "shadow" (allowed, visible in `conflicts()` and `checkShortcuts()`).
 */
import {
  createNoopTelemetry,
  defineError,
  err,
  ok,
  type Result,
  type Scope,
  type Telemetry,
  type TokenId,
} from '@staticflux/core';

export const ShortcutConflictError = defineError(
  'SF-A11Y-002',
  'conflict',
  'Two shortcuts bind the same key combination in the same scope.',
  'Change one combo, or move one shortcut into a narrower scope (a child scope may shadow its parent).',
);

export const InvalidShortcutError = defineError(
  'SF-A11Y-003',
  'validation',
  'A shortcut key combination is malformed.',
  'Use `Modifier+Key` with modifiers in the order Mod, Ctrl, Alt, Shift, Meta and a key such as `K`, `Enter`, `ArrowUp`, `F2` or `/`.',
);

// ------------------------------------------------------------- typed combos

type Letter =
  | 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I' | 'J' | 'K' | 'L' | 'M'
  | 'N' | 'O' | 'P' | 'Q' | 'R' | 'S' | 'T' | 'U' | 'V' | 'W' | 'X' | 'Y' | 'Z';
type Digit = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9';
type FunctionKey = 'F1' | 'F2' | 'F3' | 'F4' | 'F5' | 'F6' | 'F7' | 'F8' | 'F9' | 'F10' | 'F11' | 'F12';
type NamedKey =
  | 'Enter' | 'Escape' | 'Tab' | 'Space' | 'Backspace' | 'Delete' | 'Insert'
  | 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End' | 'PageUp' | 'PageDown';
type Symbol_ = '/' | '?' | ',' | '.' | ';' | "'" | '[' | ']' | '\\' | '`' | '-' | '=' | '+';
export type KeyName = Letter | Digit | FunctionKey | NamedKey | Symbol_;
type ModifierPrefix = `${'' | 'Mod+'}${'' | 'Ctrl+'}${'' | 'Alt+'}${'' | 'Shift+'}${'' | 'Meta+'}`;
/** A key combination such as `Mod+K`, `Shift+?`, `Alt+ArrowUp`, `Escape`. */
export type KeyCombo = `${ModifierPrefix}${KeyName}`;

const MODIFIERS = ['Mod', 'Ctrl', 'Alt', 'Shift', 'Meta'] as const;
const NAMED = new Set<string>([
  'Enter', 'Escape', 'Tab', 'Space', 'Backspace', 'Delete', 'Insert',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown',
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
]);
const SYMBOLS = new Set<string>(['/', '?', ',', '.', ';', "'", '[', ']', '\\', '`', '-', '=', '+']);

// ------------------------------------------------------------- declarations

export interface ShortcutScopeDef<Id extends TokenId = TokenId> {
  readonly kind: 'shortcut-scope';
  readonly id: Id;
  readonly parent: ShortcutScopeDef | undefined;
}

export const GlobalShortcutScope: ShortcutScopeDef<'a11y/global'> = Object.freeze({
  kind: 'shortcut-scope',
  id: 'a11y/global',
  parent: undefined,
});

/** Declare a shortcut scope (a feature, a panel, a dialog). Parent defaults to the global scope. */
export function defineShortcutScope<const Id extends TokenId>(
  id: Id,
  options: { readonly parent?: ShortcutScopeDef } = {},
): ShortcutScopeDef<Id> {
  return Object.freeze({ kind: 'shortcut-scope', id, parent: options.parent ?? GlobalShortcutScope });
}

export interface ShortcutDef<Id extends TokenId = TokenId> {
  readonly kind: 'shortcut';
  readonly id: Id;
  /** One or more alternative combos. */
  readonly keys: readonly KeyCombo[];
  readonly scope: ShortcutScopeDef;
  /** Shown in help/command palette. Prefer an i18n message id at the UI layer. */
  readonly description: string;
  /** Fire while focus is in a text field. Default: true for combos with Mod/Ctrl/Alt/Meta, false otherwise. */
  readonly allowInInputs?: boolean;
  /** Call `preventDefault()` when handled. Default true. */
  readonly preventDefault?: boolean;
}

export function defineShortcut<const Id extends TokenId>(
  definition: Omit<ShortcutDef<Id>, 'kind' | 'scope'> & { readonly scope?: ShortcutScopeDef },
): ShortcutDef<Id> {
  return Object.freeze({ ...definition, kind: 'shortcut', scope: definition.scope ?? GlobalShortcutScope });
}

// ------------------------------------------------------------- parsing / normalization

export interface ParsedCombo {
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly meta: boolean;
  readonly key: string;
}

/** Parse a combo for a platform (`Mod` → Meta on mac, Ctrl elsewhere). */
export function parseCombo(combo: string, isMac: boolean): Result<ParsedCombo> {
  const parts = combo === '+' ? ['+'] : combo.split('+');
  // A trailing "+" key: "Ctrl++" splits into [..., '', ''].
  if (combo.length > 1 && combo.endsWith('++')) parts.splice(parts.length - 2, 2, '+');
  const key = parts.pop();
  const flags = { ctrl: false, alt: false, shift: false, meta: false };
  let lastIndex = -1;
  for (const part of parts) {
    const index = MODIFIERS.indexOf(part as (typeof MODIFIERS)[number]);
    if (index < 0 || index <= lastIndex) {
      return err(InvalidShortcutError({ message: `Invalid modifier "${part}" in shortcut "${combo}".`, details: { combo } }));
    }
    lastIndex = index;
    if (part === 'Mod') flags[isMac ? 'meta' : 'ctrl'] = true;
    else flags[part.toLowerCase() as 'ctrl' | 'alt' | 'shift' | 'meta'] = true;
  }
  const valid = key !== undefined && (/^[A-Z0-9]$/.test(key) || NAMED.has(key) || SYMBOLS.has(key));
  if (!valid) return err(InvalidShortcutError({ message: `Invalid key "${key ?? ''}" in shortcut "${combo}".`, details: { combo } }));
  return ok({ ...flags, key });
}

/** Canonical string of a parsed combo (`Ctrl+Shift+K`). */
export function comboId(parsed: ParsedCombo): string {
  return [parsed.ctrl ? 'Ctrl' : '', parsed.alt ? 'Alt' : '', parsed.shift ? 'Shift' : '', parsed.meta ? 'Meta' : '', parsed.key]
    .filter((p) => p !== '')
    .join('+');
}

const isSymbol = (key: string): boolean => SYMBOLS.has(key);

/** Canonical combo of a keyboard event (layout-aware for symbols, code-based for Alt+letter on mac). */
export function eventComboId(event: KeyboardEvent): string | undefined {
  let key = event.key;
  if (key === undefined || key === 'Unidentified' || key === 'Dead') return undefined;
  if (['Control', 'Alt', 'Shift', 'Meta', 'OS', 'AltGraph', 'CapsLock'].includes(key)) return undefined;
  if (key === ' ') key = 'Space';
  else if (key === 'Esc') key = 'Escape';
  else if (key.length === 1) key = key.toUpperCase();
  // Alt on macOS turns letters into symbols (Alt+K → "˚"): use the physical key.
  if (event.altKey && /^Key[A-Z]$/.test(event.code) && !/^[A-Z]$/.test(key)) key = event.code.slice(3);
  if (event.altKey && /^Digit[0-9]$/.test(event.code) && !/^[0-9]$/.test(key)) key = event.code.slice(5);
  // Shift is part of the produced character for symbols ("?" = Shift+/ on US layouts).
  const shift = event.shiftKey && !isSymbol(key);
  return comboId({ ctrl: event.ctrlKey, alt: event.altKey, shift, meta: event.metaKey, key });
}

function normalizedCombos(def: ShortcutDef, isMac: boolean): Result<readonly string[]> {
  const out: string[] = [];
  for (const combo of def.keys) {
    const parsed = parseCombo(combo, isMac);
    if (!parsed.ok) return parsed;
    // Symbols ignore Shift at match time, so normalize the declaration the same way.
    const value = isSymbol(parsed.value.key) ? { ...parsed.value, shift: false } : parsed.value;
    out.push(comboId(value));
  }
  return ok(out);
}

const MAC_SYMBOLS: Readonly<Record<string, string>> = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Meta: '⌘' };

/** Human label for a combo (`⌘⇧K` on mac, `Ctrl+Shift+K` elsewhere). */
export function comboLabel(combo: KeyCombo | string, isMac: boolean): string {
  const parsed = parseCombo(combo, isMac);
  if (!parsed.ok) return combo;
  const p = parsed.value;
  const mods = [p.ctrl ? 'Ctrl' : '', p.alt ? 'Alt' : '', p.shift ? 'Shift' : '', p.meta ? 'Meta' : ''].filter((m) => m !== '');
  if (isMac) return `${mods.map((m) => MAC_SYMBOLS[m] ?? m).join('')}${p.key}`;
  return [...mods.map((m) => (m === 'Meta' ? 'Win' : m)), p.key].join('+');
}

// ------------------------------------------------------------- static check (CLI)

/** Combos browsers/OSes reserve (cannot or should not be overridden). */
export const RESERVED_COMBOS: readonly KeyCombo[] = ['Mod+W', 'Mod+T', 'Mod+N', 'Mod+Q', 'Mod+Shift+N', 'Mod+Shift+T', 'Mod+Shift+W', 'Ctrl+Tab', 'Ctrl+Shift+Tab', 'Alt+F4', 'Mod+L'];

export interface ShortcutIssue {
  readonly code: 'conflict' | 'shadow' | 'reserved' | 'invalid' | 'duplicate-id';
  readonly severity: 'error' | 'warning';
  readonly ids: readonly string[];
  readonly combo: string;
  readonly platform: 'mac' | 'other';
  readonly message: string;
}

function ancestors(scope: ShortcutScopeDef): ShortcutScopeDef[] {
  const out: ShortcutScopeDef[] = [];
  for (let s = scope.parent; s !== undefined; s = s.parent) out.push(s);
  return out;
}

/** Check a set of declarations on both platforms: conflicts (error), shadows and reserved combos (warnings). */
export function checkShortcuts(definitions: readonly ShortcutDef[]): readonly ShortcutIssue[] {
  const issues: ShortcutIssue[] = [];
  const seenIds = new Map<string, ShortcutDef>();
  for (const def of definitions) {
    const prior = seenIds.get(def.id);
    if (prior !== undefined && prior !== def) {
      issues.push({ code: 'duplicate-id', severity: 'error', ids: [def.id], combo: '', platform: 'other', message: `Shortcut id "${def.id}" is declared twice.` });
    }
    seenIds.set(def.id, def);
  }
  for (const isMac of [true, false]) {
    const platform = isMac ? 'mac' : 'other';
    const reserved = new Set(RESERVED_COMBOS.map((c) => parseCombo(c, isMac)).flatMap((r) => (r.ok ? [comboId(r.value)] : [])));
    const byScope = new Map<string, Map<string, string>>(); // scope id → combo → shortcut id
    const entries: { def: ShortcutDef; combo: string }[] = [];
    for (const def of definitions) {
      const combos = normalizedCombos(def, isMac);
      if (!combos.ok) {
        if (isMac) issues.push({ code: 'invalid', severity: 'error', ids: [def.id], combo: def.keys.join(' | '), platform, message: combos.error.message });
        continue;
      }
      for (const combo of new Set(combos.value)) {
        entries.push({ def, combo });
        const scopeMap = byScope.get(def.scope.id) ?? new Map<string, string>();
        byScope.set(def.scope.id, scopeMap);
        const other = scopeMap.get(combo);
        if (other !== undefined && other !== def.id) {
          issues.push({ code: 'conflict', severity: 'error', ids: [other, def.id], combo, platform, message: `"${other}" and "${def.id}" both bind ${combo} in scope "${def.scope.id}" (${platform}).` });
        } else scopeMap.set(combo, def.id);
        if (reserved.has(combo)) {
          issues.push({ code: 'reserved', severity: 'warning', ids: [def.id], combo, platform, message: `"${def.id}" binds ${combo}, which the browser/OS reserves (${platform}).` });
        }
      }
    }
    for (const { def, combo } of entries) {
      for (const ancestor of ancestors(def.scope)) {
        const shadowed = byScope.get(ancestor.id)?.get(combo);
        if (shadowed !== undefined) {
          issues.push({ code: 'shadow', severity: 'warning', ids: [def.id, shadowed], combo, platform, message: `"${def.id}" (${def.scope.id}) shadows "${shadowed}" (${ancestor.id}) on ${combo} (${platform}).` });
        }
      }
    }
  }
  return issues;
}

// ------------------------------------------------------------- runtime registry

export type ShortcutHandler = (event: KeyboardEvent) => void | boolean;

export interface RegisterOptions {
  /** Unregister when this scope ends. */
  readonly scope?: Scope;
  /** Extra runtime condition (e.g. "has selection"). */
  readonly when?: () => boolean;
}

export interface ActiveShortcut {
  readonly id: string;
  readonly description: string;
  readonly scope: string;
  readonly keys: readonly KeyCombo[];
  readonly labels: readonly string[];
  /** In an active scope and not shadowed. */
  readonly active: boolean;
  readonly shadowedBy: string | undefined;
}

export interface ShortcutRegistry {
  register(definition: ShortcutDef, handler: ShortcutHandler, options?: RegisterOptions): Result<() => void>;
  /** Make a scope active (e.g. while a panel has focus or a dialog is open). Returns deactivate. */
  activate(scope: ShortcutScopeDef, lifetime?: Scope): () => void;
  /** Dispatch a keydown event. Returns true when a shortcut handled it. */
  handle(event: KeyboardEvent): boolean;
  /** Listen to keydown on `target` for the lifetime of `scope`. */
  attach(target: EventTarget, scope: Scope): void;
  /** Registered shortcuts with their state (help dialog, command palette). */
  list(): readonly ActiveShortcut[];
  /** Shadows among currently registered shortcuts. */
  conflicts(): readonly ShortcutIssue[];
  label(definition: ShortcutDef): readonly string[];
  readonly activeScopes: readonly string[];
}

export interface ShortcutRegistryOptions {
  readonly isMac: boolean;
  readonly telemetry?: Telemetry;
}

interface Registration {
  readonly def: ShortcutDef;
  readonly combos: readonly string[];
  readonly handler: ShortcutHandler;
  readonly when: (() => boolean) | undefined;
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target.getAttribute('contenteditable') === 'true' || target.getAttribute('contenteditable') === '') return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) {
    return !['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color', 'file', 'image'].includes(target.type);
  }
  return false;
}

export function createShortcutRegistry(options: ShortcutRegistryOptions): ShortcutRegistry {
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const isMac = options.isMac;
  const registrations = new Map<string, Registration>(); // by shortcut id
  const activeStack: ShortcutScopeDef[] = [];

  /** Scopes in dispatch priority order. */
  const priority = (): ShortcutScopeDef[] => {
    const out: ShortcutScopeDef[] = [];
    const add = (scope: ShortcutScopeDef): void => {
      if (!out.some((s) => s.id === scope.id)) out.push(scope);
    };
    for (const scope of [...activeStack].reverse()) {
      add(scope);
      for (const ancestor of ancestors(scope)) add(ancestor);
    }
    add(GlobalShortcutScope);
    return out;
  };

  const registry: ShortcutRegistry = {
    register(def, handler, registerOptions = {}) {
      const combos = normalizedCombos(def, isMac);
      if (!combos.ok) return combos;
      const existing = registrations.get(def.id);
      if (existing !== undefined) {
        return err(ShortcutConflictError({ message: `Shortcut "${def.id}" is already registered.`, details: { id: def.id } }));
      }
      for (const other of registrations.values()) {
        if (other.def.scope.id !== def.scope.id) continue;
        const clash = combos.value.find((c) => other.combos.includes(c));
        if (clash !== undefined) {
          return err(
            ShortcutConflictError({
              message: `"${def.id}" and "${other.def.id}" both bind ${clash} in scope "${def.scope.id}".`,
              details: { ids: [other.def.id, def.id], combo: clash, scope: def.scope.id },
            }),
          );
        }
      }
      registrations.set(def.id, { def, combos: combos.value, handler, when: registerOptions.when });
      const unregister = (): void => {
        if (registrations.get(def.id)?.handler === handler) registrations.delete(def.id);
      };
      registerOptions.scope?.defer(unregister);
      return ok(unregister);
    },
    activate(scope, lifetime) {
      activeStack.push(scope);
      const deactivate = (): void => {
        const index = activeStack.lastIndexOf(scope);
        if (index >= 0) activeStack.splice(index, 1);
      };
      lifetime?.defer(deactivate);
      return deactivate;
    },
    handle(event) {
      if (event.defaultPrevented) return false;
      const combo = eventComboId(event);
      if (combo === undefined) return false;
      const editable = isEditable(event.target);
      for (const scope of priority()) {
        for (const reg of registrations.values()) {
          if (reg.def.scope.id !== scope.id || !reg.combos.includes(combo)) continue;
          const modified = /(^|\+)(Ctrl|Alt|Meta)\+/.test(combo);
          if (editable && !(reg.def.allowInInputs ?? modified)) continue;
          if (reg.when !== undefined && !reg.when()) continue;
          if (reg.handler(event) === false) continue;
          if (reg.def.preventDefault !== false) event.preventDefault();
          telemetry.event('a11y.shortcut', { subsystem: 'a11y/shortcuts', level: 'verbose', attrs: { id: reg.def.id, combo, scope: scope.id } });
          return true;
        }
      }
      return false;
    },
    attach(target, scope) {
      scope.listen(target, 'keydown', (event) => {
        registry.handle(event as KeyboardEvent);
      });
    },
    list() {
      const order = priority().map((s) => s.id);
      const winners = new Map<string, string>(); // combo → id of the highest-priority registration
      const sorted = [...registrations.values()].sort((a, b) => {
        const ai = order.indexOf(a.def.scope.id);
        const bi = order.indexOf(b.def.scope.id);
        return (ai < 0 ? Infinity : ai) - (bi < 0 ? Infinity : bi);
      });
      return sorted.map((reg) => {
        const inScope = order.includes(reg.def.scope.id);
        let shadowedBy: string | undefined;
        if (inScope) {
          for (const combo of reg.combos) {
            const winner = winners.get(combo);
            if (winner === undefined) winners.set(combo, reg.def.id);
            else if (winner !== reg.def.id) shadowedBy ??= winner;
          }
        }
        return {
          id: reg.def.id,
          description: reg.def.description,
          scope: reg.def.scope.id,
          keys: reg.def.keys,
          labels: registry.label(reg.def),
          active: inScope && shadowedBy === undefined,
          shadowedBy,
        };
      });
    },
    conflicts() {
      return checkShortcuts([...registrations.values()].map((r) => r.def)).filter(
        (issue) => issue.code === 'shadow' && issue.platform === (isMac ? 'mac' : 'other'),
      );
    },
    label(def) {
      return def.keys.map((k) => comboLabel(k, isMac));
    },
    get activeScopes() {
      return priority().map((s) => s.id);
    },
  };
  return registry;
}
