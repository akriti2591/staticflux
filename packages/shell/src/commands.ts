/**
 * Command registry (R13.3, R3.1): features contribute commands as data; the palette,
 * shortcuts and agents run them by id. Fuzzy search ranks titles/keywords.
 *
 * ```ts
 * export const exportPdfCommand = defineCommand({
 *   id: 'studio/export-pdf', title: 'Export as PDF', keywords: ['download'], group: 'Document',
 *   shortcut: 'Mod+Shift+E',
 *   run: async ({ signal }) => exportPdf(signal),
 * });
 * export const units = [commandContribution(exportPdfCommand)];
 * ```
 */
import {
  attemptAsync,
  contribution,
  createNoopTelemetry,
  err,
  ok,
  type Result,
  type Scope,
  type Telemetry,
  toSfError,
} from '@staticflux/core';
import type { KeyCombo, ShortcutScopeDef } from '@staticflux/a11y';
import { allowAllDecide, type DecidePort, type GateResource } from '@staticflux/ui';
import { CommandFailedError, CommandUnavailableError, DuplicateContributionError, UnknownCommandError } from './errors.js';
import { SHELL_SUBSYSTEM, shellMetrics } from './telemetry.js';
import { CommandsToken } from './tokens.js';

export type CommandId = `${string}/${string}`;

export interface CommandContext {
  readonly signal: AbortSignal;
  /** How it was invoked (metrics). */
  readonly source: 'palette' | 'shortcut' | 'api';
}

export interface CommandDef {
  readonly kind: 'command';
  readonly id: CommandId;
  readonly title: string;
  readonly keywords?: readonly string[];
  readonly group?: string;
  /** Default key binding (typed a11y `KeyCombo`, e.g. `Mod+Shift+E`) — registered by `bindCommandShortcuts`. */
  readonly shortcut?: KeyCombo;
  /** a11y shortcut scope of `shortcut` (default: the global scope). */
  readonly shortcutScope?: ShortcutScopeDef;
  readonly gate?: GateResource;
  /** Reactive availability (e.g. "a document is open"). */
  readonly when?: () => boolean;
  run(context: CommandContext): void | Result<unknown> | Promise<void | Result<unknown>>;
}

export function defineCommand(init: Omit<CommandDef, 'kind'>): CommandDef {
  return Object.freeze({ ...init, kind: 'command' });
}


export function commandContribution(command: CommandDef) {
  return contribution({ id: `${command.id}-command`, provides: CommandsToken, scope: 'app', create: () => command });
}

// ---------------------------------------------------------------- fuzzy match

export interface FuzzyMatch {
  readonly score: number;
  /** Matched character indices in the text (for highlighting). */
  readonly indices: readonly number[];
}

/**
 * Subsequence fuzzy match, case-insensitive. Scores consecutive runs and word starts
 * higher; earlier matches beat later ones. Undefined when `query` is not a subsequence.
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | undefined {
  const q = query.trim().toLowerCase();
  if (q === '') return { score: 0, indices: [] };
  const t = text.toLowerCase();
  const indices: number[] = [];
  let score = 0;
  let from = 0;
  let previous = -2;
  for (const char of q) {
    if (char === ' ') continue;
    const at = t.indexOf(char, from);
    if (at < 0) return undefined;
    const wordStart = at === 0 || /[\s\-_/.:]/.test(t[at - 1] ?? '');
    score += 1;
    if (at === previous + 1) score += 3;
    if (wordStart) score += 5;
    score -= Math.min(at - from, 10) * 0.1;
    indices.push(at);
    previous = at;
    from = at + 1;
  }
  if (t.startsWith(q)) score += 10;
  return { score, indices };
}

export interface CommandSearchResult {
  readonly command: CommandDef;
  readonly score: number;
  readonly indices: readonly number[];
}

// ---------------------------------------------------------------- registry

export interface CommandRegistry {
  list(): readonly CommandDef[];
  get(id: CommandId): CommandDef | undefined;
  /** Register at runtime (feature activation); unregistered when `scope` disposes. */
  register(command: CommandDef, scope?: Scope): Result<() => void>;
  /** `when` true and gate allowed (gate decisions are cached per refresh). */
  available(id: CommandId): boolean;
  /** Re-evaluate gate decisions (e.g. after session/plan change). */
  refreshDecisions(signal?: AbortSignal): Promise<void>;
  search(query: string, options?: { readonly limit?: number }): readonly CommandSearchResult[];
  run(id: CommandId, context?: Partial<CommandContext>): Promise<Result<unknown>>;
}

