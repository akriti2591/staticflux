/**
 * `<sf-menu label="Insert">` + `<sf-menu-item>` (+ `<sf-menu-group>`) — WAI-ARIA APG menu button, the menu of
 * FOUNDATIONS §4.8 and OVERLAYS-FEEDBACK §1:
 *
 * - the `trigger` slot gets `aria-haspopup="menu"` + `aria-expanded`; Enter / Space / ArrowDown open on the first item,
 *   ArrowUp on the last; a pointer click opens with the menu itself focused (the first arrow key focuses a row);
 * - in the menu: ArrowUp/Down (wrapping), Home/End, type-ahead by first letter, Enter / Space activate, Escape closes
 *   and returns focus to the trigger (or, when it is gone, its nearest landmark), Tab closes;
 * - items: `type="item|checkbox|radio"` (`menuitem`, `menuitemcheckbox`, `menuitemradio` with `aria-checked`, drawn
 *   with the check / dot icon), `.icon` (a 16 px `IconDef`), `shortcut` (visible `<kbd>` + `aria-keyshortcuts`),
 *   `disabled`; group headings with `<sf-menu-group label>`; dividers with `<div role="separator">`;
 * - **one level of submenu:** an item followed by `<sf-menu slot="submenu">` is a submenu row (`aria-haspopup`,
 *   `aria-expanded`, chevron): opens on hover after 150 ms or on → / Enter, closes on ← / Escape or when the pointer
 *   has left both for 300 ms; a submenu inside a submenu is refused (SF-KIT-003, `sf-overlay-refused`);
 * - **context menu:** `showAt({ x, y }, { keyboard, returnTo })` puts the top-left corner on the pointer and opens left
 *   or up near the edges (`bindContextMenu` wires right-click, `Shift+F10` and the Menu key);
 * - **searchable:** `filterable` adds a filter field on top (the More menu), focused on open;
 * - **bottom sheet:** `sheet="narrow"` renders the menu as a bottom sheet below 720 px (Home, OVERLAYS-FEEDBACK §1.6);
 * - an outside press closes the menu **and is consumed** (it never reaches the canvas); wheel, scroll, window blur and
 *   resize close it; opening another menu or popover, or any dialog, closes it.
 *
 * Activation fires `sf-select` with `{ value, checked }` on the menu (submenu selections bubble to the parent menu too),
 * then closes every level.
 */
import { rememberFocusReturn, type FocusReturn } from '@staticflux/a11y';
import { err, ok, type Result, type SfError } from '@staticflux/core';
import { component, defineComponent, SfElement } from '@staticflux/ui';
import { css, html, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { defineIconElement } from './icon.js';
import type { IconDef } from './icon-def.js';
import { checkIcon } from './icons/check.js';
import { chevronRightIcon } from './icons/chevron-right.js';
import { circleIcon } from './icons/circle.js';
import { type AnchorHandle, anchorFloating, type Align, placeAtPoint, type Side } from './position.js';
import { OVERLAY_GAP, type OverlayKind } from './overlay.js';
import { emit } from './internal/events.js';
import { ConnectedListeners } from './internal/listeners.js';
import { closeLayer, openLayer } from './internal/layer.js';
import { OverlaySession } from './internal/overlay-session.js';
import { ariaKeyShortcuts, shortcutLabel } from './internal/shortcuts.js';
import { floatingStyles } from './internal/floating-styles.js';
import { baseStyles, t } from './internal/styles.js';
import { isRovingDisabled, RovingFocusController } from './roving.js';
import { typeaheadIndex } from './internal/typeahead.js';

export { typeaheadIndex };

export type MenuItemType = 'item' | 'checkbox' | 'radio';

export interface MenuSelectDetail {
  readonly value: string;
  /** Checkbox / radio items: the state after activation. */
  readonly checked: boolean | undefined;
}

/** `sf-overlay-refused` detail: an overlay that the nesting table did not allow (SF-KIT-003). */
export interface OverlayRefusedDetail {
  readonly error: SfError;
}

/** Below this viewport width a `sheet="narrow"` menu is a bottom sheet (OVERLAYS-FEEDBACK §1.6). */
export const NARROW_SHEET_BREAKPOINT = 720;

/** Anchored menu or bottom sheet for a viewport width. */
export function menuPresentation(sheet: 'none' | 'narrow', viewportWidth: number): 'anchored' | 'sheet' {
  return sheet === 'narrow' && viewportWidth < NARROW_SHEET_BREAKPOINT ? 'sheet' : 'anchored';
}

/** Case-insensitive match of a filter query against a label (every word must appear). */
export function menuFilterMatch(label: string, query: string): boolean {
  const haystack = label.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== '')
    .every((word) => haystack.includes(word));
}

