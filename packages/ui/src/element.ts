/**
 * `SfElement` — the single-level base for StaticFlux components (extends LitElement,
 * nothing else; behaviour is composed from controllers):
 *
 * - `ComponentDepsController` — self-injection, render/lazy/functional deps, hooks.
 * - `MobxController`          — fine-grained re-render on observables read (R12.14).
 * - Render coalescing through the injected `RenderScheduler` (R12.13): updates wait for
 *   the frame flush; updates requested *during* a flush run in the same frame.
 * - Placeholder (size-stable, `aria-busy`) until ready (R12.19, R15.5); failed template
 *   + bubbling `sf-error` for error boundaries.
 * - Frozen while its scope is hidden: no renders, no reactions (R5.2, R12.16).
 * - `measure` / `mutate` helpers (R12.15), `crossOrigin()` per IsolationPolicy (R11.16b),
 *   render records for perf (R12.20).
 */
import type { Injector, Result, Scope, SfError } from '@staticflux/core';
import { html, LitElement, nothing, type PropertyValues, ReactiveElement, render as litRender } from 'lit';
import type { AnyComponentSpec, ComponentDeps, ComponentDepsDeclaration, ComponentHooks, DepKey, DepsOf, FunctionalKeys, LazyKeys } from './component.js';
import { ComponentDepsController, type ComponentState } from './deps.js';
import { RenderFailedError } from './errors.js';
import { SfErrorEvent, SfReadyEvent } from './events.js';
import { MobxController } from './mobx-controller.js';
import type { CrossOriginElementKind, IsolationPolicy, RenderOutcome, RenderRecord, UiEnvironment } from './ports.js';
import { UI_SUBSYSTEMS, uiMetrics } from './telemetry.js';

const EMPTY_SPEC: AnyComponentSpec = Object.freeze({ kind: 'component', tag: 'sf-anonymous', edges: [] });

/** Attribute reflecting the component lifecycle state (`resolving | ready | failed | detached`). */
export const STATE_ATTR = 'sf-state';

export abstract class SfElement<S extends AnyComponentSpec = AnyComponentSpec> extends LitElement {
  /** The component spec. Every subclass sets `static override readonly spec = component({…})`. */
  static readonly spec: AnyComponentSpec = EMPTY_SPEC;

  /** Dependency controller (state, error, scope, retry, prewarm). */
  protected readonly sf: ComponentDepsController<DepsOf<S>>;
  /** MobX tracking of the update pass. */
  protected readonly mobx: MobxController;

  private renderCount = 0;
  private reactiveInvalidation = false;
  private requestedDuringFlush = false;
  private frozenPending = false;
  private connectedAt = 0;
  private hadContent = false;
  private resolveFrame: (() => void) | undefined;
  private readonly frameJob = (): void => {
    const resolve = this.resolveFrame;
    this.resolveFrame = undefined;
    this.performUpdate();
    resolve?.();
  };

  constructor() {
    super();
    const spec = (this.constructor as typeof SfElement).spec;
    this.sf = new ComponentDepsController<DepsOf<S>>(this, spec, {
      wire: (hooks) => this.wireDeps(hooks),
      frozenChanged: (frozen) => this.onFrozenChanged(frozen),
    });
    this.mobx = new MobxController(this, {
      onInvalidate: () => {
        this.reactiveInvalidation = true;
        this.requestUpdate();
      },
    });
  }

  /** Typed dependencies. Render deps throw SF-UI-001 if read before ready (I-11). */
  get deps(): ComponentDeps<DepsOf<S>> {
    return this.sf.deps;
  }

  /** Reactive component state. */
  get componentState(): ComponentState {
    return this.sf.state;
  }

  /** True once render deps and blocking hooks are ready. */
  get ready(): boolean {
    return this.sf.state === 'ready';
  }

  get environment(): UiEnvironment | undefined {
    // Lit calls requestUpdate() from its constructor, before our controllers exist.
    return (this.sf as ComponentDepsController<DepsOf<S>> | undefined)?.environment;
  }

  /** The injector of the nearest scope (for directives/controllers that resolve on behalf of the element). */
  get injector(): Injector | undefined {
    return this.sf.scopeHandle?.injector;
  }

