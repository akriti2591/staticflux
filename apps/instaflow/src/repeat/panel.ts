/**
 * `<if-repeat-inspector>` — the Repeat panel (IF-26.23), built only from `@staticflux/kit` components under the
 * Clean Pop theme: an inspector group with a segmented generator switch, number fields per parameter, segmented
 * switches for the enumerations, a sweep slider, and Expand / Release buttons. It renders a `RepeatModel`
 * (`inspector.ts`) and fires `if-repeat-edit` with a `RepeatEdit`; the editor turns each edit into one change set.
 * Keyboard: every control is a kit control (Tab follows the visual order; segmented uses its APG arrow keys), so
 * every on-canvas handle has a keyboard path here.
 */
import { component, defineComponent, SfElement } from '@staticflux/ui';
import { themeTokens as t } from '@staticflux/ui/theme';
import { defineButton } from '@staticflux/kit/button';
import { defineInspector } from '@staticflux/kit/inspector';
import { defineSegmented } from '@staticflux/kit/segmented';
import { defineSlider } from '@staticflux/kit/slider';
import { defineTextField } from '@staticflux/kit/text-field';
import { css, html, nothing, type TemplateResult } from 'lit';
import { BRICK_AXES, MIRROR_AXES, type RepeatKind, type RepeatParamName } from './components.js';
import type { RepeatEdit, RepeatModel } from './inspector.js';
import type { RepeatPatch } from './params.js';

export const REPEAT_EDIT_EVENT = 'if-repeat-edit';

const spec = component({ tag: 'if-repeat-inspector', placeholder: () => nothing, description: 'Repeat inspector (Instaflow B7).' });

const KIND_LABELS: Readonly<Record<RepeatKind, string>> = { radial: 'Radial', grid: 'Grid', mirror: 'Mirror' };

/** How each parameter is edited: a number field (with unit), a segmented switch, or the sweep slider. */
export type RepeatField =
  | { readonly control: 'number'; readonly label: string; readonly integer?: boolean; readonly unit?: string; readonly percent?: boolean }
  | { readonly control: 'choice'; readonly label: string; readonly options: readonly (readonly [value: string, label: string])[] }
  | { readonly control: 'toggle'; readonly label: string; readonly on: string; readonly off: string }
  | { readonly control: 'slider'; readonly label: string; readonly min: number; readonly max: number; readonly unit: string };

export const REPEAT_FIELDS: Readonly<Record<RepeatParamName, RepeatField>> = {
  count: { control: 'number', label: 'Count', integer: true },
  radius: { control: 'number', label: 'Radius', unit: 'px' },
  startAngle: { control: 'number', label: 'Start angle', unit: '°' },
  sweep: { control: 'slider', label: 'Sweep', min: 1, max: 360, unit: '°' },
  rotate: { control: 'toggle', label: 'Copies', on: 'Rotate', off: 'Keep upright' },
  rows: { control: 'number', label: 'Rows', integer: true },
  columns: { control: 'number', label: 'Columns', integer: true },
  gapX: { control: 'number', label: 'Horizontal gap', unit: 'px' },
  gapY: { control: 'number', label: 'Vertical gap', unit: 'px' },
  rowOffset: { control: 'number', label: 'Row offset', unit: 'px' },
  columnOffset: { control: 'number', label: 'Column offset', unit: 'px' },
  brick: { control: 'choice', label: 'Brick', options: BRICK_AXES.map((v) => [v, { none: 'None', rows: 'Rows', columns: 'Columns' }[v]] as const) },
  brickShift: { control: 'number', label: 'Brick shift', unit: '%', percent: true },
  axis: { control: 'choice', label: 'Axis', options: MIRROR_AXES.map((v) => [v, { vertical: 'Vertical', horizontal: 'Horizontal', angle: 'Angle' }[v]] as const) },
  angle: { control: 'number', label: 'Axis angle', unit: '°' },
  offset: { control: 'number', label: 'Axis offset', unit: 'px' },
};

const asNumber = (value: string): number | undefined => {
  const trimmed = value.trim().replace(/(px|%|°)$/u, '');
  if (trimmed === '') return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : undefined;
};

export class IfRepeatInspectorElement extends SfElement<typeof spec> {
  static override readonly spec = spec;
  static override properties = { model: { attribute: false } };
  static override styles = css`
    :host {
      display: block;
      font-family: ${t.font.family.css};
      color: ${t.color.text.css};
    }
    .actions {
      display: flex;
      gap: ${t.space.xs.css};
      justify-content: flex-end;
      padding-block-start: ${t.space.xs.css};
    }
    .muted {
      font-size: ${t.type.sizeXs.css};
      color: ${t.color.textMuted.css};
    }
  `;

  declare model: RepeatModel | undefined;

  constructor() {
    super();
    this.model = undefined;
  }

