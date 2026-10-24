/**
 * MobX ⇄ Lit binding (R12.14, research §13).
 *
 * `MobxController` is a ReactiveController that tracks every observable read
 * while its host renders and requests an update when one of them changes —
 * fine-grained: only values actually read count. It is built on the core
 * reactivity port (`createTracker`), not on MobX directly, so the port stays the
 * only coupling to MobX.
 *
 * - `SfElement` wires it automatically around its update pass.
 * - Plain LitElements wrap their template: `render() { return this.mobx.track(() => html`…`); }`.
 * - Disposed on disconnect; **frozen** while the host is hidden (R5.2): tracking is
 *   dropped (observers released, so `onBecomeUnobserved` streams can stop) and one
 *   update is requested when it thaws.
 */
import { createTracker, untracked, type Tracker } from '@staticflux/core';
import type { ReactiveController, ReactiveControllerHost } from 'lit';

/** One-shot dependency tracker: runs `fn` tracked, calls `onInvalidate` once when something it read changes. */
export interface RenderTracker {
  track<T>(fn: () => T): T;
  /** True while a tracked pass's observables are being watched. */
  readonly watching: boolean;
  dispose(): void;
}

/**
 * Built on the core port's `createTracker` (a MobX Reaction): `track(fn)` runs `fn`
 * synchronously and tracks its reads — also inside a batch/action — and the reaction
 * is only notified after the tracked pass, so an observable that changes *during* the
 * pass (e.g. a child connecting synchronously in a commit) cannot re-enter the tracker.
 * A disposed reaction cannot track again, so `dispose()` drops it and the next
 * `track()` starts a fresh one. Errors thrown by `fn` are rethrown to the caller (the
 * reaction's own error boundary would only log them).
 */
export function createRenderTracker(onInvalidate: () => void, name = 'sf-ui/render'): RenderTracker {
  let tracker: Tracker | undefined;
  let watching = false;
  const ensure = (): Tracker => {
    if (tracker !== undefined) return tracker;
    const created: Tracker = createTracker(name, () => {
      // Ignore a stale notification from a tracker that has since been dropped.
      if (tracker !== created || !watching) return;
      watching = false;
      onInvalidate();
    });
    tracker = created;
    return created;
  };
  return {
    get watching() {
      return watching;
    },
    track<T>(fn: () => T): T {
      const active = ensure();
      let failure: { error: unknown } | undefined;
      let result: T | undefined;
      // Watching before the pass: a change during the pass invalidates once, after it.
      watching = true;
      active.track(() => {
        try {
          result = fn();
        } catch (error) {
          failure = { error };
        }
      });
      if (failure !== undefined) throw failure.error;
      return result as T;
    },
    dispose() {
      watching = false;
      const current = tracker;
      tracker = undefined;
      current?.dispose();
    },
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
  private inPass = false;

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
    this.inPass = true;
    try {
      return this.tracker.track(fn);
    } finally {
      this.inPass = false;
    }
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
    // Invalidated by a change made during the host's own update: Lit ignores
    // `requestUpdate()` while an update is pending, so ask again once it finished.
    if (this.inPass) {
      queueMicrotask(() => this.invalidate());
      return;
    }
    this.request();
  }

  private request(): void {
    if (this.options.onInvalidate !== undefined) this.options.onInvalidate();
    else this.host.requestUpdate();
  }
}
