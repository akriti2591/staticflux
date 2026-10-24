/**
 * The locale service: reactive current locale + direction, lazy catalog
 * loading along the fallback chain, ICU formatting and `Intl` helpers.
 *
 * Switching locale loads every catalog in use for the new locale first and
 * then flips atomically, so the UI never shows a half-translated frame. A
 * failed switch keeps the previous locale. Reads of `locale`, `dir` and `t()`
 * are tracked by the reactivity port, so components re-render on switch.
 */
import {
  AbortedError,
  anySignal,
  batch,
  box,
  createMachine,
  createNoopTelemetry,
  createSingleFlight,
  defineMachine,
  derived,
  err,
  metric,
  ok,
  type Result,
  type SfError,
  type Telemetry,
  untracked,
} from '@staticflux/core';
import { MissingParamError, UnsupportedLocaleError } from './errors.js';
import { createFormatters, type Formatters } from './formatters.js';
import { formatNodes, type IcuNode, parseMessage } from './icu.js';
import { canonicalizeLocale, localeFallbackChain, negotiateLocale, type TextDirection, textDirection } from './locale.js';
import {
  type AnyMessages,
  CATALOG,
  type CatalogLoader,
  type MessageArgs,
  type MessageParams,
  type MessageRef,
  type TranslationBundle,
} from './messages.js';

export const LocaleMachine = defineMachine({
  id: 'i18n/locale',
  initial: 'ready',
  states: ['ready', 'switching'],
  transitions: {
    ready: { switch: 'switching' },
    switching: { switch: 'switching', switched: 'ready', failed: 'ready' },
  },
});
export type LocaleState = (typeof LocaleMachine.states)[number];

export const CatalogMachine = defineMachine({
  id: 'i18n/catalog',
  initial: 'unloaded',
  states: ['unloaded', 'loading', 'loaded', 'failed'],
  transitions: {
    unloaded: { load: 'loading' },
    loading: { loaded: 'loaded', fail: 'failed' },
    failed: { load: 'loading' },
  },
  terminal: ['loaded'],
});
export type CatalogState = (typeof CatalogMachine.states)[number];

export const I18nMetrics = {
  catalogLoad: metric.histogram('i18n/catalog-load', { unit: 'ms', description: 'Time to load one catalog for one locale.' }),
  missingTranslation: metric.counter('i18n/missing-translation', { description: 'Messages shown in the source locale.' }),
  localeSwitch: metric.histogram('i18n/locale-switch', { unit: 'ms', description: 'Time from setLocale() to the flip.' }),
} as const;

const SUBSYSTEM = 'i18n/locale';

export interface I18nConfig {
  /** Locale used when nothing better matches; usually the source locale of the catalogs. */
  readonly defaultLocale: string;
  /** Locales the app ships. */
  readonly available: readonly string[];
  /** The user's preference list at startup (e.g. `navigator.languages`, a settings slice, `?lang=`). */
  readonly requested?: readonly string[];
  /** Catalogs to load during init (the active route's catalogs). */
  readonly preload?: readonly AnyMessages[];
}

export interface I18nOptions extends I18nConfig {
  readonly loaders?: readonly CatalogLoader[];
  readonly telemetry?: Telemetry;
  /** Aborts background loads when the owning scope ends. */
  readonly signal?: AbortSignal;
  /** Injectable `Intl` (tests, engines with gaps). */
  readonly intl?: Parameters<typeof createFormatters>[1];
}

export interface FormatIssue {
  readonly kind: 'missing-param' | 'syntax-error' | 'missing-translation';
  readonly id: string;
  readonly locale: string;
  readonly detail: string;
}

export interface CatalogInfo {
  readonly namespace: string;
  readonly locale: string;
  readonly state: CatalogState;
}