const SUBMENU_OPEN_MS = 150;
const SUBMENU_CLOSE_MS = 300;
/** A downward swipe this long closes a bottom sheet. */
const SHEET_SWIPE_PX = 64;

// ------------------------------------------------------------------ item

const itemSpec = component({
  tag: 'sf-menu-item',
  placeholder: () => html`<slot></slot>`,
  description: 'Menu item (menuitem / menuitemcheckbox / menuitemradio) with icon, shortcut hint and optional submenu.',
});

const ROLES: Readonly<Record<MenuItemType, string>> = { item: 'menuitem', checkbox: 'menuitemcheckbox', radio: 'menuitemradio' };

export class SfMenuItemElement extends SfElement<typeof itemSpec> {
  static override readonly spec = itemSpec;
  static override properties = {
    value: {},
    type: {},
    checked: { type: Boolean, reflect: true },
    disabled: { type: Boolean, reflect: true },
    shortcut: {},
    icon: { attribute: false },
  };
  static override styles = [
    baseStyles,
    css`
      :host {
        display: flex;
        align-items: center;
        gap: ${t.space.sm.css};
        min-block-size: ${t.size.row.css};
        padding-inline: ${t.space.sm.css};
        border-radius: ${t.radius.sm.css};
        cursor: default;
        user-select: none;
        outline: none;
      }
      :host(:hover),
      :host(:focus),
      :host([aria-expanded='true']) {
        background: ${t.color.surfaceHover.css};
      }
      :host(:focus-visible) {
        outline: 2px solid ${t.color.focusRing.css};
        outline-offset: -2px;
      }
      :host([disabled]) {
        color: ${t.color.textDisabled.css};
      }
      :host([hidden]) {
        display: none;
      }
      .check {
        display: inline-flex;
        justify-content: center;
        inline-size: ${t.size.icon.css};
        color: ${t.color.accentText.css};
      }
      .dot {
        --sf-icon-stroke: 10;
        transform: scale(0.3);
      }
      .icon {
        color: ${t.color.textMuted.css};
      }
      .label {
        flex: 1;
      }
      kbd {
        font-family: ${t.font.familyMono.css};
        font-size: ${t.type.sizeXs.css};
        color: ${t.color.textMuted.css};
      }
      .chevron {
        color: ${t.color.textMuted.css};
      }
      @media (forced-colors: active) {
        :host(:focus) {
          background: Highlight;
          color: HighlightText;
        }
      }
    `,
  ];

  declare value: string;
  declare type: MenuItemType;
  declare checked: boolean;
  declare disabled: boolean;
  declare shortcut: string | undefined;
  /** 16 px leading icon. */
  declare icon: IconDef | undefined;

  constructor() {
    super();
    this.value = '';
    this.type = 'item';
    this.checked = false;
    this.disabled = false;
    this.shortcut = undefined;
    this.icon = undefined;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.setAttribute('tabindex', '-1');
  }

  /** The text used for type-ahead and filtering. */
  get textLabel(): string {
    return (this.textContent ?? '').trim();
  }

  /**
   * The submenu this row opens: the `<sf-menu slot="submenu">` right after it. A sibling, not a child, so the
   * submenu's rows are never nested inside this row (APG submenu structure).
   */
  get submenu(): SfMenuElement | undefined {
    const next = this.nextElementSibling;
    return next instanceof SfMenuElement && next.getAttribute('slot') === 'submenu' ? next : undefined;
  }

