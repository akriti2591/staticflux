/**
 * The **New design** dialog (B11b, HOME-FILES §1.3): the one question that cannot be undone cheaply, the page size. A
 * 520 px modal over Home (native `<dialog>`: focus is held, Escape closes, focus returns to the trigger):
 *
 * - **Format** chips (a radio group: Post · Story · Landscape · Slide 16:9 · Poster A4 · Letter · Custom), the last
 *   used one pre-selected; a chip fills the size, editing the size selects Custom;
 * - **Size**: the kit's `<sf-size-field>` (W × H, keep proportions, orientation, units) with `Presets ▾` (social,
 *   print, screen; `size-presets.ts`);
 * - **Start from**: Blank, Last design (its page size), or a workspace template (its size, locked, `Template size`);
 * - **Name** (`Untitled design`, focused and selected on open; Enter creates);
 * - `More ▾`: Pages (1…50) and Background;
 * - Cancel · **Create** (Mod+Enter from anywhere). Create fires `if-create` with the `new-design` capability's input
 *   (or `{ template, name }`), and the host runs it; the dialog remembers the format, size and unit on this device.
 *
 * The draft is plain data (`NewDesignDraft`, pure functions below), so the rules are tested without a DOM.
 */
import { defineButton } from '@staticflux/kit/button';
import { defineColorField } from '@staticflux/kit/color-field';
import { defineDisclosure } from '@staticflux/kit/disclosure';
import { defineIconElement } from '@staticflux/kit/icon';
import { defineIconButton } from '@staticflux/kit/icon-button';
import { xIcon } from '@staticflux/kit/icons/x';
import { defineMenu } from '@staticflux/kit/menu';
import { defineNumberField } from '@staticflux/kit/number-field';
import { defineSizeField, type SizeChangeDetail } from '@staticflux/kit/size-field';
import { defineTextField } from '@staticflux/kit/text-field';
import { component, defineComponent, SfElement } from '@staticflux/ui';
import { themeTokens as t } from '@staticflux/ui/theme';
import { css, html, nothing, type TemplateResult } from 'lit';
import { lensMarkStyle, lensOf } from '../theme/lenses.js';
import type { NewDesignInput } from './capabilities.js';
import { CUSTOM_FORMAT, DEFAULT_DESIGN_FORMAT, DESIGN_FORMATS, DESIGN_PAGE_LIMITS, DESIGN_SIZE_LIMITS, designFormat, type DesignFormatId, formatOfSize, groupDigits, NEW_DESIGN_CHIPS, type NewDesignFormatId } from './formats.js';
import type { DesignSize, HomeEntry } from './index-record.js';
import { DESIGN_UNITS, type DesignUnit } from './routes.js';
import { SIZE_PRESET_GROUPS, sizePreset } from './size-presets.js';

export const NEW_DESIGN_TAG = 'if-new-design';
/** This device's last choice (HOME-FILES §1.3: the last used format is pre-selected). */
export const NEW_DESIGN_MEMORY_KEY = 'instaflow/ui/new-design';
export const UNTITLED = 'Untitled design';
export const DEFAULT_BACKGROUND = '#ffffff';

export const newDesignMessages = Object.freeze({
  title: 'New design',
  close: 'Close',
  format: 'Format',
  custom: 'Custom',
  size: 'Size',
  presets: 'Presets',
  startFrom: 'Start from',
  blank: 'Blank',
  lastDesign: 'Last design',
  templateSize: 'Template size',
  usesTemplate: 'Uses the template’s size',
  name: 'Name',
  more: 'More',
  pages: 'Pages',
  background: 'Background',
  cancel: 'Cancel',
  create: 'Create',
});
const m = newDesignMessages;
/** The chips in order: the formats, then Custom. */
const CHIP_ORDER: readonly NewDesignFormatId[] = [...NEW_DESIGN_CHIPS, CUSTOM_FORMAT];

/** Where the design starts: blank, the last design's size, or a template. */
export type StartFrom = { readonly kind: 'blank' } | { readonly kind: 'last' } | { readonly kind: 'template'; readonly asset: string };

export interface NewDesignDraft {
  readonly format: NewDesignFormatId;
  readonly size: DesignSize;
  readonly unit: DesignUnit;
  readonly start: StartFrom;
  readonly name: string;
  readonly pages: number;
  readonly background: string;
}

