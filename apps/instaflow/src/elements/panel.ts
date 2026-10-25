/**
 * `<if-paint-inspector>` — the Fill / Stroke / Effects panel (IF-20.23), built only from `@staticflux/kit` components
 * under the Clean Pop theme: inspector groups and rows, colour fields, text fields, segmented switchers, sliders,
 * icon buttons and menus. It renders an `AppearanceModel` (`inspector.ts`) and fires `if-appearance-edit` with an
 * `AppearanceEdit`; the editor turns edits into one change set each. It never touches the document.
 *
 * Every stack (fills, strokes, effects) lists items top first with show/hide, move up/down and remove; "+" adds an
 * item. Corners have a link toggle (one radius, or four), and a smoothing slider (0–100 %). Keyboard: every control
 * is a kit control (Tab order follows the visual order; segmented and menus use their APG keys).
 */
import { component, defineComponent, SfElement } from '@staticflux/ui';
import { themeTokens as t } from '@staticflux/ui/theme';
import { defineButton } from '@staticflux/kit/button';
import { defineColorField } from '@staticflux/kit/color-field';
import { defineIconButton } from '@staticflux/kit/icon-button';
import { defineInspector } from '@staticflux/kit/inspector';
import { defineMenu } from '@staticflux/kit/menu';
import { defineSegmented } from '@staticflux/kit/segmented';
import { defineSlider } from '@staticflux/kit/slider';
import { defineTextField } from '@staticflux/kit/text-field';
import type { JsonValue } from '@staticflux/document/v2';
import { css, html, nothing, type TemplateResult } from 'lit';
import { BLEND_MODE_NAMES, CORNER_PATHS, EFFECT_KINDS, P, STROKE_ALIGNS } from './components.js';
import { type AppearanceEdit, type AppearanceModel, NEW_ITEMS, type StackName } from './inspector.js';
import { tokenName } from './values.js';

export const APPEARANCE_EDIT_EVENT = 'if-appearance-edit';

const spec = component({ tag: 'if-paint-inspector', placeholder: () => nothing, description: 'Fill, stroke and effects inspector (Instaflow B1).' });

const LABELS = {
  fills: 'Fill',
  strokes: 'Stroke',
  effects: 'Effects',
  layer: 'Layer',
  corners: 'Corners',
} as const;

const EFFECT_LABELS: Readonly<Record<(typeof EFFECT_KINDS)[number], string>> = {
  'drop-shadow': 'Drop shadow',
  'inner-shadow': 'Inner shadow',
  'outer-glow': 'Outer glow',
  'inner-glow': 'Inner glow',
  'layer-blur': 'Layer blur',
  'background-blur': 'Background blur',
};
const CORNER_LABELS = ['Top left', 'Top right', 'Bottom right', 'Bottom left'] as const;
const ALIGN_LABELS: Readonly<Record<(typeof STROKE_ALIGNS)[number], string>> = { inside: 'Inside', center: 'Centre', outside: 'Outside' };

const asNumber = (value: string): number | undefined => {
  const n = Number(value.trim().replace('%', ''));
  return Number.isFinite(n) ? n : undefined;
};
/** A size field's value: a number, or a `@token` as typed. */
const asSize = (value: string): JsonValue | undefined => (tokenName(value.trim()) !== undefined ? value.trim() : asNumber(value));
const show = (v: JsonValue | undefined): string => (v === undefined || v === null ? '' : String(v));
type Item = Readonly<Record<string, JsonValue>>;

export class IfPaintInspectorElement extends SfElement<typeof spec> {
  static override readonly spec = spec;
  static override properties = { model: { attribute: false } };
  static override styles = css`
    :host {
      display: block;
      font-family: ${t.font.family.css};
      color: ${t.color.text.css};
    }
    .item {
      display: grid;
      gap: ${t.space.xs.css};
      padding-block: ${t.space.xs.css};
      border-block-end: 1px solid ${t.color.border.css};
    }
    .item:last-child {
      border-block-end: none;
    }
    .actions {
      display: flex;
      gap: ${t.space.xs.css};
      justify-content: flex-end;
    }
    .pair {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: ${t.space.xs.css};
    }
    .muted {
      font-size: ${t.type.sizeXs.css};
      color: ${t.color.textMuted.css};
    }
  `;

