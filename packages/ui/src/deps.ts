/**
 * The component dependency controller: self-injection (R2.8), the three
 * dependency kinds (R2.9), per-dependency init timing (LIFECYCLES §5.1) and
 * scope-bound dependency hooks (§5.2).
 *
 * Connection lifecycle (machine `ui/component`):
 *   detached → resolving → ready ⇄ (render deps refreshing keep the last value)
 *   resolving|ready → failed → resolving (retry)          any → detached (disconnect)
 *
 * - The injector comes from the nearest `UiScopeHandle` up the DOM (context protocol).
 * - Every connection gets a scope (child of the injector's scope, so disposing a
 *   feature injector also tears down its components' hooks).
 * - `on-visible` triggers through the injected `VisibilityObserver`; `on-intent`
 *   pre-warms when the pointer enters / focus lands on an element marked with
 *   `data-sf-intent="<key>"` (use `host.intent('key')`) inside the component.
 * - Readiness is reactive (handle states are observable), so the host re-renders
 *   from placeholder to content without manual wiring.
 */
import { ContextConsumer } from '@lit/context';
import {
  box,
  type Box,
  createMachine,
  type DepHandle,
  defineMachine,
  type FunctionalDep,
  type HandleState,
  type Machine,
  type Scope,
  type SfError,
  type Span,
  toSfError,
  watch,
} from '@staticflux/core';
import type { ReactiveController, ReactiveControllerHost } from 'lit';
import type {
  AnyComponentSpec,
  ComponentDepEdge,
  ComponentDeps,
  ComponentDepsDeclaration,
  ComponentHookOptions,
  ComponentHooks,
  HookResult,
} from './component.js';
import { HookFailedError, NoInjectorError, RenderDepFailedError, RenderDepNotReadyError, UnknownDepKeyError } from './errors.js';
import { SfErrorEvent } from './events.js';
import type { UiEnvironment } from './ports.js';
import { type UiScopeHandle, uiScopeContext } from './scope.js';
import { UI_SUBSYSTEMS } from './telemetry.js';

export const componentMachine = defineMachine({
  id: 'ui/component',
  initial: 'detached',
  states: ['detached', 'resolving', 'ready', 'failed'],
  transitions: {
    detached: { bind: 'resolving' },
    resolving: { ready: 'ready', fail: 'failed', unbind: 'detached' },
    ready: { fail: 'failed', unbind: 'detached' },
    failed: { retry: 'resolving', ready: 'ready', unbind: 'detached' },
  },
});

export type ComponentState = (typeof componentMachine.states)[number];
type ComponentEvent = 'bind' | 'ready' | 'fail' | 'unbind' | 'retry';

/** Attribute marking an intent trigger inside a component (value: space-separated dep keys). */
export const INTENT_ATTR = 'data-sf-intent';

const INTENT_EVENTS = ['pointerover', 'focusin', 'pointerdown'] as const;

interface Binding {
  readonly scopeHandle: UiScopeHandle;
  readonly scope: Scope;
  readonly span: Span;
  readonly handles: Map<string, DepHandle<unknown>>;
  readonly functionals: Map<string, FunctionalDep<unknown>>;
  readonly blockingPending: Box<number>;
  readonly blockingError: Box<SfError | undefined>;
}

type Host = ReactiveControllerHost & HTMLElement;

export interface ComponentDepsHooks<D extends ComponentDepsDeclaration> {
  /** Called on every bind so the host can register its dependency hooks. */
  readonly wire?: (hooks: ComponentHooks<D>) => void;
  /** Frozen (hidden) state changed. */
  readonly frozenChanged?: (frozen: boolean) => void;
}

const IDLE_HANDLE: DepHandle<undefined> = Object.freeze({
  tokenId: 'ui/unbound',
  state: 'idle',
  value: undefined,
  error: undefined,
  trigger: () => undefined,
  whenReady: () => Promise.resolve({ ok: false as const, error: NoInjectorError() }),
  subscribe: () => () => undefined,
}) as DepHandle<undefined>;

