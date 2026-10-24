/**
 * Component specs: decorator-free declaration of a component's tag, its three
 * kinds of dependencies (R2.9, LIFECYCLES §5) and its placeholder.
 *
 * ```ts
 * export const toolbarSpec = component({
 *   tag: 'studio-doc-toolbar',
 *   deps: {
 *     render:     { doc: DocumentStoreToken },                                 // placeholder until ready
 *     lazy:       { presence: { token: PresenceStoreToken, init: 'on-visible' } },
 *     functional: { exportPdf: { token: ExportPdfToken, init: 'on-intent' } },  // pre-warm on hover/focus
 *   },
 *   placeholder: () => html`<sf-skeleton lines="1"></sf-skeleton>`,
 *   size: { block: '48px' },
 * });
 * export class DocToolbar extends SfElement<typeof toolbarSpec> {
 *   static override readonly spec = toolbarSpec;
 *   override render() { const { doc, presence, exportPdf } = this.deps; … }
 * }
 * defineComponent(DocToolbar);
 * ```
 */
import {
  type DepSpec,
  type DepHandle,
  type FunctionalDep,
  type InitTiming,
  type SfError,
  type SpecValue,
  specTiming,
  specToken,
  type AnyToken,
} from '@staticflux/core';
import type { Scope } from '@staticflux/core';

export interface ComponentDepsDeclaration {
  /** Block rendering: the placeholder shows until all are ready (default init `eager`). */
  readonly render?: Readonly<Record<string, DepSpec>>;
  /** Non-blocking, reactive `DepHandle` (default init `on-arrival`). */
  readonly lazy?: Readonly<Record<string, DepSpec>>;
  /** Behaviour resolved on first use (default init `on-demand`). */
  readonly functional?: Readonly<Record<string, DepSpec>>;
}

type Group<D extends ComponentDepsDeclaration, G extends keyof ComponentDepsDeclaration> =
  D[G] extends Readonly<Record<string, DepSpec>> ? D[G] : Record<never, never>;

export type RenderKeys<D extends ComponentDepsDeclaration> = Extract<keyof Group<D, 'render'>, string>;
export type LazyKeys<D extends ComponentDepsDeclaration> = Extract<keyof Group<D, 'lazy'>, string>;
export type FunctionalKeys<D extends ComponentDepsDeclaration> = Extract<keyof Group<D, 'functional'>, string>;
export type DepKey<D extends ComponentDepsDeclaration> = RenderKeys<D> | LazyKeys<D> | FunctionalKeys<D>;

/** Value type behind a dependency key (instance type, not the handle). */
export type DepValue<D extends ComponentDepsDeclaration, K extends DepKey<D>> = K extends RenderKeys<D>
  ? SpecValue<Group<D, 'render'>[K]>
  : K extends LazyKeys<D>
    ? SpecValue<Group<D, 'lazy'>[K]>
    : K extends FunctionalKeys<D>
      ? SpecValue<Group<D, 'functional'>[K]>
      : never;

/** What `this.deps` holds: render values, lazy handles, functional handles. */
export type ComponentDeps<D extends ComponentDepsDeclaration> = {
  readonly [K in RenderKeys<D>]: SpecValue<Group<D, 'render'>[K]>;
} & {
  readonly [K in LazyKeys<D>]: DepHandle<SpecValue<Group<D, 'lazy'>[K]>>;
} & {
  readonly [K in FunctionalKeys<D>]: FunctionalDep<SpecValue<Group<D, 'functional'>[K]>>;
};

type KeysOfGroup<T> = T extends Readonly<Record<string, unknown>> ? keyof T : never;
export type DuplicateComponentDepKeys<D extends ComponentDepsDeclaration> =
  | (KeysOfGroup<D['render']> & KeysOfGroup<D['lazy']>)
  | (KeysOfGroup<D['render']> & KeysOfGroup<D['functional']>)
  | (KeysOfGroup<D['lazy']> & KeysOfGroup<D['functional']>);

