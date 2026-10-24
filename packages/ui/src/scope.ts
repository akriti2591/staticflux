/**
 * DOM-shaped injector scopes (R2.8, research §1 "Lit Context protocol").
 *
 * The Context Community Protocol (`@lit/context`) carries ONE value down the DOM:
 * a `UiScopeHandle` holding the nearest injector, the UI environment (scheduler,
 * visibility, isolation, render observers) and the frozen (hidden) flag. Components
 * never receive services through context — they resolve their declared deps from
 * the handle's injector (self-injection, no prop drilling).
 *
 * - `<sf-scope level="feature" .units=${…}>` creates a child injector of the
 *   nearest scope above it (or uses an explicit `.injector`, e.g. the feature
 *   injector the feature host created) and provides it to its subtree.
 * - `UiScopeController` does the same for any element (a component that is a scope).
 * - `provideScope(element, …)` turns a plain container (the app root) into a scope.
 * - `frozen` (hidden feature roots, R5.2/R12.16): `content-visibility: hidden` on the
 *   scope element; every component below stops reacting and rendering.
 */
import { createContext, ContextConsumer, ContextProvider } from '@lit/context';
import { box, type Box, type Injector, type Registration, type ScopeLevel, toSfError } from '@staticflux/core';
import { type PropertyValues, ReactiveElement, type ReactiveController, type ReactiveControllerHost } from 'lit';
import { NoInjectorError } from './errors.js';
import { SfErrorEvent } from './events.js';
import { createUiEnvironment, type UiEnvironment } from './ports.js';
import { UI_SUBSYSTEMS } from './telemetry.js';

export interface UiScopeHandle {
  readonly injector: Injector;
  readonly environment: UiEnvironment;
  readonly level: ScopeLevel;
  readonly name: string;
  readonly parent: UiScopeHandle | undefined;
  /** Reactive: true while this scope or any ancestor scope is frozen (hidden). */
  readonly frozen: boolean;
}

/** The single context key of StaticFlux UI (one key, not one per service). */
export const uiScopeContext = createContext<UiScopeHandle | undefined>(Symbol.for('staticflux/ui-scope'));

function makeHandle(
  injector: Injector,
  environment: UiEnvironment,
  parent: UiScopeHandle | undefined,
  own: Box<boolean>,
  name: string,
): UiScopeHandle {
  return {
    injector,
    environment,
    level: injector.level,
    name,
    parent,
    get frozen() {
      return own.get() || (parent?.frozen ?? false);
    },
  };
}

export interface UiScopeOptions {
  /** Level of the child injector to create (ignored with an explicit `injector`). Default `component`. */
  readonly level?: ScopeLevel;
  readonly name?: string;
  /** Units registered in the child injector. */
  readonly units?: readonly Registration[];
  /** Use this injector instead of creating a child (not disposed by the scope). */
  readonly injector?: Injector;
  /** Override the inherited environment. */
  readonly environment?: UiEnvironment;
}

type HostElement = ReactiveControllerHost & HTMLElement;

/** Makes its host element an injector scope for its DOM subtree. */
export class UiScopeController implements ReactiveController {
  private readonly consumer: ContextConsumer<typeof uiScopeContext, HostElement>;
  private readonly provider: ContextProvider<typeof uiScopeContext, HostElement>;
  private readonly frozenBox = box(false);
  private parentHandle: UiScopeHandle | undefined;
  private current: { handle: UiScopeHandle; owned: boolean } | undefined;
  private connected = false;
  private options: UiScopeOptions;

  constructor(
    private readonly host: HostElement,
    options: UiScopeOptions = {},
  ) {
    this.options = options;
    this.consumer = new ContextConsumer(host, {
      context: uiScopeContext,
      subscribe: true,
      callback: (value) => this.onParent(value),
    });
    this.provider = new ContextProvider(host, { context: uiScopeContext, initialValue: undefined });
    host.addController(this);
  }

  /** The scope this element provides (undefined until attached). */
  get handle(): UiScopeHandle | undefined {
    return this.current?.handle;
  }

  get frozen(): boolean {
    return this.frozenBox.get();
  }

  set frozen(value: boolean) {
    if (this.frozenBox.get() !== value) this.frozenBox.set(value);
  }

  /** Change options; re-attaches when connected (a new child injector is created). */
  configure(options: UiScopeOptions): void {
    this.options = options;
    if (this.connected) {
      this.detach();
      this.attach();
    }
  }

  hostConnected(): void {
    this.connected = true;
    if (this.current === undefined) this.attach();
  }

  hostDisconnected(): void {
    this.connected = false;
    // Moving an element (disconnect + connect in one task) keeps its injector.
    queueMicrotask(() => {
      if (!this.connected) this.detach();
    });
  }

  private onParent(value: UiScopeHandle | undefined): void {
    if (value === this.parentHandle) return;
    this.parentHandle = value;
    if (!this.connected || this.options.injector !== undefined) return;
    // The parent may provide after we connected (happy-dom/upgrade order): attach late, or re-parent.
    if (this.current !== undefined) this.detach();
    if (value !== undefined) this.attach();
  }

