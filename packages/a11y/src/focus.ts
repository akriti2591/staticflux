/**
 * Focus manager (R15.2): route-change focus, focus traps (stacked, with restore)
 * and an inert background.
 *
 * - Route change: focus the registered route target, else `[data-sf-route-focus]`,
 *   `main h1`, `h1`, `main`, `body`. Non-focusable targets get `tabindex="-1"`.
 * - Traps: `trap(container)` keeps Tab/Shift+Tab and stray focus inside the
 *   container, marks everything outside `inert` (`aria-hidden` where `inert` is
 *   unsupported), and on release restores both inertness and the previous focus.
 *   Traps stack (dialog over dialog): only the top one is active.
 */
import {
  createMachine,
  createNoopTelemetry,
  createScope,
  defineError,
  defineMachine,
  err,
  ok,
  type Result,
  type Scope,
  type Telemetry,
} from '@staticflux/core';
import { NoDocumentError } from './env.js';

export const FocusTargetError = defineError(
  'SF-A11Y-001',
  'not-found',
  'No element could be focused for the route change or trap.',
  'Render a `<main>` with an `<h1>`, mark the target with `data-sf-route-focus`, or pass `target` explicitly.',
);

export const FocusTrapMachine = defineMachine({
  id: 'a11y/focus-trap',
  initial: 'active',
  states: ['active', 'paused', 'released'],
  transitions: {
    active: { pause: 'paused', release: 'released' },
    paused: { resume: 'active', release: 'released' },
  },
  terminal: ['released'],
});
export type FocusTrapState = (typeof FocusTrapMachine.states)[number];

const SUBSYSTEM = 'a11y/focus';

const TABBABLE = [
  'a[href]',
  'area[href]',
  'button',
  'input',
  'select',
  'textarea',
  'iframe',
  'summary',
  'audio[controls]',
  'video[controls]',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]',
].join(',');

/** Attribute marking elements the inert background must leave alone (live regions, toasts). */
export const KEEP_INTERACTIVE_ATTR = 'data-sf-keep-interactive';

export interface FocusTrapOptions {
  /** Element to focus first. Default: first tabbable, else the container. */
  readonly initialFocus?: HTMLElement | (() => HTMLElement | null | undefined);
  /** Return focus to the previously focused element on release. Default true. */
  readonly restoreFocus?: boolean;
  /** Make everything outside the container inert. Default true. */
  readonly inertBackground?: boolean;
  readonly onEscape?: (event: KeyboardEvent) => void;
  /** Release automatically when this scope ends (scope-bound surfaces). */
  readonly scope?: Scope;
  /** For telemetry/devtools. */
  readonly label?: string;
}

export interface FocusTrap {
  readonly container: HTMLElement;
  readonly label: string;
  /** Reactive. */
  readonly state: FocusTrapState;
  release(): void;
}

export interface RouteFocusOptions {
  readonly target?: Element | null;
  readonly preventScroll?: boolean;
}

export interface FocusManager {
  /** Move focus for a route/view change. */
  focusRouteTarget(options?: RouteFocusOptions): Result<Element>;
  /** Register a preferred route-focus target (latest registration wins while connected). */
  registerRouteTarget(element: Element, scope?: Scope): () => void;
  trap(container: HTMLElement, options?: FocusTrapOptions): Result<FocusTrap>;
  /** Top-most active trap. */
  readonly activeTrap: FocusTrap | undefined;
  readonly trapCount: number;
  tabbables(container: Element): HTMLElement[];
  dispose(): Promise<void>;
}

export interface FocusManagerOptions {
  readonly document: Document | undefined;
  readonly telemetry?: Telemetry;
}

/** Tabbable descendants in tab order (positive tabindex first, then DOM order). */
export function tabbablesOf(container: Element): HTMLElement[] {
  const candidates = [...container.querySelectorAll<HTMLElement>(TABBABLE)].filter((el) => {
    if ((el as HTMLInputElement).disabled === true) return false;
    if (el instanceof HTMLInputElement && el.type === 'hidden') return false;
    if (el.tabIndex < 0) return false;
    if (el.closest('[hidden],[inert]') !== null) return false;
    return true;
  });
  const positive = candidates.filter((el) => el.tabIndex > 0).sort((a, b) => a.tabIndex - b.tabIndex);
  return [...positive, ...candidates.filter((el) => el.tabIndex === 0)];
}

function isFocusable(el: Element): boolean {
  return el instanceof HTMLElement && (el.tabIndex >= 0 || el.hasAttribute('tabindex'));
}