  protected override willUpdate(changed: PropertyValues<this>): void {
    this.setAttribute('role', ROLES[this.type]);
    if (this.type === 'item') this.removeAttribute('aria-checked');
    else this.setAttribute('aria-checked', this.checked ? 'true' : 'false');
    if (this.disabled) this.setAttribute('aria-disabled', 'true');
    else this.removeAttribute('aria-disabled');
    if (this.submenu === undefined) this.removeAttribute('aria-haspopup');
    else {
      this.setAttribute('aria-haspopup', 'menu');
      if (!this.hasAttribute('aria-expanded')) this.setAttribute('aria-expanded', 'false');
    }
    if (changed.has('shortcut')) {
      if (this.shortcut == null || this.shortcut === '') this.removeAttribute('aria-keyshortcuts');
      else this.setAttribute('aria-keyshortcuts', ariaKeyShortcuts(this.shortcut, this.ownerDocument));
    }
  }

  override render(): TemplateResult {
    const mark =
      this.type === 'item'
        ? nothing
        : html`<span class="check" aria-hidden="true"
            >${this.checked ? (this.type === 'radio' ? html`<sf-icon class="dot" .icon=${circleIcon}></sf-icon>` : html`<sf-icon .icon=${checkIcon}></sf-icon>`) : nothing}</span
          >`;
    const icon = this.icon === undefined ? nothing : html`<sf-icon class="icon" .icon=${this.icon}></sf-icon>`;
    const hint = this.shortcut == null || this.shortcut === '' ? nothing : html`<kbd aria-hidden="true">${shortcutLabel(this.shortcut, this.ownerDocument)}</kbd>`;
    const chevron = this.submenu === undefined ? nothing : html`<sf-icon class="chevron" .icon=${chevronRightIcon}></sf-icon>`;
    return html`${mark}${icon}<slot name="start"></slot><span class="label"><slot></slot></span>${hint}${chevron}`;
  }
}

// ------------------------------------------------------------------ group

const groupSpec = component({
  tag: 'sf-menu-group',
  placeholder: () => html`<slot></slot>`,
  description: 'A labelled group of menu items with a small uppercase heading.',
});

export class SfMenuGroupElement extends SfElement<typeof groupSpec> {
  static override readonly spec = groupSpec;
  static override properties = { label: {} };
  static override styles = [
    baseStyles,
    css`
      :host {
        display: block;
      }
      :host([hidden]) {
        display: none;
      }
      .heading {
        padding-block: ${t.space.xs.css};
        padding-inline: ${t.space.sm.css};
        font-size: ${t.type.sizeXs.css};
        font-weight: ${t.font.weightSemibold.css};
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: ${t.color.textMuted.css};
      }
    `,
  ];

  declare label: string;

  constructor() {
    super();
    this.label = '';
  }

  protected override willUpdate(): void {
    this.setAttribute('role', 'group');
    if (this.label === '') this.removeAttribute('aria-label');
    else this.setAttribute('aria-label', this.label);
  }

  override render(): TemplateResult {
    return html`${this.label === '' ? nothing : html`<div class="heading" aria-hidden="true">${this.label}</div>`}<slot></slot>`;
  }
}

// ------------------------------------------------------------------ menu

const menuSpec = component({
  tag: 'sf-menu',
  placeholder: () => html`<slot name="trigger"></slot>`,
  description: 'Menu button (APG): trigger + top-layer menu with roving focus, type-ahead, submenus, filter, consumed light dismiss.',
});

export interface ShowAtOptions {
  /** Opened from the keyboard (`Shift+F10`, the Menu key): focus the first row. Default false. */
  readonly keyboard?: boolean;
  /** Where focus returns on close (the right-clicked element); its nearest landmark when it is gone. */
  readonly returnTo?: Element;
}

