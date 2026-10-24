/**
 * Typed message catalogs. A package declares its messages once, in its source
 * locale; call sites use the returned typed refs (never string keys):
 *
 *   export const m = defineMessages('studio', {
 *     saved: 'Saved',
 *     items: '{count, plural, =0 {No items} one {# item} other {# items}}',
 *     greeting: 'Hello {name}!',
 *   });
 *   i18n.t(m.items, { count: 3 });   // params inferred: { count: number }
 *   i18n.t(m.saved);                 // no params allowed
 *
 * Translations for other locales are separate, lazily loaded bundles whose
 * keys are checked against the catalog (`defineTranslations`).
 */
import { err, ok, type Result } from '@staticflux/core';
import { CatalogLoadError } from './errors.js';

// ------------------------------------------------------------- type-level ICU parameter inference

type Whitespace = ' ' | '\n' | '\t' | '\r';
type TrimLeft<S extends string> = S extends `${Whitespace}${infer R}` ? TrimLeft<R> : S;
type TrimRight<S extends string> = S extends `${infer R}${Whitespace}` ? TrimRight<R> : S;
type Trim<S extends string> = TrimLeft<TrimRight<S>>;

/** The next brace in `S`: `['{' | '}', textBefore, rest]`, or `['', S, '']` when there is none. */
type NextBrace<S extends string> = S extends `${infer A}{${infer B}`
  ? A extends `${infer A1}}${infer A2}`
    ? ['}', A1, `${A2}{${B}`]
    : ['{', A, B]
  : S extends `${infer A}}${infer B}`
    ? ['}', A, B]
    : ['', S, ''];

/** `"name, type, style"` → `[name, type]`. */
type HeaderParts<H extends string> = H extends `${infer N},${infer Rest}`
  ? [Trim<N>, Rest extends `${infer T},${string}` ? Trim<T> : Trim<Rest>]
  : [Trim<H>, ''];

/** Value type accepted for an argument of the given ICU type. */
export type ArgValue<T extends string> = T extends ''
  ? string | number
  : T extends 'number' | 'plural' | 'selectordinal'
    ? number
    : T extends 'date' | 'time'
      ? Date | number
      : T extends 'select'
        ? string
        : T extends 'list'
          ? readonly string[]
          : unknown;

type Frame = 'msg' | 'arg';

/**
 * A brace-level scanner: `msg` frames are message text (a `{` opens an argument),
 * `arg` frames are between the branches of a plural/select (a `{` opens a branch body).
 */
type Scan<S extends string, Stack extends readonly Frame[], Acc> =
  NextBrace<S> extends [infer Kind, string, infer After extends string]
    ? Kind extends '{'
      ? Stack extends readonly ['arg', ...Frame[]]
        ? Scan<After, ['msg', ...Stack], Acc>
        : OpenArg<After, Stack, Acc>
      : Kind extends '}'
        ? Stack extends readonly [Frame, ...infer Rest extends readonly Frame[]]
          ? Scan<After, Rest, Acc>
          : Acc
        : Acc
    : Acc;

type OpenArg<S extends string, Stack extends readonly Frame[], Acc> =
  NextBrace<S> extends [infer Kind, infer Header extends string, infer After extends string]
    ? HeaderParts<Header> extends [infer N extends string, infer T extends string]
      ? Kind extends '}'
        ? Scan<After, Stack, Acc & { readonly [P in N]: ArgValue<T> }>
        : Kind extends '{'
          ? Scan<After, ['msg', 'arg', ...Stack], Acc & { readonly [P in N]: ArgValue<T> }>
          : Acc
      : Acc
    : Acc;

type Flatten<T> = { readonly [K in keyof T]: T[K] };

/**
 * Params inferred from an ICU message literal. Non-literal strings fall back to
 * an open record. Quoted braces (`'{'`) are not understood at the type level.
 */
export type ParamsOf<S extends string> = string extends S
  ? Readonly<Record<string, unknown>>
  : Flatten<Scan<S, [], unknown>>;

// ------------------------------------------------------------- runtime shapes

export type MessageParams = Readonly<Record<string, unknown>>;

declare const paramsType: unique symbol;

/** A typed reference to one message. Pass it to `i18n.t(ref, params)`. */
export interface MessageRef<P = MessageParams, NS extends string = string, K extends string = string> {
  readonly kind: 'message';
  readonly namespace: NS;
  readonly key: K;
  /** `namespace/key` — stable id used by tooling and telemetry. */
  readonly id: `${NS}/${K}`;
  /** Source-locale text. */
  readonly source: string;
  /** Locale the source text is written in. */
  readonly sourceLocale: string;
  /** Phantom carrier for the param type; never present at runtime. */
  readonly [paramsType]?: P;
}

/** Any message ref (for collections). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyMessageRef = MessageRef<any>;

/** Arguments of `t()` for a ref with params `P`: none when the message has no placeholders. */
export type MessageArgs<P> = [keyof P] extends [never] ? [params?: Readonly<Record<string, never>>] : [params: P];

