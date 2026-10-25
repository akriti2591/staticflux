/**
 * `<if-typography-panel>` — the Typography inspector panel (B2), built only from kit components under Clean Pop:
 * an inspector group with Font (menu), Size and Line height (sliders), Style (B / I / U toggle buttons with
 * `aria-pressed`), Alignment (segmented radio group), Colour (colour field plus brand tokens menu) and a
 * "Fit to box" button. B0 docks it (Properties / inspector placement); nothing here lays out a screen.
 *
 * Keyboard: every control is a kit control with its APG keyboard pattern (menus: arrows + type-ahead; segmented:
 * arrows; sliders: arrows / Page / Home / End); Tab moves between rows. Mixed values show "Mixed".
 */
import { defineButton } from '@staticflux/kit/button';
import { defineColorField } from '@staticflux/kit/color-field';
import { defineInspector } from '@staticflux/kit/inspector';
import { defineMenu } from '@staticflux/kit/menu';
import { defineSegmented, type SegmentOption } from '@staticflux/kit/segmented';
import { defineSlider } from '@staticflux/kit/slider';
import { component, defineComponent, SfElement } from '@staticflux/ui';
import { themeTokens as t } from '@staticflux/ui/theme';
import { css, html, nothing, type TemplateResult } from 'lit';
import { isTokenRef, type TextAlign } from './model.js';
import { MIXED, type TypographyService, TypographyServiceToken, type TypographySummary } from './typography.js';

export const TYPOGRAPHY_PANEL_TAG = 'if-typography-panel';

export const TYPOGRAPHY_TEXT = Object.freeze({
  group: 'Typography',
  font: 'Font',
  size: 'Size',
  lineHeight: 'Line height',
  style: 'Style',
  bold: 'Bold',
  italic: 'Italic',
  underline: 'Underline',
  align: 'Alignment',
  color: 'Colour',
  brandColors: 'Brand colours',
  fit: 'Fit to box',
  mixed: 'Mixed',
  defaultFont: 'Default font',
  empty: 'Select a text element to edit its typography.',
} as const);

export const ALIGN_OPTIONS: readonly SegmentOption<TextAlign>[] = Object.freeze([
  { value: 'start', label: 'Start' },
  { value: 'center', label: 'Center' },
  { value: 'end', label: 'End' },
  { value: 'justify', label: 'Justify' },
]);

const panelSpec = component({
  tag: TYPOGRAPHY_PANEL_TAG,
  deps: { render: { typography: TypographyServiceToken } },
  description: 'Typography inspector: font, size, style, alignment, line height, colour, Fit to box.',
});

/** Label of the font row for a summary (pure). */
export function fontLabel(summary: TypographySummary, service: Pick<TypographyService, 'fontChoices'>): string {
  if (summary.font === MIXED) return TYPOGRAPHY_TEXT.mixed;
  if (summary.font === undefined) return TYPOGRAPHY_TEXT.defaultFont;
  const key = JSON.stringify(summary.font);
  return service.fontChoices().find((c) => JSON.stringify(c.value) === key)?.label ?? (isTokenRef(summary.font) ? `@${summary.font.token}` : (summary.font.family ?? summary.font.font.slice(7, 15)));
}

export class IfTypographyPanelElement extends SfElement<typeof panelSpec> {
  static override readonly spec = panelSpec;
  static override properties = { revision: { state: true } };
  static override styles = css`
    :host {
      display: block;
      color: ${t.color.text.css};
      font-family: ${t.font.family.css};
    }
    .toggles {
      display: flex;
      gap: ${t.space.xs.css};
    }
    .empty {
      margin: 0;
      padding: ${t.space.md.css};
      color: ${t.color.textMuted.css};
      font-size: ${t.type.sizeSm.css};
    }
    .fit {
      padding: ${t.space.sm.css};
    }
  `;
  declare revision: number;
  private unwatch: (() => void) | undefined;

  constructor() {
    super();
    this.revision = 0;
  }

  override updated(): void {
    // Render deps are resolved once the element renders its content: subscribe then (once).
    if (this.unwatch === undefined && this.ready) {
      this.unwatch = this.deps.typography.onChange(() => {
        this.revision += 1;
      });
    }
  }

  override disconnectedCallback(): void {
    this.unwatch?.();
    this.unwatch = undefined;
    super.disconnectedCallback();
  }

  private act(run: (s: TypographyService) => unknown): void {
    run(this.deps.typography);
    this.revision += 1;
  }