export class SfMenuElement extends SfElement<typeof menuSpec> {
  static override readonly spec = menuSpec;
  static override properties = {
    open: { type: Boolean, reflect: true },
    label: {},
    side: {},
    align: {},
    anchor: { attribute: false },
    filterable: { type: Boolean, reflect: true },
    filterLabel: { attribute: 'filter-label' },
    emptyLabel: { attribute: 'empty-label' },
    sheet: { reflect: true },
    query: { state: true },
    presentation: { state: true },
  };
  static override styles = [
    baseStyles,
    floatingStyles,
    css`
      :host {
        display: inline-block;
      }
      :host([slot='submenu']) {
        display: block;
        inline-size: 0;
        block-size: 0;
      }
      .anchor {
        display: inline-flex;
      }
      .menu {
        min-inline-size: 180px;
        max-block-size: min(420px, calc(100vh - 16px));
        overflow: auto;
        border-radius: ${t.radius.lg.css};
        box-shadow: ${t.shadow.level2.css};
      }
      .list {
        outline: none;
      }
      .filter {
        display: flex;
        align-items: center;
        margin-block-end: ${t.space.xs.css};
        padding-inline: ${t.space.sm.css};
        min-block-size: ${t.size.control.css};
        border-radius: ${t.radius.md.css};
        background: ${t.color.surfaceSunken.css};
        border: 1px solid ${t.color.controlEdge.css};
      }
      .filter:focus-within {
        outline: 2px solid ${t.color.focusRing.css};
        outline-offset: 2px;
      }
      .filter input {
        all: unset;
        flex: 1;
        min-inline-size: 0;
        font: inherit;
        color: ${t.color.text.css};
      }
      .filter input::placeholder {
        color: ${t.color.textSubtle.css};
      }
      .empty {
        padding: ${t.space.sm.css};
        color: ${t.color.textMuted.css};
      }
      .menu[data-sheet] {
        inset-inline: 0;
        inset-block-end: 0;
        inset-block-start: auto;
        inline-size: 100vw;
        max-inline-size: none;
        max-block-size: 80vh;
        border-radius: 18px 18px 0 0;
        padding-block-start: ${t.space.md.css};
        touch-action: pan-x;
      }
      .menu[data-sheet]::before {
        content: '';
        display: block;
        inline-size: 36px;
        block-size: 4px;
        margin: 0 auto ${t.space.sm.css};
        border-radius: 2px;
        background: ${t.color.borderStrong.css};
      }
      .menu[data-sheet] ::slotted(sf-menu-item) {
        min-block-size: 44px;
      }
      ::slotted([role='separator']) {
        block-size: 1px;
        margin-block: ${t.space.xs.css};
        background: ${t.color.border.css};
        border: 0;
      }
    `,
  ];

  declare open: boolean;
  declare label: string;
  declare side: Side;
  declare align: Align;
  /** Anchor when there is no trigger (a submenu row is its own submenu's anchor). */
  declare anchor: Element | undefined;
  /** A filter field on top (the searchable More menu). */
  declare filterable: boolean;
  declare filterLabel: string;
  declare emptyLabel: string;
  /** `narrow`: a bottom sheet below 720 px (Home menus). */
  declare sheet: 'none' | 'narrow';
  declare query: string;
  declare presentation: 'anchored' | 'sheet';
  private anchored: AnchorHandle | undefined;
  private focusOnOpen: 'first' | 'last' | 'menu' | 'filter' | 'none' = 'first';
  private returnFocus = true;
  private point: { readonly x: number; readonly y: number } | undefined;
  private returnTo: Element | undefined;
  private focusReturn: FocusReturn | undefined;
  private subTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly roving: RovingFocusController;
  private readonly listeners: ConnectedListeners;
  private readonly session: OverlaySession;

