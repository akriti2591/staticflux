/**
 * MobX ⇄ Lit binding (R12.14, research §13).
 *
 * `MobxController` is a ReactiveController that tracks every observable read
 * while its host renders and requests an update when one of them changes —
 * fine-grained: only values actually read count. It is built on the core
 * reactivity port (`watch`), not on MobX directly, so the port stays the only
 * coupling to MobX.
 *
 * - `SfElement` wires it automatically around its update pass.
 * - Plain LitElements wrap their template: `render() { return this.mobx.track(() => html`…`); }`.
 * - Disposed on disconnect; **frozen** while the host is hidden (R5.2): tracking is
 *   dropped (observers released, so `onBecomeUnobserved` streams can stop) and one
 *   update is requested when it thaws.
 */
import { untracked, watch } from '@staticflux/core';
import type { ReactiveController, ReactiveControllerHost } from 'lit';

/** One-shot dependency tracker: runs `fn` tracked, calls `onInvalidate` once when something it read changes. */
export interface RenderTracker {
  track<T>(fn: () => T): T;
  /** True while a tracked pass's observables are being watched. */
  readonly watching: boolean;
  dispose(): void;
}

/**
 * The core port exposes `watch(expression, effect)`. A one-shot tracker is built
 * from it: the expression runs `fn` on its first evaluation (tracking reads); on
 * invalidation it returns a different value without reading anything, which fires
 * the effect once and leaves the reaction with no dependencies; we then dispose it.
 */
export function createRenderTracker(onInvalidate: () => void): RenderTracker {
  let current: (() => void) | undefined;
  let lastWasDeferred = false;
  const stop = (): void => {
    const dispose = current;
    current = undefined;
    dispose?.();
  };
  return {
    get watching() {
      return current !== undefined;
    },
    track<T>(fn: () => T): T {
      stop();
      let evaluated = false;
      let result: T | undefined;
      let failure: { error: unknown } | undefined;
      const dispose = watch(
        () => {
          if (!evaluated) {
            evaluated = true;
            try {
              result = fn();
            } catch (error) {
              failure = { error };
            }
            return 0;
          }
          return 1;
        },
        () => {
          if (current === dispose) current = undefined;
          dispose();
          onInvalidate();
        },
      );
      if (!evaluated) {
        // Created inside a batch/action: MobX defers the first run. Render untracked now
        // and re-render once after the batch so tracking is re-established.
        dispose();
        const value = untracked(fn);
        if (!lastWasDeferred) queueMicrotask(onInvalidate);
        lastWasDeferred = true;
        return value;
      }
      lastWasDeferred = false;
      current = dispose;
      if (failure !== undefined) throw failure.error;
      return result as T;
    },
    dispose: stop,
  };
}

export interface MobxControllerOptions {
  /** Called instead of `host.requestUpdate()` on invalidation (e.g. to mark the reason). */
  readonly onInvalidate?: () => void;
}

export class MobxController implements ReactiveController {
  private readonly tracker: RenderTracker;
  private frozenState = false;
  private dirty = false;
  private connected = false;

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly options: MobxControllerOptions = {},
  ) {
    this.tracker = createRenderTracker(() => this.invalidate());
    host.addController(this);
  }

  get frozen(): boolean {
    return this.frozenState;
  }

  /** True while observables read by the last render are watched. */
  get watching(): boolean {
    return this.tracker.watching;
  }

  /** Run `fn` (the render) tracked. Untracked while frozen or disconnected. */
  track<T>(fn: () => T): T {
    if (this.frozenState || !this.connected) return untracked(fn);
    return this.tracker.track(fn);
  }

  /** Stop reacting (hidden). Observers are released; one update is requested on thaw. */
  freeze(): void {
    if (this.frozenState) return;
    this.frozenState = true;
    if (this.tracker.watching) this.dirty = true;
    this.tracker.dispose();
  }

  thaw(): void {
    if (!this.frozenState) return;
    this.frozenState = false;
    if (this.dirty && this.connected) {
      this.dirty = false;
      this.request();
    }
  }

  hostConnected(): void {
    this.connected = true;
    // A reconnect must re-track: the previous reaction was disposed on disconnect.
    if (this.dirty && !this.frozenState) {
      this.dirty = false;
      this.request();
    }
  }

  hostDisconnected(): void {
    this.connected = false;
    if (this.tracker.watching) this.dirty = true;
    this.tracker.dispose();
  }

  private invalidate(): void {
    if (this.frozenState || !this.connected) {
      this.dirty = true;
      return;
    }
    this.request();
  }

  private request(): void {
    if (this.options.onInvalidate !== undefined) this.options.onInvalidate();
    else this.host.requestUpdate();
  }
}