export class ComponentDepsController<D extends ComponentDepsDeclaration> implements ReactiveController {
  readonly machine: Machine<ComponentState, ComponentEvent>;
  /** The typed deps object (`this.deps` on SfElement). Stable identity; getters read the current binding. */
  readonly deps: ComponentDeps<D>;
  private readonly consumer: ContextConsumer<typeof uiScopeContext, Host>;
  private binding: Binding | undefined;
  private readonly errorBox = box<SfError | undefined>(undefined);
  private readonly visibleScopes: ((scope: Scope) => HookResult)[] = [];
  private connected = false;
  private readonly tag: string;

  constructor(
    private readonly host: Host,
    private readonly spec: AnyComponentSpec,
    private readonly callbacks: ComponentDepsHooks<D> = {},
  ) {
    this.tag = spec.tag;
    this.machine = createMachine(componentMachine);
    this.deps = this.createDepsObject();
    this.consumer = new ContextConsumer(host, {
      context: uiScopeContext,
      subscribe: true,
      callback: (value) => this.onScope(value),
    });
    host.addController(this);
  }

  /** Reactive lifecycle state. */
  get state(): ComponentState {
    return this.machine.state;
  }

  /** Reactive: the failure when `failed`. */
  get error(): SfError | undefined {
    return this.errorBox.get();
  }

  get scopeHandle(): UiScopeHandle | undefined {
    return this.binding?.scopeHandle;
  }

  get environment(): UiEnvironment | undefined {
    return this.binding?.scopeHandle.environment;
  }

  /** Reactive: the nearest scope is frozen (hidden). */
  get frozen(): boolean {
    return this.binding?.scopeHandle.frozen ?? false;
  }

  /** The connection scope (disposed on disconnect). */
  get scope(): Scope | undefined {
    return this.binding?.scope;
  }

  hostConnected(): void {
    this.connected = true;
    if (this.binding === undefined) {
      const value = this.consumer.value;
      if (value !== undefined) this.bind(value);
      else
        queueMicrotask(() => {
          if (this.connected && this.binding === undefined) {
            this.host.dispatchEvent(new SfErrorEvent(NoInjectorError({ details: { element: this.tag } }), 'deps'));
          }
        });
    }
  }

  hostDisconnected(): void {
    this.connected = false;
    queueMicrotask(() => {
      if (!this.connected) this.unbind();
    });
  }

  /** Re-resolve after a failure (new handles, new hooks). */
  retry(): void {
    const handle = this.binding?.scopeHandle;
    if (handle === undefined) return;
    this.unbind();
    this.bind(handle);
  }

  /** Pre-warm dependencies by key (what intent triggers call). */
  prewarm(...keys: readonly string[]): void {
    for (const key of keys) {
      const handle = this.binding?.handles.get(key);
      if (handle === undefined) {
        if (!this.spec.edges.some((e: ComponentDepEdge) => e.key === key)) {
          this.report(UnknownDepKeyError({ details: { component: this.tag, key } }), 'deps');
        }
        continue;
      }
      handle.trigger();
    }
  }

  // ------------------------------------------------------------ binding

  private onScope(value: UiScopeHandle | undefined): void {
    if (value === this.binding?.scopeHandle) return;
    if (this.binding !== undefined) this.unbind();
    if (value !== undefined && this.connected) this.bind(value);
  }

