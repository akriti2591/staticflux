/**
 * Test helpers for UI component tests (also used by messaging/shell tests).
 * Not part of the boot path; exported for package tests and the testkit.
 */
import { createInjector, type Injector, type Registration } from '@staticflux/core';
import { createUiEnvironment, type RenderObserver, type RenderScheduler, type UiEnvironment, type VisibilityObserver } from './ports.js';
import { provideScope } from './scope.js';
import { defineUiElements } from './define.js';

/** Let pending promises/microtasks/zero-delay timers run. */
export async function settle(rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

export interface ManualVisibility extends VisibilityObserver {
  show(element: Element): void;
  readonly observed: number;
}

/** Visibility observer driven by the test. */
export function manualVisibility(): ManualVisibility {
  const callbacks = new Map<Element, Set<(visible: boolean) => void>>();
  return {
    observe(element, callback) {
      const set = callbacks.get(element) ?? new Set();
      set.add(callback);
      callbacks.set(element, set);
      return () => set.delete(callback);
    },
    show(element) {
      for (const cb of [...(callbacks.get(element) ?? [])]) cb(true);
    },
    get observed() {
      let n = 0;
      for (const set of callbacks.values()) n += set.size;
      return n;
    },
  };
}

export interface MountedRoot {
  readonly injector: Injector;
  readonly environment: UiEnvironment;
  readonly container: HTMLElement;
  dispose(): Promise<void>;
}

/** Create an app injector, a container in `document.body` that provides it, and the UI environment. */
export function mountTestRoot(
  options: {
    readonly units?: readonly Registration[];
    readonly injector?: Injector;
    readonly scheduler?: RenderScheduler;
    readonly visibility?: VisibilityObserver;
    readonly renderObservers?: readonly RenderObserver[];
  } = {},
): MountedRoot {
  defineUiElements();
  const injector = options.injector ?? createInjector({ units: options.units ?? [], idle: (cb) => setTimeout(cb, 0) });
  const environment = createUiEnvironment({
    ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
    ...(options.visibility === undefined ? {} : { visibility: options.visibility }),
    ...(options.renderObservers === undefined ? {} : { renderObservers: options.renderObservers }),
  });
  const container = document.createElement('div');
  const provided = provideScope(container, { injector, environment, name: 'test-root' });
  document.body.append(container);
  return {
    injector,
    environment,
    container,
    async dispose() {
      container.remove();
      provided.dispose();
      await injector.dispose();
    },
  };
}
