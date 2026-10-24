/**
 * Declared URL parts (R7.10–R7.12). Every query key is declared once, with a
 * kind, an owner and a codec. Keys and value types come from the core
 * `Registry` (declaration merging), so a typo is a compile error and two
 * packages declaring the same key with different types fail to compile:
 *
 *   declare module '@staticflux/core' {
 *     interface Registry {
 *       urlParams: { tab: 'comments' | 'history'; workspace: string; panel: 'chat'; prompt: string };
 *     }
 *   }
 *   export const TabParam = defineUrlBinding({
 *     key: 'tab', kind: 'view', codec: codec.enum(['comments', 'history']), owner: 'studio/doc-store',
 *   });
 *
 * Same-type duplicates are not caught by TypeScript; `checkUrlDeclarations()`
 * (CI) and the runtime registry (boot) report every collision as SF-URL-002.
 */
import { err, ok, type Registry, type Result } from '@staticflux/core';
import type { UrlCodec } from './codec.js';
import { UrlKeyCollisionError } from './errors.js';

export type UrlKind = 'path' | 'view' | 'intent' | 'sticky' | 'dialog' | 'hidden';
export type HistoryMode = 'push' | 'replace';

type RegisteredUrlParams = Registry extends { readonly urlParams: infer P } ? P : Record<never, never>;
/** Query keys declared in `Registry['urlParams']`. */
export type UrlParamKey = keyof RegisteredUrlParams & string;
/** Value type of a registered query key. */
export type UrlParamValue<K extends string> = K extends keyof RegisteredUrlParams ? RegisteredUrlParams[K] : never;

/** Kinds that are query params bound to a store. */
export type BindingKind = 'view' | 'sticky' | 'hidden';

