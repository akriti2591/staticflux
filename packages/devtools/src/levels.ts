/**
 * Runtime verbosity switching (R17.14): per-subsystem levels changed from the
 * panel or a session-scoped URL flag `?sf-debug=<subsystem:level,...>`, without
 * reload. Built only on `telemetry.setLevel` / `telemetry.enabled` (core has no
 * level getter, so the effective level is probed).
 */
import { err, Level, type LevelName, ok, type Result, type Subsystem, type Telemetry } from '@staticflux/core';
import { InvalidDebugFlagError } from './errors.js';

export const DEBUG_FLAG_PARAM = 'sf-debug' as const;
/** sessionStorage key used to keep a debug flag for the rest of the tab session. */
export const DEBUG_SESSION_KEY = 'sf-devtools/debug' as const;

export const LEVEL_NAMES: readonly LevelName[] = ['off', 'critical', 'standard', 'verbose', 'debug'];

/** A subsystem selector accepted by `telemetry.setLevel`: exact `area/name`, prefix `area/*`, or `*` (default). */
export type SubsystemSelector = Subsystem | '*';

export interface LevelEntry {
  readonly subsystem: SubsystemSelector;
  readonly level: LevelName;
}

const SELECTOR = /^(\*|[a-z0-9][a-z0-9-]*\/(\*|[a-z0-9][a-z0-9-/.]*))$/;

function isLevel(value: string): value is LevelName {
  return (LEVEL_NAMES as readonly string[]).includes(value);
}

/**
 * Parse `core/di:verbose,router/*:debug`. A bare level (`verbose`) means `*:verbose`;
 * an empty value, `1` or `true` means `*:debug`. Any invalid entry fails the whole flag.
 */
export function parseDebugFlag(value: string): Result<readonly LevelEntry[]> {
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === '1' || trimmed === 'true') return ok([{ subsystem: '*', level: 'debug' }]);
  const entries: LevelEntry[] = [];
  const invalid: string[] = [];
  for (const raw of trimmed.split(',')) {
    const part = raw.trim();
    if (part === '') continue;
    const colon = part.lastIndexOf(':');
    if (colon < 0) {
      if (isLevel(part)) entries.push({ subsystem: '*', level: part });
      else invalid.push(part);
      continue;
    }
    const subsystem = part.slice(0, colon).trim();
    const level = part.slice(colon + 1).trim();
    if (!SELECTOR.test(subsystem) || !isLevel(level)) {
      invalid.push(part);
      continue;
    }
    entries.push({ subsystem: subsystem as SubsystemSelector, level });
  }
  if (invalid.length > 0) {
    return err(InvalidDebugFlagError({ message: `Invalid sf-debug entries: ${invalid.join(', ')}`, details: { invalid } }));
  }
  return ok(entries);
}

/** Serialize entries back to the flag format (stable order: `*` first, then by subsystem). */
export function formatDebugFlag(entries: readonly LevelEntry[]): string {
  return [...entries]
    .sort((a, b) => (a.subsystem === '*' ? -1 : b.subsystem === '*' ? 1 : a.subsystem.localeCompare(b.subsystem)))
    .map((e) => `${e.subsystem}:${e.level}`)
    .join(',');
}

/** Read the raw `sf-debug` value from a URL / search string. `undefined` when absent. */
export function readDebugFlag(url: string | URL | URLSearchParams): string | undefined {
  let params: URLSearchParams;
  if (url instanceof URLSearchParams) params = url;
  else if (url instanceof URL) params = url.searchParams;
  else if (url.startsWith('?') || !url.includes('://')) params = new URLSearchParams(url.includes('?') ? url.slice(url.indexOf('?')) : url);
  else params = new URL(url).searchParams;
  const value = params.get(DEBUG_FLAG_PARAM);
  return value === null ? undefined : value;
}

/** Highest level enabled for `subsystem` (probed via `telemetry.enabled`). */
export function effectiveLevel(telemetry: Pick<Telemetry, 'enabled'>, subsystem: Subsystem): LevelName {
  for (let i = LEVEL_NAMES.length - 1; i > 0; i -= 1) {
    const name = LEVEL_NAMES[i] as LevelName;
    if (telemetry.enabled(subsystem, name)) return name;
  }
  return 'off';
}

