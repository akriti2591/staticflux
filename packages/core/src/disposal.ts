/**
 * Disposal scopes. Every resource in StaticFlux (subscription, timer, listener,
 * worker port, request, reaction) registers in the scope that owns it. Disposing
 * a scope disposes its children first, then its own resources in LIFO order, and
 * aborts the scope's `signal` so in-flight async work stops.
 */
import { defineError, type SfError, toSfError } from './errors.js';

// Symbol.dispose / Symbol.asyncDispose polyfill (Safari/iOS are not Baseline yet).
const symbols = Symbol as unknown as { dispose?: symbol; asyncDispose?: symbol };
symbols.dispose ??= Symbol.for('Symbol.dispose');
symbols.asyncDispose ??= Symbol.for('Symbol.asyncDispose');

export const ScopeDisposedError = defineError(
  'SF-CORE-001',
  'invariant',
  'A resource was registered on, or used from, a disposed scope.',
  'Check `scope.disposed` before late async continuations, or pass `scope.signal` so the work is aborted instead.',
);

export type Cleanup = () => void | Promise<void>;

export interface Scope extends Disposable, AsyncDisposable {
  readonly id: string;
  readonly name: string;
  readonly parent: Scope | undefined;
  /** Aborted when the scope is disposed. Pass it to every async operation the scope owns. */
  readonly signal: AbortSignal;
  readonly disposed: boolean;
  /** Register a cleanup function. Runs LIFO on dispose. Runs immediately if the scope is already disposed. */
  defer(cleanup: Cleanup): void;
  /** Register a Disposable/AsyncDisposable and return it. */
  use<T extends Disposable | AsyncDisposable>(resource: T): T;
  /** Add an event listener that is removed when the scope is disposed. */
  listen<K extends string>(
    target: EventTarget,
    type: K,
    listener: (event: Event) => void,
    options?: Omit<AddEventListenerOptions, 'signal'>,
  ): void;
  /** Create a child scope; disposed before this scope's own resources. */
  child(name: string): Scope;
  /** Dispose children, then resources (LIFO). Errors are collected and reported, never thrown. */
  dispose(): Promise<readonly SfError[]>;
}

export interface ScopeOptions {
  /** Called with errors thrown by cleanup functions. */
  readonly onError?: (error: SfError, scope: Scope) => void;
}

let scopeCounter = 0;

class ScopeImpl implements Scope {
  readonly id: string;
  readonly name: string;
  readonly parent: Scope | undefined;
  private readonly controller = new AbortController();
  private readonly cleanups: Cleanup[] = [];
  private readonly children = new Set<ScopeImpl>();
  private disposing: Promise<readonly SfError[]> | undefined;
  private readonly options: ScopeOptions;

  constructor(name: string, parent: ScopeImpl | undefined, options: ScopeOptions) {
    scopeCounter += 1;
    this.id = `scope-${scopeCounter}`;
    this.name = name;
    this.parent = parent;
    this.options = options;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get disposed(): boolean {
    return this.disposing !== undefined;
  }

  defer(cleanup: Cleanup): void {
    if (this.disposing !== undefined) {
      this.runLate(cleanup);
      return;
    }
    this.cleanups.push(cleanup);
  }

  use<T extends Disposable | AsyncDisposable>(resource: T): T {
    const asyncDispose = (resource as Partial<AsyncDisposable>)[Symbol.asyncDispose];
    const syncDispose = (resource as Partial<Disposable>)[Symbol.dispose];
    if (typeof asyncDispose === 'function') this.defer(async () => {
      await asyncDispose.call(resource);
    });
    else if (typeof syncDispose === 'function') this.defer(() => syncDispose.call(resource));
    return resource;
  }

  listen<K extends string>(
    target: EventTarget,
    type: K,
    listener: (event: Event) => void,
    options: Omit<AddEventListenerOptions, 'signal'> = {},
  ): void {
    if (this.disposing !== undefined) {
      this.report(ScopeDisposedError({ scope: this.name, details: { type } }));
      return;
    }
    target.addEventListener(type, listener, { ...options, signal: this.controller.signal });
  }

  child(name: string): Scope {
    const child = new ScopeImpl(name, this, this.options);
    if (this.disposing !== undefined) {
      void child.dispose();
      return child;
    }
    this.children.add(child);
    child.defer(() => {
      this.children.delete(child);
    });
    return child;
  }

  dispose(): Promise<readonly SfError[]> {
    this.disposing ??= this.run();
    return this.disposing;
  }

  [Symbol.dispose](): void {
    void this.dispose();
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.dispose().then(() => undefined);
  }

  private async run(): Promise<readonly SfError[]> {
    const errors: SfError[] = [];
    this.controller.abort(new DOMException(`Scope "${this.name}" disposed`, 'AbortError'));
    for (const child of [...this.children].reverse()) {
      errors.push(...(await child.dispose()));
    }
    while (this.cleanups.length > 0) {
      const cleanup = this.cleanups.pop() as Cleanup;
      try {
        await cleanup();
      } catch (error) {
        const sf = toSfError(error);
        errors.push(sf);
        this.report(sf);
      }
    }
    return errors;
  }

  private runLate(cleanup: Cleanup): void {
    try {
      const result = cleanup();
      if (result instanceof Promise) result.catch((error: unknown) => this.report(toSfError(error)));
    } catch (error) {
      this.report(toSfError(error));
    }
  }

  private report(error: SfError): void {
    this.options.onError?.(error, this);
  }
}

/** Create a root scope. */
export function createScope(name: string, options: ScopeOptions = {}): Scope {
  return new ScopeImpl(name, undefined, options);
}