export interface UrlBinding<K extends string = string, T = unknown> {
  readonly kind: 'url-binding';
  readonly key: K;
  readonly urlKind: BindingKind;
  readonly codec: UrlCodec<T>;
  /** Owning store/unit id (devtools, collision messages). */
  readonly owner: string;
  readonly history: HistoryMode;
  /** Value represented by an absent param; never written to the URL. */
  readonly default: T | undefined;
  readonly description: string | undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyUrlBinding = UrlBinding<string, any>;

export interface DefineUrlBindingInput<K extends UrlParamKey> {
  readonly key: K;
  /**
   * - `view` — sub-route view state (`?tab=comments`); light transition only.
   * - `sticky` — carried across navigations (`?workspace=…`, `?lang=…`, `?sf-debug`).
   * - `hidden` — declared so tooling knows it must never appear in the URL (it lives in a store / handoff);
   *   the sync service strips it if present.
   */
  readonly kind: BindingKind;
  readonly codec: UrlCodec<UrlParamValue<K>>;
  readonly owner: string;
  /** Default: `push` for view (back returns to the previous tab), `replace` for sticky. */
  readonly history?: HistoryMode;
  readonly default?: UrlParamValue<K>;
  readonly description?: string;
}

export function defineUrlBinding<const K extends UrlParamKey>(input: DefineUrlBindingInput<K>): UrlBinding<K, UrlParamValue<K>> {
  return Object.freeze({
    kind: 'url-binding',
    key: input.key,
    urlKind: input.kind,
    codec: input.codec,
    owner: input.owner,
    history: input.history ?? (input.kind === 'view' ? 'push' : 'replace'),
    default: input.default,
    description: input.description,
  });
}

// ------------------------------------------------------------- intents

export type IntentPolicy = 'prefill-only' | 'safe';

export type IntentParams<Keys extends string, Req extends Keys> = { readonly [K in Req]: UrlParamValue<K> } & {
  readonly [K in Exclude<Keys, Req>]?: UrlParamValue<K>;
};

export interface IntentDef<Id extends string = string, P = Readonly<Record<string, unknown>>> {
  readonly kind: 'intent';
  readonly id: Id;
  readonly owner: string;
  readonly params: { readonly [K in keyof P & string]-?: UrlCodec<NonNullable<P[K]>> };
  /** The intent is present when all of these params are present and valid. */
  readonly required: readonly (keyof P & string)[];
  /** R7.14: prefill-only unless explicitly marked safe. */
  readonly policy: IntentPolicy;
  readonly description: string | undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyIntentDef = IntentDef<string, any>;
export type IntentParamsOf<I> = I extends IntentDef<string, infer P> ? P : never;

export interface DefineIntentInput<Id extends string, Keys extends UrlParamKey, Req extends Keys> {
  readonly id: Id;
  readonly owner: string;
  readonly params: { readonly [K in Keys]: UrlCodec<UrlParamValue<K>> };
  /** Default: every param. */
  readonly required?: readonly Req[];
  /** Only for side-effect-free intents (opening a panel). Never for prompts, purchases, deletes. */
  readonly safe?: boolean;
  readonly description?: string;
}

/**
 * Declare a consume-once intent:
 *
 *   export const ChatPromptIntent = defineIntent({
 *     id: 'agent-chat/prompt', owner: 'agent-chat',
 *     params: { panel: codec.enum(['chat']), prompt: codec.string({ maxLength: 2000 }) },
 *     required: ['panel'],
 *   });
 */
export function defineIntent<const Id extends `${string}/${string}`, const Keys extends UrlParamKey, const Req extends Keys = Keys>(
  input: DefineIntentInput<Id, Keys, Req>,
): IntentDef<Id, IntentParams<Keys, Req>> {
  const keys = Object.keys(input.params) as Keys[];
  return Object.freeze({
    kind: 'intent',
    id: input.id,
    owner: input.owner,
    params: input.params as unknown as IntentDef<Id, IntentParams<Keys, Req>>['params'],
    required: (input.required ?? keys) as unknown as IntentDef<Id, IntentParams<Keys, Req>>['required'],
    policy: input.safe === true ? 'safe' : 'prefill-only',
    description: input.description,
  });
}

// ------------------------------------------------------------- reserved keys (marketing params)

export interface ReservedParams {
  readonly kind: 'reserved-params';
  readonly owner: string;
  readonly keys: readonly string[];
}

export function reserveParams(owner: string, keys: readonly string[]): ReservedParams {
  return Object.freeze({ kind: 'reserved-params', owner, keys: Object.freeze([...keys]) });
}

// ------------------------------------------------------------- collision detection

export type UrlDeclaration = AnyUrlBinding | AnyIntentDef | ReservedParams;

export interface UrlKeyUse {
  readonly key: string;
  readonly declaration: UrlDeclaration;
  readonly urlKind: UrlKind;
  readonly owner: string;
}

export function keysOf(declaration: UrlDeclaration): readonly UrlKeyUse[] {
  switch (declaration.kind) {
    case 'url-binding':
      return [{ key: declaration.key, declaration, urlKind: declaration.urlKind, owner: declaration.owner }];
    case 'intent':
      return Object.keys(declaration.params).map((key) => ({ key, declaration, urlKind: 'intent' as const, owner: declaration.owner }));
    case 'reserved-params':
      return declaration.keys.map((key) => ({ key, declaration, urlKind: 'hidden' as const, owner: declaration.owner }));
  }
}

function collides(a: UrlKeyUse, b: UrlKeyUse): boolean {
  if (a.declaration === b.declaration) return false;
  // Several intents of one owner may share a param (`panel=chat` / `panel=chat&prompt=…`).
  if (a.urlKind === 'intent' && b.urlKind === 'intent' && a.owner === b.owner) return false;
  return true;
}

export interface UrlCollision {
  readonly key: string;
  readonly owners: readonly string[];
  readonly kinds: readonly UrlKind[];
  readonly message: string;
}

/** Static check for CI (`sf url check`): every key used by two unrelated declarations. */
export function checkUrlDeclarations(declarations: readonly UrlDeclaration[]): readonly UrlCollision[] {
  const byKey = new Map<string, UrlKeyUse[]>();
  for (const declaration of declarations) {
    for (const use of keysOf(declaration)) byKey.set(use.key, [...(byKey.get(use.key) ?? []), use]);
  }
  const out: UrlCollision[] = [];
  for (const [key, uses] of byKey) {
    const clashing = uses.filter((u) => uses.some((v) => collides(u, v)));
    if (clashing.length === 0) continue;
    const owners = [...new Set(clashing.map((u) => u.owner))];
    out.push({ key, owners, kinds: [...new Set(clashing.map((u) => u.urlKind))], message: `URL key "${key}" is declared by ${owners.join(', ')}.` });
  }
  return out;
}

export interface UrlDeclarationRegistry {
  register(declaration: UrlDeclaration): Result<void>;
  /** Declaration owning `key`, if any. */
  lookup(key: string): readonly UrlKeyUse[];
  readonly declarations: readonly UrlDeclaration[];
}

/** Runtime registry: rejects collisions with SF-URL-002 (boot-time safety net for R7.12). */
export function createUrlDeclarationRegistry(initial: readonly UrlDeclaration[] = []): UrlDeclarationRegistry & { readonly initialErrors: readonly Result<void>[] } {
  const uses = new Map<string, UrlKeyUse[]>();
  const declarations: UrlDeclaration[] = [];
  const registry: UrlDeclarationRegistry = {
    register(declaration) {
      if (declarations.includes(declaration)) return ok();
      const incoming = keysOf(declaration);
      for (const use of incoming) {
        const clash = (uses.get(use.key) ?? []).find((existing) => collides(existing, use));
        if (clash !== undefined) {
          return err(
            UrlKeyCollisionError({
              message: `URL key "${use.key}" (${use.urlKind}, ${use.owner}) collides with the ${clash.urlKind} declared by ${clash.owner}.`,
              details: { key: use.key, owners: [clash.owner, use.owner] },
            }),
          );
        }
      }
      for (const use of incoming) uses.set(use.key, [...(uses.get(use.key) ?? []), use]);
      declarations.push(declaration);
      return ok();
    },
    lookup: (key) => uses.get(key) ?? [],
    get declarations() {
      return declarations;
    },
  };
  const initialErrors = initial.map((d) => registry.register(d)).filter((r) => !r.ok);
  return Object.assign(registry, { initialErrors });
}
