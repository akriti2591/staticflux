/**
 * The inspector's Text section (B11b, TEXT-FONTS-UX-SPEC §4.2 control table, §4.4 per density): `Style ▾` (the M1
 * presets), `Font ▾` (the font picker), `Weight ▾`, Size, Colour, the `B I U S` row with Link, the Align row; behind
 * `More ▾` (open in Pro): Line height, Letter spacing, Paragraph spacing and first-line indent, Auto-size, Vertical
 * align (fixed boxes only), Case ▾, Sub/superscript, Clear formatting and Fit to box (not on auto boxes). Lists are
 * stored but not drawn yet (T-10, M2), so `List ▾` is not rendered. Templates only; every control runs one
 * typography command (one undo step).
 */
import type { FontEntry } from '@staticflux/kit/font-picker';
import { boldIcon } from '@staticflux/kit/icons/bold';
import { caseSensitiveIcon } from '@staticflux/kit/icons/case-sensitive';
import { chevronDownIcon } from '@staticflux/kit/icons/chevron-down';
import { italicIcon } from '@staticflux/kit/icons/italic';
import { linkIcon } from '@staticflux/kit/icons/link';
import { removeFormattingIcon } from '@staticflux/kit/icons/remove-formatting';
import { strikethroughIcon } from '@staticflux/kit/icons/strikethrough';
import { subscriptIcon } from '@staticflux/kit/icons/subscript';
import { superscriptIcon } from '@staticflux/kit/icons/superscript';
import { textAlignCenterIcon } from '@staticflux/kit/icons/text-align-center';
import { textAlignEndIcon } from '@staticflux/kit/icons/text-align-end';
import { textAlignJustifyIcon } from '@staticflux/kit/icons/text-align-justify';
import { textAlignStartIcon } from '@staticflux/kit/icons/text-align-start';
import { textAutoHeightIcon } from '@staticflux/kit/icons/text-auto-height';
import { textAutoWidthIcon } from '@staticflux/kit/icons/text-auto-width';
import { textFixedIcon } from '@staticflux/kit/icons/text-fixed';
import { underlineIcon } from '@staticflux/kit/icons/underline';
import { alignVerticalJustifyCenterIcon } from '@staticflux/kit/icons/align-vertical-justify-center';
import { alignVerticalJustifyEndIcon } from '@staticflux/kit/icons/align-vertical-justify-end';
import { alignVerticalJustifyStartIcon } from '@staticflux/kit/icons/align-vertical-justify-start';
import type { IconDef } from '@staticflux/kit/icon';
import type { NumberChangeDetail } from '@staticflux/kit/number-field';
import { html, nothing, type TemplateResult } from 'lit';
import type { TextAlign, TextBox, VerticalAlign } from '../text/model.js';
import { type FontChoice, MIXED, TEXT_CASES, TEXT_PRESETS, type TextCase, type TextPresetName, type TypographyService, type TypographySummary } from '../text/typography.js';
import { colorSwatch, type PaintHost } from './inspector-paint.js';

/** The typography commands the section runs (the editor's typography service, through its mirror). */
export type TextCommands = Omit<TypographyService, 'summary' | 'fontChoices' | 'colorChoices' | 'onChange'>;

export const textMessages = Object.freeze({
  style: 'Style',
  custom: 'Custom',
  font: 'Font',
  weight: 'Weight',
  size: 'Size',
  colour: 'Text colour',
  bold: 'Bold',
  italic: 'Italic',
  underline: 'Underline',
  strike: 'Strikethrough',
  link: 'Link',
  linkUrl: 'Link address',
  linkRemove: 'Remove link',
  linkApply: 'Apply',
  align: 'Text alignment',
  alignLabels: { start: 'Align left', center: 'Centre', end: 'Align right', justify: 'Justify' } as Readonly<Record<TextAlign, string>>,
  more: 'More',
  lineHeight: 'Line height',
  letterSpacing: 'Letter spacing',
  spaceBefore: 'Space before',
  spaceAfter: 'Space after',
  indent: 'First-line indent',
  autoSize: 'Auto-size',
  boxes: { 'auto-width': 'Auto width', 'auto-height': 'Auto height', fixed: 'Fixed' } as Readonly<Record<TextBox, string>>,
  verticalAlign: 'Vertical align',
  verticals: { top: 'Top', middle: 'Middle', bottom: 'Bottom' } as Readonly<Record<VerticalAlign, string>>,
  case: 'Convert case',
  cases: { upper: 'UPPER', lower: 'lower', title: 'Title Case', sentence: 'Sentence case' } as Readonly<Record<TextCase, string>>,
  subscript: 'Subscript',
  superscript: 'Superscript',
  clear: 'Clear formatting',
  fit: 'Fit to box',
  mixed: 'Mixed',
  sizePresets: 'Size presets',
});

