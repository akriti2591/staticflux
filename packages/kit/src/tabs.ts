/**
 * `<sf-tabs>` + `<sf-tab>` + `<sf-tab-panel>` — WAI-ARIA APG tabs.
 *
 * Tabs and panels are light-DOM children (so `aria-controls` / `aria-labelledby` resolve
 * in one tree); the tablist wrapper is in the shadow root. One tab is in the tab order;
 * arrows (RTL-aware; ArrowUp/Down when `orientation="vertical"`), Home/End move;
 * `activation="auto"` (default) selects on focus, `"manual"` on Enter/Space/click.
 * Panels are optional (tabs can drive view state elsewhere). Fires `sf-change` `{ value }`.
 *
 * ```html
 * <sf-tabs label="Document views" .value=${tab} @sf-change=${…}>
 *   <sf-tab value="content">Content</sf-tab><sf-tab value="comments">Comments</sf-tab>
 *   <sf-tab-panel value="content">…</sf-tab-panel>
 * </sf-tabs>
 * ```
 */
import { component, defineComponent, SfElement } from '@staticflux/ui';
import { css, html, nothing, type TemplateResult } from 'lit';
import { emit } from './internal/events.js';
import { uniqueId } from './internal/ids.js';
import { ConnectedListeners } from './internal/listeners.js';
import { baseStyles, focusRing, t } from './internal/styles.js';
import { isRovingDisabled, RovingFocusController } from './roving.js';

// ------------------------------------------------------------------ tab

const tabSpec = component({ tag: 'sf-tab', placeholder: () => html`<slot></slot>`, description: 'A tab (role=tab) inside <sf-tabs>.' });

export class SfTabElement extends SfElement<typeof tabSpec> {
  static override readonly spec = tabSpec;
  static override properties = { value: { reflect: true }, disabled: { type: Boolean, reflect: true } };
  static override styles = [
    baseStyles,
    focusRing,
    css`
      :host {
        position: relative;
        display: inline-flex;
        align-items: center;
        gap: ${t.space.xs.css};
        min-block-size: ${t.size.control.css};
        padding-inline: ${t.space.md.css};
        color: ${t.color.textMuted.css};
        font-weight: ${t.font.weightMedium.css};
        cursor: pointer;
        user-select: none;
        border-radius: ${t.radius.sm.css};
        transition: color ${t.motion.durationFast.css} ${t.motion.easeStandard.css};
      }
      :host(:hover) {
        color: ${t.color.text.css};
      }
      :host([aria-selected='true']) {
        color: ${t.color.text.css};
      }
      :host::after {
        content: '';
        position: absolute;
        inset-inline: ${t.space.sm.css};
        inset-block-end: -1px;
        block-size: 2px;
        border-radius: 1px;
        background: transparent;
        transition: background-color ${t.motion.durationNormal.css} ${t.motion.easeStandard.css};
      }
      :host([aria-selected='true'])::after {
        background: ${t.color.accent.css};
      }
      :host([disabled]) {
        color: ${t.color.textDisabled.css};
        cursor: not-allowed;
      }
      @media (forced-colors: active) {
        :host([aria-selected='true'])::after {
          background: Highlight;
        }
      }
    `,
  ];

  declare value: string;
  declare disabled: boolean;

  constructor() {
    super();
    this.value = '';
    this.disabled = false;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.slot = 'tab';
    this.setAttribute('role', 'tab');
    if (this.id === '') this.id = uniqueId('sf-tab');
  }

  override render(): TemplateResult {
    return html`<slot></slot>`;
  }
}

// ------------------------------------------------------------------ panel

const panelSpec = component({ tag: 'sf-tab-panel', placeholder: () => nothing, description: 'A tab panel (role=tabpanel) inside <sf-tabs>.' });

export class SfTabPanelElement extends SfElement<typeof panelSpec> {
  static override readonly spec = panelSpec;
  static override properties = { value: { reflect: true } };
  static override styles = [
    baseStyles,
    focusRing,
    css`
      :host {
        display: block;
      }
    `,
  ];

  declare value: string;

  constructor() {
    super();
    this.value = '';
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.setAttribute('role', 'tabpanel');
    if (this.id === '') this.id = uniqueId('sf-tab-panel');
  }

  override render(): TemplateResult {
    return html`<slot></slot>`;
  }
}

// ------------------------------------------------------------------ tabs