  /** Isolation policy of the nearest scope (read by the `sfSrc` directive). */
  get isolationPolicy(): IsolationPolicy | undefined {
    return this.sf.environment?.isolation;
  }

  /** The connection scope: disposed on disconnect. */
  get connectionScope(): Scope | undefined {
    return this.sf.scope;
  }

  /**
   * Override to register dependency hooks; called each time the element binds to an injector.
   * @example
   * protected override wireDeps(on: ComponentHooks<DepsOf<typeof spec>>) {
   *   on.onReady('presence', (presence, scope) => presence.subscribe(...), { blocking: false });
   * }
   */
  protected wireDeps(_hooks: ComponentHooks<DepsOf<S>>): void {}

  /** Placeholder template (spec.placeholder → default skeleton). */
  protected renderPlaceholder(): unknown {
    const spec = (this.constructor as typeof SfElement).spec;
    return spec.placeholder?.() ?? html`<sf-skeleton></sf-skeleton>`;
  }

  /** Failed template (spec.failed → empty). Shell boundaries render the visible fallback. */
  protected renderFailed(error: SfError): unknown {
    const spec = (this.constructor as typeof SfElement).spec;
    return spec.failed?.(error) ?? nothing;
  }

  /** Re-resolve dependencies after a failure. */
  retry(): void {
    this.sf.retry();
  }

  /** Mark an element inside the template as the intent trigger of deps (`data-sf-intent=${this.intent('exportPdf')}`). */
  intent(...keys: readonly (LazyKeys<DepsOf<S>> | FunctionalKeys<DepsOf<S>>)[]): string {
    return keys.join(' ');
  }

  /** Pre-warm deps now (e.g. from a custom gesture). */
  prewarm(...keys: readonly DepKey<DepsOf<S>>[]): void {
    this.sf.prewarm(...keys);
  }

  /** `crossorigin` attribute value for a URL per the injected IsolationPolicy (or `nothing`). */
  crossOrigin(url: string, kind: CrossOriginElementKind = 'img'): string | typeof nothing {
    return this.isolationPolicy?.crossOriginFor(url, kind) ?? nothing;
  }

  /** DOM read in the scheduler's measure phase (no layout thrashing, R12.15). */
  measure<T>(read: () => T, signal?: AbortSignal): Promise<Result<T>> {
    const scheduler = this.environment?.scheduler;
    if (scheduler === undefined) return Promise.resolve().then(() => ({ ok: true as const, value: read() }));
    return scheduler.measure(read, signal ?? this.sf.scope?.signal);
  }

  /** DOM write in the scheduler's mutate phase (after every read of the frame). */
  mutate<T>(write: () => T, signal?: AbortSignal): Promise<Result<T>> {
    const scheduler = this.environment?.scheduler;
    if (scheduler === undefined) return Promise.resolve().then(() => ({ ok: true as const, value: write() }));
    return scheduler.mutate(write, signal ?? this.sf.scope?.signal);
  }

  // ------------------------------------------------------------ Lit lifecycle

  override connectedCallback(): void {
    this.connectedAt = this.environment?.now() ?? 0;
    super.connectedCallback();
    if (this.connectedAt === 0) this.connectedAt = this.environment?.now() ?? 0;
  }

  override requestUpdate(name?: PropertyKey, oldValue?: unknown, options?: Parameters<LitElement['requestUpdate']>[2]): void {
    // Only the first request of a cycle schedules; remember whether it came from inside a frame flush.
    if (!this.isUpdatePending) this.requestedDuringFlush = this.environment?.scheduler.flushing ?? false;
    super.requestUpdate(name, oldValue, options);
  }

  protected override scheduleUpdate(): void | Promise<unknown> {
    const scheduler = this.environment?.scheduler;
    // Not bound yet (first placeholder paint) or requested during a flush: same frame, Lit's microtask.
    if (scheduler === undefined || this.requestedDuringFlush) return super.scheduleUpdate();
    return new Promise<void>((resolve) => {
      this.resolveFrame = resolve;
      scheduler.schedule(this.frameJob);
    });
  }

