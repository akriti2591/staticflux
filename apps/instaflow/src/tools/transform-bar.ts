/**
 * `<if-transform-bar>` — the numeric transform bar (Instaflow M1c B10a; IF-34.8–34.12), built only from
 * `@staticflux/kit` components under the Clean Pop theme: X, Y, W and H, the angle and the skew of the selection,
 * a linked W/H toggle, Flip horizontal / vertical, and Apply / Cancel while a transform session is active. Main thread
 * only (Lit); it renders a `TransformBarModel` (the editor's `TransformMirror`) and fires `if-transform-edit` with a
 * `TransformEdit` and `if-transform-session` with `commit` or `cancel`; the editor turns each edit into one undo step,
 * or one step of the active session.
 *
 * Keyboard first: every control is a kit control in visual order. In a number field Enter (or leaving it) applies the
 * typed value; ArrowUp / ArrowDown step it by 1 (Shift: 10) and apply at once; the toggle and buttons are kit buttons.
 *
 * The contribution: `transformBarPanel` (`instaflow/transform`, inspector column, Canvas lens, selection scope); the
 * host binds its model with `bindTransformBar`.
 */
import { defineButton } from '@staticflux/kit/button';
import { defineIconButton } from '@staticflux/kit/icon-button';
import { defineInspector } from '@staticflux/kit/inspector';
import { defineTextField } from '@staticflux/kit/text-field';
import { component, defineComponent, SfElement } from '@staticflux/ui';
import { themeTokens as t } from '@staticflux/ui/theme';
import { css, html, nothing, type TemplateResult } from 'lit';
import { definePanel, type PanelContribution } from '../spec/contributions.js';
import { StudioIds } from '../spec/studio-ids.js';
import type { TransformBarModel } from '../workers/mirrors.js';
import type { FlipAxis, NumericField, TransformEdit } from './free-transform.js';

export const TRANSFORM_EDIT_EVENT = 'if-transform-edit';
export const TRANSFORM_SESSION_EVENT = 'if-transform-session';
export type TransformSessionAction = 'commit' | 'cancel';

const spec = component({ tag: 'if-transform-bar', placeholder: () => nothing, description: 'Numeric transform bar (Instaflow B10a).' });

/** The bar's fields in visual order: row label, accessible name, unit (data, rule 4). */
export const TRANSFORM_BAR_FIELDS: readonly { readonly field: NumericField; readonly label: string; readonly name: string; readonly unit: string }[] = Object.freeze([
  { field: 'x', label: 'X', name: 'X position', unit: '' },
  { field: 'y', label: 'Y', name: 'Y position', unit: '' },
  { field: 'w', label: 'W', name: 'Width', unit: '' },
  { field: 'h', label: 'H', name: 'Height', unit: '' },
  { field: 'rotation', label: 'Angle', name: 'Angle', unit: '°' },
  { field: 'skew', label: 'Skew', name: 'Skew', unit: '°' },
]);

/** Arrow-key steps in a field (Shift: large). */
export const FIELD_STEPS = Object.freeze({ small: 1, large: 10 });

/** A typed value as a number (units and spaces ignored; undefined when it is not one). */
export function parseNumber(value: string): number | undefined {
  const trimmed = value.trim().replace(/(px|°|deg)$/u, '').trim();
  if (trimmed === '') return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : undefined;
}

/** How a value is shown (two decimals at most). */
export function formatNumber(value: number, unit: string): string {
  return `${Math.round(value * 100) / 100}${unit}`;
}

const ARROW_STEPS: Readonly<Record<string, number>> = Object.freeze({ ArrowUp: 1, ArrowDown: -1 });

export class IfTransformBarElement extends SfElement<typeof spec> {
  static override readonly spec = spec;
  static override properties = { model: { attribute: false }, linked: { type: Boolean } };
  static override styles = css`
    :host {
      display: block;
      font-family: ${t.font.family.css};
      color: ${t.color.text.css};
    }
    .grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      column-gap: ${t.space.xs.css};
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: ${t.space.xs.css};
      padding-block-start: ${t.space.xs.css};
    }
    .muted {
      font-size: ${t.type.sizeXs.css};
      color: ${t.color.textMuted.css};
    }
  `;

  declare model: TransformBarModel | undefined;
  /** W and H keep their ratio (panel state; never in the document). */
  declare linked: boolean;

  constructor() {
    super();
    this.model = undefined;
    this.linked = false;
  }

  private edit(edit: TransformEdit): void {
    this.dispatchEvent(new CustomEvent<TransformEdit>(TRANSFORM_EDIT_EVENT, { detail: edit, bubbles: true, composed: true }));
  }