  declare model: AppearanceModel | undefined;

  constructor() {
    super();
    this.model = undefined;
  }

  private edit(edit: AppearanceEdit): void {
    this.dispatchEvent(new CustomEvent<AppearanceEdit>(APPEARANCE_EDIT_EVENT, { detail: edit, bubbles: true, composed: true }));
  }

  private stackActions(stack: StackName, index: number, count: number, item: Item, what: string): TemplateResult {
    const hidden = item['visible'] === false;
    return html`<div class="actions">
      <sf-icon-button size="sm" variant="ghost" label=${hidden ? `Show ${what}` : `Hide ${what}`} .pressed=${hidden} @click=${() => this.edit({ op: 'toggle', stack, index })}
        >${hidden ? '◌' : '●'}</sf-icon-button
      >
      <sf-icon-button size="sm" variant="ghost" label=${`Move ${what} up`} ?disabled=${index === count - 1} @click=${() => this.edit({ op: 'move', stack, from: index, to: index + 1 })}>↑</sf-icon-button>
      <sf-icon-button size="sm" variant="ghost" label=${`Move ${what} down`} ?disabled=${index === 0} @click=${() => this.edit({ op: 'move', stack, from: index, to: index - 1 })}>↓</sf-icon-button>
      <sf-icon-button size="sm" variant="ghost" label=${`Remove ${what}`} @click=${() => this.edit({ op: 'remove', stack, index })}>−</sf-icon-button>
    </div>`;
  }

  private paintControls(stack: StackName, index: number, item: Item, what: string): TemplateResult {
    const paint = item['paint'];
    const update = (patch: Record<string, JsonValue>): void => this.edit({ op: 'update', stack, index, patch });
    if (typeof paint === 'string') {
      const token = tokenName(paint);
      return html`<sf-color-field
          label=${`${what} colour`}
          label-hidden
          value=${token === undefined ? paint : ''}
          @sf-change=${(e: CustomEvent<{ value: string }>) => update({ paint: e.detail.value })}
        ></sf-color-field>
        ${this.tokenMenu(`${what} brand colour`, this.model?.tokens.colors ?? [], token, (value) => update({ paint: value }))}`;
    }
    const kind = typeof paint === 'object' && paint !== null && !Array.isArray(paint) ? String((paint as Item)['kind']) : 'none';
    return html`<span class="muted">${kind === 'image' ? 'Image' : `${kind[0]?.toUpperCase() ?? ''}${kind.slice(1)} gradient`}</span>`;
  }

  private tokenMenu(label: string, tokens: readonly string[], current: string | undefined, pick: (token: string) => void): TemplateResult | typeof nothing {
    if (tokens.length === 0) return nothing;
    return html`<sf-menu label=${current === undefined ? label : `@${current}`} @sf-select=${(e: CustomEvent<{ value: string }>) => pick(e.detail.value)}>
      ${tokens.map((token) => html`<sf-menu-item value=${token}>${token}</sf-menu-item>`)}
    </sf-menu>`;
  }