/** B11c audit (TEXT-FONTS §4.2): the sizes the `▾` beside Size offers. */
export const SIZE_PRESETS: readonly number[] = Object.freeze([12, 14, 16, 18, 20, 24, 32, 40, 48, 64, 96]);

/** `Weight ▾`: the named weights (the engine synthesises the ones a face lacks, TEXT-FONTS §5.2). */
export const WEIGHTS: readonly (readonly [number, string])[] = Object.freeze([
  [100, 'Thin'],
  [200, 'Extra light'],
  [300, 'Light'],
  [400, 'Regular'],
  [500, 'Medium'],
  [600, 'Semibold'],
  [700, 'Bold'],
  [800, 'Extra bold'],
  [900, 'Black'],
] as const);

const ALIGN_ICONS: Readonly<Record<TextAlign, IconDef>> = { start: textAlignStartIcon, center: textAlignCenterIcon, end: textAlignEndIcon, justify: textAlignJustifyIcon };
const ALIGN_KEYS: Readonly<Record<TextAlign, string>> = { start: 'Mod+Shift+L', center: 'Mod+Shift+E', end: 'Mod+Shift+R', justify: 'Mod+Shift+J' };
const BOX_ICONS: Readonly<Record<TextBox, IconDef>> = { 'auto-width': textAutoWidthIcon, 'auto-height': textAutoHeightIcon, fixed: textFixedIcon };
const VERTICAL_ICONS: Readonly<Record<VerticalAlign, IconDef>> = { top: alignVerticalJustifyStartIcon, middle: alignVerticalJustifyCenterIcon, bottom: alignVerticalJustifyEndIcon };

const value = <T>(v: T | typeof MIXED | undefined): T | undefined => (v === MIXED ? undefined : v);
const isMixed = (v: unknown): boolean => v === MIXED;

const numberField = (label: string, v: number | typeof MIXED | undefined, commit: (n: number) => void, o: { min?: number; max?: number; step?: number; unit?: string } = {}): TemplateResult =>
  html`<sf-number-field
    label=${label}
    .value=${value(v)}
    ?mixed=${isMixed(v)}
    min=${o.min ?? nothing}
    max=${o.max ?? nothing}
    step=${o.step ?? nothing}
    unit=${o.unit ?? ''}
    @sf-change=${(e: CustomEvent<NumberChangeDetail>) => {
      if (e.detail.value !== undefined) commit(e.detail.value);
    }}
  ></sf-number-field>`;

const toggle = (label: string, icon: IconDef, on: boolean | typeof MIXED, run: () => void, shortcut?: string): TemplateResult =>
  html`<sf-icon-button size="sm" variant="ghost" label=${label} shortcut=${shortcut ?? nothing} .pressed=${on === true} @click=${run}><sf-icon .icon=${icon} size="16"></sf-icon></sf-icon-button>`;

/** What the section needs besides the paint host (fonts, the More row's state). */
export interface TextHost extends PaintHost {
  readonly fonts: readonly FontChoice[];
  isMoreOpen(key: string): boolean;
  toggleMore(key: string): void;
}

function fontPicker(host: TextHost, s: TypographySummary, text: TextCommands): TemplateResult {
  const current = s.font;
  const family = current === MIXED ? textMessages.mixed : current !== undefined && 'family' in current ? (current.family ?? textMessages.font) : textMessages.font;
  const fonts: FontEntry[] = host.fonts.map((f) => ({ family: f.label, cached: true }));
  return html`<sf-popover label=${textMessages.font} outside="pass">
    <sf-button slot="trigger" size="sm" variant="ghost" class="wide" aria-label=${`${textMessages.font}: ${family}`}
      ><span class="font" style=${`font-family:"${family}"`}>${family}</span> <sf-icon .icon=${chevronDownIcon} size="14"></sf-icon
    ></sf-button>
    <sf-font-picker
      value=${family}
      .fonts=${fonts}
      @sf-change=${(e: CustomEvent<{ family: string }>) => {
        const choice = host.fonts.find((f) => f.label === e.detail.family);
        if (choice !== undefined) void text.setFont(choice.value);
      }}
    ></sf-font-picker>
  </sf-popover>`;
}