/** What this device remembers (format, size, unit). */
export interface NewDesignMemory {
  readonly format: NewDesignFormatId;
  readonly size: DesignSize;
  readonly unit: DesignUnit;
}

const isUnit = (v: unknown): v is DesignUnit => typeof v === 'string' && (DESIGN_UNITS as readonly string[]).includes(v);
const isSide = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= DESIGN_SIZE_LIMITS.min && v <= DESIGN_SIZE_LIMITS.max;

/** The remembered choice (tolerant: anything malformed is ignored). */
export function readNewDesignMemory(storage: Pick<Storage, 'getItem'> | undefined): NewDesignMemory | undefined {
  try {
    const raw = storage?.getItem(NEW_DESIGN_MEMORY_KEY);
    const v = raw === null || raw === undefined ? undefined : (JSON.parse(raw) as Partial<NewDesignMemory>);
    if (v === undefined || !isSide(v.size?.width) || !isSide(v.size?.height) || !isUnit(v.unit)) return undefined;
    const format = v.format === CUSTOM_FORMAT || NEW_DESIGN_CHIPS.includes(v.format as DesignFormatId) ? (v.format as NewDesignFormatId) : formatOfSize(v.size);
    return { format, size: { width: v.size.width, height: v.size.height }, unit: v.unit };
  } catch {
    return undefined;
  }
}

export function writeNewDesignMemory(storage: Pick<Storage, 'setItem'> | undefined, draft: NewDesignDraft): void {
  try {
    storage?.setItem(NEW_DESIGN_MEMORY_KEY, JSON.stringify({ format: draft.format, size: draft.size, unit: draft.unit }));
  } catch {
    // Memory is a convenience (private windows, blocked storage).
  }
}

/** The draft the dialog opens with: the last choice on this device, else the default format; `format` overrides. */
export function initialDraft(memory: NewDesignMemory | undefined, format?: NewDesignFormatId): NewDesignDraft {
  const base: NewDesignDraft = { format: DEFAULT_DESIGN_FORMAT, size: DESIGN_FORMATS[DEFAULT_DESIGN_FORMAT].size, unit: 'px', start: { kind: 'blank' }, name: UNTITLED, pages: 1, background: DEFAULT_BACKGROUND };
  const remembered = memory === undefined ? base : { ...base, format: memory.format, size: memory.size, unit: memory.unit, pages: memory.format === CUSTOM_FORMAT ? 1 : designFormat(memory.format).pages };
  if (format === undefined || format === remembered.format) return remembered;
  return format === CUSTOM_FORMAT ? { ...remembered, format } : chooseFormat(remembered, format);
}

/** Choose a chip: its size and page count. */
export function chooseFormat(draft: NewDesignDraft, id: NewDesignFormatId): NewDesignDraft {
  if (id === CUSTOM_FORMAT) return { ...draft, format: id };
  const f = DESIGN_FORMATS[id];
  return { ...draft, format: id, size: f.size, pages: f.pages, start: draft.start.kind === 'template' ? { kind: 'blank' } : draft.start };
}

/** Edit the size pair: a size that is not a chip's selects Custom (HOME-FILES §1.3). */
export function setDraftSize(draft: NewDesignDraft, size: DesignSize, unit: DesignUnit = draft.unit): NewDesignDraft {
  const same = size.width === draft.size.width && size.height === draft.size.height;
  return { ...draft, size, unit, format: same ? draft.format : CUSTOM_FORMAT };
}

/** Start from blank, the last design (its size) or a template (its size; the template wins over a chip). */
export function setStartFrom(draft: NewDesignDraft, start: StartFrom, sizes: { readonly last?: DesignSize; readonly template?: (asset: string) => DesignSize | undefined }): NewDesignDraft {
  const size = start.kind === 'last' ? sizes.last : start.kind === 'template' ? sizes.template?.(start.asset) : undefined;
  return size === undefined ? { ...draft, start } : { ...draft, start, size, format: formatOfSize(size) };
}

