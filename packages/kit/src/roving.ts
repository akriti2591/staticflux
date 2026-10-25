/**
 * `@staticflux/kit/roving` — roving tabindex (WAI-ARIA APG "Managing focus within
 * composites"): one item of a composite is in the tab order (`tabindex=0`), arrow keys
 * move focus between items, Home/End jump. RTL-aware for horizontal orientation.
 *
 * `rovingNextIndex` is the pure key → index function; `RovingFocusController` applies it
 * to an element's items (toolbar, tabs, segmented control, menu, radio groups).
 */
import type { ReactiveController, ReactiveControllerHost } from 'lit';
import { directionOf } from './internal/direction.js';

export type RovingOrientation = 'horizontal' | 'vertical' | 'both';

export interface RovingKeyOptions {
  readonly orientation: RovingOrientation;
  /** Wrap from the last item to the first and back (default true). */
  readonly wrap?: boolean;
  readonly dir?: 'ltr' | 'rtl';
  /** Items that cannot take focus are skipped. */
  readonly isDisabled?: (index: number) => boolean;
}

/** The index focus moves to for `key`, or undefined when the key is not a navigation key. */
export function rovingNextIndex(current: number, count: number, key: string, options: RovingKeyOptions): number | undefined {
  if (count <= 0) return undefined;
  const { orientation } = options;
  const wrap = options.wrap ?? true;
  const rtl = options.dir === 'rtl';
  const horizontal = orientation !== 'vertical';
  const vertical = orientation !== 'horizontal';
  let step: 1 | -1 | undefined;
  let start: number | undefined;
  if (key === 'Home') start = 0;
  else if (key === 'End') start = count - 1;
  else if (horizontal && key === 'ArrowRight') step = rtl ? -1 : 1;
  else if (horizontal && key === 'ArrowLeft') step = rtl ? 1 : -1;
  else if (vertical && key === 'ArrowDown') step = 1;
  else if (vertical && key === 'ArrowUp') step = -1;
  else return undefined;
  const disabled = options.isDisabled ?? (() => false);
  if (start !== undefined) {
    const direction = start === 0 ? 1 : -1;
    for (let i = start; i >= 0 && i < count; i += direction) if (!disabled(i)) return i;
    return undefined;
  }
  let index = current;
  for (let tries = 0; tries < count; tries += 1) {
    index += step as number;
    if (index < 0 || index >= count) {
      if (!wrap) return current;
      index = (index + count) % count;
    }
    if (!disabled(index)) return index;
  }
  return current;
}

const NON_TEXT_INPUTS = /* @__PURE__ */ new Set(['button', 'checkbox', 'radio', 'range', 'color', 'submit', 'reset', 'image', 'file']);

/** Is the event origin a text-editing control (its arrow keys belong to the caret)? */
export function isTextEditing(target: EventTarget | undefined): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target.localName === 'textarea') return true;
  return target.localName === 'input' && !NON_TEXT_INPUTS.has((target as HTMLInputElement).type);
}

/** True for items that cannot take roving focus (`disabled` or `aria-disabled="true"`). */
export function isRovingDisabled(item: Element): boolean {
  return item.hasAttribute('disabled') || item.getAttribute('aria-disabled') === 'true';
}

export interface RovingFocusOptions {
  /** The composite's items, in order (re-read on every key and sync). */
  readonly items: () => readonly HTMLElement[];
  /** Fixed, or read on every key (e.g. a tablist whose orientation is a property). */
  readonly orientation: RovingOrientation | (() => RovingOrientation);
  readonly wrap?: boolean;
  /** Initial tab stop when nothing was focused yet (e.g. the selected tab). Default: first enabled. */
  readonly initial?: () => number;
  /** Called after focus moved by keyboard (selection-follows-focus widgets select here). */
  readonly onMove?: (item: HTMLElement, index: number, event: KeyboardEvent) => void;
  /** Skip disabled items when moving (default true). */
  readonly skipDisabled?: boolean;
}

export class RovingFocusController implements ReactiveController {
  private active = -1;
  private connection: AbortController | undefined;

  constructor(
    private readonly host: ReactiveControllerHost & HTMLElement,
    private readonly options: RovingFocusOptions,
  ) {
    host.addController(this);
  }

  hostConnected(): void {
    this.connection = new AbortController();
    const { signal } = this.connection;
    this.host.addEventListener('keydown', (event) => this.onKeydown(event), { signal });
    this.host.addEventListener('focusin', (event) => this.onFocusin(event), { signal });
  }

  hostDisconnected(): void {
    this.connection?.abort();
  }

  hostUpdated(): void {
    this.sync();
  }

  /** The index of the item holding the tab stop. */
  get activeIndex(): number {
    return this.active;
  }

  /** Make exactly one item tabbable (call after items change). */
  sync(): void {
    const items = this.options.items();
    if (items.length === 0) return;
    if (this.active < 0 || this.active >= items.length || this.disabledAt(items, this.active)) {
      const initial = this.options.initial?.() ?? -1;
      this.active = initial >= 0 && initial < items.length && !this.disabledAt(items, initial) ? initial : items.findIndex((item) => !isRovingDisabled(item));
      if (this.active < 0) this.active = 0;
    }
    items.forEach((item, i) => {
      // `data-roving` tells kit controls that their tab stop is managed by this composite.
      item.setAttribute('data-roving', '');
      item.setAttribute('tabindex', i === this.active ? '0' : '-1');
    });
  }

  /** Forget the tab stop: the next sync picks `initial()` again (e.g. after the selection changed). */
  reset(): void {
    this.active = -1;
  }

  /** Move the tab stop (and focus) to `index`. */
  focusItem(index: number): void {
    const items = this.options.items();
    const item = items[index];
    if (item === undefined) return;
    this.active = index;
    this.sync();
    item.focus();
  }

  private disabledAt(items: readonly HTMLElement[], index: number): boolean {
    const item = items[index];
    return (this.options.skipDisabled ?? true) && item !== undefined && isRovingDisabled(item);
  }

  private indexOf(items: readonly HTMLElement[], event: Event): number {
    const path = event.composedPath();
    return items.findIndex((item) => path.includes(item));
  }

  private onFocusin(event: FocusEvent): void {
    const items = this.options.items();
    const index = this.indexOf(items, event);
    if (index >= 0 && index !== this.active) {
      this.active = index;
      this.sync();
    }
  }

  private onKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    if (isTextEditing(event.composedPath()[0])) return; // arrows move the caret in fields (APG toolbar note)
    const items = this.options.items();
    const current = this.indexOf(items, event);
    if (current < 0) return;
    const next = rovingNextIndex(current, items.length, event.key, {
      orientation: typeof this.options.orientation === 'function' ? this.options.orientation() : this.options.orientation,
      wrap: this.options.wrap ?? true,
      dir: directionOf(this.host),
      isDisabled: (i) => this.disabledAt(items, i),
    });
    if (next === undefined) return;
    event.preventDefault();
    if (next === current) return;
    this.focusItem(next);
    const item = items[next];
    if (item !== undefined) this.options.onMove?.(item, next, event);
  }
}
