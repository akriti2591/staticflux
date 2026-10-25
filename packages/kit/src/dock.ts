/**
 * Dock and panels — the persistent, docked UI (UX §3: a right dock, resizable,
 * collapsible to an icon rail; panels inside it collapse and resize).
 *
 * - `<sf-dock side="end" label="Inspector" size="320">` — an edge container. A window-
 *   splitter handle (`role="separator"`, `aria-valuenow`) resizes its inline size by pointer
 *   or keyboard (arrows, Shift, Home/End; Enter collapses). Collapsed, it shows the `rail`
 *   slot (icon buttons that reopen tabs) and an expand button. Fires `sf-resize` `{ size }`
 *   and `sf-collapse` `{ collapsed }`; the app persists them (e.g. per workspace).
 * - `<sf-panel label="Layers">` — a collapsible section: the header is a disclosure button
 *   (`aria-expanded`, `aria-controls`) with an `actions` slot beside it; the body is a named
 *   region and a container-query container. `resizable` adds a block-size handle. Fires
 *   `sf-toggle` `{ open }` and `sf-resize` `{ size }`.
 *
 * Logical properties throughout (`side="start|end"` follows the writing direction).
 */
import { I18nToken } from '@staticflux/i18n';
import { component, defineComponent, SfElement } from '@staticflux/ui';
import { css, html, nothing, type TemplateResult } from 'lit';
import { defineIconButton } from './icon-button.js';
import { emit } from './internal/events.js';
import { uniqueId } from './internal/ids.js';
import { ConnectedListeners } from './internal/listeners.js';
import { attachResizeHandle, clampSize } from './internal/resize.js';
import { baseStyles, focusRing, t } from './internal/styles.js';
import { kitMessages, kitText } from './messages.js';

const handleStyles = css`
  .handle {
    position: absolute;
    z-index: ${t.z.raised.css};
    touch-action: none;
    background: transparent;
    transition: background-color ${t.motion.durationFast.css} ${t.motion.easeStandard.css};
  }
  .handle:hover,
  .handle[data-resizing],
  .handle:focus-visible {
    background: ${t.color.accent.css};
    outline: none;
  }
  @media (forced-colors: active) {
    .handle:focus-visible {
      background: Highlight;
    }
  }
`;

// ------------------------------------------------------------------ dock

const dockSpec = component({
  tag: 'sf-dock',
  deps: { lazy: { i18n: I18nToken } },
  placeholder: () => nothing,
  description: 'Edge dock: resizable (window splitter), collapsible to an icon rail.',
});

export class SfDockElement extends SfElement<typeof dockSpec> {
  static override readonly spec = dockSpec;
  static override properties = {
    side: { reflect: true },
    label: {},
    size: { type: Number },
    min: { type: Number },
    max: { type: Number },
    collapsed: { type: Boolean, reflect: true },
  };
  static override styles = [
    baseStyles,
    focusRing,
    handleStyles,
    css`
      :host {
        position: relative;
        display: flex;
        block-size: 100%;
        background: ${t.color.surface1.css};
        border-inline-start: 1px solid ${t.color.border.css};
      }
      :host([side='start']) {
        border-inline-start: 0;
        border-inline-end: 1px solid ${t.color.border.css};
      }
      .body {
        display: flex;
        flex-direction: column;
        min-inline-size: 0;
        overflow: hidden;
      }
      .rail {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: ${t.space.xs.css};
        inline-size: ${t.size.railWidth.css};
        padding-block: ${t.space.sm.css};
      }
      .bar {
        display: flex;
        justify-content: flex-end;
        padding: ${t.space.xs.css};
      }
      .handle {
        inset-block: 0;
        inline-size: 4px;
        cursor: col-resize;
      }
      :host([side='end']) .handle,
      :host(:not([side])) .handle {
        inset-inline-start: -2px;
      }
      :host([side='start']) .handle {
        inset-inline-end: -2px;
      }
    `,
  ];

  declare side: 'start' | 'end';
  declare label: string;
  declare size: number;
  declare min: number;
  declare max: number;
  declare collapsed: boolean;
  private readonly handleListeners: ConnectedListeners;
  private wiredHandle: HTMLElement | undefined;

