import { createDeferred, createInjector, createMemorySink, createScope, createTelemetry, effect, err, ok, type Result } from '@staticflux/core';
import { describe, expect, it, vi } from 'vitest';
import { CatalogLoadError } from './errors.js';
import { catalogLoader, type CatalogLoader, defineMessages, defineTranslations, type TranslationBundle } from './messages.js';
import { createI18n } from './service.js';
import { bindDocumentLocale, CatalogLoadersToken, catalogLoaderUnit, I18nConfigToken, i18nConfigUnit, I18nToken, i18nUnit } from './units.js';

const m = defineMessages('studio', {
  saved: 'Saved',
  greeting: 'Hello {name}!',
  items: '{count, plural, one {# item} other {# items}}',
  broken: 'fine in source',
});

const fr = defineTranslations(m, 'fr', {
  saved: 'Enregistré',
  greeting: 'Bonjour {name} !',
  items: '{count, plural, one {# élément} other {# éléments}}',
  broken: '{oops',
});
const frCA = defineTranslations(m, 'fr-CA', { saved: 'Sauvegardé' });
const ar = defineTranslations(m, 'ar', { saved: 'تم الحفظ' });

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function loaderFrom(bundles: Record<string, TranslationBundle>, spy?: (locale: string) => void): CatalogLoader {
  return catalogLoader(
    m,
    Object.fromEntries(
      Object.entries(bundles).map(([locale, bundle]) => [
        locale,
        async () => {
          spy?.(locale);
          return bundle;
        },
      ]),
    ),
  );
}

