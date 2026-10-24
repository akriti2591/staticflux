/**
 * Typed search params (R7.9, R7.10). A route declares a schema of `searchParam.*` values;
 * reading the match gives typed values, building an href takes a typed partial input.
 *
 * Every param has a URL-state kind (R7.10):
 * - `route` (default) — part of the route identity; a change runs the full pipeline.
 * - `view`  — sub-route view state (`?tab=comments`); a change runs the light view pipeline
 *   (R7.7) and never reactivates the feature.
 * Keys that no route declares (intent / sticky params owned by `@staticflux/urlstate`) are
 * ignored by the router when classifying a navigation.
 *
 * Parsing is lenient: invalid values fall back to the param default and are reported.
 */
export type SearchParamKind = 'route' | 'view';

export interface SearchParam<T> {
  readonly kind: 'search-param';
  readonly urlKind: SearchParamKind;
  /** Decode a raw value. `undefined` input = absent. Returns `invalid` for unparsable input. */
  parse(raw: string | undefined): { readonly value: T } | 'invalid';
  /** Value used when the param is absent or invalid. */
  readonly fallback: T;
  /** Encode for the URL. `undefined` = omit the key. */
  serialize(value: T): string | undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SearchSchema = Readonly<Record<string, SearchParam<any>>>;

export type SearchParamType<P> = P extends SearchParam<infer T> ? T : never;

/** Typed values read from a location. */
export type SearchValues<S extends SearchSchema> = { readonly [K in keyof S]: SearchParamType<S[K]> };

/** Typed (partial) input for building an href. */
export type SearchInput<S extends SearchSchema> = { readonly [K in keyof S]?: SearchParamType<S[K]> };

interface ParamOptions<T> {
  readonly default?: T;
  readonly kind?: SearchParamKind;
}

type WithDefault<T, O> = O extends { readonly default: T } ? T : T | undefined;

function make<T>(
  options: ParamOptions<T> | undefined,
  decode: (raw: string) => T | 'invalid',
  encode: (value: T) => string,
): SearchParam<T | undefined> {
  const fallback = options?.default;
  return Object.freeze({
    kind: 'search-param' as const,
    urlKind: options?.kind ?? 'route',
    fallback,
    parse(raw: string | undefined) {
      if (raw === undefined) return { value: fallback };
      const decoded = decode(raw);
      return decoded === 'invalid' ? 'invalid' : { value: decoded };
    },
    serialize(value: T | undefined) {
      return value === undefined || value === fallback ? undefined : encode(value);
    },
  });
}

/** Search param builders. `default` makes the read type non-optional; `kind: 'view'` marks view state. */
export const searchParam = {
  string<const O extends ParamOptions<string> = ParamOptions<string>>(options?: O): SearchParam<WithDefault<string, O>> {
    return make<string>(options, (raw) => raw, (v) => v) as SearchParam<WithDefault<string, O>>;
  },
  number<const O extends ParamOptions<number> = ParamOptions<number>>(options?: O): SearchParam<WithDefault<number, O>> {
    return make<number>(
      options,
      (raw) => {
        const n = Number(raw);
        return raw.trim().length === 0 || !Number.isFinite(n) ? 'invalid' : n;
      },
      (v) => String(v),
    ) as SearchParam<WithDefault<number, O>>;
  },
  boolean<const O extends ParamOptions<boolean> = ParamOptions<boolean>>(options?: O): SearchParam<WithDefault<boolean, O>> {
    return make<boolean>(
      options,
      (raw) => (raw === '' || raw === '1' || raw === 'true' ? true : raw === '0' || raw === 'false' ? false : 'invalid'),
      (v) => (v ? '1' : '0'),
    ) as SearchParam<WithDefault<boolean, O>>;
  },
  enum<const V extends readonly string[], const O extends ParamOptions<V[number]> = ParamOptions<V[number]>>(
    values: V,
    options?: O,
  ): SearchParam<WithDefault<V[number], O>> {
    return make<V[number]>(
      options,
      (raw) => ((values as readonly string[]).includes(raw) ? (raw as V[number]) : 'invalid'),
      (v) => v,
    ) as SearchParam<WithDefault<V[number], O>>;
  },
  /** Custom codec (e.g. a schema library). `decode` returns `'invalid'` for bad input. */
  custom<T, const O extends ParamOptions<T> = ParamOptions<T>>(
    codec: { readonly decode: (raw: string) => T | 'invalid'; readonly encode: (value: T) => string },
    options?: O,
  ): SearchParam<WithDefault<T, O>> {
    return make<T>(options, codec.decode, codec.encode) as SearchParam<WithDefault<T, O>>;
  },
} as const;

export interface ParsedSearch {
  readonly values: Readonly<Record<string, unknown>>;
  readonly invalid: readonly string[];
}

/** Parse every declared key of `schema` from `params`. */
export function parseSearch(schema: SearchSchema, params: URLSearchParams): ParsedSearch {
  const values: Record<string, unknown> = {};
  const invalid: string[] = [];
  for (const [key, param] of Object.entries(schema)) {
    const raw = params.get(key) ?? undefined;
    const parsed = param.parse(raw);
    if (parsed === 'invalid') {
      invalid.push(key);
      values[key] = param.fallback;
    } else {
      values[key] = parsed.value;
    }
  }
  return { values, invalid };
}

/** Serialize typed input with `schema`; keys not in the schema are ignored. Returns `''` or `?a=b`. */
export function serializeSearch(schema: SearchSchema, input: Readonly<Record<string, unknown>> | undefined): string {
  if (input === undefined) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    const param = schema[key];
    if (param === undefined || value === undefined) continue;
    const encoded = param.serialize(value);
    if (encoded !== undefined) params.set(key, encoded);
  }
  const text = params.toString();
  return text.length === 0 ? '' : `?${text}`;
}