/** What Create asks for: the capability input of a blank design, or the template and name. */
export function draftRequest(draft: NewDesignDraft): { readonly kind: 'new'; readonly input: NewDesignInput } | { readonly kind: 'template'; readonly template: string; readonly name: string } {
  const name = draft.name.trim();
  if (draft.start.kind === 'template') return { kind: 'template', template: draft.start.asset, name: name === '' ? UNTITLED : name };
  const chip = draft.format === CUSTOM_FORMAT ? undefined : DESIGN_FORMATS[draft.format];
  const matches = chip !== undefined && chip.size.width === draft.size.width && chip.size.height === draft.size.height;
  const input: NewDesignInput = {
    ...(matches ? { format: draft.format } : { format: CUSTOM_FORMAT, width: draft.size.width, height: draft.size.height }),
    ...(draft.unit === 'px' ? {} : { unit: draft.unit }),
    ...((matches ? chip.pages : 1) === draft.pages ? {} : { pages: draft.pages }),
    ...(name === '' || name === UNTITLED ? {} : { name }),
    ...(draft.background.toLowerCase() === DEFAULT_BACKGROUND ? {} : { background: draft.background.toLowerCase() }),
  };
  return { kind: 'new', input };
}

export type NewDesignCreateDetail = ReturnType<typeof draftRequest>;

const spec = component({
  tag: NEW_DESIGN_TAG,
  placeholder: () => nothing,
  description: 'Home’s New design dialog: format chips, the size field pair, start from, name, pages and background.',
});

export class IfNewDesignElement extends SfElement<typeof spec> {
  static override readonly spec = spec;
  static override properties = {
    templates: { attribute: false },
    last: { attribute: false },
    draft: { state: true },
  };
  static override styles = css`
    dialog {
      inline-size: min(520px, calc(100vw - 32px));
      max-block-size: calc(100vh - 32px);
      padding: 0;
      border: 1px solid ${t.color.border.css};
      border-radius: 18px;
      background: ${t.color.surface2.css};
      color: ${t.color.text.css};
      box-shadow: ${t.shadow.level3.css};
      font-family: ${t.font.family.css};
    }
    dialog::backdrop {
      background: ${t.color.backdrop.css};
    }
    form {
      display: flex;
      flex-direction: column;
      gap: ${t.space.lg.css};
      padding: ${t.space.xl.css};
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    h2 {
      margin: 0;
      font-family: ${t.font.familyDisplay.css};
      font-weight: ${t.font.weightDisplay.css};
      font-size: 22px;
    }
    fieldset {
      margin: 0;
      padding: 0;
      border: 0;
    }
    .label {
      display: block;
      margin-block-end: ${t.space.xs.css};
      font-size: ${t.type.sizeSm.css};
      font-weight: ${t.font.weightSemibold.css};
    }
    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: ${t.space.xs.css};
    }
    .chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-block-size: 32px;
      padding-inline: 10px;
      border: 1px solid ${t.color.controlEdge.css};
      border-radius: 999px;
      background: ${t.color.surface1.css};
      color: ${t.color.text.css};
      font: inherit;
      font-size: ${t.type.sizeSm.css};
      cursor: pointer;
    }
    .chip[aria-checked='true'] {
      border-color: ${t.color.accent.css};
      background: ${t.color.accentSubtle.css};
    }
    .chip:focus-visible,
    select:focus-visible {
      outline: 2px solid ${t.color.focusRing.css};
      outline-offset: 2px;
    }
    .mono {
      font-family: ${t.font.familyMono.css};
      color: ${t.color.textMuted.css};
    }
    select {
      block-size: ${t.size.control.css};
      padding-inline: ${t.space.sm.css};
      border: 1px solid ${t.color.controlEdge.css};
      border-radius: ${t.radius.control.css};
      background: ${t.color.surface1.css};
      color: ${t.color.text.css};
      font: inherit;
    }
    .hint {
      margin: ${t.space.xs.css} 0 0;
      color: ${t.color.textMuted.css};
      font-size: ${t.type.sizeSm.css};
    }
    .more {
      display: flex;
      gap: ${t.space.md.css};
      flex-wrap: wrap;
      align-items: flex-end;
    }
    footer {
      display: flex;
      justify-content: flex-end;
      gap: ${t.space.sm.css};
    }
    @media (forced-colors: active) {
      .chip[aria-checked='true'] {
        border-color: Highlight;
      }
    }
  `;

  declare templates: readonly HomeEntry[];
  /** The last design's page size (`Start from › Last design`). */
  declare last: DesignSize | undefined;
  declare draft: NewDesignDraft;

  constructor() {
    super();
    this.templates = [];
    this.last = undefined;
    this.draft = initialDraft(undefined);
  }

  private get dialog(): HTMLDialogElement | null {
    return this.renderRoot.querySelector('dialog');
  }