  private attach(): void {
    const parent = this.parentHandle ?? this.consumer.value;
    this.parentHandle = parent;
    const name = this.options.name ?? this.host.localName;
    let injector: Injector;
    let owned = false;
    if (this.options.injector !== undefined) {
      injector = this.options.injector;
    } else if (parent !== undefined) {
      try {
        injector = parent.injector.child(this.options.level ?? 'component', name, this.options.units ?? []);
        owned = true;
      } catch (error) {
        this.host.dispatchEvent(new SfErrorEvent(toSfError(error), 'scope'));
        return;
      }
    } else {
      queueMicrotask(() => {
        if (this.connected && this.current === undefined) {
          this.host.dispatchEvent(
            new SfErrorEvent(NoInjectorError({ details: { element: this.host.localName } }), 'scope'),
          );
        }
      });
      return;
    }
    const environment = this.options.environment ?? parent?.environment ?? createUiEnvironment();
    const handle = makeHandle(injector, environment, parent, this.frozenBox, name);
    this.current = { handle, owned };
    injector.telemetry.event('ui.scope.attached', {
      subsystem: UI_SUBSYSTEMS.scope,
      level: 'verbose',
      attrs: { scope: name, level: injector.level, owned },
    });
    this.provider.setValue(handle, true);
  }

  private detach(): void {
    const current = this.current;
    if (current === undefined) return;
    this.current = undefined;
    this.provider.setValue(undefined, true);
    if (current.owned) void current.handle.injector.dispose();
  }
}

/** Make a plain element (e.g. the app root container) a scope. Returns the handle and a disposer. */
export function provideScope(
  element: HTMLElement,
  options: { readonly injector: Injector; readonly environment?: UiEnvironment; readonly name?: string },
): { readonly handle: UiScopeHandle; dispose(): void } {
  const handle = makeHandle(
    options.injector,
    options.environment ?? createUiEnvironment(),
    undefined,
    box(false),
    options.name ?? element.localName,
  );
  const provider = new ContextProvider(element, { context: uiScopeContext, initialValue: handle });
  return {
    handle,
    dispose() {
      provider.setValue(undefined, true);
      provider.clearCallbacks();
    },
  };
}

/**
 * `<sf-scope>`: a child injector for its subtree.
 *
 * ```html
 * <sf-scope .injector=${appInjector} .environment=${env}>        <!-- app root -->
 *   <sf-scope level="feature" name="studio" .injector=${ctx.injector} ?frozen=${ctx.hidden}>
 *     <studio-editor></studio-editor>
 * ```
 */
export class SfScopeElement extends ReactiveElement {
  static override properties = {
    level: { type: String },
    name: { type: String },
    units: { attribute: false },
    injector: { attribute: false },
    environment: { attribute: false },
    frozen: { type: Boolean, reflect: true },
  };

  declare level: ScopeLevel;
  declare name: string;
  declare units: readonly Registration[];
  declare injector: Injector | undefined;
  declare environment: UiEnvironment | undefined;
  declare frozen: boolean;

  readonly scope: UiScopeController;

  constructor() {
    super();
    this.level = 'component';
    this.name = '';
    this.units = [];
    this.injector = undefined;
    this.environment = undefined;
    this.frozen = false;
    this.scope = new UiScopeController(this);
  }

  /** Light DOM: children are rendered by whoever renders the scope element. */
  protected override createRenderRoot(): HTMLElement {
    return this;
  }

  override connectedCallback(): void {
    // Options must be in place before the controller attaches (property values may arrive before connection).
    this.syncOptions();
    if (this.style.display === '') this.style.display = 'block';
    super.connectedCallback();
  }

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has('frozen')) this.applyFrozen();
    if (this.hasUpdated && (changed.has('level') || changed.has('name') || changed.has('units') || changed.has('injector') || changed.has('environment'))) {
      this.syncOptions();
    }
  }

  /** Hand the current properties to the controller (re-attaches only while connected). */
  private syncOptions(): void {
    const options: UiScopeOptions = {
      level: this.level,
      units: this.units,
      ...(this.name === '' ? {} : { name: this.name }),
      ...(this.injector === undefined ? {} : { injector: this.injector }),
      ...(this.environment === undefined ? {} : { environment: this.environment }),
    };
    this.scope.configure(options);
  }

  private applyFrozen(): void {
    this.scope.frozen = this.frozen;
    // R12.16: hidden roots cost zero render work; DOM and state stay.
    this.style.contentVisibility = this.frozen ? 'hidden' : '';
    if (this.level === 'feature') this.style.contain = this.frozen ? 'strict' : 'layout style';
  }
}

export const SF_SCOPE_TAG = 'sf-scope';

/** Register `<sf-scope>` (idempotent). */
export function defineScopeElement(registry: CustomElementRegistry = customElements): void {
  if (registry.get(SF_SCOPE_TAG) === undefined) registry.define(SF_SCOPE_TAG, SfScopeElement);
}