export type CustomElementTag = `${string}-${string}`;

export interface ComponentSpecInit<D extends ComponentDepsDeclaration> {
  readonly tag: CustomElementTag;
  readonly deps?: D;
  /** Shown (with `aria-busy="true"`) until render deps and blocking hooks are ready. Default: `<sf-skeleton>`. */
  readonly placeholder?: () => unknown;
  /** Shown when a render dep or blocking hook failed. Default: an empty, `role="alert"`-free region (the boundary decides). */
  readonly failed?: (error: SfError) => unknown;
  /** Space reserved while the placeholder shows (CSS lengths) — no layout shift (R12.19). */
  readonly size?: { readonly inline?: string; readonly block?: string };
  readonly description?: string;
}

export type DepKind = 'render' | 'lazy' | 'functional';

export interface ComponentDepEdge {
  readonly key: string;
  readonly kind: DepKind;
  readonly token: AnyToken;
  readonly init: InitTiming;
}

export interface ComponentSpec<D extends ComponentDepsDeclaration = ComponentDepsDeclaration>
  extends ComponentSpecInit<D> {
  readonly kind: 'component';
  /** Normalized dependency edges (for the deps controller, devtools and the graph tool). */
  readonly edges: readonly ComponentDepEdge[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyComponentSpec = ComponentSpec<any>;
export type DepsOf<S> = S extends ComponentSpec<infer D> ? D : never;

const DEFAULT_TIMING: Record<DepKind, InitTiming> = { render: 'eager', lazy: 'on-arrival', functional: 'on-demand' };

/** Declare a component spec (data). Compile error if a key appears in more than one dependency kind. */
export function component<const D extends ComponentDepsDeclaration = Record<never, never>>(
  init: ComponentSpecInit<D> &
    ([DuplicateComponentDepKeys<D>] extends [never] ? unknown : { __duplicateDepKeys: DuplicateComponentDepKeys<D> }),
): ComponentSpec<D> {
  const edges: ComponentDepEdge[] = [];
  const deps = (init.deps ?? {}) as ComponentDepsDeclaration;
  for (const kind of ['render', 'lazy', 'functional'] as const) {
    for (const [key, spec] of Object.entries(deps[kind] ?? {})) {
      edges.push({ key, kind, token: specToken(spec), init: specTiming(spec, DEFAULT_TIMING[kind]) });
    }
  }
  return Object.freeze({ ...init, kind: 'component', edges: Object.freeze(edges) }) as ComponentSpec<D>;
}

/** Hook cleanup: a function returned from a hook runs when the hook's scope is disposed. */
export type HookResult = void | (() => void) | Promise<void>;

export interface ComponentHookOptions {
  /** Keep the placeholder until this hook settles (failure → failed state). */
  readonly blocking?: boolean;
}

/**
 * Dependency hooks (LIFECYCLES §5.2), bound to the element's connection: their scopes
 * are disposed on disconnect, or when the dependency refreshes (the hook re-runs).
 */
export interface ComponentHooks<D extends ComponentDepsDeclaration> {
  /** Once per connection, when the dependency's value first becomes available. */
  onInjected<K extends DepKey<D>>(key: K, fn: (value: DepValue<D, K>, scope: Scope) => HookResult): void;
  /** When ready, and again (fresh scope) after every refresh. */
  onReady<K extends DepKey<D>>(
    key: K,
    fn: (value: DepValue<D, K>, scope: Scope) => HookResult,
    options?: ComponentHookOptions,
  ): void;
  /** After each refresh of the dependency. */
  onRefresh<K extends DepKey<D>>(key: K, fn: (value: DepValue<D, K>, scope: Scope) => HookResult): void;
  onFailed<K extends DepKey<D>>(key: K, fn: (error: SfError) => void): void;
  /** While connected and not frozen (hidden): re-runs on every un-hide with a fresh scope (R5.2). */
  whileVisible(fn: (scope: Scope) => HookResult): void;
}