  private common(stack: StackName, index: number, item: Item, what: string): TemplateResult {
    const update = (patch: Record<string, JsonValue>): void => this.edit({ op: 'update', stack, index, patch });
    const opacity = typeof item['opacity'] === 'number' ? item['opacity'] : 1;
    return html`<div class="pair">
      <sf-text-field
        label=${`${what} opacity`}
        label-hidden
        value=${`${Math.round(opacity * 100)}%`}
        @sf-change=${(e: CustomEvent<{ value: string }>) => {
          const n = asNumber(e.detail.value);
          if (n !== undefined) update({ opacity: Math.max(0, Math.min(1, n / 100)) });
        }}
      ></sf-text-field>
      <sf-menu label=${`${what} blend: ${show(item['blend'] ?? 'normal')}`} @sf-select=${(e: CustomEvent<{ value: string }>) => update({ blend: e.detail.value })}>
        ${BLEND_MODE_NAMES.map((mode) => html`<sf-menu-item value=${mode}>${mode}</sf-menu-item>`)}
      </sf-menu>
    </div>`;
  }

  private fills(model: AppearanceModel): TemplateResult {
    const count = model.fills.length;
    return html`<sf-inspector-group label=${LABELS.fills}>
      ${model.sources.fills.arc === 'inherit' ? html`<span class="muted">From class</span>` : nothing}
      ${[...model.fills.keys()].reverse().map((index) => {
        const item = model.fills[index] as unknown as Item;
        const what = `fill ${count - index}`;
        return html`<div class="item">
          <sf-inspector-row label=${`Fill ${count - index}`}>${this.paintControls('fills', index, item, what)}</sf-inspector-row>
          ${this.common('fills', index, item, what)} ${this.stackActions('fills', index, count, item, what)}
        </div>`;
      })}
      <sf-button size="sm" variant="ghost" @click=${() => this.edit({ op: 'add', stack: 'fills', item: NEW_ITEMS.fills })}>+ Add fill</sf-button>
    </sf-inspector-group>`;
  }

  private strokes(model: AppearanceModel): TemplateResult {
    const count = model.strokes.length;
    return html`<sf-inspector-group label=${LABELS.strokes}>
      ${[...model.strokes.keys()].reverse().map((index) => {
        const item = model.strokes[index] as unknown as Item;
        const what = `stroke ${count - index}`;
        const update = (patch: Record<string, JsonValue>): void => this.edit({ op: 'update', stack: 'strokes', index, patch });
        const dash = Array.isArray(item['dash']) ? (item['dash'] as number[]).join(' ') : '';
        return html`<div class="item">
          <sf-inspector-row label=${`Stroke ${count - index}`}>${this.paintControls('strokes', index, item, what)}</sf-inspector-row>
          <div class="pair">
            <sf-text-field
              label=${`${what} width`}
              label-hidden
              value=${show(item['width'])}
              @sf-change=${(e: CustomEvent<{ value: string }>) => {
                const v = asSize(e.detail.value);
                if (v !== undefined) update({ width: v });
              }}
            ></sf-text-field>
            <sf-text-field
              label=${`${what} dashes`}
              label-hidden
              placeholder="Dash gap"
              value=${dash}
              @sf-change=${(e: CustomEvent<{ value: string }>) => {
                const parts = e.detail.value.split(/[\s,]+/).filter((x) => x !== '').map(Number);
                if (parts.every((n) => Number.isFinite(n) && n >= 0)) update({ dash: parts });
              }}
            ></sf-text-field>
          </div>
          <sf-segmented
            label=${`${what} position`}
            .options=${STROKE_ALIGNS.map((value) => ({ value, label: ALIGN_LABELS[value] }))}
            .value=${show(item['align'] ?? 'center')}
            @sf-change=${(e: CustomEvent<{ value: string }>) => update({ align: e.detail.value })}
          ></sf-segmented>
          ${this.common('strokes', index, item, what)} ${this.stackActions('strokes', index, count, item, what)}
        </div>`;
      })}
      <sf-button size="sm" variant="ghost" @click=${() => this.edit({ op: 'add', stack: 'strokes', item: NEW_ITEMS.strokes })}>+ Add stroke</sf-button>
    </sf-inspector-group>`;
  }