export interface I18n {
  /** Current locale. Reactive. */
  readonly locale: string;
  /** Writing direction of the current locale. Reactive. */
  readonly dir: TextDirection;
  /** Lookup order for the current locale (ends with the default locale). Reactive. */
  readonly fallbackChain: readonly string[];
  readonly available: readonly string[];
  readonly defaultLocale: string;
  /** Locale-switch lifecycle state. Reactive. */
  readonly state: LocaleState;
  /** Format a message. Never throws; problems are reported to telemetry and `onIssue`. Reactive. */
  t<P>(ref: MessageRef<P>, ...args: MessageArgs<P>): string;
  /** Format a message, returning syntax/missing-param problems as errors. */
  tryFormat<P>(ref: MessageRef<P>, ...args: MessageArgs<P>): Result<string>;
  /** True if the current chain has a real translation (not just the source fallback). */
  has(ref: MessageRef<unknown>): boolean;
  /** Ensure these catalogs are loaded for the current locale (and kept loaded on switch). */
  load(catalogs: AnyMessages | readonly AnyMessages[], signal?: AbortSignal): Promise<Result<void>>;
  /** Switch locale at runtime (negotiated against `available`). Resolves to the locale actually used. */
  setLocale(requested: string, signal?: AbortSignal): Promise<Result<string>>;
  negotiate(requested: readonly string[]): string;
  number(value: number, options?: Intl.NumberFormatOptions): string;
  currency(value: number, currency: string, options?: Intl.NumberFormatOptions): string;
  date(value: Date | number, options?: Intl.DateTimeFormatOptions): string;
  relativeTime(value: number, unit: Intl.RelativeTimeFormatUnit, options?: Intl.RelativeTimeFormatOptions): string;
  list(items: readonly string[], options?: Intl.ListFormatOptions): string;
  pluralCategory(value: number, type?: Intl.PluralRuleType): Intl.LDMLPluralRule;
  /** Formatters for the current locale. */
  formatters(): Formatters;
  /** Called after every completed switch. Returns unsubscribe. */
  onChange(listener: (locale: string, previous: string) => void): () => void;
  /** Called for every formatting problem. Returns unsubscribe. */
  onIssue(listener: (issue: FormatIssue) => void): () => void;
  /** Loaded catalogs (devtools). */
  inspect(): readonly CatalogInfo[];
}

interface CatalogEntry {
  readonly machine: ReturnType<typeof createMachine<CatalogState, 'load' | 'loaded' | 'fail'>>;
  bundle: TranslationBundle | undefined;
}