  override render(): TemplateResult {
    const service = this.deps.typography;
    const s = service.summary();
    if (s === undefined) return html`<p class="empty">${TYPOGRAPHY_TEXT.empty}</p>`;
    const pressed = (v: boolean | typeof MIXED): string => (v === MIXED ? 'mixed' : String(v));
    const colorHex = typeof s.color === 'string' && s.color !== MIXED && s.color.startsWith('#') ? s.color : '';
    const fonts = service.fontChoices();
    const colors = service.colorChoices();
    return html`<sf-inspector-group label=${TYPOGRAPHY_TEXT.group}>
        <sf-inspector-row label=${TYPOGRAPHY_TEXT.font}>
          <sf-menu label=${TYPOGRAPHY_TEXT.font} @sf-select=${(e: CustomEvent<{ value: string }>) => {
            const choice = fonts[Number(e.detail.value)];
            if (choice !== undefined) this.act((x) => x.setFont(choice.value));
          }}>
            <sf-button slot="trigger" variant="secondary" size="sm">${fontLabel(s, service)}</sf-button>
            ${fonts.map((f, i) => html`<sf-menu-item value=${String(i)}>${f.label}</sf-menu-item>`)}
          </sf-menu>
        </sf-inspector-row>
        <sf-inspector-row label=${TYPOGRAPHY_TEXT.size} hint=${s.size === MIXED ? TYPOGRAPHY_TEXT.mixed : nothing}>
          <sf-slider min="4" max="400" step="1" unit="px" .value=${s.size === MIXED ? 16 : s.size} @sf-change=${(e: CustomEvent<{ value: number }>) => this.act((x) => x.setSize(Number(e.detail.value)))}></sf-slider>
        </sf-inspector-row>
        <sf-inspector-row label=${TYPOGRAPHY_TEXT.style}>
          <div class="toggles" role="group" aria-label=${TYPOGRAPHY_TEXT.style}>
            <sf-button variant="ghost" size="sm" aria-label=${TYPOGRAPHY_TEXT.bold} pressed=${pressed(s.bold)} @click=${() => this.act((x) => x.toggle('bold'))}>B</sf-button>
            <sf-button variant="ghost" size="sm" aria-label=${TYPOGRAPHY_TEXT.italic} pressed=${pressed(s.italic)} @click=${() => this.act((x) => x.toggle('italic'))}>I</sf-button>
            <sf-button variant="ghost" size="sm" aria-label=${TYPOGRAPHY_TEXT.underline} pressed=${pressed(s.underline)} @click=${() => this.act((x) => x.toggle('underline'))}>U</sf-button>
          </div>
        </sf-inspector-row>
        <sf-inspector-row label=${TYPOGRAPHY_TEXT.align}>
          <sf-segmented label=${TYPOGRAPHY_TEXT.align} size="sm" .options=${ALIGN_OPTIONS} .value=${s.align === MIXED ? '' : s.align} @sf-change=${(e: CustomEvent<{ value: TextAlign }>) => this.act((x) => x.setAlign(e.detail.value))}></sf-segmented>
        </sf-inspector-row>
        <sf-inspector-row label=${TYPOGRAPHY_TEXT.lineHeight}>
          <sf-slider min="0" max="3" step="0.05" .value=${s.lineHeight === MIXED ? 0 : s.lineHeight} @sf-change=${(e: CustomEvent<{ value: number }>) => this.act((x) => x.setLineHeight(Number(e.detail.value)))}></sf-slider>
        </sf-inspector-row>
        <sf-inspector-row label=${TYPOGRAPHY_TEXT.color} hint=${isTokenRef(s.color) ? `@${s.color.token}` : nothing}>
          <sf-color-field .value=${colorHex} @sf-change=${(e: CustomEvent<{ value: string }>) => this.act((x) => x.setColor(e.detail.value))}></sf-color-field>
        </sf-inspector-row>
        ${colors.length === 0
          ? nothing
          : html`<sf-inspector-row label=${TYPOGRAPHY_TEXT.brandColors}>
              <sf-menu label=${TYPOGRAPHY_TEXT.brandColors} @sf-select=${(e: CustomEvent<{ value: string }>) => {
                const choice = colors[Number(e.detail.value)];
                if (choice !== undefined) this.act((x) => x.setColor(choice.value));
              }}>
                <sf-button slot="trigger" variant="secondary" size="sm">${TYPOGRAPHY_TEXT.brandColors}</sf-button>
                ${colors.map((c, i) => html`<sf-menu-item value=${String(i)}>${c.label}</sf-menu-item>`)}
              </sf-menu>
            </sf-inspector-row>`}
      </sf-inspector-group>
      <div class="fit"><sf-button variant="secondary" size="sm" @click=${() => this.act((x) => x.fitToBox())}>${TYPOGRAPHY_TEXT.fit}</sf-button></div>`;
  }
}

export function defineTypographyPanel(registry: CustomElementRegistry = customElements): void {
  defineButton(registry);
  defineColorField(registry);
  defineInspector(registry);
  defineMenu(registry);
  defineSegmented(registry);
  defineSlider(registry);
  if (registry.get(TYPOGRAPHY_PANEL_TAG) === undefined) defineComponent(IfTypographyPanelElement, registry);
}
