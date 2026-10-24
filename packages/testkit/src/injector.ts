/**
 * `createTestInjector` (R16.2): a real core injector with a recording telemetry and
 * overrides bound at the highest precedence (`experiment`), so a fake always wins
 * over the unit it replaces — the same `bind`/`variant` semantics apps use.
 */
import {
  type AnyUnit,
  type Binding,
  bind,
  createInjector,
  type Injector,
  type LevelName,
  type Registration,
  type ScopeLevel,
  type Subsystem,
  type Token,
  unit,
} from '@staticflux/core';
import { TestResolveFailedError } from './errors.js';
import { createTestTelemetry, type TestTelemetry } from './telemetry.js';

export const OVERRIDE_SOURCE = 'testkit/override';

function isBinding(entry: Registration): entry is Binding {
  return 'kind' in entry && (entry as { kind?: unknown }).kind === 'binding';
}

/** Re-bind every entry at `experiment` precedence (keeps a binding's `when`). */
export function asOverrides(entries: readonly Registration[]): Binding[] {
  return entries.map((entry) =>
    isBinding(entry)
      ? bind(entry.unit, {
          precedence: 'experiment',
          source: entry.source ?? OVERRIDE_SOURCE,
          ...(entry.when === undefined ? {} : { when: entry.when }),
        })
      : bind(entry as AnyUnit, { precedence: 'experiment', source: OVERRIDE_SOURCE }),
  );
}

/** A unit that provides a fixed value for `token` (use as an override). */
export function provideValue<T>(provides: Token<T>, value: T, scope: ScopeLevel = 'app'): AnyUnit {
  return unit({ id: `testkit/value:${provides.id}`, provides, scope, create: () => value });
}

export interface TestInjectorOptions {
  readonly units?: readonly Registration[];
  /** Bound with `experiment` precedence: they beat every regular binding of the same token. */
  readonly overrides?: readonly Registration[];
  /** Injector scope level (default `app`). */
  readonly level?: ScopeLevel;
  readonly name?: string;
  /** Telemetry default level (default `debug`, so every span is recorded). */
  readonly telemetryLevel?: LevelName;
  readonly telemetryLevels?: Readonly<Partial<Record<Subsystem, LevelName>>>;
  /** Telemetry clock (e.g. a fake clock's `now`). */
  readonly now?: () => number;
  /** Idle scheduler for `idle` init timing (e.g. `time.injectorIdle`). Default: run on the next microtask. */
  readonly idle?: (callback: () => void) => void;
}

export interface TestInjector extends TestTelemetry {
  readonly injector: Injector;
  /** Resolve and unwrap; throws `SF-TEST-002` (with the injector error as cause) on failure. */
  get<T>(token: Token<T>): Promise<T>;
  /** Disposes the injector and detaches the sink. */
  dispose(): Promise<void>;
}

export function createTestInjector(options: TestInjectorOptions = {}): TestInjector {
  const recording = createTestTelemetry({
    level: options.telemetryLevel ?? 'debug',
    ...(options.telemetryLevels === undefined ? {} : { levels: options.telemetryLevels }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const injector = createInjector({
    name: options.name ?? 'test',
    level: options.level ?? 'app',
    telemetry: recording.telemetry,
    idle: options.idle ?? ((callback) => queueMicrotask(callback)),
    units: [...(options.units ?? []), ...asOverrides(options.overrides ?? [])],
  });
  return {
    ...recording,
    injector,
    get records() {
      return recording.records;
    },
    async get<T>(token: Token<T>): Promise<T> {
      const result = await injector.get(token);
      if (!result.ok) {
        throw TestResolveFailedError({
          message: `Could not resolve "${token.id}": ${result.error.code} ${result.error.message}`,
          cause: result.error,
        });
      }
      return result.value;
    },
    async dispose() {
      await injector.dispose();
      recording.dispose();
    },
  };
}