function linkPopover(s: TypographySummary, text: TextCommands): TemplateResult {
  const href = value(s.link);
  let typed = href ?? '';
  return html`<sf-popover label=${textMessages.link}>
    <sf-icon-button slot="trigger" size="sm" variant="ghost" label=${textMessages.link} shortcut="Mod+K" .pressed=${href !== undefined}><sf-icon .icon=${linkIcon} size="16"></sf-icon></sf-icon-button>
    <form
      class="link-form"
      @submit=${(e: SubmitEvent) => {
        e.preventDefault();
        if (typed.trim() !== '') void text.setLink(typed.trim());
      }}
    >
      <sf-text-field label=${textMessages.linkUrl} placeholder="https://" .value=${typed} @input=${(e: Event) => (typed = (e.composedPath()[0] as HTMLInputElement).value ?? '')}></sf-text-field>
      <div class="row">
        <sf-button type="submit" size="sm" variant="primary">${textMessages.linkApply}</sf-button>
        ${href === undefined ? nothing : html`<sf-button size="sm" variant="ghost" @click=${() => void text.setLink(null)}>${textMessages.linkRemove}</sf-button>`}
      </div>
    </form>
  </sf-popover>`;
}

/** A `▾` menu beside a field (the trigger is an icon button named `label`). */
function menuIcon<V extends string>(label: string, items: readonly (readonly [V, string])[], current: V | undefined, pick: (v: V) => void): TemplateResult {
  return html`<sf-menu label=${label} @sf-select=${(e: CustomEvent<{ value: V }>) => pick(e.detail.value)}>
    <sf-icon-button slot="trigger" size="sm" variant="ghost" label=${label}><sf-icon .icon=${chevronDownIcon} size="14"></sf-icon></sf-icon-button>
    ${items.map(([v, l]) => html`<sf-menu-item type="radio" value=${v} ?checked=${v === current}>${l}</sf-menu-item>`)}
  </sf-menu>`;
}

function menu<V extends string>(label: string, shown: string, items: readonly (readonly [V, string])[], current: V | undefined, pick: (v: V) => void, cls = ''): TemplateResult {
  return html`<sf-menu label=${label} @sf-select=${(e: CustomEvent<{ value: V }>) => pick(e.detail.value)}>
    <sf-button slot="trigger" size="sm" variant="ghost" class=${cls} aria-label=${`${label}: ${shown}`}>${shown} <sf-icon .icon=${chevronDownIcon} size="14"></sf-icon></sf-button>
    ${items.map(([v, l]) => html`<sf-menu-item type="radio" value=${v} ?checked=${v === current}>${l}</sf-menu-item>`)}
  </sf-menu>`;
}