describe('createI18n: formatting and fallback', () => {
  it('formats source messages and negotiates the initial locale', () => {
    const i18n = createI18n({ defaultLocale: 'en', available: ['en', 'fr'], requested: ['de', 'fr-BE'] });
    expect(i18n.locale).toBe('fr');
    expect(i18n.available).toEqual(['en', 'fr']);
    const en = createI18n({ defaultLocale: 'en', available: ['fr'] });
    expect(en.locale).toBe('en');
    expect(en.available).toEqual(['en', 'fr']);
    expect(en.t(m.saved)).toBe('Saved');
    expect(en.t(m.greeting, { name: 'Ada' })).toBe('Hello Ada!');
    expect(en.t(m.items, { count: 2 })).toBe('2 items');
    expect(en.dir).toBe('ltr');
  });

  it('loads catalogs along the fallback chain and prefers the most specific translation', async () => {
    const loaded: string[] = [];
    const i18n = createI18n({
      defaultLocale: 'en',
      available: ['en', 'fr', 'fr-CA'],
      requested: ['fr-CA'],
      loaders: [loaderFrom({ fr, 'fr-CA': frCA }, (l) => loaded.push(l))],
    });
    expect(await i18n.load(m)).toEqual(ok());
    expect(loaded.sort()).toEqual(['fr', 'fr-CA']);
    expect(i18n.fallbackChain).toEqual(['fr-CA', 'fr', 'en']);
    expect(i18n.t(m.saved)).toBe('Sauvegardé'); // fr-CA
    expect(i18n.t(m.greeting, { name: 'Ada' })).toBe('Bonjour Ada !'); // fr
    expect(i18n.t(m.items, { count: 1 })).toBe('1 élément');
    expect(i18n.has(m.saved)).toBe(true);
    expect(i18n.inspect()).toEqual(
      expect.arrayContaining([
        { namespace: 'studio', locale: 'fr-ca', state: 'loaded' },
        { namespace: 'studio', locale: 'fr', state: 'loaded' },
      ]),
    );
  });

  it('falls back to source text for missing translations and reports it once', async () => {
    const sink = createMemorySink();
    const telemetry = createTelemetry({ defaultLevel: 'debug' });
    telemetry.addSink(sink);
    const i18n = createI18n({ defaultLocale: 'en', available: ['en', 'ar'], requested: ['ar'], loaders: [loaderFrom({ ar })], telemetry });
    const issues = vi.fn();
    i18n.onIssue(issues);
    await i18n.load([m]);
    expect(i18n.dir).toBe('rtl');
    expect(i18n.t(m.saved)).toBe('تم الحفظ');
    expect(i18n.t(m.greeting, { name: 'x' })).toBe('Hello x!');
    expect(i18n.t(m.greeting, { name: 'y' })).toBe('Hello y!');
    expect(i18n.has(m.greeting)).toBe(false);
    expect(issues.mock.calls.filter(([i]) => i.kind === 'missing-translation')).toHaveLength(1);
    expect(sink.records.some((r) => r.type === 'metric' && r.metric === 'i18n/missing-translation')).toBe(true);
    expect(sink.records.some((r) => r.type === 'span' && r.name === 'i18n.catalog-load')).toBe(true);
  });

  it('falls back to the source message when a translation has a syntax error', async () => {
    const i18n = createI18n({ defaultLocale: 'en', available: ['fr'], requested: ['fr'], loaders: [loaderFrom({ fr })] });
    const issues = vi.fn();
    i18n.onIssue(issues);
    await i18n.load(m);
    expect(i18n.t(m.broken)).toBe('fine in source');
    expect(issues).toHaveBeenCalledWith(expect.objectContaining({ kind: 'syntax-error', id: 'studio/broken' }));
    const r = i18n.tryFormat(m.broken);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('SF-I18N-001');
  });

  it('returns raw source when even the source message is broken', () => {
    const bad = defineMessages('bad', { x: 'oops {' });
    const i18n = createI18n({ defaultLocale: 'en', available: [] });
    expect(i18n.t(bad.x)).toBe('oops {');
  });

  it('tryFormat reports missing params as SF-I18N-002', () => {
    const i18n = createI18n({ defaultLocale: 'en', available: [] });
    expect(i18n.tryFormat(m.greeting, { name: 'Ada' })).toEqual(ok('Hello Ada!'));
    const missing = i18n.tryFormat(m.greeting, {} as { name: string });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe('SF-I18N-002');
    expect(i18n.t(m.greeting, {} as { name: string })).toBe('Hello {name}!');
  });

  it('loads catalogs on first use without an explicit load() and re-renders readers', async () => {
    const i18n = createI18n({ defaultLocale: 'en', available: ['fr'], requested: ['fr'], loaders: [loaderFrom({ fr })] });
    const seen: string[] = [];
    const stop = effect(() => {
      seen.push(i18n.t(m.saved));
    });
    await tick();
    await tick();
    expect(seen).toEqual(['Saved', 'Enregistré']);
    stop();
  });

  it('treats loaders without the locale as "no translation", not as failure', async () => {
    const i18n = createI18n({ defaultLocale: 'en', available: ['de'], requested: ['de'], loaders: [loaderFrom({ fr })] });
    expect(await i18n.load(m)).toEqual(ok());
    expect(i18n.t(m.saved)).toBe('Saved');
  });

  it('merges several loaders for one namespace', async () => {
    const extra: CatalogLoader = {
      namespace: 'studio',
      locales: ['fr'],
      load: async () => ok(defineTranslations(m, 'fr', { saved: 'Sauvé' })),
    };
    const i18n = createI18n({ defaultLocale: 'en', available: ['fr'], requested: ['fr'], loaders: [loaderFrom({ fr }), extra] });
    await i18n.load(m);
    expect(i18n.t(m.saved)).toBe('Sauvé');
    expect(i18n.t(m.greeting, { name: 'A' })).toBe('Bonjour A !');
  });
});