  private bind(scopeHandle: UiScopeHandle): void {
    const injector = scopeHandle.injector;
    const scope = injector.scope.child(`component:${this.tag}`);
    const span = injector.telemetry.span('ui.component.resolve', {
      subsystem: UI_SUBSYSTEMS.component,
      level: 'verbose',
      attrs: { component: this.tag, scope: scopeHandle.name },
    });
    const binding: Binding = {
      scopeHandle,
      scope,
      span,
      handles: new Map(),
      functionals: new Map(),
      blockingPending: box(0),
      blockingError: box<SfError | undefined>(undefined),
    };
    this.binding = binding;
    this.errorBox.set(undefined);
    this.transition('bind');

    const visibleKeys: DepHandle<unknown>[] = [];
    for (const edge of this.spec.edges) {
      // Core schedules eager/on-arrival/idle; on-visible/on-intent/on-demand are ours to trigger.
      const handle = injector.handle(edge.token, edge.init);
      binding.handles.set(edge.key, handle);
      if (edge.kind === 'functional') {
        binding.functionals.set(edge.key, {
          get tokenId() {
            return handle.tokenId;
          },
          get state() {
            return handle.state;
          },
          get: (signal?: AbortSignal) => handle.whenReady(signal ?? scope.signal),
          prewarm: () => handle.trigger(),
        });
      }
      if (edge.init === 'on-visible') visibleKeys.push(handle);
      scope.defer(() => (handle as { dispose?: () => void }).dispose?.());
    }

    if (visibleKeys.length > 0) {
      const stop = scopeHandle.environment.visibility.observe(this.host, (visible) => {
        if (!visible) return;
        for (const handle of visibleKeys) handle.trigger();
        stop();
      });
      scope.defer(stop);
    }
    if (this.spec.edges.length > 0) {
      for (const type of INTENT_EVENTS) scope.listen(this.host, type, (event) => this.onIntent(event));
    }

    this.visibleScopes.length = 0;
    this.callbacks.wire?.(this.createHooks(binding));
    this.watchFrozen(binding);
    this.watchReadiness(binding);
  }

  private unbind(): void {
    const binding = this.binding;
    if (binding === undefined) return;
    this.binding = undefined;
    if (this.machine.is('resolving')) binding.span.end('cancelled');
    this.transition('unbind');
    void binding.scope.dispose();
  }

  private transition(event: ComponentEvent): void {
    if (this.machine.can(event)) this.machine.send(event);
  }

  private watchReadiness(binding: Binding): void {
    const renderKeys = this.spec.edges.filter((e) => e.kind === 'render').map((e) => e.key);
    const summary = (): 'resolving' | 'ready' | 'failed' => {
      if (binding.blockingError.get() !== undefined) return 'failed';
      let ready = true;
      for (const key of renderKeys) {
        const state: HandleState = binding.handles.get(key)?.state ?? 'idle';
        if (state === 'failed') return 'failed';
        if (state !== 'ready' && state !== 'refreshing') ready = false;
      }
      if (binding.blockingPending.get() > 0) return 'resolving';
      return ready ? 'ready' : 'resolving';
    };
    watch(summary, (next) => this.applyReadiness(binding, next), { scope: binding.scope, fireImmediately: true });
  }

  private applyReadiness(binding: Binding, next: 'resolving' | 'ready' | 'failed'): void {
    if (this.binding !== binding) return;
    if (next === 'ready') {
      if (this.machine.is('resolving')) binding.span.end('ok');
      this.errorBox.set(undefined);
      this.transition('ready');
    } else if (next === 'failed') {
      const cause = binding.blockingError.get() ?? this.firstRenderFailure(binding);
      const error = RenderDepFailedError({
        units: [this.tag],
        scope: binding.scopeHandle.name,
        ...(cause === undefined ? {} : { cause, message: `${this.tag}: ${cause.message}` }),
        details: { component: this.tag, ...(cause === undefined ? {} : { dependencyCode: cause.code }) },
      });
      if (this.machine.is('resolving')) binding.span.end('error', error);
      this.errorBox.set(error);
      this.transition('fail');
      this.report(error, 'deps');
    }
  }

  private firstRenderFailure(binding: Binding): SfError | undefined {
    for (const edge of this.spec.edges) {
      if (edge.kind !== 'render') continue;
      const handle = binding.handles.get(edge.key);
      if (handle?.state === 'failed') return handle.error;
    }
    return undefined;
  }