const tabsSpec = component({ tag: 'sf-tabs', placeholder: () => nothing, description: 'Tabs (APG): tablist, roving focus, auto/manual activation, optional panels.' });

export class SfTabsElement extends SfElement<typeof tabsSpec> {
  static override readonly spec = tabsSpec;
  static override properties = {
    value: {},
    label: {},
    activation: {},
    orientation: { reflect: true },
  };
  static override styles = [
    baseStyles,
    css`
      :host {
        display: block;
      }
      [role='tablist'] {
        display: flex;
        gap: ${t.space.xs.css};
        border-block-end: 1px solid ${t.color.border.css};
        overflow-x: auto;
        scrollbar-width: none;
      }
      :host([orientation='vertical']) {
        display: grid;
        grid-template-columns: auto 1fr;
      }
      :host([orientation='vertical']) [role='tablist'] {
        flex-direction: column;
        border-block-end: 0;
        border-inline-end: 1px solid ${t.color.border.css};
      }
    `,
  ];

  declare value: string;
  declare label: string;
  declare activation: 'auto' | 'manual';
  declare orientation: 'horizontal' | 'vertical';
  private readonly roving: RovingFocusController;

  constructor() {
    super();
    this.value = '';
    this.label = '';
    this.activation = 'auto';
    this.orientation = 'horizontal';
    this.roving = new RovingFocusController(this, {
      items: () => this.tabs,
      orientation: () => this.orientation,
      initial: () => this.tabs.findIndex((tab) => tab.value === this.value),
      onMove: (item) => {
        if (this.activation === 'auto') this.select((item as SfTabElement).value);
      },
    });
    new ConnectedListeners(this, (signal) => {
      this.addEventListener(
        'click',
        (event) => {
          const tab = this.tabs.find((candidate) => event.composedPath().includes(candidate));
          if (tab !== undefined) this.select(tab.value);
        },
        { signal },
      );
      this.addEventListener(
        'keydown',
        (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          const tab = this.tabs.find((candidate) => event.composedPath().includes(candidate));
          if (tab === undefined) return;
          event.preventDefault();
          this.select(tab.value);
        },
        { signal },
      );
    });
  }

  get tabs(): SfTabElement[] {
    return [...this.querySelectorAll<SfTabElement>(':scope > sf-tab')];
  }

  get panels(): SfTabPanelElement[] {
    return [...this.querySelectorAll<SfTabPanelElement>(':scope > sf-tab-panel')];
  }

  /** Select a tab by value (disabled tabs are ignored); fires `sf-change`. */
  select(value: string): void {
    const tab = this.tabs.find((candidate) => candidate.value === value);
    if (tab === undefined || isRovingDisabled(tab) || value === this.value) return;
    this.value = value;
    this.roving.reset();
    emit(this, 'sf-change', { value });
  }

  protected override updated(): void {
    this.syncChildren();
  }

  private syncChildren(): void {
    const panels = this.panels;
    for (const tab of this.tabs) {
      const selected = tab.value === this.value;
      tab.setAttribute('aria-selected', selected ? 'true' : 'false');
      if (tab.disabled) tab.setAttribute('aria-disabled', 'true');
      else tab.removeAttribute('aria-disabled');
      const panel = panels.find((p) => p.value === tab.value);
      if (panel === undefined) tab.removeAttribute('aria-controls');
      else {
        tab.setAttribute('aria-controls', panel.id);
        panel.setAttribute('aria-labelledby', tab.id);
        panel.hidden = !selected;
        panel.setAttribute('tabindex', '0');
      }
    }
    this.roving.sync();
  }

  override render(): TemplateResult {
    return html`<div role="tablist" part="tablist" aria-label=${this.label || nothing} aria-orientation=${this.orientation === 'vertical' ? 'vertical' : nothing}>
        <slot name="tab" @slotchange=${() => this.syncChildren()}></slot>
      </div>
      <slot @slotchange=${() => this.syncChildren()}></slot>`;
  }
}

export function defineTabs(registry: CustomElementRegistry = customElements): void {
  if (registry.get(tabSpec.tag) === undefined) defineComponent(SfTabElement, registry);
  if (registry.get(panelSpec.tag) === undefined) defineComponent(SfTabPanelElement, registry);
  if (registry.get(tabsSpec.tag) === undefined) defineComponent(SfTabsElement, registry);
}