describe('createI18n: runtime locale switch', () => {
  it('switches reactively after catalogs load (atomic flip) and notifies listeners', async () => {
    const gate = createDeferred<void>();
    const loader: CatalogLoader = {
      namespace: 'studio',
      locales: ['fr'],
      load: async () => {
        await gate.promise;
        return ok(fr);
      },
    };
    const i18n = createI18n({ defaultLocale: 'en', available: ['en', 'fr'], loaders: [loader] });
    await i18n.load(m);
    const seen: string[] = [];
    const stop = effect(() => {
      seen.push(`${i18n.locale}:${i18n.t(m.saved)}`);
    });
    const changes = vi.fn();
    i18n.onChange(changes);
    const pending = i18n.setLocale('fr-FR');
    expect(i18n.state).toBe('switching');
    expect(i18n.locale).toBe('en'); // not flipped yet
    gate.resolve();
    expect(await pending).toEqual(ok('fr'));
    expect(i18n.state).toBe('ready');
    expect(seen).toEqual(['en:Saved', 'fr:Enregistré']);
    expect(changes).toHaveBeenCalledWith('fr', 'en');
    expect(await i18n.setLocale('fr')).toEqual(ok('fr')); // no-op
    expect(changes).toHaveBeenCalledTimes(1);
    stop();
  });

  it('keeps the previous locale when a catalog fails to load', async () => {
    const failing: CatalogLoader = { namespace: 'studio', locales: ['fr'], load: async () => err(CatalogLoadError()) };
    const i18n = createI18n({ defaultLocale: 'en', available: ['fr'], loaders: [failing] });
    await i18n.load(m);
    const result = await i18n.setLocale('fr');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('SF-I18N-003');
    expect(i18n.locale).toBe('en');
    expect(i18n.state).toBe('ready');
    expect(i18n.inspect()).toContainEqual({ namespace: 'studio', locale: 'fr', state: 'failed' });
  });

  it('retries a failed catalog on the next attempt', async () => {
    let calls = 0;
    const flaky: CatalogLoader = {
      namespace: 'studio',
      locales: ['fr'],
      load: async (): Promise<Result<TranslationBundle>> => {
        calls += 1;
        return calls === 1 ? err(CatalogLoadError()) : ok(fr);
      },
    };
    const i18n = createI18n({ defaultLocale: 'en', available: ['fr'], loaders: [flaky] });
    await i18n.load(m);
    expect((await i18n.setLocale('fr')).ok).toBe(false);
    expect(await i18n.setLocale('fr')).toEqual(ok('fr'));
    expect(i18n.t(m.saved)).toBe('Enregistré');
  });

  it('newest switch wins; older resolves as aborted', async () => {
    const gate = createDeferred<void>();
    const slow: CatalogLoader = {
      namespace: 'studio',
      locales: ['fr'],
      load: async () => {
        await gate.promise;
        return ok(fr);
      },
    };
    const i18n = createI18n({ defaultLocale: 'en', available: ['fr', 'ar'], loaders: [slow, loaderFrom({ ar })] });
    await i18n.load(m);
    const first = i18n.setLocale('fr');
    const second = await i18n.setLocale('ar');
    expect(second).toEqual(ok('ar'));
    gate.resolve();
    const r = await first;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('aborted');
    expect(i18n.locale).toBe('ar');
  });

  it('rejects malformed tags and coalesces concurrent loads (single-flight)', async () => {
    const spy = vi.fn();
    const i18n = createI18n({ defaultLocale: 'en', available: ['fr'], loaders: [loaderFrom({ fr }, spy)] });
    const bad = await i18n.setLocale('$$$');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe('SF-I18N-004');
    await i18n.load(m);
    await Promise.all([i18n.setLocale('fr'), i18n.setLocale('fr')]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('Intl helpers follow the current locale', async () => {
    const i18n = createI18n({ defaultLocale: 'en', available: ['de'] });
    expect(i18n.number(1234.5)).toBe('1,234.5');
    await i18n.setLocale('de');
    expect(i18n.number(1234.5)).toBe('1.234,5');
    expect(i18n.currency(3, 'EUR').replace(/\s/g, ' ')).toBe('3,00 €');
    expect(i18n.list(['a', 'b'])).toBe('a und b');
    expect(i18n.relativeTime(-1, 'day', { numeric: 'auto' })).toBe('gestern');
    expect(i18n.date(Date.UTC(2026, 0, 15, 12), { year: 'numeric', timeZone: 'UTC' })).toBe('2026');
    expect(i18n.pluralCategory(1)).toBe('one');
    expect(i18n.formatters().locale).toBe('de');
    expect(i18n.negotiate(['de-AT'])).toBe('de');
  });

  it('aborts loads when the lifetime signal ends', async () => {
    const lifetime = new AbortController();
    const loader: CatalogLoader = {
      namespace: 'studio',
      locales: ['fr'],
      load: (_locale, signal) =>
        new Promise((resolve) => signal.addEventListener('abort', () => resolve(err(CatalogLoadError({ message: 'aborted' }))))),
    };
    const i18n = createI18n({ defaultLocale: 'en', available: ['fr'], requested: ['fr'], loaders: [loader], signal: lifetime.signal });
    const pending = i18n.load(m);
    lifetime.abort();
    expect((await pending).ok).toBe(false);
  });

  it('emits lifecycle transition telemetry', async () => {
    const sink = createMemorySink();
    const telemetry = createTelemetry({ defaultLevel: 'verbose' });
    telemetry.addSink(sink);
    const i18n = createI18n({ defaultLocale: 'en', available: ['de'], telemetry });
    await i18n.setLocale('de');
    const names = sink.records.filter((r) => r.type === 'event').map((r) => (r.type === 'event' ? r.name : ''));
    expect(names).toContain('lifecycle.i18n/locale.ready→switching');
    expect(names).toContain('lifecycle.i18n/locale.switching→ready');
    expect(sink.records.some((r) => r.type === 'metric' && r.metric === 'i18n/locale-switch')).toBe(true);
  });
});

describe('i18n DI units', () => {
  it('provides the service with contributed loaders and preloads the active locale', async () => {
    const injector = createInjector({
      units: [
        i18nConfigUnit({ defaultLocale: 'en', available: ['en', 'fr'], requested: ['fr'], preload: [m] }),
        catalogLoaderUnit(loaderFrom({ fr })),
        i18nUnit,
      ],
    });
    const result = await injector.get(I18nToken);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.t(m.saved)).toBe('Enregistré'); // loaded during init
    const loaders = await injector.get(CatalogLoadersToken);
    expect(loaders.ok && loaders.value).toHaveLength(1);
    const config = await injector.get(I18nConfigToken);
    expect(config.ok && config.value.defaultLocale).toBe('en');
  });

  it('a failing preload degrades to source text instead of failing the unit', async () => {
    const failing: CatalogLoader = { namespace: 'studio', locales: ['fr'], load: async () => err(CatalogLoadError()) };
    const injector = createInjector({
      units: [i18nConfigUnit({ defaultLocale: 'en', available: ['fr'], requested: ['fr'], preload: [m] }), catalogLoaderUnit(failing, 1), i18nUnit],
    });
    const result = await injector.get(I18nToken);
    expect(result.ok && result.value.t(m.saved)).toBe('Saved');
  });

  it('works with zero loaders and no preload', async () => {
    const injector = createInjector({ units: [i18nConfigUnit({ defaultLocale: 'en', available: [] }), i18nUnit] });
    const result = await injector.get(I18nToken);
    expect(result.ok && result.value.locale).toBe('en');
  });
});

describe('bindDocumentLocale', () => {
  it('keeps lang and dir in sync and stops with the scope', async () => {
    const i18n = createI18n({ defaultLocale: 'en', available: ['ar', 'fr'] });
    const el = document.createElement('div');
    const scope = createScope('test');
    bindDocumentLocale(i18n, el, scope);
    expect(el.getAttribute('lang')).toBe('en');
    expect(el.getAttribute('dir')).toBe('ltr');
    await i18n.setLocale('ar');
    expect(el.getAttribute('lang')).toBe('ar');
    expect(el.getAttribute('dir')).toBe('rtl');
    await scope.dispose();
    await i18n.setLocale('fr');
    expect(el.getAttribute('lang')).toBe('ar');
  });

  it('defaults to <html>', () => {
    const i18n = createI18n({ defaultLocale: 'en', available: [] });
    const stop = bindDocumentLocale(i18n, undefined);
    expect(document.documentElement.getAttribute('lang')).toBe('en');
    stop();
  });
});