  protected override shouldUpdate(changed: PropertyValues): boolean {
    if (this.sf.frozen) {
      this.frozenPending = true;
      return false;
    }
    return super.shouldUpdate(changed);
  }

  protected override update(changed: PropertyValues): void {
    const env = this.environment;
    const start = env?.now() ?? 0;
    const reason: RenderRecord['reason'] = !this.hasUpdated ? 'initial' : this.reactiveInvalidation ? 'reactive' : 'property';
    this.reactiveInvalidation = false;
    let outcome: RenderOutcome = 'placeholder';
    try {
      this.mobx.track(() => {
        const state = this.sf.state;
        if (state === 'ready') {
          outcome = 'content';
          super.update(changed);
        } else if (state === 'failed') {
          outcome = 'failed';
          this.commit(changed, this.renderFailed(this.sf.error ?? RenderFailedError()));
        } else {
          outcome = 'placeholder';
          this.commit(changed, this.renderPlaceholder());
        }
      });
    } catch (error) {
      const sf = RenderFailedError({ cause: error, units: [this.localName], details: { component: this.localName } });
      outcome = 'failed';
      this.sf.scopeHandle?.injector.telemetry.event('ui.render.failed', {
        subsystem: UI_SUBSYSTEMS.render,
        level: 'critical',
        attrs: { component: this.localName },
      });
      this.commit(changed, this.renderFailed(sf));
      this.dispatchEvent(new SfErrorEvent(sf, 'render'));
    }
    this.reflectState(outcome);
    this.record(outcome, reason, start);
  }

  /** Commit an alternate template (placeholder / failed) without calling `render()`. */
  private commit(changed: PropertyValues, template: unknown): void {
    if (!this.hasUpdated) this.renderOptions.isConnected = this.isConnected;
    ReactiveElement.prototype['update'].call(this, changed);
    litRender(template, this.renderRoot, this.renderOptions);
  }

  private reflectState(outcome: RenderOutcome): void {
    const state = outcome === 'content' ? 'ready' : outcome === 'failed' ? 'failed' : 'resolving';
    if (this.getAttribute(STATE_ATTR) !== state) this.setAttribute(STATE_ATTR, state);
    const busy = outcome === 'placeholder';
    if (busy) this.setAttribute('aria-busy', 'true');
    else this.removeAttribute('aria-busy');
    const size = (this.constructor as typeof SfElement).spec.size;
    if (size !== undefined) {
      this.style.minInlineSize = busy ? (size.inline ?? '') : '';
      this.style.minBlockSize = busy ? (size.block ?? '') : '';
    }
  }

  private record(outcome: RenderOutcome, reason: RenderRecord['reason'], start: number): void {
    this.renderCount += 1;
    const env = this.environment;
    if (env === undefined) return;
    const time = env.now();
    const record: RenderRecord = {
      tag: this.localName,
      element: this,
      outcome,
      count: this.renderCount,
      duration: time - start,
      reason,
      time,
    };
    const telemetry = this.sf.scopeHandle?.injector.telemetry;
    if (telemetry?.enabled(UI_SUBSYSTEMS.render, 'debug') === true) {
      telemetry.record(uiMetrics.renders, 1, { tag: record.tag, outcome, reason });
      telemetry.record(uiMetrics.renderDuration, record.duration, { tag: record.tag });
    }
    for (const observer of env.renderObservers) observer.rendered?.(record);
    if (outcome === 'content' && !this.hadContent) {
      this.hadContent = true;
      for (const observer of env.renderObservers) observer.firstContent?.(record);
      telemetry?.record(uiMetrics.timeToContent, time - this.connectedAt, { tag: record.tag });
      this.dispatchEvent(new SfReadyEvent(this.localName));
    }
  }

  private onFrozenChanged(frozen: boolean): void {
    if (frozen) {
      this.mobx.freeze();
      return;
    }
    this.mobx.thaw();
    if (this.frozenPending) {
      this.frozenPending = false;
      this.requestUpdate();
    }
  }
}

/** Type helper for `wireDeps` parameters: `ComponentHooksOf<typeof spec>`. */
export type ComponentHooksOf<S extends AnyComponentSpec> = ComponentHooks<DepsOf<S>>;
export type { ComponentDepsDeclaration };
