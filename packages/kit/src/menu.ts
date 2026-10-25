/**
 * `<sf-menu label="Insert">` + `<sf-menu-item>` — WAI-ARIA APG menu button:
 *
 * - the `trigger` slot gets `aria-haspopup="menu"` + `aria-expanded`; Enter / Space /
 *   ArrowDown open on the first item, ArrowUp on the last; click toggles;
 * - in the menu: ArrowUp/Down (wrapping), Home/End, type-ahead by first letter, Enter /
 *   Space activate, Escape closes and returns focus to the trigger, Tab closes;
 * - items: `type="item|checkbox|radio"` (`menuitem`, `menuitemcheckbox`, `menuitemradio`
 *   with `aria-checked`), `disabled`, `shortcut` (visible `<kbd>` + `aria-keyshortcuts`).
 *
 * Activation fires `sf-select` with `{ value, checked }` on the menu, then closes it.
 * The popup is in the top layer and anchored (CSS anchor positioning or JS fallback).
 */
import { component, defineComponent, SfElement } from '@staticflux/ui';
import { css, html, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { type AnchorHandle, anchorFloating, type Align, type Side } from './position.js';
import { emit } from './internal/events.js';
import { ConnectedListeners } from './internal/listeners.js';
import { closeLayer, lightDismiss, openLayer } from './internal/layer.js';
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

// ------------------------------------------------------------------ item

const itemSpec = component({
  tag: 'sf-menu-item',
  placeholder: () => html`<slot></slot>`,
  description: 'Menu item (menuitem / menuitemcheckbox / menuitemradio) with optional shortcut hint.',
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
      :host(:focus) {
        background: ${t.color.surfaceHover.css};
      }
      :host(:focus-visible) {
        outline: 2px solid ${t.color.focusRing.css};
        outline-offset: -2px;
      }
      :host([disabled]) {
        color: ${t.color.textDisabled.css};
      }
      .check {
        inline-size: ${t.size.icon.css};
        text-align: center;
        color: ${t.color.accentText.css};
      }
      .label {
        flex: 1;
      }
      kbd {
        font-family: ${t.font.familyMono.css};
        font-size: ${t.type.sizeXs.css};
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

  constructor() {
    super();
    this.value = '';
    this.type = 'item';
    this.checked = false;
    this.disabled = false;
    this.shortcut = undefined;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.setAttribute('tabindex', '-1');
  }

  /** The text used for type-ahead. */
  get textLabel(): string {
    return (this.textContent ?? '').trim();
  }

  protected override willUpdate(changed: PropertyValues<this>): void {
    this.setAttribute('role', ROLES[this.type]);
    if (this.type === 'item') this.removeAttribute('aria-checked');
    else this.setAttribute('aria-checked', this.checked ? 'true' : 'false');
    if (this.disabled) this.setAttribute('aria-disabled', 'true');
    else this.removeAttribute('aria-disabled');
    if (changed.has('shortcut')) {
      if (this.shortcut === undefined || this.shortcut === '') this.removeAttribute('aria-keyshortcuts');
      else this.setAttribute('aria-keyshortcuts', ariaKeyShortcuts(this.shortcut, this.ownerDocument));
    }
  }

  override render(): TemplateResult {
    const mark = this.type === 'item' ? nothing : html`<span class="check" aria-hidden="true">${this.checked ? (this.type === 'radio' ? '●' : '✓') : ''}</span>`;
    const hint = this.shortcut === undefined || this.shortcut === '' ? nothing : html`<kbd aria-hidden="true">${shortcutLabel(this.shortcut, this.ownerDocument)}</kbd>`;
    return html`${mark}<slot name="start"></slot><span class="label"><slot></slot></span>${hint}`;
  }
}

// ------------------------------------------------------------------ menu

const menuSpec = component({
  tag: 'sf-menu',
  placeholder: () => html`<slot name="trigger"></slot>`,
  description: 'Menu button (APG): trigger + top-layer menu with roving focus, type-ahead, light dismiss.',
});

export class SfMenuElement extends SfElement<typeof menuSpec> {
  static override readonly spec = menuSpec;
  static override properties = {
    open: { type: Boolean, reflect: true },
    label: {},
    side: {},
    align: {},
  };
  static override styles = [
    baseStyles,
    floatingStyles,
    css`
      :host {
        display: inline-block;
      }
      .anchor {
        display: inline-flex;
      }
      .menu {
        min-inline-size: 180px;
        max-block-size: min(420px, calc(100vh - 16px));
        overflow: auto;
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
  private anchored: AnchorHandle | undefined;
  private dismiss: AbortController | undefined;
  private focusOnOpen: 'first' | 'last' = 'first';
  private returnFocus = true;
  private readonly roving: RovingFocusController;
  private readonly listeners: ConnectedListeners;

  constructor() {
    super();
    this.open = false;
    this.label = '';
    this.side = 'block-end';
    this.align = 'start';
    this.roving = new RovingFocusController(this, { items: () => this.items, orientation: 'vertical' });
    this.listeners = new ConnectedListeners(this, (signal) => {
      this.addEventListener('click', (event) => this.onClick(event), { signal });
      this.addEventListener('keydown', (event) => this.onKeydown(event), { signal });
    });
  }

  get trigger(): HTMLElement | undefined {
    return this.querySelector<HTMLElement>(':scope > [slot="trigger"]') ?? undefined;
  }

  /** Enabled menu items, in order. */
  get items(): SfMenuItemElement[] {
    return [...this.querySelectorAll<SfMenuItemElement>(':scope > sf-menu-item')].filter((item) => !isRovingDisabled(item));
  }

  get menu(): HTMLElement | null {
    return this.renderRoot.querySelector<HTMLElement>('.menu');
  }

  /** Open with focus on the first (default) or last item. */
  show(focus: 'first' | 'last' = 'first'): void {
    this.focusOnOpen = focus;
    this.open = true;
  }

  hide(returnFocus = true): void {
    this.returnFocus = returnFocus;
    this.open = false;
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.teardown();
  }

  /** Activate an item: toggle checkable state, fire `sf-select`, close. */
  activate(item: SfMenuItemElement): void {
    if (item.disabled) return;
    let checked: boolean | undefined;
    if (item.type === 'checkbox') checked = item.checked = !item.checked;
    else if (item.type === 'radio') {
      for (const other of this.items) if (other.type === 'radio') other.checked = other === item;
      checked = true;
    }
    emit<MenuSelectDetail>(this, 'sf-select', { value: item.value, checked });
    this.hide(true);
  }

  private onClick(event: MouseEvent): void {
    const path = event.composedPath();
    const trigger = this.trigger;
    if (trigger !== undefined && path.includes(trigger)) {
      if (this.open) this.hide(true);
      else this.show('first');
      return;
    }
    const item = this.items.find((candidate) => path.includes(candidate));
    if (item !== undefined) this.activate(item);
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
    const items = this.items;
    const current = items.findIndex((item) => path.includes(item));
    if (current < 0) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      this.activate(items[current] as SfMenuItemElement);
    } else if (event.key === 'Tab') {
      this.hide(false);
    } else if (event.key.length === 1 && /\S/.test(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const next = typeaheadIndex(
        items.map((i) => i.textLabel),
        current,
        event.key,
      );
      if (next >= 0) this.roving.focusItem(next);
    }
  }

  protected override willUpdate(changed: PropertyValues<this>): void {
    const trigger = this.trigger;
    if (trigger !== undefined) {
      trigger.setAttribute('aria-haspopup', 'menu');
      trigger.setAttribute('aria-expanded', this.open ? 'true' : 'false');
    }
    if (changed.has('open') && changed.get('open') !== undefined) emit(this, 'sf-toggle', { open: this.open });
  }

  protected override updated(changed: PropertyValues<this>): void {
    if (!changed.has('open')) return;
    if (this.open) this.setup();
    else if (changed.get('open') === true) {
      this.teardown();
      if (this.returnFocus) this.trigger?.focus();
      this.returnFocus = true;
    }
  }

  private setup(): void {
    const menu = this.menu;
    if (menu === null) return;
    openLayer(menu);
    this.anchored = anchorFloating(this.renderRoot.querySelector('.anchor') ?? this, menu, { side: this.side, align: this.align }, this.listeners.signal);
    this.dismiss = new AbortController();
    lightDismiss(() => [this], (cause) => this.hide(cause === 'escape'), this.ownerDocument, this.dismiss.signal);
    const items = this.items;
    this.roving.focusItem(this.focusOnOpen === 'last' ? items.length - 1 : 0);
  }

  private teardown(): void {
    this.dismiss?.abort();
    this.dismiss = undefined;
    this.anchored?.stop();
    this.anchored = undefined;
    const menu = this.menu;
    if (menu !== null) closeLayer(menu);
  }

  override render(): TemplateResult {
    return html`<span class="anchor"><slot name="trigger"></slot></span>
      <div class="floating menu" part="menu" role="menu" aria-label=${this.label || nothing}><slot></slot></div>`;
  }
}

export function defineMenu(registry: CustomElementRegistry = customElements): void {
  if (registry.get(itemSpec.tag) === undefined) defineComponent(SfMenuItemElement, registry);
  if (registry.get(menuSpec.tag) === undefined) defineComponent(SfMenuElement, registry);
}
