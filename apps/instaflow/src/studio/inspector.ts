/**
 * `<if-inspector>` — the Studio inspector (B11b, STUDIO-UX-SPEC §5): the **full view of the control model** the
 * selection pill projects. A header (the selection's name, renamed in place; its kind tag; the lock state, the same
 * Lock control the pill shows as Unlock), then the sections of the selection kind in order (`INSPECTOR_SECTIONS`,
 * §5.1; sections not listed are not rendered). With nothing selected it shows Page (name, size, orientation,
 * Background as a fill stack) and Document (title, pages, units) — never a "select something" message (§5.5).
 *
 * Sections are disclosures (▸ with a summary line when collapsed; the state is remembered on this device); Pro pins
 * them all open and opens every row's second line and `More ▾`. Every field is a kit control (scrubbable numbers, the
 * shared colour popover, the font picker, menus); every edit goes out through `InspectorPort` as one undo step. It
 * holds no document logic: the editor's mirrors give the models, the port runs capabilities and mirror actions.
 */
import { defineButton } from '@staticflux/kit/button';
import { defineColorPopover, type ColorChangeDetail, type DocumentColor, pushRecentColor } from '@staticflux/kit/color-popover';
import { defineDisclosure } from '@staticflux/kit/disclosure';
import { defineFontPicker } from '@staticflux/kit/font-picker';
import { defineIconElement } from '@staticflux/kit/icon';
import { defineIconButton } from '@staticflux/kit/icon-button';
import { chevronDownIcon } from '@staticflux/kit/icons/chevron-down';
import { flipHorizontal2Icon } from '@staticflux/kit/icons/flip-horizontal-2';
import { flipVertical2Icon } from '@staticflux/kit/icons/flip-vertical-2';
import { linkIcon } from '@staticflux/kit/icons/link';
import { lockIcon } from '@staticflux/kit/icons/lock';
import { lockOpenIcon } from '@staticflux/kit/icons/lock-open';
import { defineSizeField } from '@staticflux/kit/size-field';
import { unlinkIcon } from '@staticflux/kit/icons/unlink';
import { defineInlineEdit } from '@staticflux/kit/inline-edit';
import { defineMenu } from '@staticflux/kit/menu';
import { defineNumberField, type NumberChangeDetail } from '@staticflux/kit/number-field';
import { definePopover } from '@staticflux/kit/popover';
import { defineSegmented } from '@staticflux/kit/segmented';
import { defineSlider } from '@staticflux/kit/slider';
import { defineSwatch } from '@staticflux/kit/swatch';
import { defineTag } from '@staticflux/kit/tag';
import { defineTextField } from '@staticflux/kit/text-field';
import { component, defineComponent, SfElement } from '@staticflux/ui';
import { themeTokens as t } from '@staticflux/ui/theme';
import { css, html, nothing, type TemplateResult } from 'lit';
import type { PageSummary, SelectionSummary } from '../app/scene-summary.js';
import { type BlendModeName, P } from '../elements/components.js';
import type { AppearanceEdit, AppearanceModel } from '../elements/inspector.js';
import type { RepeatEdit, RepeatModel } from '../repeat/inspector.js';
import { REPEAT_FIELDS } from '../repeat/panel.js';
import type { Density } from '../spec/contributions.js';
import type { FontChoice, TypographySummary } from '../text/typography.js';
import type { NumericField, TransformEdit } from '../tools/free-transform.js';
import type { TransformBarModel } from '../workers/mirrors.js';
import { type HudPort, paintFromColor } from './hud.js';
import {
  effectsSummary,
  FIT_LABELS,
  type InspectorSection,
  type InspectorSectionId,
  inspectorSections,
  layerSummary,
  PAGE_SIZE_RANGE,
  pagePresetOf,
  pageSizePresets,
} from './inspector-model.js';
import { cornersSection, effectPresetMenu, effectStack, fillStack, layerSection, type PaintHost, paintMessages, sharedPaintRow, strokeStack } from './inspector-paint.js';
import { type TextCommands, type TextHost, textSection } from './inspector-text.js';