export function createI18n(options: I18nOptions): I18n {
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const loaders = options.loaders ?? [];
  const lifetime = options.signal;
  const defaultLocale = options.defaultLocale;
  const available = options.available.includes(defaultLocale) ? options.available : [defaultLocale, ...options.available];
  const negotiate = (requested: readonly string[]): string => negotiateLocale(requested, available, defaultLocale);

  const localeBox = box(negotiate(options.requested ?? []));
  const version = box(0);
  const chain = derived(() => localeFallbackChain(localeBox.get(), defaultLocale));
  const direction = derived(() => textDirection(localeBox.get()));
  const machine = createMachine(LocaleMachine, {
    onInvalid: (state, event) =>
      telemetry.event('lifecycle.invalid', { subsystem: SUBSYSTEM, level: 'critical', attrs: { machine: LocaleMachine.id, state, event } }),
  });
  machine.onTransition((r) =>
    telemetry.event(`lifecycle.${r.machine}.${r.from}→${r.to}`, { subsystem: SUBSYSTEM, level: 'verbose', attrs: { event: r.event } }),
  );

  const catalogs = new Map<string, string>(); // namespace → source locale (ensured namespaces)
  const entries = new Map<string, CatalogEntry>(); // `${ns}@${locale}`
  const flights = createSingleFlight<string, void>();
  const compiled = new Map<string, Result<readonly IcuNode[]>>();
  const formatterCache = new Map<string, Formatters>();
  const changeListeners = new Set<(locale: string, previous: string) => void>();
  const issueListeners = new Set<(issue: FormatIssue) => void>();
  const reportedMissing = new Set<string>();
  let switchSeq = 0;

  const bump = (): void => version.set(untracked(() => version.get()) + 1);

  const formattersFor = (locale: string): Formatters => {
    let f = formatterCache.get(locale);
    if (f === undefined) {
      f = createFormatters(locale, options.intl);
      formatterCache.set(locale, f);
    }
    return f;
  };

  const compile = (text: string): Result<readonly IcuNode[]> => {
    let result = compiled.get(text);
    if (result === undefined) {
      result = parseMessage(text);
      compiled.set(text, result);
    }
    return result;
  };

  const report = (issue: FormatIssue): void => {
    const level = issue.kind === 'syntax-error' ? 'critical' : issue.kind === 'missing-param' ? 'standard' : 'debug';
    telemetry.event(`i18n.${issue.kind}`, { subsystem: SUBSYSTEM, level, attrs: { id: issue.id, locale: issue.locale, detail: issue.detail } });
    for (const listener of issueListeners) listener(issue);
  };

  const sameLocale = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

  const entryFor = (namespace: string, locale: string): CatalogEntry => {
    const key = `${namespace}@${locale.toLowerCase()}`;
    let entry = entries.get(key);
    if (entry === undefined) {
      entry = { machine: createMachine(CatalogMachine), bundle: undefined };
      entries.set(key, entry);
    }
    return entry;
  };

  const loadOne = async (namespace: string, locale: string, signal: AbortSignal): Promise<Result<void>> => {
    const sourceLocale = catalogs.get(namespace) ?? defaultLocale;
    if (sameLocale(sourceLocale, locale)) return ok();
    const entry = entryFor(namespace, locale);
    if (entry.machine.state === 'loaded') return ok();
    const relevant = loaders.filter((l) => l.namespace === namespace && l.locales.some((x) => sameLocale(x, locale)));
    if (relevant.length === 0) {
      // Nothing ships for this locale: the chain continues. Not an error.
      entry.machine.send('load');
      entry.machine.send('loaded');
      return ok();
    }
    return flights.run(
      `${namespace}@${locale.toLowerCase()}`,
      async (flightSignal) => {
        entry.machine.send('load');
        const span = telemetry.span('i18n.catalog-load', { subsystem: SUBSYSTEM, attrs: { namespace, locale } });
        const started = telemetry.now();
        const merged: Record<string, string> = {};
        for (const loader of relevant) {
          const result = await loader.load(locale, flightSignal);
          if (!result.ok) {
            entry.machine.send('fail');
            span.end(result.error.kind === 'aborted' ? 'cancelled' : 'error', result.error);
            return result;
          }
          if (result.value !== undefined) Object.assign(merged, result.value.messages);
        }
        if (flightSignal.aborted) {
          entry.machine.send('fail');
          span.end('cancelled');
          return err(AbortedError());
        }
        entry.bundle = { kind: 'translations', namespace, locale, messages: merged };
        entry.machine.send('loaded');
        telemetry.record(I18nMetrics.catalogLoad, telemetry.now() - started, { namespace, locale });
        span.end('ok');
        return ok();
      },
      signal,
    );
  };

  const loadAll = async (namespaces: readonly string[], locales: readonly string[], signal: AbortSignal): Promise<Result<void>> => {
    const results = await Promise.all(namespaces.flatMap((ns) => locales.map((locale) => loadOne(ns, locale, signal))));
    const failure = results.find((r) => !r.ok);
    return failure ?? ok();
  };

  const signalFor = (signal: AbortSignal | undefined): AbortSignal => anySignal(signal, lifetime);

  /**
   * Walk the chain. A source-locale hit counts as "translated" only when the source
   * locale is part of the current locale's own truncation chain (`en-GB` → `en`),
   * not when reached as the default at the end of the chain.
   */
  const resolveText = (ref: MessageRef<unknown>): { text: string; translated: boolean } => {
    const current = chain.get();
    const own = localeFallbackChain(localeBox.get(), localeBox.get()).length;
    for (let index = 0; index < current.length; index += 1) {
      const locale = current[index] ?? '';
      if (sameLocale(locale, ref.sourceLocale)) return { text: ref.source, translated: index < own };
      const text = entries.get(`${ref.namespace}@${locale.toLowerCase()}`)?.bundle?.messages[ref.key];
      if (text !== undefined) return { text, translated: true };
    }
    return { text: ref.source, translated: false };
  };

  const ensureRegistered = (namespace: string, sourceLocale: string): void => {
    if (catalogs.has(namespace)) return;
    catalogs.set(namespace, sourceLocale);
    // First use without an explicit load(): fetch in the background; the bump re-renders readers.
    // Deferred: never mutate observable state inside the (tracked) render that triggered it.
    queueMicrotask(() => {
      void loadAll([namespace], untracked(() => chain.get()), signalFor(undefined)).then((r) => {
        if (r.ok) bump();
      });
    });
  };

  const render = (ref: MessageRef<unknown>, params: MessageParams): { text: string; error: SfError | undefined } => {
    localeBox.get();
    version.get(); // track catalog arrivals
    ensureRegistered(ref.namespace, ref.sourceLocale);
    const locale = localeBox.get();
    const { text, translated } = resolveText(ref);
    if (!translated && !reportedMissing.has(`${ref.id}@${locale}`)) {
      reportedMissing.add(`${ref.id}@${locale}`);
      telemetry.record(I18nMetrics.missingTranslation, 1, { id: ref.id, locale });
      report({ kind: 'missing-translation', id: ref.id, locale, detail: 'source text shown' });
    }
    let error: SfError | undefined;
    let nodes = compile(text);
    if (!nodes.ok) {
      report({ kind: 'syntax-error', id: ref.id, locale, detail: nodes.error.message });
      error = nodes.error;
      nodes = text === ref.source ? nodes : compile(ref.source);
      if (!nodes.ok) return { text: ref.source, error };
    }
    const outcome = formatNodes(nodes.value, params, formattersFor(locale));
    if (outcome.missing.length > 0) {
      report({ kind: 'missing-param', id: ref.id, locale, detail: outcome.missing.join(',') });
      error ??= MissingParamError({
        message: `Message "${ref.id}" is missing params: ${outcome.missing.join(', ')}.`,
        details: { id: ref.id, missing: outcome.missing },
      });
    }
    return { text: outcome.text, error };
  };

  // Catalogs given up front are known (and loaded by `load`/`preload`).
  for (const messages of options.preload ?? []) catalogs.set(messages[CATALOG].namespace, messages[CATALOG].sourceLocale);

  const i18n: I18n = {
    get locale() {
      return localeBox.get();
    },
    get dir() {
      return direction.get();
    },
    get fallbackChain() {
      return chain.get();
    },
    available,
    defaultLocale,
    get state() {
      return machine.state;
    },
    t(ref, ...args) {
      return render(ref, (args[0] ?? {}) as MessageParams).text;
    },
    tryFormat(ref, ...args) {
      const out = render(ref, (args[0] ?? {}) as MessageParams);
      return out.error === undefined ? ok(out.text) : err(out.error);
    },
    has(ref) {
      localeBox.get();
      version.get();
      return resolveText(ref).translated;
    },
    async load(input, signal) {
      const list = Array.isArray(input) ? (input as readonly AnyMessages[]) : [input as AnyMessages];
      for (const messages of list) catalogs.set(messages[CATALOG].namespace, messages[CATALOG].sourceLocale);
      const result = await loadAll(
        list.map((m) => m[CATALOG].namespace),
        chain.get(),
        signalFor(signal),
      );
      bump();
      return result;
    },
    async setLocale(requested, signal) {
      const canonical = canonicalizeLocale(requested);
      if (canonical === undefined) return err(UnsupportedLocaleError({ details: { requested } }));
      const target = negotiate([canonical]);
      const previous = localeBox.get();
      if (sameLocale(target, previous) && machine.state === 'ready') return ok(previous);
      switchSeq += 1;
      const seq = switchSeq;
      machine.send('switch');
      const span = telemetry.span('i18n.switch', { subsystem: SUBSYSTEM, attrs: { from: previous, to: target } });
      const started = telemetry.now();
      const result = await loadAll([...catalogs.keys()], localeFallbackChain(target, defaultLocale), signalFor(signal));
      if (seq !== switchSeq) {
        span.end('cancelled');
        return err(AbortedError({ message: `Locale switch to "${target}" was superseded.` }));
      }
      if (!result.ok) {
        machine.send('failed');
        span.end('error', result.error);
        return err(result.error);
      }
      batch(() => {
        localeBox.set(target);
        bump();
      });
      machine.send('switched');
      telemetry.record(I18nMetrics.localeSwitch, telemetry.now() - started, { locale: target });
      span.end('ok');
      if (!sameLocale(previous, target)) for (const listener of changeListeners) listener(target, previous);
      return ok(target);
    },
    negotiate,
    number: (value, opts) => formattersFor(localeBox.get()).number(value, opts),
    currency: (value, currency, opts) => formattersFor(localeBox.get()).currency(value, currency, opts),
    date: (value, opts) => formattersFor(localeBox.get()).date(value, opts),
    relativeTime: (value, unit, opts) => formattersFor(localeBox.get()).relativeTime(value, unit, opts),
    list: (items, opts) => formattersFor(localeBox.get()).list(items, opts),
    pluralCategory: (value, type) => formattersFor(localeBox.get()).pluralCategory(value, type),
    formatters: () => formattersFor(localeBox.get()),
    onChange(listener) {
      changeListeners.add(listener);
      return () => {
        changeListeners.delete(listener);
      };
    },
    onIssue(listener) {
      issueListeners.add(listener);
      return () => {
        issueListeners.delete(listener);
      };
    },
    inspect() {
      return [...entries.entries()].map(([key, entry]) => {
        const [namespace = '', locale = ''] = key.split('@');
        return { namespace, locale, state: entry.machine.state };
      });
    },
  };
  return i18n;
}