/** Minimal storage port (structural subset of `Storage`). */
export interface SessionStoragePort {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface VerbosityControl {
  /** Change a level now (no reload). Remembers the level that was effective before the first override. */
  setLevel(subsystem: SubsystemSelector, level: LevelName): void;
  /** Apply several entries (e.g. a parsed flag). */
  apply(entries: readonly LevelEntry[]): void;
  /** Overrides made through this control (subsystem → level). */
  overrides(): readonly LevelEntry[];
  /** Effective level for a concrete subsystem. */
  levelOf(subsystem: Subsystem): LevelName;
  /** Undo one override (or all), restoring the probed previous level. */
  reset(subsystem?: SubsystemSelector): void;
  /** Persist the current overrides for this tab session (or clear with `undefined`). */
  persistSession(enabled: boolean): void;
  /** Parse + apply a flag string; invalid flags change nothing. */
  applyFlag(value: string): Result<readonly LevelEntry[]>;
  onChange(listener: () => void): () => void;
}

export interface VerbosityOptions {
  readonly telemetry: Telemetry;
  readonly session?: SessionStoragePort | undefined;
  /** Level restored when resetting `*` (default `standard`, core's default). */
  readonly defaultLevel?: LevelName;
}

/** Probe the subsystem a selector stands for (prefix selectors probe a synthetic member). */
function probeSubsystem(selector: SubsystemSelector): Subsystem | undefined {
  if (selector === '*') return undefined;
  return (selector.endsWith('/*') ? `${selector.slice(0, -2)}/__devtools-probe__` : selector) as Subsystem;
}

export function createVerbosityControl(options: VerbosityOptions): VerbosityControl {
  const { telemetry } = options;
  const current = new Map<SubsystemSelector, LevelName>();
  const previous = new Map<SubsystemSelector, LevelName>();
  const listeners = new Set<() => void>();
  let persist = false;
  const notify = (): void => {
    if (persist) writeSession();
    for (const listener of [...listeners]) listener();
  };
  const writeSession = (): void => {
    const session = options.session;
    if (session === undefined) return;
    try {
      if (current.size === 0) session.removeItem(DEBUG_SESSION_KEY);
      else session.setItem(DEBUG_SESSION_KEY, formatDebugFlag(control.overrides()));
    } catch {
      // storage can throw (private mode, quota) — devtools degrade silently
    }
  };
  const set = (subsystem: SubsystemSelector, level: LevelName): void => {
    if (!previous.has(subsystem)) {
      const probe = probeSubsystem(subsystem);
      previous.set(subsystem, probe === undefined ? (options.defaultLevel ?? 'standard') : effectiveLevel(telemetry, probe));
    }
    current.set(subsystem, level);
    telemetry.setLevel(subsystem, level);
  };
  const control: VerbosityControl = {
    setLevel(subsystem, level) {
      set(subsystem, level);
      notify();
    },
    apply(entries) {
      for (const entry of entries) set(entry.subsystem, entry.level);
      notify();
    },
    overrides: () => [...current].map(([subsystem, level]) => ({ subsystem, level })),
    levelOf: (subsystem) => effectiveLevel(telemetry, subsystem),
    reset(subsystem) {
      const targets = subsystem === undefined ? [...current.keys()] : [subsystem];
      for (const target of targets) {
        const before = previous.get(target);
        if (before !== undefined) telemetry.setLevel(target, before);
        current.delete(target);
        previous.delete(target);
      }
      notify();
    },
    persistSession(enabled) {
      persist = enabled;
      if (enabled) writeSession();
      else {
        try {
          options.session?.removeItem(DEBUG_SESSION_KEY);
        } catch {
          // ignore
        }
      }
    },
    applyFlag(value) {
      const parsed = parseDebugFlag(value);
      if (parsed.ok) control.apply(parsed.value);
      return parsed;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return control;
}

/** Read the stored session flag (if any). */
export function readSessionFlag(session: SessionStoragePort | undefined): string | undefined {
  if (session === undefined) return undefined;
  try {
    return session.getItem(DEBUG_SESSION_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Numeric rank, for sorting/comparing levels in views. */
export function levelRank(level: LevelName): number {
  return Level[level];
}