  private effects(model: AppearanceModel): TemplateResult {
    const count = model.effects.length;
    const numberField = (label: string, value: JsonValue | undefined, set: (n: number) => void): TemplateResult =>
      html`<sf-text-field
        label=${label}
        label-hidden
        placeholder=${label}
        value=${show(value)}
        @sf-change=${(e: CustomEvent<{ value: string }>) => {
          const n = asNumber(e.detail.value);
          if (n !== undefined) set(n);
        }}
      ></sf-text-field>`;
    return html`<sf-inspector-group label=${LABELS.effects}>
      ${model.effectsPreset === undefined ? nothing : html`<span class="muted">Preset ${model.effectsPreset}</span>`}
      ${[...model.effects.keys()].reverse().map((index) => {
        const raw = model.effects[index];
        if (typeof raw === 'string') return html`<div class="item"><span class="muted">${raw}</span>${this.stackActions('effects', index, count, {}, `effect ${raw}`)}</div>`;
        const item = raw as unknown as Item;
        const kind = String(item['kind']) as (typeof EFFECT_KINDS)[number];
        const what = `${EFFECT_LABELS[kind] ?? kind} ${count - index}`;
        const update = (patch: Record<string, JsonValue>): void => this.edit({ op: 'update', stack: 'effects', index, patch });
        const blur = kind === 'layer-blur' || kind === 'background-blur';
        return html`<div class="item">
          <span class="muted">${what}</span>
          ${blur
            ? numberField(`${what} radius`, item['radius'], (n) => update({ radius: Math.max(0, n) }))
            : html`<div class="pair">
                  ${kind === 'drop-shadow' || kind === 'inner-shadow'
                    ? html`${numberField(`${what} x`, item['x'], (n) => update({ x: n }))} ${numberField(`${what} y`, item['y'], (n) => update({ y: n }))}`
                    : nothing}
                  ${numberField(`${what} blur`, item['blur'], (n) => update({ blur: Math.max(0, n) }))} ${numberField(`${what} spread`, item['spread'] ?? 0, (n) => update({ spread: n }))}
                </div>
                <sf-color-field
                  label=${`${what} colour`}
                  label-hidden
                  value=${tokenName(item['color']) === undefined ? show(item['color']) : ''}
                  @sf-change=${(e: CustomEvent<{ value: string }>) => update({ color: e.detail.value })}
                ></sf-color-field>`}
          ${this.stackActions('effects', index, count, item, what)}
        </div>`;
      })}
      <sf-menu label="+ Add effect" @sf-select=${(e: CustomEvent<{ value: string }>) => this.addEffect(e.detail.value)}>
        ${EFFECT_KINDS.map((kind) => html`<sf-menu-item value=${kind}>${EFFECT_LABELS[kind]}</sf-menu-item>`)}
        ${(model.tokens.effects ?? []).map((token) => html`<sf-menu-item value=${token}>${token}</sf-menu-item>`)}
      </sf-menu>
    </sf-inspector-group>`;
  }

  private addEffect(kind: string): void {
    if (tokenName(kind) !== undefined) {
      this.edit({ op: 'add', stack: 'effects', item: kind });
      return;
    }
    const color = '#16151a33';
    const item: JsonValue =
      kind === 'layer-blur' || kind === 'background-blur'
        ? { kind, radius: 8 }
        : kind === 'outer-glow' || kind === 'inner-glow'
          ? { kind, blur: 12, spread: 0, color: '#ff5c3999' }
          : kind === 'inner-shadow'
            ? { kind, x: 0, y: 2, blur: 4, spread: 0, color }
            : (NEW_ITEMS.effects as unknown as JsonValue);
    this.edit({ op: 'add', stack: 'effects', item: item as never });
  }