  constructor() {
    super();
    this.side = 'end';
    this.label = '';
    this.size = 320;
    this.min = 200;
    this.max = 640;
    this.collapsed = false;
    this.handleListeners = new ConnectedListeners(this, () => {
      this.wiredHandle = undefined;
    });
  }

  /** Set the size (clamped) and fire `sf-resize`. */
  resize(size: number): void {
    const next = clampSize(size, this.min, this.max);
    if (next === this.size) return;
    this.size = next;
    emit(this, 'sf-resize', { size: next });
  }

  setCollapsed(collapsed: boolean): void {
    if (collapsed === this.collapsed) return;
    this.collapsed = collapsed;
    emit(this, 'sf-collapse', { collapsed });
  }

  protected override updated(): void {
    const handle = this.renderRoot.querySelector<HTMLElement>('.handle');
    const signal = this.handleListeners.signal;
    if (handle === null || signal === undefined || handle === this.wiredHandle) return;
    this.wiredHandle = handle;
    attachResizeHandle(
      handle,
      {
        edge: () => (this.side === 'start' ? 'inline-end' : 'inline-start'),
        size: () => this.size,
        bounds: () => ({ min: this.min, max: this.max }),
        onResize: (size) => (this.size = size),
        onCommit: (size) => {
          this.size = clampSize(size, this.min, this.max);
          emit(this, 'sf-resize', { size: this.size });
        },
        onToggle: () => this.setCollapsed(!this.collapsed),
      },
      signal,
    );
  }

  override render(): TemplateResult {
    const label = this.label;
    const i18n = this.deps.i18n;
    if (this.collapsed) {
      return html`<div class="rail" part="rail">
        <sf-icon-button label=${kitText(i18n, kitMessages.expandPanel, { label })} tooltip-side=${this.side === 'end' ? 'inline-start' : 'inline-end'} @click=${() => this.setCollapsed(false)}
          ><span aria-hidden="true">${this.side === 'end' ? '‹' : '›'}</span></sf-icon-button
        >
        <slot name="rail"></slot>
      </div>`;
    }
    return html`<div
        class="handle"
        role="separator"
        tabindex="0"
        aria-orientation="vertical"
        aria-label=${kitText(i18n, kitMessages.resizePanel, { label })}
        aria-valuenow=${this.size}
        aria-valuemin=${this.min}
        aria-valuemax=${this.max}
      ></div>
      <div class="body" part="body" style=${`inline-size:${this.size}px`}>
        <div class="bar">
          <slot name="header"></slot>
          <sf-icon-button label=${kitText(i18n, kitMessages.collapsePanel, { label })} size="sm" tooltip-side="block-end" @click=${() => this.setCollapsed(true)}
            ><span aria-hidden="true">${this.side === 'end' ? '›' : '‹'}</span></sf-icon-button
          >
        </div>
        <slot></slot>
      </div>`;
  }
}

// ------------------------------------------------------------------ panel

const panelSpec = component({
  tag: 'sf-panel',
  deps: { lazy: { i18n: I18nToken } },
  placeholder: () => nothing,
  description: 'Collapsible (disclosure) and optionally resizable section inside a dock.',
});