  private watchFrozen(binding: Binding): void {
    let visibleScope: Scope | undefined;
    const startVisible = (): void => {
      if (this.visibleScopes.length === 0) return;
      visibleScope = binding.scope.child('visible');
      for (const fn of this.visibleScopes) this.runHookFn(binding, 'visible', () => fn(visibleScope as Scope), visibleScope);
    };
    const stopVisible = (): void => {
      const s = visibleScope;
      visibleScope = undefined;
      void s?.dispose();
    };
    watch(
      () => binding.scopeHandle.frozen,
      (frozen) => {
        if (this.binding !== binding) return;
        if (frozen) stopVisible();
        else startVisible();
        this.callbacks.frozenChanged?.(frozen);
      },
      { scope: binding.scope },
    );
    if (binding.scopeHandle.frozen) this.callbacks.frozenChanged?.(true);
    else startVisible();
  }

  // ------------------------------------------------------------ hooks

  private createHooks(binding: Binding): ComponentHooks<D> {
    const handleFor = (key: string): DepHandle<unknown> | undefined => {
      const handle = binding.handles.get(key);
      if (handle === undefined) this.report(UnknownDepKeyError({ details: { component: this.tag, key } }), 'hook');
      return handle;
    };
    const makeRunner = (key: string, fn: (value: unknown, scope: Scope) => HookResult) => {
      let hookScope: Scope | undefined;
      return (value: unknown): Promise<SfError | undefined> => {
        void hookScope?.dispose();
        hookScope = binding.scope.child(`hook:${key}`);
        const s = hookScope;
        return this.runHookFn(binding, key, () => fn(value, s), s);
      };
    };
    const hooks = {
      onInjected: (key: string, fn: (value: unknown, scope: Scope) => HookResult) => {
        const handle = handleFor(key);
        if (handle === undefined) return;
        const run = makeRunner(key, fn);
        let done = false;
        const check = (): void => {
          if (done || handle.value === undefined || (handle.state !== 'ready' && handle.state !== 'refreshing')) return;
          done = true;
          void run(handle.value);
        };
        binding.scope.defer(handle.subscribe(check));
        check();
      },
      onReady: (key: string, fn: (value: unknown, scope: Scope) => HookResult, options: ComponentHookOptions = {}) => {
        const handle = handleFor(key);
        if (handle === undefined) return;
        const run = makeRunner(key, fn);
        let ran = false;
        let previous: HandleState = handle.state;
        let settleBlocking: ((error: SfError | undefined) => void) | undefined;
        if (options.blocking === true) {
          binding.blockingPending.set(binding.blockingPending.get() + 1);
          settleBlocking = (error) => {
            settleBlocking = undefined;
            if (this.binding !== binding) return;
            if (error !== undefined) binding.blockingError.set(error);
            binding.blockingPending.set(binding.blockingPending.get() - 1);
          };
        }
        const onState = (state: HandleState): void => {
          const fresh = state === 'ready' && (!ran || previous === 'refreshing');
          previous = state;
          if (fresh) {
            ran = true;
            const pending = run(handle.value);
            const settle = settleBlocking;
            if (settle !== undefined) void pending.then(settle);
          } else if (state === 'failed' && !ran) {
            settleBlocking?.(handle.error);
          }
        };
        binding.scope.defer(handle.subscribe(onState));
        if (handle.state === 'ready') onState('ready');
      },
      onRefresh: (key: string, fn: (value: unknown, scope: Scope) => HookResult) => {
        const handle = handleFor(key);
        if (handle === undefined) return;
        const run = makeRunner(key, fn);
        let previous: HandleState = handle.state;
        binding.scope.defer(
          handle.subscribe((state) => {
            if (previous === 'refreshing' && state === 'ready') void run(handle.value);
            previous = state;
          }),
        );
      },
      onFailed: (key: string, fn: (error: SfError) => void) => {
        const handle = handleFor(key);
        if (handle === undefined) return;
        const check = (state: HandleState): void => {
          if (state === 'failed' && handle.error !== undefined) fn(handle.error);
        };
        binding.scope.defer(handle.subscribe(check));
        if (handle.state === 'failed') check('failed');
      },
      whileVisible: (fn: (scope: Scope) => HookResult) => {
        this.visibleScopes.push(fn);
      },
    };
    return hooks as unknown as ComponentHooks<D>;
  }

