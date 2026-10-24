/**
 * DOM events of the UI layer. Typed classes with exported type constants —
 * listeners use `SfErrorEvent.type`, never a string literal.
 *
 * - `sf-error`: a component (or scope) failed. Bubbles and is composed, so the
 *   nearest shell error boundary (`<sf-boundary>`) can catch it per region.
 * - `sf-ready`: a component committed its real content for the first time
 *   (feature first-render marks, perf).
 */
import type { SfError } from '@staticflux/core';

export type SfErrorOrigin = 'deps' | 'hook' | 'render' | 'scope';

export class SfErrorEvent extends Event {
  static readonly type = 'sf-error' as const;
  constructor(
    readonly error: SfError,
    readonly origin: SfErrorOrigin,
  ) {
    super(SfErrorEvent.type, { bubbles: true, composed: true, cancelable: true });
  }
}

export class SfReadyEvent extends Event {
  static readonly type = 'sf-ready' as const;
  constructor(readonly tag: string) {
    super(SfReadyEvent.type, { bubbles: true, composed: true });
  }
}

declare global {
  interface HTMLElementEventMap {
    'sf-error': SfErrorEvent;
    'sf-ready': SfReadyEvent;
  }
}