export const inspectorMessages = Object.freeze({
  inspector: 'Inspector',
  name: 'Name',
  page: 'Page',
  pageName: 'Page name',
  size: 'Size',
  sizePreset: 'Size preset',
  customSize: 'Custom',
  width: 'W',
  height: 'H',
  pageSize: 'Page size',
  background: 'Background',
  document: 'Document',
  title: 'Title',
  pages: 'Pages',
  units: 'Units',
  pixels: 'Pixels',
  transform: 'Transform',
  x: 'X',
  y: 'Y',
  w: 'W',
  h: 'H',
  angle: 'Angle',
  skew: 'Skew',
  link: 'Keep proportions',
  flipH: 'Flip horizontal',
  flipV: 'Flip vertical',
  apply: 'Apply',
  cancel: 'Cancel',
  lockedStay: (n: number) => (n === 1 ? '1 locked element stays put' : `${n} locked elements stay put`),
  text: 'Text',
  image: 'Image',
  fit: 'Fit',
  replace: 'Replace…',
  source: 'Source',
  cropX: 'Crop X',
  cropY: 'Crop Y',
  cropScale: 'Scale',
  cropRotate: 'Rotate picture',
  resetCrop: 'Reset crop',
  frame: 'Frame',
  clip: 'Clip content',
  repeat: 'Repeat',
  repeatKind: 'Repeat type',
  instances: (n: number) => (n === 1 ? '1 instance' : `${n} instances`),
  expand: 'Expand',
  release: 'Release',
  combine: 'Combine',
  operation: 'Operation',
  operations: { union: 'Union', subtract: 'Subtract', intersect: 'Intersect', exclude: 'Exclude' } as Readonly<Record<string, string>>,
  flatten: 'Flatten',
  mask: 'Mask',
  maskMode: 'Mask mode',
  maskModes: { clip: 'Clip', alpha: 'Alpha', luminance: 'Luminance' } as Readonly<Record<string, string>>,
  invert: 'Invert',
  fill: 'Fill',
  stroke: 'Stroke',
  effects: 'Effects',
  corners: 'Corners',
  layer: 'Layer',
  locked: 'Locked',
  lockedLine: 'This selection is locked. Unlock it to edit.',
  lock: 'Lock',
  unlock: 'Unlock',
  replaceAll: 'Replace all',
  more: 'More',
  repeatKinds: { radial: 'Radial', grid: 'Grid', mirror: 'Mirror' } as Readonly<Record<string, string>>,
});

const SECTION_HEADINGS: Readonly<Record<InspectorSectionId, string>> = {
  page: inspectorMessages.page,
  document: inspectorMessages.document,
  transform: inspectorMessages.transform,
  text: inspectorMessages.text,
  image: inspectorMessages.image,
  frame: inspectorMessages.frame,
  repeat: inspectorMessages.repeat,
  combine: inspectorMessages.combine,
  mask: inspectorMessages.mask,
  fill: inspectorMessages.fill,
  stroke: inspectorMessages.stroke,
  corners: inspectorMessages.corners,
  effects: inspectorMessages.effects,
  layer: inspectorMessages.layer,
  locked: inspectorMessages.locked,
};

/** What the inspector shows (the editor's mirrors, set by the app). */
export interface InspectorModel {
  readonly selection: SelectionSummary | undefined;
  readonly page: PageSummary | undefined;
  readonly title: string;
  readonly pages: number;
  /** The single selected element's appearance (undefined for several). */
  readonly appearance: AppearanceModel | undefined;
  /** The open page's Background stack. */
  readonly pageFill: AppearanceModel | undefined;
  readonly transform: TransformBarModel | undefined;
  readonly typography: TypographySummary | undefined;
  readonly fonts: readonly FontChoice[];
  readonly repeat: RepeatModel | undefined;
  readonly colors: readonly DocumentColor[];
  /** The selected image's library name. */
  readonly imageName: string | undefined;
}

export const EMPTY_INSPECTOR: InspectorModel = Object.freeze({
  selection: undefined,
  page: undefined,
  title: '',
  pages: 1,
  appearance: undefined,
  pageFill: undefined,
  transform: undefined,
  typography: undefined,
  fonts: [],
  repeat: undefined,
  colors: [],
  imageName: undefined,
});

/** What the inspector runs (the app implements it over capabilities and mirror actions). */
export interface InspectorPort extends HudPort {
  appearance(edit: AppearanceEdit): void;
  pageAppearance(edit: AppearanceEdit): void;
  transform(edit: TransformEdit): void;
  transformSession(action: 'commit' | 'cancel'): void;
  repeat(edit: RepeatEdit): void;
  readonly text: TextCommands;
  renamePage(name: string): void;
  resizePage(width: number, height: number): void;
  renameTitle(title: string): void;
  replaceImage(): void;
}

const spec = component({ tag: 'if-inspector', placeholder: () => nothing, description: 'Instaflow inspector: the selection kind’s sections, the page and document with nothing selected (B11b).' });