  private session(action: TransformSessionAction): void {
    this.dispatchEvent(new CustomEvent<TransformSessionAction>(TRANSFORM_SESSION_EVENT, { detail: action, bubbles: true, composed: true }));
  }

  private set(field: NumericField, value: number): void {
    this.edit({ field, value, ...(this.linked ? { linked: true } : {}) });
  }

  private flip(axis: FlipAxis): void {
    this.edit({ flip: axis });
  }

  private field(model: TransformBarModel, f: (typeof TRANSFORM_BAR_FIELDS)[number]): TemplateResult {
    const value = model[f.field];
    return html`<sf-inspector-row label=${f.label}>
      <sf-text-field
        label=${f.name}
        label-hidden
        size="sm"
        data-field=${f.field}
        value=${formatNumber(value, f.unit)}
        @sf-change=${(e: CustomEvent<{ value: string }>) => {
          const n = parseNumber(e.detail.value);
          if (n !== undefined && Math.abs(n - value) > 1e-9) this.set(f.field, n);
        }}
        @keydown=${(e: KeyboardEvent) => {
          const step = ARROW_STEPS[e.key];
          if (step === undefined) return;
          e.preventDefault();
          this.set(f.field, value + step * (e.shiftKey ? FIELD_STEPS.large : FIELD_STEPS.small));
        }}
      ></sf-text-field>
    </sf-inspector-row>`;
  }

  override render(): TemplateResult {
    const model = this.model;
    if (model === undefined) return html`<p class="muted">Select an element to transform it.</p>`;
    const count = model.nodes.length;
    return html`<sf-inspector-group label="Transform">
      <div class="grid">${TRANSFORM_BAR_FIELDS.map((f) => this.field(model, f))}</div>
      <div class="actions">
        <sf-icon-button label="Link width and height" size="sm" .pressed=${this.linked} @click=${() => (this.linked = !this.linked)}>⛓</sf-icon-button>
        <sf-button size="sm" variant="ghost" @click=${() => this.flip('horizontal')}>Flip horizontal</sf-button>
        <sf-button size="sm" variant="ghost" @click=${() => this.flip('vertical')}>Flip vertical</sf-button>
      </div>
      ${model.transforming
        ? html`<div class="actions" role="group" aria-label="Free transform">
            <sf-button size="sm" variant="ghost" @click=${() => this.session('cancel')}>Cancel</sf-button>
            <sf-button size="sm" @click=${() => this.session('commit')}>Apply</sf-button>
          </div>`
        : nothing}
      <span class="muted"
        >${count === 1 ? '1 element' : `${count} elements`}${model.locked > 0 ? ` · ${model.locked} locked` : ''}${model.transforming ? ' · Free transform: Enter applies, Escape cancels' : ''}</span
      >
    </sf-inspector-group>`;
  }
}

/** What the host gives the bar: the model, change notifications and the sinks. */
export interface TransformBarSource {
  model(): TransformBarModel | undefined;
  subscribe(listener: () => void): () => void;
  apply(edit: TransformEdit): void;
  session(action: TransformSessionAction): void;
}

/** Bind a mounted `<if-transform-bar>` to a source (model in, edits out). Returns the unbind function. */
export function bindTransformBar(element: IfTransformBarElement, source: TransformBarSource): () => void {
  const refresh = (): void => {
    element.model = source.model();
  };
  const onEdit = (event: Event): void => source.apply((event as CustomEvent<TransformEdit>).detail);
  const onSession = (event: Event): void => source.session((event as CustomEvent<TransformSessionAction>).detail);
  refresh();
  const stop = source.subscribe(refresh);
  element.addEventListener(TRANSFORM_EDIT_EVENT, onEdit);
  element.addEventListener(TRANSFORM_SESSION_EVENT, onSession);
  return () => {
    stop();
    element.removeEventListener(TRANSFORM_EDIT_EVENT, onEdit);
    element.removeEventListener(TRANSFORM_SESSION_EVENT, onSession);
  };
}

/** Define the bar element and the kit components it uses. */
export function defineTransformBar(registry: CustomElementRegistry = customElements): void {
  defineButton(registry);
  defineIconButton(registry);
  defineTextField(registry);
  defineInspector(registry);
  if (registry.get(spec.tag) === undefined) defineComponent(IfTransformBarElement, registry);
}

/** The numeric transform bar (inspector column, first on a selection); the host binds it with `bindTransformBar`. */
export const transformBarPanel: PanelContribution = definePanel({
  id: StudioIds.panel.transform,
  label: 'Transform',
  description: 'X, Y, W, H, angle and skew of the selection; linked W/H; flips; Apply / Cancel in Free transform.',
  placements: ['inspector'],
  lenses: [StudioIds.lens.canvas],
  scopes: ['selection'],
  render: () => html`<if-transform-bar></if-transform-bar>`,
});