  constructor() {
    super();
    this.open = false;
    this.label = '';
    this.side = 'block-end';
    this.align = 'start';
    this.anchor = undefined;
    this.filterable = false;
    this.filterLabel = 'Search';
    this.emptyLabel = 'No matches';
    this.sheet = 'none';
    this.query = '';
    this.presentation = 'anchored';
    this.roving = new RovingFocusController(this, { items: () => this.items, orientation: 'vertical' });
    this.session = new OverlaySession(this, {
      kind: () => this.kind,
      panel: () => this.menu,
      inside: () => [this],
      outside: () => 'consume',
      scroll: () => (this.presentation === 'sheet' ? 'follow' : 'close'),
      onDismiss: (cause) => {
        if (cause === 'escape' && this.isSubmenu) {
          this.hide(false);
          this.parentRow?.focus();
          return;
        }
        // The outside press was consumed, so focus did not move: bring it back. A newer overlay takes focus itself.
        this.hide(cause !== 'replaced');
      },
    });
    this.listeners = new ConnectedListeners(this, (signal) => {
      this.addEventListener('click', (event) => this.onClick(event), { signal });
      this.addEventListener('keydown', (event) => this.onKeydown(event), { signal });
      this.addEventListener('pointerover', (event) => this.onPointerOver(event), { signal });
      this.addEventListener('pointerleave', () => this.scheduleSubmenuClose(), { signal });
      // A selection in a submenu closes this menu too (the event bubbles on to the app).
      this.addEventListener('sf-select', (event) => event.target !== this && this.open && this.hide(true), { signal });
    });
  }

  /** `submenu` when this menu sits in a menu item's `submenu` slot. */
  get kind(): OverlayKind {
    return this.isSubmenu ? 'submenu' : 'menu';
  }

  get isSubmenu(): boolean {
    return this.getAttribute('slot') === 'submenu' && this.parentElement instanceof SfMenuElement;
  }

  private get parentRow(): SfMenuItemElement | undefined {
    const row = this.previousElementSibling;
    return this.isSubmenu && row instanceof SfMenuItemElement ? row : undefined;
  }

  get trigger(): HTMLElement | undefined {
    return this.querySelector<HTMLElement>(':scope > [slot="trigger"]') ?? undefined;
  }

  /** Enabled, visible menu items (groups included), in order. */
  get items(): SfMenuItemElement[] {
    return [...this.querySelectorAll<SfMenuItemElement>(':scope > sf-menu-item, :scope > sf-menu-group > sf-menu-item')].filter((item) => !isRovingDisabled(item) && !item.hidden);
  }

  private get allItems(): SfMenuItemElement[] {
    return [...this.querySelectorAll<SfMenuItemElement>(':scope > sf-menu-item, :scope > sf-menu-group > sf-menu-item')];
  }

  get menu(): HTMLElement | null {
    return this.renderRoot.querySelector<HTMLElement>('.menu');
  }

  private get list(): HTMLElement | null {
    return this.renderRoot.querySelector<HTMLElement>('.list');
  }

  /** Open with focus on the first (default) or last item. Refused where the nesting rules forbid a menu. */
  show(focus: 'first' | 'last' = 'first'): Result<void, SfError> {
    const allowed = this.allowed();
    if (!allowed.ok) return allowed;
    this.point = undefined;
    this.focusOnOpen = this.filterable ? 'filter' : focus;
    this.open = true;
    return ok(undefined);
  }

  /** Open as a context menu at a viewport point (OVERLAYS-FEEDBACK §1.5 corner rule). */
  showAt(point: { readonly x: number; readonly y: number }, options: ShowAtOptions = {}): Result<void, SfError> {
    const allowed = this.allowed();
    if (!allowed.ok) return allowed;
    this.point = point;
    this.returnTo = options.returnTo;
    this.focusOnOpen = this.filterable ? 'filter' : options.keyboard === true ? 'first' : 'menu';
    if (this.open) this.place();
    this.open = true;
    return ok(undefined);
  }

  hide(returnFocus = true): void {
    this.returnFocus = returnFocus;
    this.open = false;
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    clearTimeout(this.subTimer);
    this.teardown();
  }

