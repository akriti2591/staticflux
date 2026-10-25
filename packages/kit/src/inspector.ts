/**
 * Inspector (UX §3 "Properties", Pro density): precise values in labelled rows.
 *
 * - `<sf-inspector-group label="Layout">` — a collapsible group (disclosure button +
 *   region) whose body is a container-query container.
 * - `<sf-inspector-row label="Width">` — label | control grid; stacks below 240 px of group
 *   width (container query). The row names its slotted control: a kit field gets the row
 *   label as its (visually hidden) label, any other control gets `aria-label` unless it is
 *   already named. `hint` shows a muted line (e.g. "inherited from Brand kit" — UX `explain`).
 */
import { component, defineComponent, SfElement } from '@staticflux/ui';
import { css, html, nothing, type TemplateResult } from 'lit';
import { emit } from './internal/events.js';
import { uniqueId } from './internal/ids.js';
import { baseStyles, t } from './internal/styles.js';

/** Give `control` an accessible name from a row label (kit fields: `label` + `labelHidden`). */
export function nameControl(control: Element, label: string): void {
  if (label === '') return;
  const field = control as Element & { label?: unknown; labelHidden?: unknown };
  if ('label' in field && 'labelHidden' in field) {
    if (field.label === '' || field.label === undefined) {
      field.label = label;
      field.labelHidden = true;
    }
    return;
  }
  if (control.hasAttribute('aria-label') || control.hasAttribute('aria-labelledby')) return;
  // Plain text (a <span>, <div> or <p> without a role) is not a control: naming it is prohibited (WAI-ARIA) and would
  // hide its visible text from screen readers.
  if (!canBeNamed(control)) return;
  control.setAttribute('aria-label', label);
}

const NAMEABLE_TAGS = new Set(['input', 'select', 'textarea', 'button', 'a', 'img', 'meter', 'progress', 'output']);
const NAME_PROHIBITED_ROLES = new Set(['generic', 'paragraph', 'presentation', 'none', 'caption', 'code', 'emphasis', 'strong', 'deletion', 'insertion', 'subscript', 'superscript']);

function canBeNamed(control: Element): boolean {
  const role = control.getAttribute('role')?.trim().split(/\s+/)[0];
  if (role !== undefined && role !== '') return !NAME_PROHIBITED_ROLES.has(role);
  return NAMEABLE_TAGS.has(control.localName) || control.localName.includes('-');
}

// ------------------------------------------------------------------ group

const groupSpec = component({ tag: 'sf-inspector-group', placeholder: () => nothing, description: 'Collapsible inspector group.' });

export class SfInspectorGroupElement extends SfElement<typeof groupSpec> {
  static override readonly spec = groupSpec;
  static override properties = { label: {}, collapsed: { type: Boolean, reflect: true } };
  static override styles = [
    baseStyles,
    css`
      :host {
        display: block;
        border-block-end: 1px solid ${t.color.border.css};
      }
      .toggle {
        all: unset;
        box-sizing: border-box;
        display: flex;
        align-items: center;
        gap: ${t.space.xs.css};
        inline-size: 100%;
        min-block-size: ${t.size.row.css};
        padding-inline: ${t.space.sm.css};
        font-size: ${t.type.sizeSm.css};
        font-weight: ${t.font.weightSemibold.css};
        color: ${t.color.text.css};
        cursor: pointer;
      }
      .toggle:focus-visible {
        outline: 2px solid ${t.color.focusRing.css};
        outline-offset: -2px;
      }
      .chevron {
        color: ${t.color.textMuted.css};
        transition: transform ${t.motion.durationFast.css} ${t.motion.easeStandard.css};
      }
      :host([collapsed]) .chevron {
        transform: rotate(-90deg);
      }
      .body {
        container-type: inline-size;
        display: grid;
        gap: ${t.space.xs.css};
        padding-inline: ${t.space.sm.css};
        padding-block-end: ${t.space.sm.css};
      }
    `,
  ];

  declare label: string;
  declare collapsed: boolean;
  private readonly ids = { header: uniqueId('sf-ig-h'), body: uniqueId('sf-ig-b') };

  constructor() {
    super();
    this.label = '';
    this.collapsed = false;
  }

  toggle(): void {
    this.collapsed = !this.collapsed;
    emit(this, 'sf-toggle', { open: !this.collapsed });
  }

  override render(): TemplateResult {
    return html`<button class="toggle" id=${this.ids.header} aria-expanded=${this.collapsed ? 'false' : 'true'} aria-controls=${this.ids.body} @click=${() => this.toggle()}>
        <span class="chevron" aria-hidden="true">▾</span>${this.label}
      </button>
      <div class="body" id=${this.ids.body} role="group" aria-labelledby=${this.ids.header} ?hidden=${this.collapsed}><slot></slot></div>`;
  }
}

// ------------------------------------------------------------------ row

const rowSpec = component({ tag: 'sf-inspector-row', placeholder: () => html`<slot></slot>`, description: 'Inspector row: label | control (stacks in narrow groups).' });

export class SfInspectorRowElement extends SfElement<typeof rowSpec> {
  static override readonly spec = rowSpec;
  static override properties = { label: {}, hint: {} };
  static override styles = [
    baseStyles,
    css`
      :host {
        display: grid;
        grid-template-columns: minmax(64px, 36%) minmax(0, 1fr);
        align-items: center;
        column-gap: ${t.space.sm.css};
        min-block-size: ${t.size.row.css};
      }
      .label {
        font-size: ${t.type.sizeSm.css};
        color: ${t.color.textMuted.css};
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .control {
        display: flex;
        gap: ${t.space.xs.css};
        min-inline-size: 0;
      }
      .control ::slotted(*) {
        flex: 1;
        min-inline-size: 0;
      }
      .hint {
        grid-column: 2;
        font-size: ${t.type.sizeXs.css};
        color: ${t.color.textMuted.css};
      }
      @container (max-width: 240px) {
        :host {
          grid-template-columns: minmax(0, 1fr);
          row-gap: 2px;
        }
        .hint {
          grid-column: 1;
        }
      }
    `,
  ];

  declare label: string;
  declare hint: string;

  constructor() {
    super();
    this.label = '';
    this.hint = '';
  }

  private nameSlotted(event: Event): void {
    const slot = event.target as HTMLSlotElement;
    for (const control of slot.assignedElements()) nameControl(control, this.label);
  }

  protected override updated(): void {
    const slot = this.renderRoot.querySelector('slot');
    if (slot !== null) for (const control of slot.assignedElements()) nameControl(control, this.label);
  }

  override render(): TemplateResult {
    // The visible label is decorative: the control carries the name (ids cannot cross the shadow boundary).
    return html`<span class="label" part="label" aria-hidden="true" title=${this.label}>${this.label}</span>
      <div class="control" part="control"><slot @slotchange=${(e: Event) => this.nameSlotted(e)}></slot></div>
      ${this.hint === '' ? nothing : html`<span class="hint" part="hint">${this.hint}</span>`}`;
  }
}

export function defineInspector(registry: CustomElementRegistry = customElements): void {
  if (registry.get(groupSpec.tag) === undefined) defineComponent(SfInspectorGroupElement, registry);
  if (registry.get(rowSpec.tag) === undefined) defineComponent(SfInspectorRowElement, registry);
}
