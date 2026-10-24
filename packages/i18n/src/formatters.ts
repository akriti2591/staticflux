/**
 * Cached, feature-detected `Intl` formatters for one locale. Constructing Intl
 * objects is expensive, so each (locale, options) pair is built once.
 * Missing APIs (old Safari: `ListFormat`, `RelativeTimeFormat`) degrade to
 * simple, readable fallbacks instead of throwing.
 */

export interface Formatters {
  readonly locale: string;
  number(value: number, options?: Intl.NumberFormatOptions): string;
  currency(value: number, currency: string, options?: Intl.NumberFormatOptions): string;
  date(value: Date | number, options?: Intl.DateTimeFormatOptions): string;
  relativeTime(value: number, unit: Intl.RelativeTimeFormatUnit, options?: Intl.RelativeTimeFormatOptions): string;
  list(items: readonly string[], options?: Intl.ListFormatOptions): string;
  pluralCategory(value: number, type?: Intl.PluralRuleType): Intl.LDMLPluralRule;
}

interface IntlLike {
  readonly NumberFormat?: typeof Intl.NumberFormat;
  readonly DateTimeFormat?: typeof Intl.DateTimeFormat;
  readonly PluralRules?: typeof Intl.PluralRules;
  readonly RelativeTimeFormat?: typeof Intl.RelativeTimeFormat;
  readonly ListFormat?: typeof Intl.ListFormat;
}

function keyOf(options: object | undefined): string {
  return options === undefined ? '' : JSON.stringify(options);
}

/**
 * Build formatters for `locale`. `intl` is injectable so tests can simulate
 * engines without `ListFormat` / `RelativeTimeFormat`.
 */
export function createFormatters(locale: string, intl: IntlLike = Intl): Formatters {
  const cache = new Map<string, unknown>();
  const cached = <T>(kind: string, options: object | undefined, build: () => T): T => {
    const key = `${kind}|${keyOf(options)}`;
    let value = cache.get(key) as T | undefined;
    if (value === undefined) {
      value = build();
      cache.set(key, value);
    }
    return value;
  };
  const safe = <T>(build: () => T, fallback: () => T): T => {
    try {
      return build();
    } catch {
      return fallback();
    }
  };

  const formatNumber = (value: number, options?: Intl.NumberFormatOptions): string => {
    const NumberFormat = intl.NumberFormat;
    if (NumberFormat === undefined) return String(value);
    return safe(
      () => cached('number', options, () => new NumberFormat(locale, options)).format(value),
      () => String(value),
    );
  };

  return {
    locale,
    number: formatNumber,
    currency(value, currency, options) {
      return formatNumber(value, { ...options, style: 'currency', currency });
    },
    date(value, options) {
      const DateTimeFormat = intl.DateTimeFormat;
      const date = typeof value === 'number' ? new Date(value) : value;
      if (DateTimeFormat === undefined) return date.toISOString();
      return safe(
        () => cached('date', options, () => new DateTimeFormat(locale, options)).format(date),
        () => date.toISOString(),
      );
    },
    relativeTime(value, unit, options) {
      const RelativeTimeFormat = intl.RelativeTimeFormat;
      const fallback = (): string => {
        const amount = formatNumber(Math.abs(value));
        const label = Math.abs(value) === 1 ? unit.replace(/s$/, '') : unit.endsWith('s') ? unit : `${unit}s`;
        return value < 0 ? `${amount} ${label} ago` : `in ${amount} ${label}`;
      };
      if (RelativeTimeFormat === undefined) return fallback();
      return safe(() => cached('relative', options, () => new RelativeTimeFormat(locale, options)).format(value, unit), fallback);
    },
    list(items, options) {
      const ListFormat = intl.ListFormat;
      const fallback = (): string => {
        if (items.length <= 1) return items.join('');
        const joiner = options?.type === 'disjunction' ? ' or ' : options?.type === 'unit' ? ', ' : ' and ';
        return `${items.slice(0, -1).join(', ')}${joiner}${items[items.length - 1] ?? ''}`;
      };
      if (ListFormat === undefined) return fallback();
      return safe(() => cached('list', options, () => new ListFormat(locale, options)).format(items), fallback);
    },
    pluralCategory(value, type = 'cardinal') {
      const PluralRules = intl.PluralRules;
      const fallback = (): Intl.LDMLPluralRule => (value === 1 ? 'one' : 'other');
      if (PluralRules === undefined) return fallback();
      return safe(() => cached('plural', { type }, () => new PluralRules(locale, { type })).select(value), fallback);
    },
  };
}