  private allowed(): Result<void, SfError> {
    const verdict = this.session.check();
    if (!verdict.ok) {
      emit<OverlayRefusedDetail>(this, 'sf-overlay-refused', { error: verdict.error });
      return err(verdict.error);
    }
    return ok(undefined);
  }

  /** Activate an item: open its submenu, or toggle checkable state, fire `sf-select`, close. */
  activate(item: SfMenuItemElement, via: 'keyboard' | 'pointer' = 'keyboard'): void {
    if (item.disabled) return;
    const sub = item.submenu;
    if (sub !== undefined) {
      this.openSubmenu(item, via === 'keyboard');
      return;
    }
    let checked: boolean | undefined;
    if (item.type === 'checkbox') checked = item.checked = !item.checked;
    else if (item.type === 'radio') {
      for (const other of this.items) if (other.type === 'radio') other.checked = other === item;
      checked = true;
    }
    emit<MenuSelectDetail>(this, 'sf-select', { value: item.value, checked });
    this.hide(!this.isSubmenu);
  }

  private openSubmenu(row: SfMenuItemElement, focusFirst: boolean): void {
    clearTimeout(this.subTimer);
    for (const other of this.items) if (other !== row) other.submenu?.hide(false);
    const sub = row.submenu;
    if (sub === undefined) return;
    sub.anchor = row;
    sub.side = 'inline-end';
    if (sub.open) {
      if (focusFirst) sub.roving.focusItem(0);
      return;
    }
    // A pointer-opened submenu leaves focus where it is (APG); the keyboard moves into it.
    if (sub.show('first').ok && !focusFirst) sub.focusOnOpen = 'none';
  }

  private scheduleSubmenuClose(): void {
    const open = this.items.find((item) => item.submenu?.open === true);
    if (open === undefined) return;
    clearTimeout(this.subTimer);
    this.subTimer = setTimeout(() => open.submenu?.hide(false), SUBMENU_CLOSE_MS);
  }

  private onPointerOver(event: PointerEvent): void {
    if (!this.open || event.pointerType === 'touch') return;
    const path = event.composedPath();
    const item = this.items.find((candidate) => path.includes(candidate));
    if (item === undefined) return;
    // Inside an open submenu (its items are light children of the row): keep it open.
    if (item.submenu?.open === true || this.items.some((row) => row.submenu?.open === true && path.includes(row.submenu))) {
      clearTimeout(this.subTimer);
      return;
    }
    clearTimeout(this.subTimer);
    if (item.submenu !== undefined) this.subTimer = setTimeout(() => this.openSubmenu(item, false), SUBMENU_OPEN_MS);
    else this.scheduleSubmenuClose();
  }

  private onClick(event: MouseEvent): void {
    const path = event.composedPath();
    const trigger = this.trigger;
    if (trigger !== undefined && path.includes(trigger)) {
      if (this.open) this.hide(true);
      // `detail === 0`: a keyboard-generated click (Enter / Space on the trigger) focuses the first row.
      else if (this.show('first').ok && event.detail > 0 && !this.filterable) this.focusOnOpen = 'menu';
      return;
    }
    const item = this.items.find((candidate) => path.includes(candidate) && !path.includes(candidate.submenu as EventTarget));
    if (item !== undefined && item.closest('sf-menu') === this) {
      event.stopPropagation();
      this.activate(item, 'pointer');
    }
  }