const OPEN_KEY = 'instaflow/ui/inspector-sections';
const readOpen = (): Readonly<Record<string, boolean>> => {
  try {
    const raw = globalThis.localStorage?.getItem(OPEN_KEY);
    const value = raw === null || raw === undefined ? {} : (JSON.parse(raw) as unknown);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, boolean>) : {};
  } catch {
    return {};
  }
};
const writeOpen = (state: Readonly<Record<string, boolean>>): void => {
  try {
    globalThis.localStorage?.setItem(OPEN_KEY, JSON.stringify(state));
  } catch {
    // Storage blocked: the sections still toggle for this session.
  }
};
const RECENT_KEY = 'instaflow/ui/recent-colours';
const readRecent = (): string[] => {
  try {
    const raw = globalThis.localStorage?.getItem(RECENT_KEY);
    const list = raw === null || raw === undefined ? [] : (JSON.parse(raw) as unknown);
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

const numberField = (label: string, value: number | undefined, commit: (n: number) => void, o: { min?: number; max?: number; unit?: string; step?: number; wrap?: string; disabled?: boolean } = {}): TemplateResult =>
  html`<sf-number-field
    label=${label}
    .value=${value}
    min=${o.min ?? nothing}
    max=${o.max ?? nothing}
    step=${o.step ?? nothing}
    unit=${o.unit ?? ''}
    wrap=${o.wrap ?? nothing}
    ?disabled=${o.disabled === true}
    @sf-change=${(e: CustomEvent<NumberChangeDetail>) => {
      if (e.detail.value !== undefined) commit(e.detail.value);
    }}
  ></sf-number-field>`;

const round = (n: number, places = 2): number => Math.round(n * 10 ** places) / 10 ** places;

export class IfInspectorElement extends SfElement<typeof spec> {
  static override readonly spec = spec;
  static override properties = {
    model: { attribute: false },
    port: { attribute: false },
    density: { reflect: true },
    opened: { state: true },
    rows: { state: true },
    more: { state: true },
    recent: { state: true },
    linked: { state: true },
  };
  static override styles = css`
    :host {
      display: block;
      font-family: ${t.font.family.css};
      font-size: ${t.type.sizeSm.css};
      color: ${t.color.text.css};
    }
    header {
      display: flex;
      align-items: center;
      gap: ${t.space.sm.css};
      padding: 12px 14px;
      border-block-end: 1px solid ${t.color.border.css};
    }
    header .name {
      flex: 1;
      min-inline-size: 0;
      font-family: ${t.font.familyDisplay.css};
      font-weight: ${t.font.weightDisplay.css};
      font-size: 15px;
    }
    section {
      padding: 6px 14px 12px;
      border-block-end: 1px solid ${t.color.border.css};
    }
    .rows,
    .stack {
      display: grid;
      gap: ${t.space.xs.css};
    }
    .row {
      display: flex;
      align-items: center;
      gap: ${t.space.xs.css};
      flex-wrap: wrap;
    }
    sf-size-field.page-size {
      --sf-size-field-input: 5.75rem;
    }
    .grid2 {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }
    .label {
      color: ${t.color.textMuted.css};
      font-size: 12px;
      min-inline-size: 72px;
    }
    .muted {
      color: ${t.color.textMuted.css};
    }
    .mono {
      font-family: ${t.font.familyMono.css};
      font-size: 12px;
    }
    p {
      margin: 0;
    }
    .stack-row {
      display: grid;
      gap: 4px;
    }
    .stack-row[data-hidden] .line > :not(sf-icon-button) {
      opacity: 0.5;
    }
    .line {
      display: flex;
      align-items: center;
      gap: 4px;
      min-block-size: 34px;
    }
    .summary {
      all: unset;
      flex: 1;
      min-inline-size: 0;
      display: grid;
      cursor: pointer;
      border-radius: ${t.radius.sm.css};
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .summary.static {
      cursor: default;
    }
    .summary:focus-visible {
      outline: 2px solid ${t.color.focusRing.css};
      outline-offset: 2px;
    }
    .second {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 4px;
      padding-inline-start: 32px;
    }
    .opacity sf-number-field,
    .width sf-number-field {
      inline-size: 64px;
    }
    .sides {
      display: flex;
      gap: 4px;
    }
    .sides sf-number-field {
      inline-size: 52px;
    }
    .thumb,
    .gradient-thumb {
      display: inline-block;
      inline-size: 16px;
      block-size: 16px;
      border-radius: 4px;
      box-shadow: inset 0 0 0 1px ${t.color.border.css};
    }
    .gradient-editor {
      display: grid;
      gap: ${t.space.sm.css};
      inline-size: 236px;
    }
    .strip {
      block-size: 24px;
      border-radius: 6px;
      box-shadow: inset 0 0 0 1px ${t.color.border.css};
    }
    .stops {
      display: grid;
      gap: 4px;
    }
    .stop {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .stop sf-number-field {
      flex: 1;
    }
    .font {
      max-inline-size: 150px;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .wide {
      min-inline-size: 160px;
      justify-content: space-between;
    }
    .link-form {
      display: grid;
      gap: ${t.space.sm.css};
      inline-size: 236px;
    }
  `;

  declare model: InspectorModel;
  declare port: InspectorPort | undefined;
  declare density: Density;
  declare opened: Readonly<Record<string, boolean>>;
  declare rows: ReadonlySet<string>;
  declare more: ReadonlySet<string>;
  declare recent: readonly string[];
  /** W and H keep their ratio (the link toggle). */
  declare linked: boolean;

  constructor() {
    super();
    this.model = EMPTY_INSPECTOR;
    this.port = undefined;
    this.density = 'standard';
    this.opened = readOpen();
    this.rows = new Set();
    this.more = new Set();
    this.recent = readRecent();
    this.linked = false;
  }

  /** Expand a section and scroll it into view (`?inspect=<section>`, NAVIGATION-DEEPLINKS §2.2). False when not shown. */
  async reveal(section: InspectorSectionId): Promise<boolean> {
    this.setOpen(section, true);
    await this.updateComplete;
    const el = this.renderRoot.querySelector<HTMLElement>(`[data-section="${section}"]`);
    el?.scrollIntoView({ block: 'nearest' });
    return el !== null;
  }

  /** Open the Page section and focus the page name (the page label's double-click). */
  async focusPageName(): Promise<void> {
    await this.reveal('page');
    this.renderRoot.querySelector<HTMLElement>(`section[data-section="page"] sf-text-field`)?.focus();
  }

  /** Rename the selection in place: the header's name field edits (`Mod+Shift+R`, F2, the context menu). */
  async focusName(): Promise<boolean> {
    await this.updateComplete;
    const field = this.renderRoot.querySelector<HTMLElement & { edit(): void }>('header sf-inline-edit.name');
    field?.edit();
    return field !== null;
  }

  private get pro(): boolean {
    return this.density === 'pro';
  }

  private setOpen(id: string, open: boolean): void {
    this.opened = { ...this.opened, [id]: open };
    writeOpen(this.opened);
  }

  private host(): PaintHost & TextHost {
    const self = this;
    return {
      pro: this.pro,
      documentColors: this.model.colors,
      recent: this.recent,
      fonts: this.model.fonts,
      commitColor(detail: ColorChangeDetail, apply: (paint: string) => void) {
        if (detail.kind !== 'token') {
          self.recent = pushRecentColor(self.recent, detail.hex);
          try {
            globalThis.localStorage?.setItem(RECENT_KEY, JSON.stringify(self.recent));
          } catch {
            // Storage blocked: recents stay for the session.
          }
        }
        apply(paintFromColor(detail));
      },
      isExpanded: (key) => this.rows.has(key),
      toggleRow: (key) => {
        const next = new Set(this.rows);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        this.rows = next;
      },
      resolve: (token) => this.resolve(token),
      isMoreOpen: (key) => this.more.has(key),
      toggleMore: (key) => {
        const next = new Set(this.more);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        this.more = next;
      },
    };
  }

  /** `@token` → hex through the document colours the appearance model knows (undefined: unresolved). */
  private resolve(token: string): string | undefined {
    if (!token.startsWith('@')) return token;
    const selection = this.model.selection;
    if (selection?.fill?.token === token) return selection.fill.color;
    if (selection?.stroke?.token === token) return selection.stroke.color;
    return undefined;
  }

  private section(s: InspectorSection, body: TemplateResult | typeof nothing, summary = ''): TemplateResult | typeof nothing {
    if (body === nothing) return nothing;
    const open = this.opened[s.id] ?? s.collapsed !== true;
    return html`<section data-section=${s.id} aria-label=${SECTION_HEADINGS[s.id]}>
      <sf-disclosure heading=${SECTION_HEADINGS[s.id]} summary=${summary} key=${`inspector/${s.id}`} ?open=${open} ?pinned=${this.pro} @sf-toggle=${(e: CustomEvent<{ open: boolean }>) => this.setOpen(s.id, e.detail.open)}>
        ${body}
      </sf-disclosure>
    </section>`;
  }

  private header(selection: SelectionSummary | undefined, port: InspectorPort): TemplateResult {
    if (selection === undefined || selection.kind === 'none') {
      const page = this.model.page;
      return html`<header><span class="name">${page?.name ?? inspectorMessages.page}</span><sf-tag mono>${inspectorMessages.page}</sf-tag></header>`;
    }
    const single = selection.nodes.length === 1;
    const lockLabel = selection.locked ? inspectorMessages.unlock : inspectorMessages.lock;
    return html`<header>
      ${single
        ? html`<sf-inline-edit class="name" label=${inspectorMessages.name} .value=${selection.label} @sf-change=${(e: CustomEvent<{ value: string }>) => port.invoke('instaflow/rename', { name: e.detail.value })}></sf-inline-edit>`
        : html`<span class="name">${selection.label}</span>`}
      <sf-tag mono>${selection.typeLabel}</sf-tag>
      <sf-icon-button size="sm" variant="ghost" label=${lockLabel} shortcut="Mod+Shift+L" .pressed=${selection.locked} @click=${() => port.invoke('instaflow/lock', { locked: !selection.locked })}
        ><sf-icon .icon=${selection.locked ? lockIcon : lockOpenIcon} size="16"></sf-icon
      ></sf-icon-button>
    </header>`;
  }

  // ---------------------------------------------------------------- sections

  private pageSection(port: InspectorPort): TemplateResult | typeof nothing {
    const page = this.model.page;
    if (page === undefined) return nothing;
    const preset = pagePresetOf(page.width, page.height);
    const fill = this.model.pageFill;
    return html`<div class="rows">
      <sf-text-field label=${inspectorMessages.pageName} .value=${page.name} @sf-change=${(e: CustomEvent<{ value: string }>) => port.renamePage(e.detail.value)}></sf-text-field>
      <sf-menu label=${inspectorMessages.sizePreset} @sf-select=${(e: CustomEvent<{ value: string }>) => {
        const p = pageSizePresets().find((x) => x.id === e.detail.value);
        if (p !== undefined) port.resizePage(p.width, p.height);
      }}>
        <sf-button slot="trigger" size="sm" variant="ghost" class="wide" aria-label=${`${inspectorMessages.sizePreset}: ${preset?.label ?? inspectorMessages.customSize}`}>${preset?.label ?? inspectorMessages.customSize} <sf-icon .icon=${chevronDownIcon} size="14"></sf-icon></sf-button>
        ${pageSizePresets().map((p) => html`<sf-menu-item type="radio" value=${p.id} ?checked=${p.id === preset?.id}>${p.label}</sf-menu-item>`)}
      </sf-menu>
      <!-- B11c: the kit's size field (units, keep proportions, orientation), the same range as New design. -->
      <sf-size-field
        class="page-size"
        label=${inspectorMessages.pageSize}
        .width=${page.width}
        .height=${page.height}
        .min=${PAGE_SIZE_RANGE.min}
        .max=${PAGE_SIZE_RANGE.max}
        @sf-change=${(e: CustomEvent<{ width: number; height: number }>) => (e.detail.width === page.width && e.detail.height === page.height ? undefined : port.resizePage(e.detail.width, e.detail.height))}
      ></sf-size-field>
      ${fill === undefined
        ? nothing
        : html`<div class="stack" role="group" aria-label=${inspectorMessages.background}>
            <span class="label">${inspectorMessages.background}</span>
            ${fillStack(this.host(), fill, (edit) => port.pageAppearance(edit), { name: inspectorMessages.background, page: true })}
          </div>`}
    </div>`;
  }

  private documentSection(port: InspectorPort): TemplateResult {
    return html`<div class="rows">
      <sf-text-field label=${inspectorMessages.title} .value=${this.model.title} @sf-change=${(e: CustomEvent<{ value: string }>) => port.renameTitle(e.detail.value)}></sf-text-field>
      <div class="row"><span class="label">${inspectorMessages.pages}</span><span class="mono">${this.model.pages}</span></div>
      <div class="row"><span class="label">${inspectorMessages.units}</span><span>${inspectorMessages.pixels}</span></div>
    </div>`;
  }

  private transformSection(port: InspectorPort): TemplateResult | typeof nothing {
    const m = this.model.transform;
    if (m === undefined) return nothing;
    const set = (field: NumericField, value: number, linked = false): void => port.transform({ field, value, ...(linked ? { linked: true } : {}) });
    const moreOpen = this.pro || this.more.has('transform');
    return html`<div class="rows">
      <div class="grid2">
        ${numberField(inspectorMessages.x, round(m.x), (n) => set('x', n), { unit: 'px' })}
        ${numberField(inspectorMessages.y, round(m.y), (n) => set('y', n), { unit: 'px' })}
        ${numberField(inspectorMessages.w, round(m.w), (n) => set('w', Math.max(1, n), this.linked), { min: 1, unit: 'px' })}
        ${numberField(inspectorMessages.h, round(m.h), (n) => set('h', Math.max(1, n), this.linked), { min: 1, unit: 'px' })}
      </div>
      <div class="row">
        ${numberField(inspectorMessages.angle, round(m.rotation, 1), (n) => set('rotation', n), { unit: '°', wrap: 'angle' })}
        <sf-icon-button size="sm" variant="ghost" label=${inspectorMessages.link} .pressed=${this.linked} @click=${() => (this.linked = !this.linked)}><sf-icon .icon=${this.linked ? linkIcon : unlinkIcon} size="16"></sf-icon></sf-icon-button>
      </div>
      <sf-disclosure variant="more" key="inspector/transform-more" .count=${(m.skew !== 0 ? 1 : 0) + (m.flipX ? 1 : 0) + (m.flipY ? 1 : 0)} ?open=${moreOpen} ?pinned=${this.pro} @sf-toggle=${() => this.toggleMore('transform')}>
        <div class="row">
          ${numberField(inspectorMessages.skew, round(m.skew, 1), (n) => set('skew', Math.max(-80, Math.min(80, n))), { unit: '°', min: -80, max: 80 })}
          <sf-icon-button size="sm" variant="ghost" label=${inspectorMessages.flipH} shortcut="Shift+H" .pressed=${m.flipX} @click=${() => port.transform({ flip: 'horizontal' })}><sf-icon .icon=${flipHorizontal2Icon} size="16"></sf-icon></sf-icon-button>
          <sf-icon-button size="sm" variant="ghost" label=${inspectorMessages.flipV} shortcut="Shift+V" .pressed=${m.flipY} @click=${() => port.transform({ flip: 'vertical' })}><sf-icon .icon=${flipVertical2Icon} size="16"></sf-icon></sf-icon-button>
        </div>
      </sf-disclosure>
      ${m.locked > 0 ? html`<p class="muted">${inspectorMessages.lockedStay(m.locked)}</p>` : nothing}
      ${m.transforming
        ? html`<div class="row">
            <sf-button size="sm" variant="primary" @click=${() => port.transformSession('commit')}>${inspectorMessages.apply}</sf-button>
            <sf-button size="sm" variant="ghost" @click=${() => port.transformSession('cancel')}>${inspectorMessages.cancel}</sf-button>
          </div>`
        : nothing}
    </div>`;
  }

  private toggleMore(key: string): void {
    const next = new Set(this.more);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    this.more = next;
  }

  private imageSection(s: SelectionSummary, port: InspectorPort): TemplateResult {
    const fit = (s.fit ?? 'cover') as keyof typeof FIT_LABELS;
    const crop = s.crop ?? { x: 0.5, y: 0.5, scale: 1, rotation: 0 };
    const moreOpen = this.pro || this.more.has('image');
    const setCrop = (patch: Partial<typeof crop>): void => port.invoke('instaflow/image-crop', { crop: patch });
    return html`<div class="rows">
      <div class="row">
        <span class="label">${inspectorMessages.fit}</span>
        <sf-menu label=${inspectorMessages.fit} @sf-select=${(e: CustomEvent<{ value: string }>) => port.setImageFit(e.detail.value)}>
          <sf-button slot="trigger" size="sm" variant="ghost" aria-label=${`${inspectorMessages.fit}: ${FIT_LABELS[fit]}`}>${FIT_LABELS[fit]} <sf-icon .icon=${chevronDownIcon} size="14"></sf-icon></sf-button>
          ${(Object.keys(FIT_LABELS) as (keyof typeof FIT_LABELS)[]).map((f) => html`<sf-menu-item type="radio" value=${f} ?checked=${f === fit}>${FIT_LABELS[f]}</sf-menu-item>`)}
        </sf-menu>
        <sf-button size="sm" @click=${() => port.replaceImage()}>${inspectorMessages.replace}</sf-button>
      </div>
      ${this.model.imageName === undefined ? nothing : html`<div class="row"><span class="label">${inspectorMessages.source}</span><span class="mono">${this.model.imageName}</span></div>`}
      <sf-disclosure variant="more" key="inspector/image-more" .count=${s.cropped === true ? 1 : 0} ?open=${moreOpen} ?pinned=${this.pro} @sf-toggle=${() => this.toggleMore('image')}>
        <div class="grid2">
          ${numberField(inspectorMessages.cropX, Math.round(crop.x * 100), (n) => setCrop({ x: Math.max(0, Math.min(100, n)) / 100 }), { min: 0, max: 100, unit: '%' })}
          ${numberField(inspectorMessages.cropY, Math.round(crop.y * 100), (n) => setCrop({ y: Math.max(0, Math.min(100, n)) / 100 }), { min: 0, max: 100, unit: '%' })}
          ${numberField(inspectorMessages.cropScale, Math.round(crop.scale * 100), (n) => setCrop({ scale: Math.max(1, Math.min(10000, n)) / 100 }), { min: 1, max: 10000, unit: '%' })}
          <sf-menu label=${inspectorMessages.cropRotate} @sf-select=${(e: CustomEvent<{ value: string }>) => setCrop({ rotation: Number(e.detail.value) })}>
            <sf-button slot="trigger" size="sm" variant="ghost" aria-label=${`${inspectorMessages.cropRotate}: ${crop.rotation}°`}>${crop.rotation}° <sf-icon .icon=${chevronDownIcon} size="14"></sf-icon></sf-button>
            ${[0, 90, 180, 270].map((r) => html`<sf-menu-item type="radio" value=${String(r)} ?checked=${r === crop.rotation}>${r}°</sf-menu-item>`)}
          </sf-menu>
        </div>
        ${s.cropped === true ? html`<sf-button size="sm" variant="ghost" @click=${() => port.invoke('instaflow/image-crop-reset')}>${inspectorMessages.resetCrop}</sf-button>` : nothing}
      </sf-disclosure>
    </div>`;
  }

  private frameSection(s: SelectionSummary, port: InspectorPort): TemplateResult {
    return html`<div class="row">
      <sf-button size="sm" variant="ghost" .pressed=${s.clip === true} @click=${() => port.setProp(P.clip, !(s.clip === true), inspectorMessages.clip)}>${inspectorMessages.clip}</sf-button>
    </div>`;
  }

  private repeatSection(port: InspectorPort): TemplateResult | typeof nothing {
    const m = this.model.repeat;
    if (m === undefined) return nothing;
    const params = m.params as unknown as Readonly<Record<string, number | string | boolean>>;
    const fields = m.fields.filter((name) => name !== 'angle' || (m.params.kind === 'mirror' && m.params.axis === 'angle'));
    const set = (patch: Readonly<Record<string, number | string | boolean>>): void => port.repeat({ op: 'set', patch: patch as never });
    return html`<div class="rows">
      <sf-segmented label=${inspectorMessages.repeatKind} .options=${m.kinds.map((k) => ({ value: k, label: inspectorMessages.repeatKinds[k] ?? k }))} .value=${m.params.kind} @sf-change=${(e: CustomEvent<{ value: string }>) => set({ kind: e.detail.value })}></sf-segmented>
      <div class="grid2">
        ${fields.map((name) => {
          const f = REPEAT_FIELDS[name];
          const v = params[name];
          if (f.control === 'number') {
            const shown = typeof v === 'number' ? (f.percent === true ? Math.round(v * 100) : round(v)) : undefined;
            return numberField(f.label, shown, (n) => set({ [name]: f.percent === true ? n / 100 : f.integer === true ? Math.round(n) : n }), { unit: f.unit ?? (f.percent === true ? '%' : '') });
          }
          if (f.control === 'slider') return numberField(f.label, typeof v === 'number' ? v : f.max, (n) => set({ [name]: Math.max(f.min, Math.min(f.max, n)) }), { min: f.min, max: f.max, unit: f.unit });
          if (f.control === 'toggle') return html`<sf-button size="sm" variant="ghost" .pressed=${v === true} @click=${() => set({ [name]: v !== true })}>${v === true ? f.on : f.off}</sf-button>`;
          return html`<sf-segmented label=${f.label} .options=${f.options.map(([value, label]) => ({ value, label }))} .value=${String(v)} @sf-change=${(e: CustomEvent<{ value: string }>) => set({ [name]: e.detail.value })}></sf-segmented>`;
        })}
      </div>
      <p class="muted">${inspectorMessages.instances(m.instances)}</p>
      <div class="row">
        <sf-button size="sm" @click=${() => port.repeat({ op: 'expand' })}>${inspectorMessages.expand}</sf-button>
        <sf-button size="sm" variant="ghost" @click=${() => port.repeat({ op: 'release' })}>${inspectorMessages.release}</sf-button>
      </div>
    </div>`;
  }

  private combineSection(s: SelectionSummary, port: InspectorPort): TemplateResult {
    return html`<div class="rows">
      <sf-segmented
        label=${inspectorMessages.operation}
        .options=${Object.entries(inspectorMessages.operations).map(([value, label]) => ({ value, label }))}
        .value=${s.booleanOp ?? 'union'}
        @sf-change=${(e: CustomEvent<{ value: string }>) => port.setProp(P.boolean, e.detail.value, inspectorMessages.operations[e.detail.value] ?? inspectorMessages.operation)}
      ></sf-segmented>
      <div class="row">
        <sf-button size="sm" variant="ghost" @click=${() => port.invoke('instaflow/boolean-release')}>${inspectorMessages.release}</sf-button>
        <sf-button size="sm" variant="ghost" @click=${() => port.invoke('instaflow/flatten')}>${inspectorMessages.flatten}</sf-button>
      </div>
    </div>`;
  }

  private maskSection(s: SelectionSummary, port: InspectorPort): TemplateResult | typeof nothing {
    const mask = s.mask;
    if (mask === undefined) return nothing;
    return html`<div class="rows">
      <sf-segmented
        label=${inspectorMessages.maskMode}
        .options=${Object.entries(inspectorMessages.maskModes).map(([value, label]) => ({ value, label }))}
        .value=${mask.mode}
        @sf-change=${(e: CustomEvent<{ value: string }>) => port.invoke(`instaflow/mask-${e.detail.value}`, undefined, [mask.node])}
      ></sf-segmented>
      <div class="row">
        <sf-button size="sm" variant="ghost" .pressed=${mask.invert} @click=${() => port.invoke('instaflow/mask-invert', undefined, [mask.node])}>${inspectorMessages.invert}</sf-button>
        <sf-button size="sm" variant="ghost" @click=${() => port.invoke('instaflow/mask-release', undefined, [mask.node])}>${inspectorMessages.release}</sf-button>
      </div>
    </div>`;
  }

  private single(s: SelectionSummary): AppearanceModel | undefined {
    const a = this.model.appearance;
    return s.nodes.length === 1 && a !== undefined && a.node === s.nodes[0] ? a : undefined;
  }

  private fillSection(s: SelectionSummary, port: InspectorPort): TemplateResult | typeof nothing {
    const a = this.single(s);
    if (a !== undefined) return fillStack(this.host(), a, (edit) => port.appearance(edit));
    if (s.fill === undefined) return nothing;
    return sharedPaintRow(this.host(), paintMessages.fill, paintMessages.mixedFills, s.fill, (paint) => port.setPaint('fills', paint, 'Fill'));
  }

  private strokeSection(s: SelectionSummary, port: InspectorPort): TemplateResult | typeof nothing {
    const a = this.single(s);
    if (a !== undefined) return strokeStack(this.host(), a, (edit) => port.appearance(edit), { sides: s.common === 'rectangle' || s.common === 'frame' || s.common === 'image' });
    if (s.stroke === undefined) return nothing;
    return sharedPaintRow(this.host(), paintMessages.stroke, paintMessages.mixedStrokes, s.stroke, (paint) => port.setPaint('strokes', paint, 'Stroke'));
  }

  private effectsSection(s: SelectionSummary, port: InspectorPort): TemplateResult {
    const a = this.single(s);
    if (a !== undefined) return effectStack(this.host(), a, (edit) => port.appearance(edit));
    return effectPresetMenu(inspectorMessages.replaceAll, false, [], (items) => port.setProp(P.effects, typeof items === 'string' ? items : [...items], paintMessages.effects));
  }

  private layerSectionFor(s: SelectionSummary, port: InspectorPort): TemplateResult {
    const a = this.single(s);
    if (a !== undefined) return layerSection(a.opacity, a.blend, (o) => port.appearance({ op: 'set', path: P.opacity, value: o }), (b) => port.appearance({ op: 'set', path: P.blend, value: b }));
    return layerSection(
      s.opacity ?? 1,
      (s.blend ?? 'normal') as BlendModeName | 'mixed',
      (o) => port.setProp(P.opacity, o, 'Opacity'),
      (b) => port.setProp(P.blend, b, 'Blend'),
    );
  }

  private summaryOf(id: InspectorSectionId, s: SelectionSummary): string {
    const a = this.single(s);
    if (id === 'effects') return a === undefined ? '' : effectsSummary(a);
    if (id === 'layer') return a !== undefined ? layerSummary(a.opacity, a.blend) : s.opacity === 'mixed' || s.blend === 'mixed' ? 'Mixed' : layerSummary(s.opacity ?? 1, (s.blend ?? 'normal') as BlendModeName);
    if (id === 'corners') return a === undefined || typeof a.radius !== 'number' || a.radius === 0 ? '' : `${a.radius} px`;
    if (id === 'stroke') return a === undefined ? '' : a.strokes.length === 0 ? 'None' : a.strokes.length === 1 ? '1 stroke' : `${a.strokes.length} strokes`;
    return '';
  }

  private body(id: InspectorSectionId, s: SelectionSummary | undefined, port: InspectorPort): TemplateResult | typeof nothing {
    if (id === 'page') return this.pageSection(port);
    if (id === 'document') return this.documentSection(port);
    if (s === undefined) return nothing;
    const views: Readonly<Record<InspectorSectionId, () => TemplateResult | typeof nothing>> = {
      page: () => nothing,
      document: () => nothing,
      transform: () => this.transformSection(port),
      text: () => (this.model.typography === undefined ? nothing : textSection(this.host(), this.model.typography, port.text)),
      image: () => this.imageSection(s, port),
      frame: () => this.frameSection(s, port),
      repeat: () => this.repeatSection(port),
      combine: () => this.combineSection(s, port),
      mask: () => this.maskSection(s, port),
      fill: () => this.fillSection(s, port),
      stroke: () => this.strokeSection(s, port),
      corners: () => {
        const a = this.single(s);
        return a === undefined ? nothing : cornersSection(a, (edit) => port.appearance(edit));
      },
      effects: () => this.effectsSection(s, port),
      layer: () => this.layerSectionFor(s, port),
      locked: () =>
        html`<div class="rows">
          <p class="muted">${inspectorMessages.lockedLine}</p>
          <div class="row"><sf-button size="sm" @click=${() => port.invoke('instaflow/lock', { locked: false })}><sf-icon .icon=${lockOpenIcon} size="16"></sf-icon> ${inspectorMessages.unlock}</sf-button></div>
        </div>`,
    };
    return views[id]();
  }

  override render(): TemplateResult | typeof nothing {
    const port = this.port;
    if (port === undefined) return nothing;
    const s = this.model.selection;
    const kind = s?.kind ?? 'none';
    const sections = inspectorSections(kind, s?.common);
    return html`${this.header(s, port)}
      ${sections.map((section) => this.section(section, this.body(section.id, s, port), s === undefined ? '' : this.summaryOf(section.id, s)))}`;
  }
}

/** Define `<if-inspector>` and the kit components it renders. */
export function defineInspectorElement(registry: CustomElementRegistry = customElements): void {
  defineButton(registry);
  defineColorPopover(registry);
  defineDisclosure(registry);
  defineFontPicker(registry);
  defineIconElement(registry);
  defineIconButton(registry);
  defineInlineEdit(registry);
  defineMenu(registry);
  defineNumberField(registry);
  definePopover(registry);
  defineSegmented(registry);
  defineSizeField(registry);
  defineSlider(registry);
  defineSwatch(registry);
  defineTag(registry);
  defineTextField(registry);
  if (registry.get(spec.tag) === undefined) defineComponent(IfInspectorElement, registry);
}

declare global {
  interface HTMLElementTagNameMap {
    'if-inspector': IfInspectorElement;
  }
}