interface InertRecord {
  count: number;
  /** Traps on top whose container lies inside this element: inertness is lifted while > 0. */
  lifted: number;
  readonly attr: 'inert' | 'aria-hidden';
  readonly previous: string | null;
}

export function createFocusManager(options: FocusManagerOptions): FocusManager {
  const doc = options.document;
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const lifetime = createScope('a11y/focus-manager');
  const routeTargets: Element[] = [];
  const stack: TrapImpl[] = [];
  const inert = new Map<Element, InertRecord>();
  const supportsInert = doc !== undefined && 'inert' in doc.createElement('div');

  const focus = (el: Element, preventScroll = true): boolean => {
    if (!(el instanceof HTMLElement) || doc === undefined) return false;
    if (!isFocusable(el)) el.setAttribute('tabindex', '-1');
    el.focus({ preventScroll });
    return doc.activeElement === el;
  };

  const apply = (el: Element, record: InertRecord): void => {
    if (record.count > 0 && record.lifted === 0) el.setAttribute(record.attr, record.attr === 'inert' ? '' : 'true');
    else if (record.previous === null) el.removeAttribute(record.attr);
    else el.setAttribute(record.attr, record.previous);
  };

  const makeInert = (el: Element): void => {
    let record = inert.get(el);
    if (record === undefined) {
      const attr = supportsInert ? 'inert' : 'aria-hidden';
      record = { count: 0, lifted: 0, attr, previous: el.getAttribute(attr) };
      inert.set(el, record);
    }
    record.count += 1;
    apply(el, record);
  };

  const releaseInert = (el: Element): void => {
    const record = inert.get(el);
    if (record === undefined) return;
    record.count -= 1;
    apply(el, record);
    if (record.count <= 0 && record.lifted <= 0) inert.delete(el);
  };

  /** A trap opened inside an element a lower trap made inert lifts that inertness while it is open. */
  const liftAround = (container: Element): Element[] => {
    const lifted: Element[] = [];
    for (let node: Element | null = container; node !== null; node = node.parentElement) {
      const record = inert.get(node);
      if (record === undefined) continue;
      record.lifted += 1;
      apply(node, record);
      lifted.push(node);
    }
    return lifted;
  };

  const unlift = (elements: readonly Element[]): void => {
    for (const el of elements) {
      const record = inert.get(el);
      if (record === undefined) continue;
      record.lifted -= 1;
      apply(el, record);
      if (record.count <= 0 && record.lifted <= 0) inert.delete(el);
    }
  };

  /** Siblings of the container and of each of its ancestors, up to <body>. */
  const backgroundOf = (container: Element): Element[] => {
    const out: Element[] = [];
    for (let node: Element | null = container; node !== null && node !== doc?.body && node.parentElement !== null; node = node.parentElement) {
      for (const sibling of node.parentElement.children) {
        if (sibling === node) continue;
        if (sibling.hasAttribute(KEEP_INTERACTIVE_ATTR) || sibling.hasAttribute('aria-live')) continue;
        if (sibling.tagName === 'SCRIPT' || sibling.tagName === 'STYLE' || sibling.tagName === 'TEMPLATE') continue;
        out.push(sibling);
      }
    }
    return out;
  };

  class TrapImpl implements FocusTrap {
    readonly machine = createMachine(FocusTrapMachine);
    readonly scope: Scope;
    readonly background: Element[];
    readonly previous: Element | null;
    lifted: Element[] = [];
    constructor(
      readonly container: HTMLElement,
      readonly label: string,
      readonly options: FocusTrapOptions,
    ) {
      this.scope = lifetime.child(`trap:${label}`);
      this.previous = doc?.activeElement ?? null;
      this.background = options.inertBackground === false ? [] : backgroundOf(container);
      this.machine.onTransition((r) =>
        telemetry.event(`lifecycle.${r.machine}.${r.from}→${r.to}`, { subsystem: SUBSYSTEM, level: 'verbose', attrs: { trap: label } }),
      );
    }
    get state(): FocusTrapState {
      return this.machine.state;
    }
    release(): void {
      if (this.machine.state === 'released') return;
      const wasTop = stack[stack.length - 1] === this;
      this.machine.send('release');
      const index = stack.indexOf(this);
      if (index >= 0) stack.splice(index, 1);
      for (const el of this.background) releaseInert(el);
      unlift(this.lifted);
      void this.scope.dispose();
      if (wasTop) {
        const next = stack[stack.length - 1];
        if (next !== undefined && next.machine.state === 'paused') next.machine.send('resume');
        const restore = this.options.restoreFocus !== false && this.previous !== null && this.previous.isConnected;
        if (restore && this.previous !== null) focus(this.previous);
        else if (next !== undefined) next.focusInitial();
      }
      telemetry.event('a11y.trap-released', { subsystem: SUBSYSTEM, level: 'verbose', attrs: { trap: this.label } });
    }
    focusInitial(): void {
      const configured = typeof this.options.initialFocus === 'function' ? this.options.initialFocus() : this.options.initialFocus;
      const target = configured ?? tabbablesOf(this.container)[0] ?? this.container;
      focus(target);
    }
    onKeydown(event: KeyboardEvent): void {
      if (stack[stack.length - 1] !== this || this.machine.state !== 'active') return;
      if (event.key === 'Escape' && this.options.onEscape !== undefined) {
        this.options.onEscape(event);
        return;
      }
      if (event.key !== 'Tab') return;
      const items = tabbablesOf(this.container);
      const active = doc?.activeElement ?? null;
      event.preventDefault();
      if (items.length === 0) {
        focus(this.container);
        return;
      }
      const index = active === null ? -1 : items.indexOf(active as HTMLElement);
      const next = event.shiftKey
        ? index <= 0
          ? items[items.length - 1]
          : items[index - 1]
        : index < 0 || index === items.length - 1
          ? items[0]
          : items[index + 1];
      if (next !== undefined) focus(next);
    }
    onFocusIn(event: FocusEvent): void {
      if (stack[stack.length - 1] !== this || this.machine.state !== 'active') return;
      const target = event.target;
      if (target instanceof Node && this.container.contains(target)) return;
      const keep = target instanceof Element && target.closest(`[${KEEP_INTERACTIVE_ATTR}]`) !== null;
      if (!keep) this.focusInitial();
    }
  }

  return {
    focusRouteTarget(routeOptions = {}) {
      if (doc === undefined) return err(NoDocumentError());
      const registered = [...routeTargets].reverse().find((el) => el.isConnected);
      const candidates: (Element | null | undefined)[] = [
        routeOptions.target,
        registered,
        doc.querySelector('[data-sf-route-focus]'),
        doc.querySelector('main h1'),
        doc.querySelector('h1'),
        doc.querySelector('main'),
        doc.body,
      ];
      const span = telemetry.span('a11y.route-focus', { subsystem: SUBSYSTEM, level: 'verbose' });
      for (const candidate of candidates) {
        if (candidate === null || candidate === undefined) continue;
        if (focus(candidate, routeOptions.preventScroll ?? true)) {
          span.set('target', candidate.tagName.toLowerCase());
          span.end('ok');
          return ok(candidate);
        }
      }
      const error = FocusTargetError();
      span.end('error', error);
      return err(error);
    },
    registerRouteTarget(element, scope) {
      routeTargets.push(element);
      const remove = (): void => {
        const index = routeTargets.lastIndexOf(element);
        if (index >= 0) routeTargets.splice(index, 1);
      };
      scope?.defer(remove);
      return remove;
    },
    trap(container, trapOptions = {}) {
      if (doc === undefined) return err(NoDocumentError());
      if (!container.isConnected) return err(FocusTargetError({ message: 'The focus-trap container is not in the document.' }));
      const label = trapOptions.label ?? (container.id || container.tagName.toLowerCase());
      const top = stack[stack.length - 1];
      if (top !== undefined && top.machine.state === 'active') top.machine.send('pause');
      const trap = new TrapImpl(container, label, trapOptions);
      stack.push(trap);
      trap.lifted = liftAround(container);
      for (const el of trap.background) makeInert(el);
      trap.scope.listen(doc, 'keydown', (event) => trap.onKeydown(event as KeyboardEvent), { capture: true });
      trap.scope.listen(doc, 'focusin', (event) => trap.onFocusIn(event as FocusEvent), { capture: true });
      trapOptions.scope?.defer(() => trap.release());
      trap.focusInitial();
      telemetry.event('a11y.trap-activated', { subsystem: SUBSYSTEM, level: 'verbose', attrs: { trap: label, depth: stack.length } });
      return ok(trap);
    },
    get activeTrap() {
      return stack[stack.length - 1];
    },
    get trapCount() {
      return stack.length;
    },
    tabbables: tabbablesOf,
    async dispose() {
      for (const trap of [...stack].reverse()) trap.release();
      await lifetime.dispose();
    },
  };
}