  private onKeydown(event: KeyboardEvent): void {
    const path = event.composedPath();
    const trigger = this.trigger;
    if (trigger !== undefined && path.includes(trigger) && !this.open) {
      // Enter / Space reach us as the trigger's click (buttons activate themselves).
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        this.show('first');
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        this.show('last');
      }
      return;
    }
    if (!this.open) return;
    // Keys inside an open submenu belong to it.
    if (this.items.some((row) => row.submenu?.open === true && path.includes(row.submenu))) return;
    const items = this.items;
    const filter = this.renderRoot.querySelector('input');
    if (filter !== null && path[0] === filter) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        this.roving.focusItem(event.key === 'ArrowDown' ? 0 : items.length - 1);
      } else if (event.key === 'Enter' && items.length > 0) {
        event.preventDefault();
        this.activate(items[0] as SfMenuItemElement);
      }
      return;
    }
    const current = items.findIndex((item) => path.includes(item));
    if (current < 0) {
      // The menu itself has focus (opened by pointer): the first arrow key focuses a row.
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        this.roving.focusItem(event.key === 'ArrowDown' ? 0 : items.length - 1);
      }
      return;
    }
    const item = items[current] as SfMenuItemElement;
    if (event.key === 'Enter' || event.key === ' ' || (event.key === 'ArrowRight' && item.submenu !== undefined)) {
      event.preventDefault();
      this.activate(item);
    } else if (event.key === 'ArrowLeft' && this.isSubmenu) {
      event.preventDefault();
      this.hide(false);
      this.parentRow?.focus();
    } else if (event.key === 'Tab') {
      this.hide(false);
    } else if (!this.filterable && event.key.length === 1 && /\S/.test(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const next = typeaheadIndex(
        items.map((i) => i.textLabel),
        current,
        event.key,
      );
      if (next >= 0) this.roving.focusItem(next);
    }
  }

  private onFilterInput(event: Event): void {
    this.query = (event.target as HTMLInputElement).value;
    for (const item of this.allItems) item.hidden = !menuFilterMatch(item.textLabel, this.query);
    for (const group of this.querySelectorAll<HTMLElement>(':scope > sf-menu-group')) {
      group.hidden = ![...group.querySelectorAll<HTMLElement>(':scope > sf-menu-item')].some((item) => !item.hidden);
    }
    this.requestUpdate();
  }

  protected override willUpdate(changed: PropertyValues<this>): void {
    const trigger = this.trigger;
    if (trigger !== undefined) {
      trigger.setAttribute('aria-haspopup', 'menu');
      trigger.setAttribute('aria-expanded', this.open ? 'true' : 'false');
    }
    this.parentRow?.setAttribute('aria-expanded', this.open ? 'true' : 'false');
    if (changed.has('open') && this.open) {
      const view = this.ownerDocument.defaultView;
      this.presentation = this.point === undefined && !this.isSubmenu ? menuPresentation(this.sheet, view?.innerWidth ?? 1024) : 'anchored';
    }
    if (changed.has('open') && changed.get('open') !== undefined) emit(this, 'sf-toggle', { open: this.open });
  }

  protected override updated(changed: PropertyValues<this>): void {
    if (!changed.has('open')) return;
    if (this.open) this.setup();
    else if (changed.get('open') === true) {
      this.teardown();
      if (this.returnFocus) this.focusReturn?.restore();
      this.returnFocus = true;
      this.focusReturn = undefined;
    }
  }

  private place(): void {
    const menu = this.menu;
    if (menu === null) return;
    this.anchored?.stop();
    this.anchored = undefined;
    if (this.presentation === 'sheet') return;
    if (this.point !== undefined) {
      placeAtPoint(menu, this.point);
      return;
    }
    const anchor = this.anchor ?? this.renderRoot.querySelector('.anchor') ?? this;
    const offset = this.isSubmenu ? 2 : OVERLAY_GAP.menu;
    this.anchored = anchorFloating(anchor, menu, { side: this.side, align: this.align, offset }, this.listeners.signal);
  }

  private setup(): void {
    const menu = this.menu;
    if (menu === null) return;
    this.focusReturn = rememberFocusReturn(this.returnTo ?? this.trigger ?? this.parentRow ?? null);
    if (this.presentation === 'sheet') menu.setAttribute('data-sheet', '');
    else menu.removeAttribute('data-sheet');
    openLayer(menu);
    this.place();
    this.session.open();
    const items = this.items;
    if (this.focusOnOpen === 'filter') this.renderRoot.querySelector('input')?.focus();
    else if (this.focusOnOpen === 'menu') this.list?.focus();
    else if (this.focusOnOpen === 'first' || this.focusOnOpen === 'last') this.roving.focusItem(this.focusOnOpen === 'last' ? items.length - 1 : 0);
  }

  private teardown(): void {
    clearTimeout(this.subTimer);
    for (const item of this.allItems) item.submenu?.hide(false);
    this.session.close();
    this.anchored?.stop();
    this.anchored = undefined;
    const menu = this.menu;
    if (menu !== null) {
      closeLayer(menu);
      menu.style.removeProperty('max-block-size');
    }
    if (this.query !== '') {
      this.query = '';
      for (const item of this.allItems) item.hidden = false;
      for (const group of this.querySelectorAll<HTMLElement>(':scope > sf-menu-group')) group.hidden = false;
    }
    this.point = undefined;
    this.returnTo = undefined;
  }

  private onSheetPointerDown(event: PointerEvent): void {
    if (this.presentation !== 'sheet') return;
    const startY = event.clientY;
    const menu = this.menu;
    const done = new AbortController();
    const signal = done.signal;
    this.ownerDocument.addEventListener(
      'pointerup',
      (up) => {
        done.abort();
        if (up.clientY - startY >= SHEET_SWIPE_PX) this.hide(true);
      },
      { signal },
    );
    menu?.addEventListener('pointercancel', () => done.abort(), { signal });
  }

  override render(): TemplateResult {
    const filter = this.filterable
      ? html`<div class="filter"><input type="search" aria-label=${this.filterLabel} placeholder=${this.filterLabel} .value=${this.query} @input=${(e: Event) => this.onFilterInput(e)} /></div>`
      : nothing;
    const empty = this.filterable && this.query !== '' && this.items.length === 0 ? html`<div class="empty" role="status">${this.emptyLabel}</div>` : nothing;
    return html`<span class="anchor"><slot name="trigger"></slot></span>
      <div class="floating menu" part="menu" @pointerdown=${(e: PointerEvent) => this.onSheetPointerDown(e)}>
        ${filter}
        <div class="list" role="menu" aria-label=${this.label || nothing} tabindex="-1"><slot></slot></div>
        ${empty}
      </div>
      <slot name="submenu" @slotchange=${() => this.allItems.forEach((item) => item.requestUpdate())}></slot>`;
  }
}