export class SfPanelElement extends SfElement<typeof panelSpec> {
  static override readonly spec = panelSpec;
  static override properties = {
    label: {},
    collapsed: { type: Boolean, reflect: true },
    resizable: { type: Boolean },
    size: { type: Number },
    min: { type: Number },
    max: { type: Number },
  };
  static override styles = [
    baseStyles,
    focusRing,
    handleStyles,
    css`
      :host {
        position: relative;
        display: flex;
        flex-direction: column;
        min-block-size: 0;
        border-block-end: 1px solid ${t.color.border.css};
      }
      :host(:not([collapsed]):not([sized])) {
        flex: 1;
      }
      header {
        display: flex;
        align-items: center;
        gap: ${t.space.xs.css};
        min-block-size: ${t.size.row.css};
        padding-inline: ${t.space.xs.css};
      }
      .toggle {
        all: unset;
        flex: 1;
        display: flex;
        align-items: center;
        gap: ${t.space.xs.css};
        padding-inline: ${t.space.xs.css};
        font-size: ${t.type.sizeSm.css};
        font-weight: ${t.font.weightSemibold.css};
        color: ${t.color.textMuted.css};
        border-radius: ${t.radius.sm.css};
        cursor: pointer;
      }
      .toggle:hover {
        color: ${t.color.text.css};
      }
      .toggle:focus-visible {
        outline: 2px solid ${t.color.focusRing.css};
        outline-offset: 1px;
      }
      .chevron {
        display: inline-block;
        transition: transform ${t.motion.durationFast.css} ${t.motion.easeStandard.css};
      }
      :host([collapsed]) .chevron {
        transform: rotate(-90deg);
      }
      :host(:dir(rtl)[collapsed]) .chevron {
        transform: rotate(90deg);
      }
      .body {
        flex: 1;
        min-block-size: 0;
        overflow: auto;
        container-type: inline-size;
        padding-inline: ${t.space.sm.css};
        padding-block-end: ${t.space.sm.css};
      }
      .handle {
        inset-inline: 0;
        inset-block-end: -2px;
        block-size: 4px;
        cursor: row-resize;
      }
    `,
  ];

  declare label: string;
  declare collapsed: boolean;
  declare resizable: boolean;
  declare size: number;
  declare min: number;
  declare max: number;
  private readonly ids = { header: uniqueId('sf-panel-h'), body: uniqueId('sf-panel-b') };
  private readonly handleListeners: ConnectedListeners;
  private wiredHandle: HTMLElement | undefined;

  constructor() {
    super();
    this.label = '';
    this.collapsed = false;
    this.resizable = false;
    this.size = 240;
    this.min = 96;
    this.max = 800;
    this.handleListeners = new ConnectedListeners(this, () => {
      this.wiredHandle = undefined;
    });
  }

  toggle(): void {
    this.collapsed = !this.collapsed;
    emit(this, 'sf-toggle', { open: !this.collapsed });
  }

  protected override updated(): void {
    this.toggleAttribute('sized', this.resizable && !this.collapsed);
    this.style.blockSize = this.resizable && !this.collapsed ? `${this.size}px` : '';
    const handle = this.renderRoot.querySelector<HTMLElement>('.handle');
    const signal = this.handleListeners.signal;
    if (handle === null || signal === undefined || handle === this.wiredHandle) return;
    this.wiredHandle = handle;
    attachResizeHandle(
      handle,
      {
        edge: () => 'block-end',
        size: () => this.size,
        bounds: () => ({ min: this.min, max: this.max }),
        onResize: (size) => (this.size = size),
        onCommit: (size) => {
          this.size = clampSize(size, this.min, this.max);
          emit(this, 'sf-resize', { size: this.size });
        },
        onToggle: () => this.toggle(),
      },
      signal,
    );
  }

  override render(): TemplateResult {
    return html`<header part="header">
        <button class="toggle" id=${this.ids.header} aria-expanded=${this.collapsed ? 'false' : 'true'} aria-controls=${this.ids.body} @click=${() => this.toggle()}>
          <span class="chevron" aria-hidden="true">▾</span>${this.label}
        </button>
        <slot name="actions"></slot>
      </header>
      <div class="body" part="body" id=${this.ids.body} role="region" aria-labelledby=${this.ids.header} ?hidden=${this.collapsed}><slot></slot></div>
      ${this.resizable && !this.collapsed
        ? html`<div
            class="handle"
            role="separator"
            tabindex="0"
            aria-orientation="horizontal"
            aria-label=${kitText(this.deps.i18n, kitMessages.resizePanel, { label: this.label })}
            aria-valuenow=${this.size}
            aria-valuemin=${this.min}
            aria-valuemax=${this.max}
          ></div>`
        : nothing}`;
  }
}

export function defineDock(registry: CustomElementRegistry = customElements): void {
  defineIconButton(registry);
  if (registry.get(dockSpec.tag) === undefined) defineComponent(SfDockElement, registry);
  if (registry.get(panelSpec.tag) === undefined) defineComponent(SfPanelElement, registry);
}