export interface CommandRegistryOptions {
  readonly commands?: readonly CommandDef[];
  readonly decide?: DecidePort;
  readonly telemetry?: Telemetry;
}

export function createCommandRegistry(options: CommandRegistryOptions = {}): Result<CommandRegistry> {
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const decide = options.decide ?? allowAllDecide;
  const commands = new Map<CommandId, CommandDef>();
  const denied = new Set<CommandId>();

  const add = (command: CommandDef): Result<void> => {
    if (commands.has(command.id) && commands.get(command.id) !== command) {
      return err(DuplicateContributionError({ details: { command: command.id } }));
    }
    commands.set(command.id, command);
    return ok();
  };
  for (const command of options.commands ?? []) {
    const added = add(command);
    if (!added.ok) return added;
  }

  const decideOne = async (command: CommandDef, signal?: AbortSignal): Promise<void> => {
    if (command.gate === undefined) return;
    const verdict = await decide.decide(command.gate, signal);
    if (verdict.effect === 'allow') denied.delete(command.id);
    else denied.add(command.id);
  };

  const available = (command: CommandDef): boolean => !denied.has(command.id) && (command.when?.() ?? true);

  const registry: CommandRegistry = {
    list: () => [...commands.values()],
    get: (id) => commands.get(id),
    register(command, scope) {
      const added = add(command);
      if (!added.ok) return added;
      void decideOne(command);
      const remove = (): void => {
        if (commands.get(command.id) === command) commands.delete(command.id);
      };
      scope?.defer(remove);
      return ok(remove);
    },
    available(id) {
      const command = commands.get(id);
      return command !== undefined && available(command);
    },
    async refreshDecisions(signal) {
      await Promise.all([...commands.values()].map((c) => decideOne(c, signal)));
    },
    search(query, searchOptions = {}) {
      const results: CommandSearchResult[] = [];
      for (const command of commands.values()) {
        if (!available(command)) continue;
        const onTitle = fuzzyMatch(query, command.title);
        let best: FuzzyMatch | undefined = onTitle;
        for (const keyword of command.keywords ?? []) {
          const m = fuzzyMatch(query, keyword);
          if (m !== undefined && (best === undefined || m.score - 2 > best.score)) best = { score: m.score - 2, indices: onTitle?.indices ?? [] };
        }
        if (best !== undefined) results.push({ command, score: best.score, indices: best.indices });
      }
      results.sort((a, b) => b.score - a.score || a.command.title.localeCompare(b.command.title));
      return results.slice(0, searchOptions.limit ?? 50);
    },
    async run(id, context = {}) {
      const command = commands.get(id);
      if (command === undefined) return err(UnknownCommandError({ details: { command: id } }));
      if (!available(command)) return err(CommandUnavailableError({ details: { command: id } }));
      const source = context.source ?? 'api';
      const span = telemetry.span('shell.command', { subsystem: SHELL_SUBSYSTEM, level: 'standard', attrs: { command: id, source } });
      const outcome = await attemptAsync(async () => command.run({ signal: context.signal ?? new AbortController().signal, source }));
      let result: Result<unknown>;
      if (!outcome.ok) result = err(CommandFailedError({ cause: toSfError(outcome.error), details: { command: id } }));
      else if (typeof outcome.value === 'object' && outcome.value !== null && 'ok' in outcome.value) result = outcome.value;
      else result = ok(outcome.value);
      telemetry.record(shellMetrics.commandRuns, 1, { command: id, outcome: result.ok ? 'ok' : 'error' });
      span.end(result.ok ? 'ok' : 'error', result.ok ? undefined : result.error);
      return result;
    },
  };
  void registry.refreshDecisions();
  return ok(registry);
}