  /** Run one hook body in a span; returned cleanups go into `scope`. Resolves with the failure, if any. */
  private runHookFn(binding: Binding, key: string, body: () => HookResult, scope: Scope): Promise<SfError | undefined> {
    const telemetry = binding.scopeHandle.injector.telemetry;
    const span = telemetry.span('ui.hook', {
      subsystem: UI_SUBSYSTEMS.component,
      level: 'verbose',
      parent: binding.span,
      attrs: { component: this.tag, dependency: key },
    });
    const fail = (error: unknown): SfError => {
      const sf = HookFailedError({ cause: toSfError(error), units: [this.tag], details: { component: this.tag, dependency: key } });
      span.end('error', sf);
      this.report(sf, 'hook');
      return sf;
    };
    try {
      const result = body();
      if (typeof result === 'function') {
        scope.defer(result);
        span.end('ok');
        return Promise.resolve(undefined);
      }
      if (result instanceof Promise) {
        return result.then(
          () => {
            span.end('ok');
            return undefined;
          },
          (error: unknown) => fail(error),
        );
      }
      span.end('ok');
      return Promise.resolve(undefined);
    } catch (error) {
      return Promise.resolve(fail(error));
    }
  }

  // ------------------------------------------------------------ intent + deps object

  private onIntent(event: Event): void {
    const binding = this.binding;
    if (binding === undefined) return;
    for (const node of event.composedPath()) {
      if (node === this.host) break;
      if (!(node instanceof Element)) continue;
      const keys = node.getAttribute(INTENT_ATTR);
      if (keys === null) continue;
      for (const key of keys.split(/\s+/)) {
        if (key !== '') binding.handles.get(key)?.trigger();
      }
    }
  }

  private createDepsObject(): ComponentDeps<D> {
    const out: Record<string, unknown> = {};
    for (const edge of this.spec.edges) {
      Object.defineProperty(out, edge.key, {
        enumerable: true,
        get: () => {
          const binding = this.binding;
          const handle = binding?.handles.get(edge.key);
          if (edge.kind === 'render') {
            if (handle === undefined || (handle.state !== 'ready' && handle.state !== 'refreshing')) {
              throw RenderDepNotReadyError({
                units: [this.tag],
                details: { component: this.tag, dependency: edge.key, state: handle?.state ?? 'unbound' },
              });
            }
            return handle.value;
          }
          if (edge.kind === 'lazy') return handle ?? IDLE_HANDLE;
          return binding?.functionals.get(edge.key) ?? IDLE_FUNCTIONAL;
        },
      });
    }
    return Object.freeze(out) as ComponentDeps<D>;
  }

  private report(error: SfError, origin: 'deps' | 'hook'): void {
    const telemetry = this.binding?.scopeHandle.injector.telemetry;
    telemetry?.event('ui.component.error', {
      subsystem: UI_SUBSYSTEMS.component,
      level: 'critical',
      attrs: { component: this.tag, code: error.code, origin },
    });
    this.host.dispatchEvent(new SfErrorEvent(error, origin));
  }
}

const IDLE_FUNCTIONAL: FunctionalDep<undefined> = Object.freeze({
  tokenId: 'ui/unbound',
  state: 'idle',
  get: () => Promise.resolve({ ok: false as const, error: NoInjectorError() }),
  prewarm: () => undefined,
}) as FunctionalDep<undefined>;
