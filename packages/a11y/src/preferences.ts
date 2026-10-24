/**
 * Platform preference facts (R15.3): reduced motion, contrast, forced colors,
 * color scheme, reduced transparency. Reactive (reads are tracked) and updated
 * from `matchMedia` change events. Without `matchMedia` (workers, old engines,
 * some embedded hosts) the facts keep their safe defaults.
 */
import { box, createScope, type Scope } from '@staticflux/core';

export type ContrastPreference = 'no-preference' | 'more' | 'less' | 'custom';
export type ColorScheme = 'light' | 'dark';

export interface PreferenceSnapshot {
  readonly reducedMotion: boolean;
  readonly contrast: ContrastPreference;
  readonly forcedColors: boolean;
  readonly colorScheme: ColorScheme;
  readonly reducedTransparency: boolean;
}

export interface PreferenceFacts extends PreferenceSnapshot {
  /** True when values come from `matchMedia` (false = defaults only). */
  readonly supported: boolean;
  snapshot(): PreferenceSnapshot;
  dispose(): Promise<void>;
}

export interface PreferenceFactsOptions {
  readonly matchMedia: ((query: string) => MediaQueryList) | undefined;
  /** Disposed with this scope, if given. */
  readonly scope?: Scope;
}

export const PREFERENCE_DEFAULTS: PreferenceSnapshot = Object.freeze({
  reducedMotion: false,
  contrast: 'no-preference',
  forcedColors: false,
  colorScheme: 'light',
  reducedTransparency: false,
});

interface Fact<T> {
  readonly queries: readonly (readonly [query: string, value: T])[];
  readonly fallback: T;
}

const FACTS: { readonly [K in keyof PreferenceSnapshot]: Fact<PreferenceSnapshot[K]> } = {
  reducedMotion: { queries: [['(prefers-reduced-motion: reduce)', true]], fallback: false },
  contrast: {
    queries: [
      ['(prefers-contrast: more)', 'more'],
      ['(prefers-contrast: less)', 'less'],
      ['(prefers-contrast: custom)', 'custom'],
    ],
    fallback: 'no-preference',
  },
  forcedColors: { queries: [['(forced-colors: active)', true]], fallback: false },
  colorScheme: { queries: [['(prefers-color-scheme: dark)', 'dark']], fallback: 'light' },
  reducedTransparency: { queries: [['(prefers-reduced-transparency: reduce)', true]], fallback: false },
};

function listen(list: MediaQueryList, listener: () => void, scope: Scope): void {
  if (typeof list.addEventListener === 'function') {
    list.addEventListener('change', listener);
    scope.defer(() => list.removeEventListener('change', listener));
    return;
  }
  // Safari < 14
  const legacy = list as unknown as { addListener?: (l: () => void) => void; removeListener?: (l: () => void) => void };
  legacy.addListener?.(listener);
  scope.defer(() => legacy.removeListener?.(listener));
}

export function createPreferenceFacts(options: PreferenceFactsOptions): PreferenceFacts {
  const scope = options.scope?.child('a11y/preferences') ?? createScope('a11y/preferences');
  const matchMedia = options.matchMedia;
  const values = {} as { [K in keyof PreferenceSnapshot]: ReturnType<typeof box<PreferenceSnapshot[K]>> };

  const bindFact = <K extends keyof PreferenceSnapshot>(key: K): void => {
    const fact = FACTS[key] as Fact<PreferenceSnapshot[K]>;
    const lists: (readonly [MediaQueryList, PreferenceSnapshot[K]])[] = [];
    if (matchMedia !== undefined) {
      for (const [query, value] of fact.queries) {
        try {
          lists.push([matchMedia(query), value]);
        } catch {
          // unsupported query syntax: keep the default for this branch
        }
      }
    }
    const compute = (): PreferenceSnapshot[K] => lists.find(([list]) => list.matches)?.[1] ?? fact.fallback;
    const value = box(compute());
    values[key] = value as (typeof values)[K];
    for (const [list] of lists) listen(list, () => value.set(compute()), scope);
  };
  for (const key of Object.keys(FACTS) as (keyof PreferenceSnapshot)[]) bindFact(key);

  const facts: PreferenceFacts = {
    supported: matchMedia !== undefined,
    get reducedMotion() {
      return values.reducedMotion.get();
    },
    get contrast() {
      return values.contrast.get();
    },
    get forcedColors() {
      return values.forcedColors.get();
    },
    get colorScheme() {
      return values.colorScheme.get();
    },
    get reducedTransparency() {
      return values.reducedTransparency.get();
    },
    snapshot() {
      return {
        reducedMotion: facts.reducedMotion,
        contrast: facts.contrast,
        forcedColors: facts.forcedColors,
        colorScheme: facts.colorScheme,
        reducedTransparency: facts.reducedTransparency,
      };
    },
    async dispose() {
      await scope.dispose();
    },
  };
  return facts;
}