/** Symbol under which a `Messages` object carries its catalog descriptor. */
export const CATALOG: unique symbol = Symbol('staticflux.i18n.catalog');

export interface CatalogDescriptor<NS extends string = string> {
  readonly namespace: NS;
  readonly sourceLocale: string;
  /** Source-locale messages by key. */
  readonly messages: Readonly<Record<string, string>>;
  readonly keys: readonly string[];
}

export type Messages<NS extends string, M extends Readonly<Record<string, string>>> = {
  readonly [K in keyof M & string]: MessageRef<ParamsOf<M[K]>, NS, K>;
} & { readonly [CATALOG]: CatalogDescriptor<NS> };

/** Any messages object (for collections). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyMessages = { readonly [CATALOG]: CatalogDescriptor } & Readonly<Record<string, any>>;

export interface DefineMessagesOptions {
  /** Locale the source texts are written in. Default `en`. */
  readonly sourceLocale?: string;
}

const NAMESPACE = /^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*$/;

/**
 * Declare a package's messages. `namespace` is the package/feature name
 * (`studio`, `agent-chat`); it scopes keys so packages never collide.
 */
export function defineMessages<const NS extends string, const M extends Readonly<Record<string, string>>>(
  namespace: NS,
  messages: M,
  options: DefineMessagesOptions = {},
): Messages<NS, M> {
  if (!NAMESPACE.test(namespace)) {
    throw new TypeError(`defineMessages: invalid namespace "${namespace}" (use lowercase kebab-case, e.g. "agent-chat").`);
  }
  const descriptor: CatalogDescriptor<NS> = Object.freeze({
    namespace,
    sourceLocale: options.sourceLocale ?? 'en',
    messages: Object.freeze({ ...messages }),
    keys: Object.freeze(Object.keys(messages)),
  });
  const refs: Record<string, MessageRef> = {};
  for (const [key, source] of Object.entries(messages)) {
    refs[key] = Object.freeze({
      kind: 'message',
      namespace,
      key,
      id: `${namespace}/${key}`,
      source,
      sourceLocale: descriptor.sourceLocale,
    }) as MessageRef;
  }
  Object.defineProperty(refs, CATALOG, { value: descriptor, enumerable: false });
  return Object.freeze(refs) as unknown as Messages<NS, M>;
}

/** The descriptor of a `Messages` object. */
export function catalogOf(messages: AnyMessages): CatalogDescriptor {
  return messages[CATALOG];
}

// ------------------------------------------------------------- translations

/** Translated texts of one catalog for one locale. */
export interface TranslationBundle<NS extends string = string> {
  readonly kind: 'translations';
  readonly namespace: NS;
  readonly locale: string;
  readonly messages: Readonly<Record<string, string>>;
}

type KeysOfMessages<X> = X extends Messages<string, infer M> ? keyof M & string : never;
type NamespaceOf<X> = X extends Messages<infer NS, Readonly<Record<string, string>>> ? NS : string;

/**
 * Declare translations for a catalog. Keys are checked against the catalog
 * (unknown keys are a compile error); missing keys fall back to the source and
 * are reported by `checkCatalogs()`.
 */
export function defineTranslations<X extends AnyMessages>(
  messages: X,
  locale: string,
  texts: { readonly [K in KeysOfMessages<X>]?: string },
): TranslationBundle<NamespaceOf<X>> {
  return Object.freeze({
    kind: 'translations',
    namespace: messages[CATALOG].namespace as NamespaceOf<X>,
    locale,
    messages: Object.freeze({ ...(texts as Readonly<Record<string, string>>) }),
  });
}

// ------------------------------------------------------------- loaders

/**
 * Loads one catalog's translations for a locale (usually a dynamic `import()`
 * so each locale is its own lazy chunk). `ok(undefined)` = no translation for
 * that locale (the fallback chain continues).
 */
export interface CatalogLoader {
  readonly namespace: string;
  readonly locales: readonly string[];
  load(locale: string, signal: AbortSignal): Promise<Result<TranslationBundle | undefined>>;
}

export type BundleSource = TranslationBundle | { readonly default: TranslationBundle };

/**
 * Build a loader from per-locale import functions:
 *
 *   catalogLoader(m, { fr: () => import('./i18n/fr.js'), de: () => import('./i18n/de.js') })
 */
export function catalogLoader(
  messages: AnyMessages,
  imports: Readonly<Record<string, (signal: AbortSignal) => Promise<BundleSource>>>,
): CatalogLoader {
  const namespace = messages[CATALOG].namespace;
  const byLocale = new Map(Object.entries(imports).map(([locale, load]) => [locale.toLowerCase(), load]));
  return {
    namespace,
    locales: Object.keys(imports),
    async load(locale, signal) {
      const load = byLocale.get(locale.toLowerCase());
      if (load === undefined) return ok(undefined);
      try {
        const loaded = await load(signal);
        return ok('default' in loaded ? loaded.default : loaded);
      } catch (error) {
        return err(CatalogLoadError({ cause: error, details: { namespace, locale } }));
      }
    },
  };
}
