/**
 * `<sf-align-popover>` — the alignment popover (STUDIO-UX-SPEC §4.2.7): a 3 × 2 grid of icon buttons (left · centre ·
 * right / top · middle · bottom), a divider, a distribute row (horizontal · vertical · tidy up), and `Align to:
 * Selection · Page` (Page is the only option for a single element). Each button commits at once and the popover
 * stays open (people align twice): `sf-align` `{ action, to }`; `sf-align-to` `{ to }` when the target changes.
 * Distribute needs three or more elements and tidy up two: rows that cannot apply are not shown (never disabled).
 */
import { I18nToken } from '@staticflux/i18n';
import { component, defineComponent, SfElement } from '@staticflux/ui';
import { css, html, nothing, type TemplateResult } from 'lit';
import { defineIconElement } from './icon.js';
import { defineIconButton } from './icon-button.js';
import type { IconDef } from './icon-def.js';
import { alignCenterHorizontalIcon } from './icons/align-center-horizontal.js';
import { alignCenterVerticalIcon } from './icons/align-center-vertical.js';
import { alignEndHorizontalIcon } from './icons/align-end-horizontal.js';
import { alignEndVerticalIcon } from './icons/align-end-vertical.js';
import { alignHorizontalSpaceAroundIcon } from './icons/align-horizontal-space-around.js';
import { alignStartHorizontalIcon } from './icons/align-start-horizontal.js';
import { alignStartVerticalIcon } from './icons/align-start-vertical.js';
import { alignVerticalSpaceAroundIcon } from './icons/align-vertical-space-around.js';
import { layoutGridIcon } from './icons/layout-grid.js';
import { defineSegmented, type SegmentOption } from './segmented.js';
import { emit } from './internal/events.js';
import { baseStyles, t } from './internal/styles.js';
import { kitMessages, kitText } from './messages.js';

export type AlignAction = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom' | 'distribute-horizontal' | 'distribute-vertical' | 'tidy-up';
export type AlignTo = 'selection' | 'page';

export interface AlignDetail {
  readonly action: AlignAction;
  readonly to: AlignTo;
}

type MessageKey = keyof typeof kitMessages;

const ALIGN: readonly (readonly [AlignAction, IconDef, MessageKey])[] = [
  ['left', alignStartVerticalIcon, 'alignLeft'],
  ['center', alignCenterVerticalIcon, 'alignCenter'],
  ['right', alignEndVerticalIcon, 'alignRight'],
  ['top', alignStartHorizontalIcon, 'alignTop'],
  ['middle', alignCenterHorizontalIcon, 'alignMiddle'],
  ['bottom', alignEndHorizontalIcon, 'alignBottom'],
];

const DISTRIBUTE: readonly (readonly [AlignAction, IconDef, MessageKey, number])[] = [
  ['distribute-horizontal', alignHorizontalSpaceAroundIcon, 'distributeHorizontal', 3],
  ['distribute-vertical', alignVerticalSpaceAroundIcon, 'distributeVertical', 3],
  ['tidy-up', layoutGridIcon, 'tidyUp', 2],
];

/** Where a single element aligns: always the page (§4.2.7). */
export function alignTarget(count: number, chosen: AlignTo): AlignTo {
  return count <= 1 ? 'page' : chosen;
}

/** The distribute-row actions that apply to `count` selected elements. */
export function distributeActions(count: number): AlignAction[] {
  return DISTRIBUTE.filter(([, , , min]) => count >= min).map(([action]) => action);
}

const alignSpec = component({
  tag: 'sf-align-popover',
  deps: { lazy: { i18n: I18nToken } },
  placeholder: () => html``,
  description: 'Alignment popover: 3 × 2 align grid, distribute row, Align to Selection / Page; stays open.',
});

export class SfAlignPopoverElement extends SfElement<typeof alignSpec> {
  static override readonly spec = alignSpec;
  static override properties = { count: { type: Number }, to: {} };
  static override styles = [
    baseStyles,
    css`
      :host {
        display: grid;
        gap: ${t.space.sm.css};
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(3, auto);
        justify-content: start;
        gap: ${t.space.xs.css};
      }
      hr {
        margin: 0;
        border: 0;
        block-size: 1px;
        background: ${t.color.border.css};
      }
      .to {
        display: flex;
        align-items: center;
        gap: ${t.space.sm.css};
        font-size: ${t.type.sizeSm.css};
        color: ${t.color.textMuted.css};
      }
    `,
  ];

  /** Number of selected elements. */
  declare count: number;
  declare to: AlignTo;

  constructor() {
    super();
    this.count = 1;
    this.to = 'selection';
  }

  private run(action: AlignAction): void {
    emit<AlignDetail>(this, 'sf-align', { action, to: alignTarget(this.count, this.to) });
  }

  override render(): TemplateResult {
    const i18n = this.deps.i18n;
    const button = ([action, icon, key]: readonly [AlignAction, IconDef, MessageKey, ...unknown[]]): TemplateResult =>
      html`<sf-icon-button label=${kitText(i18n, kitMessages[key])} data-action=${action} @click=${() => this.run(action)}><sf-icon .icon=${icon} size="18"></sf-icon></sf-icon-button>`;
    const distribute = DISTRIBUTE.filter(([, , , min]) => this.count >= min);
    const target = alignTarget(this.count, this.to);
    const options: SegmentOption<AlignTo>[] =
      this.count <= 1
        ? [{ value: 'page', label: kitText(i18n, kitMessages.alignToPage) }]
        : [
            { value: 'selection', label: kitText(i18n, kitMessages.alignToSelection) },
            { value: 'page', label: kitText(i18n, kitMessages.alignToPage) },
          ];
    return html`<div class="grid" role="group" aria-label=${kitText(i18n, kitMessages.align)}>${ALIGN.map(button)}</div>
      ${distribute.length === 0 ? nothing : html`<hr /><div class="grid" role="group" aria-label=${kitText(i18n, kitMessages.distribute)}>${distribute.map(button)}</div>`}
      <div class="to">
        <span aria-hidden="true">${kitText(i18n, kitMessages.alignTo)}</span>
        <sf-segmented
          label=${kitText(i18n, kitMessages.alignTo)}
          .options=${options}
          .value=${target}
          @sf-change=${(e: CustomEvent<{ value: AlignTo }>) => {
            this.to = e.detail.value;
            emit(this, 'sf-align-to', { to: e.detail.value });
          }}
        ></sf-segmented>
      </div>`;
  }
}

export function defineAlignPopover(registry: CustomElementRegistry = customElements): void {
  defineIconElement(registry);
  defineIconButton(registry);
  defineSegmented(registry);
  if (registry.get(alignSpec.tag) === undefined) defineComponent(SfAlignPopoverElement, registry);
}