  get open(): boolean {
    return this.dialog?.open === true;
  }

  /** Open on the remembered choice (or `format`); `focus: 'width'` puts the caret in W (Custom size…), else the name. */
  async show(options: { readonly format?: NewDesignFormatId; readonly focus?: 'width' | 'name' } = {}): Promise<void> {
    this.draft = initialDraft(readNewDesignMemory(globalThis.localStorage), options.format);
    await this.updateComplete;
    const dialog = this.dialog;
    if (dialog === null) return;
    if (!dialog.open) dialog.showModal();
    await this.updateComplete;
    if (options.focus === 'width') {
      const w = this.renderRoot.querySelector('sf-size-field')?.shadowRoot?.querySelector<HTMLElement>('sf-number-field[data-side="width"]');
      (w?.shadowRoot?.querySelector('input') ?? w)?.focus();
    } else {
      const input = this.renderRoot.querySelector('sf-text-field.name')?.shadowRoot?.querySelector('input');
      input?.focus();
      input?.select();
    }
  }

  close(): void {
    this.dialog?.close();
  }

  private create(): void {
    writeNewDesignMemory(globalThis.localStorage, this.draft);
    const detail = draftRequest(this.draft);
    this.close();
    this.dispatchEvent(new CustomEvent<NewDesignCreateDetail>('if-create', { detail, bubbles: true, composed: true }));
  }

  private onChipKey(e: KeyboardEvent): void {
    const order = CHIP_ORDER;
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (step === 0) return;
    e.preventDefault();
    const at = order.indexOf(this.draft.format);
    const next = order[(at + step + order.length) % order.length] as NewDesignFormatId;
    this.draft = chooseFormat(this.draft, next);
    void this.updateComplete.then(() => this.renderRoot.querySelector<HTMLElement>(`.chip[data-format="${next}"]`)?.focus());
  }

  private chip(id: NewDesignFormatId): TemplateResult {
    const checked = this.draft.format === id;
    const f = id === CUSTOM_FORMAT ? undefined : DESIGN_FORMATS[id];
    return html`<button
      type="button"
      class="chip"
      role="radio"
      data-format=${id}
      aria-checked=${checked ? 'true' : 'false'}
      tabindex=${checked ? '0' : '-1'}
      @click=${() => (this.draft = chooseFormat(this.draft, id))}
    >
      <span aria-hidden="true" style=${lensMarkStyle(lensOf(f?.lens ?? 'layout'), 1)}></span>
      <span>${f?.title ?? m.custom}</span>
      ${f === undefined ? nothing : html`<span class="mono">${groupDigits(f.size.width)} × ${groupDigits(f.size.height)}</span>`}
    </button>`;
  }

  private renderStartFrom(): TemplateResult {
    const value = this.draft.start.kind === 'template' ? `template:${this.draft.start.asset}` : this.draft.start.kind;
    const sizes = { ...(this.last === undefined ? {} : { last: this.last }), template: (asset: string) => this.templates.find((e) => e.asset === asset)?.format };
    const onChange = (e: Event): void => {
      const v = (e.target as HTMLSelectElement).value;
      const start: StartFrom = v.startsWith('template:') ? { kind: 'template', asset: v.slice('template:'.length) } : v === 'last' ? { kind: 'last' } : { kind: 'blank' };
      this.draft = setStartFrom(this.draft, start, sizes);
    };
    return html`<div>
      <label class="label" for="start">${m.startFrom}</label>
      <select id="start" .value=${value} @change=${onChange}>
        <option value="blank" ?selected=${value === 'blank'}>${m.blank}</option>
        ${this.last === undefined ? nothing : html`<option value="last" ?selected=${value === 'last'}>${m.lastDesign}</option>`}
        ${this.templates.map(
          (tpl) =>
            html`<option value=${`template:${tpl.asset}`} ?selected=${value === `template:${tpl.asset}`}>
              ${tpl.title}${tpl.format === undefined ? '' : ` · ${tpl.format.width} × ${tpl.format.height}`}
            </option>`,
        )}
      </select>
      ${this.draft.start.kind === 'template' ? html`<p class="hint">${m.usesTemplate}</p>` : nothing}
    </div>`;
  }