/**
 * Wire a context menu to a target (OVERLAYS-FEEDBACK §1.5, FOUNDATIONS §4.8): right-click opens at the pointer with
 * nothing focused; `Shift+F10` and the Menu key open at the focused element's corner with the first row focused.
 * Focus returns to the element that opened it (or its landmark when that is gone). Ends with `signal`.
 */
export function bindContextMenu(target: HTMLElement, menu: SfMenuElement, signal: AbortSignal): void {
  const keyboardOpen = (origin: Element): void => {
    const rect = origin.getBoundingClientRect();
    menu.showAt({ x: rect.left, y: rect.bottom }, { keyboard: true, returnTo: origin });
  };
  target.addEventListener(
    'contextmenu',
    (event) => {
      event.preventDefault();
      const origin = (event.composedPath()[0] as Element | undefined) ?? target;
      // The Menu key fires `contextmenu` without pointer coordinates.
      if (event.clientX === 0 && event.clientY === 0) keyboardOpen(origin instanceof Element ? origin : target);
      else menu.showAt({ x: event.clientX, y: event.clientY }, { returnTo: origin instanceof Element ? origin : target });
    },
    { signal },
  );
  target.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'F10' || !event.shiftKey) return;
      event.preventDefault();
      const origin = event.composedPath()[0];
      keyboardOpen(origin instanceof Element ? origin : target);
    },
    { signal },
  );
}

export function defineMenu(registry: CustomElementRegistry = customElements): void {
  defineIconElement(registry);
  if (registry.get(itemSpec.tag) === undefined) defineComponent(SfMenuItemElement, registry);
  if (registry.get(groupSpec.tag) === undefined) defineComponent(SfMenuGroupElement, registry);
  if (registry.get(menuSpec.tag) === undefined) defineComponent(SfMenuElement, registry);
}