/** The Text section for the selected text (or the edited range). */
export function textSection(host: TextHost, s: TypographySummary, text: TextCommands): TemplateResult {
  const weight = value(s.weight);
  const weightName = weight === undefined ? textMessages.mixed : (WEIGHTS.find(([w]) => w === weight)?.[1] ?? String(weight));
  const color = value(s.color);
  const hex = typeof color === 'string' ? color : undefined;
  const align = value(s.align);
  const box = s.box ?? 'auto-height';
  const moreOpen = host.pro || host.isMoreOpen('text');
  const nonDefault = [value(s.lineHeight) !== 0, value(s.letterSpacing) !== 0, value(s.spaceBefore) !== 0, value(s.spaceAfter) !== 0, value(s.indent) !== 0, s.script !== undefined, box !== 'auto-height'].filter(Boolean).length;
  const presets = (Object.keys(TEXT_PRESETS) as TextPresetName[]).map((n) => [n, n] as const);
  return html`<div class="rows">
    ${menu(textMessages.style, s.preset ?? textMessages.custom, presets, s.preset, (name) => void text.applyPreset(name), 'wide')}
    <div class="row">${fontPicker(host, s, text)}</div>
    <div class="row">
      ${menu(textMessages.weight, weightName, WEIGHTS.map(([w, n]) => [String(w), `${n} ${w}`] as const), weight === undefined ? undefined : String(weight), (w) => void text.setWeight(Number(w)))}
      ${numberField(textMessages.size, s.size, (n) => void text.setSize(Math.max(1, Math.min(999, n))), { min: 1, max: 999, unit: 'px' })}
      ${menuIcon(textMessages.sizePresets, SIZE_PRESETS.map((n) => [String(n), `${n} px`] as const), value(s.size) === undefined ? undefined : String(value(s.size)), (n) => void text.setSize(Number(n)))}
      ${colorSwatch(host, textMessages.colour, hex, (paint) => void text.setColor(paint), { mixed: isMixed(s.color) })}
    </div>
    <div class="row" role="group" aria-label="Character style">
      ${toggle(textMessages.bold, boldIcon, s.bold, () => void text.toggle('bold'), 'Mod+B')} ${toggle(textMessages.italic, italicIcon, s.italic, () => void text.toggle('italic'), 'Mod+I')}
      ${toggle(textMessages.underline, underlineIcon, s.underline, () => void text.toggle('underline'), 'Mod+U')} ${toggle(textMessages.strike, strikethroughIcon, s.strike, () => void text.toggle('strike'), 'Mod+Shift+X')}
      ${linkPopover(s, text)}
    </div>
    <div class="row" role="group" aria-label=${textMessages.align}>
      ${(['start', 'center', 'end', 'justify'] as const).map((a) => toggle(textMessages.alignLabels[a], ALIGN_ICONS[a], align === a, () => void text.setAlign(a), ALIGN_KEYS[a]))}
    </div>
    <sf-disclosure variant="more" key="inspector/text-more" .count=${nonDefault} ?open=${moreOpen} ?pinned=${host.pro} @sf-toggle=${() => host.toggleMore('text')}>
      <div class="grid2">
        ${numberField(textMessages.lineHeight, s.lineHeight, (n) => void text.setLineHeight(Math.max(0, Math.min(10, n))), { min: 0, max: 10, step: 0.05 })}
        ${numberField(textMessages.letterSpacing, s.letterSpacing, (n) => void text.setLetterSpacing(Math.max(-20, Math.min(200, n))), { min: -20, max: 200, step: 0.1, unit: 'px' })}
        ${numberField(textMessages.spaceBefore, s.spaceBefore, (n) => void text.setParagraph({ spaceBefore: Math.max(0, n) }), { min: 0, max: 4096, unit: 'px' })}
        ${numberField(textMessages.spaceAfter, s.spaceAfter, (n) => void text.setParagraph({ spaceAfter: Math.max(0, n) }), { min: 0, max: 4096, unit: 'px' })}
        ${numberField(textMessages.indent, s.indent, (n) => void text.setParagraph({ indent: n }), { min: -4096, max: 4096, unit: 'px' })}
      </div>
      <div class="row" role="group" aria-label=${textMessages.autoSize}>
        <span class="label">${textMessages.autoSize}</span>
        ${(['auto-width', 'auto-height', 'fixed'] as const).map((b) => toggle(textMessages.boxes[b], BOX_ICONS[b], box === b, () => void text.setBox(b)))}
      </div>
      ${box === 'fixed'
        ? html`<div class="row" role="group" aria-label=${textMessages.verticalAlign}>
            <span class="label">${textMessages.verticalAlign}</span>
            ${(['top', 'middle', 'bottom'] as const).map((v) => toggle(textMessages.verticals[v], VERTICAL_ICONS[v], (s.verticalAlign ?? 'top') === v, () => void text.setVerticalAlign(v)))}
          </div>`
        : nothing}
      <div class="row">
        ${toggle(textMessages.subscript, subscriptIcon, s.script === 'sub', () => void text.setScript(s.script === 'sub' ? null : 'sub'), 'Mod+,')}
        ${toggle(textMessages.superscript, superscriptIcon, s.script === 'super', () => void text.setScript(s.script === 'super' ? null : 'super'), 'Mod+.')}
        <sf-menu label=${textMessages.case} @sf-select=${(e: CustomEvent<{ value: TextCase }>) => void text.convertCase(e.detail.value)}>
          <sf-icon-button slot="trigger" size="sm" variant="ghost" label=${textMessages.case}><sf-icon .icon=${caseSensitiveIcon} size="16"></sf-icon></sf-icon-button>
          ${TEXT_CASES.map((c) => html`<sf-menu-item value=${c}>${textMessages.cases[c]}</sf-menu-item>`)}
        </sf-menu>
        <sf-icon-button size="sm" variant="ghost" label=${textMessages.clear} shortcut="Mod+\\" @click=${() => void text.clearFormatting()}><sf-icon .icon=${removeFormattingIcon} size="16"></sf-icon></sf-icon-button>
      </div>
      ${box === 'fixed' ? html`<sf-button size="sm" variant="ghost" @click=${() => void text.fitToBox()}>${textMessages.fit}</sf-button>` : nothing}
    </sf-disclosure>
  </div>`;
}