  override render(): TemplateResult {
    const d = this.draft;
    const template = d.start.kind === 'template';
    return html`<dialog aria-labelledby="nd-title" @close=${() => this.dispatchEvent(new CustomEvent('if-close', { bubbles: true, composed: true }))}>
      <form
        @submit=${(e: SubmitEvent) => {
          e.preventDefault();
          this.create();
        }}
        @keydown=${(e: KeyboardEvent) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            this.create();
          }
        }}
      >
        <header>
          <h2 id="nd-title">${m.title}</h2>
          <sf-icon-button label=${m.close} variant="ghost" @click=${() => this.close()}><sf-icon .icon=${xIcon} size="18"></sf-icon></sf-icon-button>
        </header>
        <fieldset>
          <span class="label" id="nd-format">${m.format}</span>
          <div class="chips" role="radiogroup" aria-labelledby="nd-format" @keydown=${(e: KeyboardEvent) => this.onChipKey(e)}>${CHIP_ORDER.map((id) => this.chip(id))}</div>
        </fieldset>
        <div>
          <span class="label">${m.size}</span>
          <sf-size-field
            label=${m.size}
            .width=${d.size.width}
            .height=${d.size.height}
            unit=${d.unit}
            min=${DESIGN_SIZE_LIMITS.min}
            max=${DESIGN_SIZE_LIMITS.max}
            ?disabled=${template}
            @sf-change=${(e: CustomEvent<SizeChangeDetail>) => (this.draft = setDraftSize(this.draft, { width: e.detail.width, height: e.detail.height }, e.detail.unit))}
            @sf-submit=${() => this.create()}
          >
            <sf-menu slot="presets" label=${m.presets} @sf-select=${(e: CustomEvent<{ value: string }>) => {
              const preset = sizePreset(e.detail.value);
              if (preset !== undefined) this.draft = setDraftSize(this.draft, preset.size);
            }}>
              <sf-button slot="trigger" variant="secondary" size="sm" ?disabled=${template}>${m.presets} ▾</sf-button>
              ${SIZE_PRESET_GROUPS.map(
                (g) => html`<sf-menu-group label=${g.label}>
                  ${g.presets.map((p) => html`<sf-menu-item value=${p.id}>${p.label} · ${groupDigits(p.size.width)} × ${groupDigits(p.size.height)}</sf-menu-item>`)}
                </sf-menu-group>`,
              )}
            </sf-menu>
          </sf-size-field>
          ${template ? html`<p class="hint">${m.templateSize}</p>` : nothing}
        </div>
        ${this.renderStartFrom()}
        <sf-text-field
          class="name"
          label=${m.name}
          .value=${d.name}
          @input=${(e: Event) => (this.draft = { ...this.draft, name: (e.composedPath()[0] as HTMLInputElement).value ?? '' })}
          @keydown=${(e: KeyboardEvent) => {
            if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
              e.preventDefault();
              this.create();
            }
          }}
        ></sf-text-field>
        <sf-disclosure variant="more" heading=${m.more}>
          <div class="more">
            <sf-number-field
              label=${m.pages}
              .value=${d.pages}
              min=${DESIGN_PAGE_LIMITS.min}
              max=${DESIGN_PAGE_LIMITS.max}
              step="1"
              precision="0"
              ?disabled=${template}
              @sf-change=${(e: CustomEvent<{ value?: number }>) => (e.detail.value === undefined ? undefined : (this.draft = { ...this.draft, pages: Math.round(e.detail.value) }))}
            ></sf-number-field>
            <sf-color-field label=${m.background} value=${d.background} @sf-change=${(e: CustomEvent<{ value: string }>) => (this.draft = { ...this.draft, background: e.detail.value })}></sf-color-field>
          </div>
        </sf-disclosure>
        <footer>
          <sf-button variant="secondary" @click=${() => this.close()}>${m.cancel}</sf-button>
          <sf-button variant="primary" @click=${() => this.create()}>${m.create}</sf-button>
        </footer>
      </form>
    </dialog>`;
  }
}

export function defineNewDesign(registry: CustomElementRegistry = customElements): void {
  defineButton(registry);
  defineIconElement(registry);
  defineIconButton(registry);
  defineMenu(registry);
  defineNumberField(registry);
  defineSizeField(registry);
  defineTextField(registry);
  defineDisclosure(registry);
  defineColorField(registry);
  if (registry.get(spec.tag) === undefined) defineComponent(IfNewDesignElement, registry);
}

declare global {
  interface HTMLElementTagNameMap {
    'if-new-design': IfNewDesignElement;
  }
}