  private corners(model: AppearanceModel): TemplateResult {
    const sizeField = (label: string, value: JsonValue | undefined, path: string): TemplateResult =>
      html`<sf-text-field
        label=${label}
        label-hidden
        value=${show(value)}
        @sf-change=${(e: CustomEvent<{ value: string }>) => {
          const v = asSize(e.detail.value);
          if (v !== undefined) this.edit({ op: 'set', path, value: v });
        }}
      ></sf-text-field>`;
    return html`<sf-inspector-group label=${LABELS.corners}>
      <sf-inspector-row label="Radius">${sizeField('Corner radius', model.radius, P.radius)}</sf-inspector-row>
      <div class="actions">
        <sf-icon-button
          size="sm"
          variant="ghost"
          label="Link corners"
          .pressed=${model.cornersLinked}
          @click=${() => this.edit({ op: 'link-corners', linked: !model.cornersLinked })}
          >⛓</sf-icon-button
        >
      </div>
      ${model.cornersLinked
        ? nothing
        : html`<div class="pair">${CORNER_PATHS.map((path, i) => sizeField(`${CORNER_LABELS[i]} radius`, model.corners[i] ?? model.radius, path))}</div>`}
      <sf-slider
        label="Corner smoothing"
        min="0"
        max="100"
        step="1"
        unit="%"
        .value=${Math.round(model.smoothing * 100)}
        @sf-change=${(e: CustomEvent<{ value: number }>) => this.edit({ op: 'set', path: P.smoothing, value: Math.max(0, Math.min(1, Number(e.detail.value) / 100)) })}
      ></sf-slider>
    </sf-inspector-group>`;
  }

  private layer(model: AppearanceModel): TemplateResult {
    return html`<sf-inspector-group label=${LABELS.layer}>
      <sf-slider
        label="Opacity"
        min="0"
        max="100"
        step="1"
        unit="%"
        .value=${Math.round(model.opacity * 100)}
        @sf-change=${(e: CustomEvent<{ value: number }>) => this.edit({ op: 'set', path: P.opacity, value: Math.max(0, Math.min(1, Number(e.detail.value) / 100)) })}
      ></sf-slider>
      <sf-menu label=${`Blend: ${model.blend}`} @sf-select=${(e: CustomEvent<{ value: string }>) => this.edit({ op: 'set', path: P.blend, value: e.detail.value })}>
        ${BLEND_MODE_NAMES.map((mode) => html`<sf-menu-item value=${mode}>${mode}</sf-menu-item>`)}
      </sf-menu>
    </sf-inspector-group>`;
  }

  override render(): TemplateResult {
    const model = this.model;
    if (model === undefined) return html`<p class="muted">Select an element to edit its fill, stroke and effects.</p>`;
    return html`${this.layer(model)} ${this.fills(model)} ${this.strokes(model)} ${this.effects(model)} ${this.corners(model)}`;
  }
}

/** What the host gives the panel: the selected element's model, change notifications and the edit sink. */
export interface AppearanceSource {
  model(): AppearanceModel | undefined;
  subscribe(listener: () => void): () => void;
  apply(edit: AppearanceEdit): void;
}

/** Bind a mounted `<if-paint-inspector>` to a source (model in, edits out). Returns the unbind function. */
export function bindPaintInspector(element: IfPaintInspectorElement, source: AppearanceSource): () => void {
  const refresh = (): void => {
    element.model = source.model();
  };
  const onEdit = (event: Event): void => source.apply((event as CustomEvent<AppearanceEdit>).detail);
  refresh();
  const stop = source.subscribe(refresh);
  element.addEventListener(APPEARANCE_EDIT_EVENT, onEdit);
  return () => {
    stop();
    element.removeEventListener(APPEARANCE_EDIT_EVENT, onEdit);
  };
}

/** Define the panel element and the kit components it uses. */
export function definePaintInspector(registry: CustomElementRegistry = customElements): void {
  defineButton(registry);
  defineIconButton(registry);
  defineColorField(registry);
  defineTextField(registry);
  defineSegmented(registry);
  defineSlider(registry);
  defineMenu(registry);
  defineInspector(registry);
  if (registry.get(spec.tag) === undefined) defineComponent(IfPaintInspectorElement, registry);
}