  private edit(edit: RepeatEdit): void {
    this.dispatchEvent(new CustomEvent<RepeatEdit>(REPEAT_EDIT_EVENT, { detail: edit, bubbles: true, composed: true }));
  }

  private set(patch: RepeatPatch): void {
    this.edit({ op: 'set', patch });
  }

  private field(model: RepeatModel, name: RepeatParamName): TemplateResult {
    const f = REPEAT_FIELDS[name];
    const value = (model.params as unknown as Readonly<Record<string, number | string | boolean>>)[name];
    switch (f.control) {
      case 'number': {
        const shown = typeof value === 'number' ? (f.percent === true ? `${Math.round(value * 100)}%` : `${Math.round(value * 100) / 100}${f.unit ?? ''}`) : '';
        return html`<sf-inspector-row label=${f.label}>
          <sf-text-field
            label=${f.label}
            label-hidden
            value=${shown}
            @sf-change=${(e: CustomEvent<{ value: string }>) => {
              const n = asNumber(e.detail.value);
              if (n === undefined) return;
              const v = f.percent === true ? n / 100 : f.integer === true ? Math.round(n) : n;
              this.set({ [name]: v });
            }}
          ></sf-text-field>
        </sf-inspector-row>`;
      }
      case 'choice':
        return html`<sf-segmented
          label=${f.label}
          .options=${f.options.map(([v, label]) => ({ value: v, label }))}
          .value=${String(value)}
          @sf-change=${(e: CustomEvent<{ value: string }>) => this.set({ [name]: e.detail.value })}
        ></sf-segmented>`;
      case 'toggle':
        return html`<sf-segmented
          label=${f.label}
          .options=${[
            { value: 'on', label: f.on },
            { value: 'off', label: f.off },
          ]}
          .value=${value === true ? 'on' : 'off'}
          @sf-change=${(e: CustomEvent<{ value: string }>) => this.set({ [name]: e.detail.value === 'on' })}
        ></sf-segmented>`;
      case 'slider':
        return html`<sf-slider
          label=${f.label}
          min=${String(f.min)}
          max=${String(f.max)}
          step="1"
          unit=${f.unit}
          .value=${typeof value === 'number' ? value : f.max}
          @sf-change=${(e: CustomEvent<{ value: number }>) => this.set({ [name]: Math.max(f.min, Math.min(f.max, Number(e.detail.value))) })}
        ></sf-slider>`;
    }
  }

  override render(): TemplateResult {
    const model = this.model;
    if (model === undefined) return html`<p class="muted">Select a repeat to edit it, or repeat a selection from the HUD.</p>`;
    const visible = model.fields.filter((name) => name !== 'angle' || (model.params.kind === 'mirror' && model.params.axis === 'angle'));
    return html`<sf-inspector-group label="Repeat">
      <sf-segmented
        label="Repeat type"
        .options=${model.kinds.map((kind) => ({ value: kind, label: KIND_LABELS[kind] }))}
        .value=${model.params.kind}
        @sf-change=${(e: CustomEvent<{ value: string }>) => this.set({ kind: e.detail.value as RepeatKind })}
      ></sf-segmented>
      ${visible.map((name) => this.field(model, name))}
      <span class="muted">${model.instances === 1 ? '1 instance' : `${model.instances} instances`}</span>
      <div class="actions">
        <sf-button size="sm" variant="ghost" @click=${() => this.edit({ op: 'release' })}>Release</sf-button>
        <sf-button size="sm" @click=${() => this.edit({ op: 'expand' })}>Expand</sf-button>
      </div>
    </sf-inspector-group>`;
  }
}

/** What the host gives the panel: the selected repeat's model, change notifications and the edit sink. */
export interface RepeatInspectorSource {
  model(): RepeatModel | undefined;
  subscribe(listener: () => void): () => void;
  apply(edit: RepeatEdit): void;
}

/** Bind a mounted `<if-repeat-inspector>` to a source (model in, edits out). Returns the unbind function. */
export function bindRepeatInspector(element: IfRepeatInspectorElement, source: RepeatInspectorSource): () => void {
  const refresh = (): void => {
    element.model = source.model();
  };
  const onEdit = (event: Event): void => source.apply((event as CustomEvent<RepeatEdit>).detail);
  refresh();
  const stop = source.subscribe(refresh);
  element.addEventListener(REPEAT_EDIT_EVENT, onEdit);
  return () => {
    stop();
    element.removeEventListener(REPEAT_EDIT_EVENT, onEdit);
  };
}

/** Define the panel element and the kit components it uses. */
export function defineRepeatInspector(registry: CustomElementRegistry = customElements): void {
  defineButton(registry);
  defineTextField(registry);
  defineSegmented(registry);
  defineSlider(registry);
  defineInspector(registry);
  if (registry.get(spec.tag) === undefined) defineComponent(IfRepeatInspectorElement, registry);
}
