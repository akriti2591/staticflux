/**
 * `<sf-color-popover>` — the one colour picker (STUDIO-UX-SPEC §4.2.5, FOUNDATIONS §4.6) for the HUD, the inspector
 * and dialogs. It is the *content* of a `<sf-popover outside="pass">` anchored to the swatch that opened it, 264 px
 * wide. Top to bottom:
 *
 * - **value row**: the hex field (mono, `#` fixed), an opacity number, the eyedropper (only when `EyeDropper` exists;
 *   a mode: the popover hides while picking, Escape cancels the pick); `Detach from token` while a token is bound;
 *   an unresolved token shows a hatched swatch and `Replace with #…`;
 * - **Document colours** (≤ 12, most used first, `#FFF4E0 · 3 uses` as the name; Pro: `captions` shows the hex),
 *   **Brand** tokens (click binds the token), **Palette** (the app's fixed 24), **Recent** (last 8);
 * - **Custom ▸** expands inline (never a second popover): a saturation/brightness area and a hue slider; dragging
 *   previews, release commits. `custom-open` starts it expanded (Pro, DENSITY-DISCLOSURE §3.4).
 *
 * Typing a complete hex previews (`sf-input`); Enter or blur commits (`sf-change`, one undo step); a grid click
 * commits; hover never previews (Figma). Arrows move within a grid (6 columns), Enter picks, `Mod+C` / `Mod+V` on a
 * swatch copy and paste a hex. Escape (through the surrounding popover) restores the opening value: `restore()`.
 * `mixed`: hatched value swatch, empty hex field; a commit sets every element.
 *
 * R13.52 (APPEARANCE §2.2 contrast tag): with `contrast-with` (a solid `#rrggbb` behind the paint) the popover shows the
 * WCAG contrast of the current solid against it — `AAA 7.2 : 1 on #FFFFFF`, `AA`, `AA large`, `×` — as a polite mono tag,
 * outlined when below AA. `contrastLevel` / `contrastRatio` are the pure parts.
 */
import { I18nToken } from '@staticflux/i18n';
import { normalizeHex } from '@staticflux/ui/theme';
import { component, defineComponent, SfElement } from '@staticflux/ui';
import { css, html, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { defineIconElement } from './icon.js';
import { chevronDownIcon } from './icons/chevron-down.js';
import { chevronRightIcon } from './icons/chevron-right.js';
import { pipetteIcon } from './icons/pipette.js';
import { defineNumberField, type NumberChangeDetail } from './number-field.js';
import { defineSwatch } from './swatch.js';
import { emit } from './internal/events.js';
import { ConnectedListeners } from './internal/listeners.js';
import { baseStyles, t } from './internal/styles.js';
import { pickerMessages } from './picker-messages.js';
import { kitMessages, kitText } from './messages.js';

export interface DocumentColor {
  readonly hex: string;
  readonly uses: number;
}

export interface BrandColor {
  /** Token name without `@`. */
  readonly name: string;
  /** Resolved hex; undefined when the kit cannot resolve it. */
  readonly hex: string | undefined;
}

export type ColorChangeDetail =
  | { readonly kind: 'color'; readonly hex: string; readonly opacity: number }
  | { readonly kind: 'token'; readonly token: string }
  | { readonly kind: 'detach'; readonly hex: string };

export interface ColorInputDetail {
  readonly hex: string;
  readonly opacity: number;
}

export const MAX_DOCUMENT_COLORS = 12;
export const MAX_RECENT_COLORS = 8;
export const COLOR_GRID_COLUMNS = 6;

// ------------------------------------------------------------------ pure colour helpers

export interface Hsv {
  /** 0–360 */
  readonly h: number;
  /** 0–1 */
  readonly s: number;
  /** 0–1 */
  readonly v: number;
}

/** `#RRGGBB` → HSV (undefined when not a hex). */
export function hexToHsv(hex: string): Hsv | undefined {
  const normal = normalizeHex(hex);
  if (!normal.ok) return undefined;
  const n = Number.parseInt(normal.value.slice(1, 7), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

/** HSV → `#RRGGBB` (uppercase). */
export function hsvToHex({ h, s, v }: Hsv): string {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const to = (value: number): string =>
    Math.round((value + m) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`.toUpperCase();
}

/** A complete hex the field may preview (`#abc`, `abc`, `#aabbcc`); undefined while incomplete or invalid. */
export function completeHex(text: string): string | undefined {
  const v = text.trim().replace(/^#?/, '#');
  if (!/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) return undefined;
  const normal = normalizeHex(v);
  return normal.ok ? normal.value.toUpperCase() : undefined;
}

/** Most used first, at most 12 (ties keep their order). */
export function rankDocumentColors(colors: readonly DocumentColor[]): DocumentColor[] {
  return [...colors].sort((a, b) => b.uses - a.uses).slice(0, MAX_DOCUMENT_COLORS);
}

/** The recent list after committing `hex`: newest first, unique, at most 8. */
export function pushRecentColor(recent: readonly string[], hex: string): string[] {
  const upper = hex.toUpperCase();
  return [upper, ...recent.filter((c) => c.toUpperCase() !== upper)].slice(0, MAX_RECENT_COLORS);
}

/** Grid keyboard: the next index for an arrow key in a `columns`-wide grid of `count` cells (undefined = not ours). */
export function gridNextIndex(current: number, count: number, key: string, columns = COLOR_GRID_COLUMNS): number | undefined {
  const step: Readonly<Record<string, number>> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns };
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  const delta = step[key];
  if (delta === undefined) return undefined;
  const next = current + delta;
  return next < 0 || next >= count ? current : next;
}

// ------------------------------------------------------------------ element

const colorPopoverSpec = component({
  tag: 'sf-color-popover',
  deps: { lazy: { i18n: I18nToken } },
  placeholder: () => html``,
  description: 'The colour popover: hex, opacity, eyedropper, document colours, brand, palette, recent, inline custom picker.',
});

interface EyeDropperLike {
  open(options?: { signal?: AbortSignal }): Promise<{ sRGBHex: string }>;
}

export class SfColorPopoverElement extends SfElement<typeof colorPopoverSpec> {
  static override readonly spec = colorPopoverSpec;
  static override properties = {
    label: {},
    value: {},
    opacity: { type: Number },
    mixed: { type: Boolean, reflect: true },
    token: {},
    unresolved: { type: Boolean },
    fallback: {},
    documentColors: { attribute: false },
    brand: { attribute: false },
    palette: { attribute: false },
    recent: { attribute: false },
    customOpen: { type: Boolean, attribute: 'custom-open', reflect: true },
    captions: { type: Boolean },
    contrastWith: { attribute: 'contrast-with' },
    text: { state: true },
    error: { state: true },
    hsv: { state: true },
  };
  static override styles = [
    baseStyles,
    css`
      :host {
        display: grid;
        /* One column the host's width (#45): an auto column grew to the value row's min-content (the hex input's
           intrinsic size), 330 px, and the 264 px popover scrolled sideways. */
        grid-template-columns: minmax(0, 1fr);
        gap: ${t.space.md.css};
        inline-size: 236px;
      }
      .value {
        display: flex;
        align-items: center;
        gap: ${t.space.xs.css};
      }
      .hex {
        display: flex;
        align-items: center;
        flex: 1;
        min-inline-size: 0;
        gap: 4px;
        min-block-size: ${t.size.control.css};
        padding-inline: ${t.space.sm.css};
        border-radius: ${t.radius.md.css};
        border: 1px solid ${t.color.controlEdge.css};
        background: ${t.color.surfaceSunken.css};
        font-family: ${t.font.familyMono.css};
      }
      .hex:focus-within {
        outline: 2px solid ${t.color.focusRing.css};
        outline-offset: 2px;
      }
      .hex[data-invalid] {
        border-color: ${t.color.danger.css};
      }
      .hex input {
        all: unset;
        flex: 1;
        min-inline-size: 0;
        text-transform: uppercase;
      }
      sf-number-field {
        inline-size: 72px;
      }
      .contrast {
        justify-self: start;
        padding: 1px ${t.space.xs.css};
        border: 1px solid transparent;
        border-radius: ${t.radius.sm.css};
        background: ${t.color.neutral3.css};
        font-family: ${t.font.familyMono.css};
        font-size: ${t.type.sizeXs.css};
        color: ${t.color.text.css};
      }
      .contrast[data-low] {
        border-color: ${t.color.warning.css};
      }
      .error {
        font-size: ${t.type.sizeSm.css};
        color: ${t.color.dangerText.css};
      }
      .heading {
        margin: 0 0 ${t.space.xs.css};
        font-size: ${t.type.sizeXs.css};
        font-weight: ${t.font.weightSemibold.css};
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: ${t.color.textMuted.css};
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(${COLOR_GRID_COLUMNS}, 24px);
        justify-content: space-between;
        gap: 8px;
      }
      .cell {
        all: unset;
        position: relative;
        display: grid;
        place-items: center;
        inline-size: 24px;
        block-size: 24px;
        border-radius: ${t.radius.full.css};
        cursor: default;
      }
      .cell:focus-visible,
      .cell[aria-pressed='true'] {
        outline: 2px solid ${t.color.focusRing.css};
        outline-offset: 2px;
      }
      .caption {
        grid-column: 1 / -1;
        font-family: ${t.font.familyMono.css};
        font-size: 10px;
        color: ${t.color.textMuted.css};
      }
      .link {
        all: unset;
        font-size: ${t.type.sizeSm.css};
        color: ${t.color.accentText.css};
        text-decoration: underline;
        cursor: pointer;
      }
      .link:focus-visible,
      .toggle:focus-visible,
      .icon:focus-visible {
        outline: 2px solid ${t.color.focusRing.css};
        outline-offset: 2px;
      }
      .toggle,
      .icon {
        all: unset;
        display: inline-flex;
        align-items: center;
        gap: 4px;
        min-block-size: 28px;
        border-radius: ${t.radius.sm.css};
        cursor: default;
      }
      .icon {
        justify-content: center;
        inline-size: 28px;
      }
      .toggle:hover,
      .icon:hover {
        background: ${t.color.surfaceHover.css};
      }
      .area {
        position: relative;
        block-size: 160px;
        border-radius: ${t.radius.md.css};
        background:
          linear-gradient(to top, #000, transparent),
          linear-gradient(to right, #fff, transparent),
          var(--_hue);
        touch-action: none;
      }
      .area:focus-visible {
        outline: 2px solid ${t.color.focusRing.css};
        outline-offset: 2px;
      }
      .thumb {
        position: absolute;
        inline-size: 14px;
        block-size: 14px;
        margin: -7px 0 0 -7px;
        border-radius: 50%;
        box-shadow:
          0 0 0 2px #fff,
          0 0 0 3px rgb(0 0 0 / 0.4);
        pointer-events: none;
      }
      .hue {
        inline-size: 100%;
        accent-color: ${t.color.accent.css};
      }
      @media (forced-colors: active) {
        .cell sf-swatch {
          forced-color-adjust: none;
        }
      }
    `,
  ];

  /** Accessible name prefix (`Fill colour`). */
  declare label: string;
  /** The current colour (`#RRGGBB`); empty when mixed. */
  declare value: string;
  declare opacity: number;
  declare mixed: boolean;
  /** The bound brand token (without `@`), if any. */
  declare token: string | undefined;
  /** The bound token cannot resolve in this brand kit. */
  declare unresolved: boolean;
  /** `Replace with` colour for an unresolved token. */
  declare fallback: string | undefined;
  declare documentColors: readonly DocumentColor[];
  declare brand: readonly BrandColor[];
  declare palette: readonly string[];
  declare recent: readonly string[];
  declare customOpen: boolean;
  /** Pro: hex captions under the document colours. */
  declare captions: boolean;
  /** R13.52: the solid behind the paint (`#rrggbb`): the contrast tag compares against it. */
  declare contrastWith: string | undefined;
  declare text: string;
  declare error: boolean;
  declare hsv: Hsv;
  private opening: { readonly value: string; readonly opacity: number } | undefined;
  private picking: AbortController | undefined;

  constructor() {
    super();
    this.label = '';
    this.value = '';
    this.opacity = 1;
    this.mixed = false;
    this.token = undefined;
    this.unresolved = false;
    this.fallback = undefined;
    this.documentColors = [];
    this.brand = [];
    this.palette = [];
    this.recent = [];
    this.customOpen = false;
    this.captions = false;
    this.contrastWith = undefined;
    this.text = '';
    this.error = false;
    this.hsv = { h: 0, s: 0, v: 0 };
    new ConnectedListeners(this, (signal) => {
      // Escape on the surrounding popover restores the opening value (§4.2.5).
      this.closest('sf-popover')?.addEventListener(
        'sf-toggle',
        (event) => {
          const detail = (event as CustomEvent<{ open: boolean; cause?: string }>).detail;
          if (detail.open) this.opening = { value: this.value, opacity: this.opacity };
          else if (detail.cause === 'escape') this.restore();
        },
        { signal },
      );
    });
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.opening = { value: this.value, opacity: this.opacity };
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.picking?.abort();
  }

  /** Put the opening value back (Escape): a preview of it, then `sf-restore`. */
  restore(): void {
    const opening = this.opening;
    if (opening === undefined) return;
    this.value = opening.value;
    this.opacity = opening.opacity;
    emit<ColorInputDetail>(this, 'sf-input', { hex: opening.value, opacity: opening.opacity });
    emit(this, 'sf-restore', {});
  }

  /** The eyedropper exists in this browser. */
  get canPick(): boolean {
    return typeof (this.ownerDocument.defaultView as unknown as { EyeDropper?: unknown } | null)?.EyeDropper === 'function';
  }

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has('value') || changed.has('mixed')) {
      this.text = this.mixed ? '' : this.value.replace(/^#/, '').toUpperCase();
      this.error = false;
      const hsv = hexToHsv(this.value);
      if (hsv !== undefined) this.hsv = hsv;
    }
  }

  private commitColor(hex: string, opacity = this.opacity): void {
    const upper = hex.toUpperCase();
    this.value = upper;
    this.mixed = false;
    emit<ColorChangeDetail>(this, 'sf-change', { kind: 'color', hex: upper, opacity });
  }

  private preview(hex: string): void {
    emit<ColorInputDetail>(this, 'sf-input', { hex: hex.toUpperCase(), opacity: this.opacity });
  }

  private onHexInput(event: Event): void {
    this.text = (event.target as HTMLInputElement).value;
    const hex = completeHex(this.text);
    this.error = false;
    if (hex !== undefined) this.preview(hex);
  }

  private commitText(): void {
    if (this.text.trim() === '' && this.mixed) return;
    const hex = completeHex(this.text);
    if (hex === undefined) {
      this.error = true;
      return;
    }
    if (hex !== this.value.toUpperCase() || this.mixed) this.commitColor(hex);
  }

  private async pick(): Promise<void> {
    const View = (this.ownerDocument.defaultView as unknown as { EyeDropper?: new () => EyeDropperLike } | null)?.EyeDropper;
    if (View === undefined) return;
    const popover = this.closest('sf-popover');
    this.picking?.abort();
    const picking = new AbortController();
    this.picking = picking;
    popover?.setAttribute('suspended', '');
    try {
      const result = await new View().open({ signal: picking.signal });
      this.commitColor(result.sRGBHex);
    } catch {
      // Escape or abort: nothing picked, nothing changes.
    } finally {
      popover?.removeAttribute('suspended');
      if (this.picking === picking) this.picking = undefined;
    }
  }

  private onGridKey(event: KeyboardEvent, hexes: readonly string[]): void {
    const cells = [...(event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('.cell')];
    const current = cells.indexOf(event.composedPath()[0] as HTMLElement);
    if (current < 0) return;
    const mod = event.metaKey || event.ctrlKey;
    if (mod && event.key.toLowerCase() === 'c') {
      event.preventDefault();
      void this.ownerDocument.defaultView?.navigator.clipboard?.writeText(hexes[current] ?? '').catch(() => undefined);
      return;
    }
    if (mod && event.key.toLowerCase() === 'v') {
      event.preventDefault();
      void this.ownerDocument.defaultView?.navigator.clipboard
        ?.readText()
        .then((text) => {
          const hex = completeHex(text);
          if (hex !== undefined) this.commitColor(hex);
        })
        .catch(() => undefined);
      return;
    }
    const next = gridNextIndex(current, cells.length, event.key);
    if (next === undefined) return;
    event.preventDefault();
    cells[next]?.focus();
  }

  private grid(id: string, heading: string, cells: readonly { readonly hex: string | undefined; readonly name: string; readonly pressed: boolean; readonly pick: () => void }[], caption = false): TemplateResult | typeof nothing {
    if (cells.length === 0) return nothing;
    const hexes = cells.map((c) => c.hex ?? '');
    return html`<section aria-labelledby=${id}>
      <h3 class="heading" id=${id}>${heading}</h3>
      <div class="grid" role="group" aria-labelledby=${id} @keydown=${(e: KeyboardEvent) => this.onGridKey(e, hexes)}>
        ${cells.map(
          (cell, i) =>
            html`<button type="button" class="cell" tabindex=${i === 0 ? '0' : '-1'} aria-label=${cell.name} aria-pressed=${cell.pressed ? 'true' : 'false'} @click=${cell.pick}>
              <sf-swatch size="24" color=${cell.hex ?? ''} ?unresolved=${cell.hex === undefined}></sf-swatch>
            </button>`,
        )}
        ${caption ? html`<span class="caption" aria-hidden="true">${hexes.join(' ')}</span>` : nothing}
      </div>
    </section>`;
  }

  private onArea(event: PointerEvent): void {
    const area = event.currentTarget as HTMLElement;
    area.setPointerCapture?.(event.pointerId);
    const update = (e: PointerEvent, done: boolean): void => {
      const rect = area.getBoundingClientRect();
      const s = Math.min(1, Math.max(0, (e.clientX - rect.left) / (rect.width || 1)));
      const v = 1 - Math.min(1, Math.max(0, (e.clientY - rect.top) / (rect.height || 1)));
      this.hsv = { h: this.hsv.h, s, v };
      const hex = hsvToHex(this.hsv);
      if (done) this.commitColor(hex);
      else this.preview(hex);
    };
    update(event, false);
    const stop = new AbortController();
    area.addEventListener('pointermove', (e) => update(e, false), { signal: stop.signal });
    area.addEventListener(
      'pointerup',
      (e) => {
        update(e, true);
        stop.abort();
      },
      { signal: stop.signal },
    );
    area.addEventListener('pointercancel', () => stop.abort(), { signal: stop.signal });
  }

  private onAreaKey(event: KeyboardEvent): void {
    const step = event.shiftKey ? 0.1 : 0.01;
    const deltas: Readonly<Record<string, [number, number]>> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    const delta = deltas[event.key];
    if (delta === undefined) return;
    event.preventDefault();
    const clamp = (n: number): number => Math.min(1, Math.max(0, n));
    this.hsv = { h: this.hsv.h, s: clamp(this.hsv.s + delta[0]), v: clamp(this.hsv.v + delta[1]) };
    this.commitColor(hsvToHex(this.hsv));
  }

  private renderContrast(current: string, text: (ref: typeof pickerMessages.contrast, args: { level: string; ratio: string; hex: string }) => string): TemplateResult | typeof nothing {
    const behind = this.contrastWith;
    const ratio = behind === undefined || this.mixed ? undefined : contrastRatio(current, behind);
    if (ratio === undefined || behind === undefined) return nothing;
    const level = contrastLevel(ratio);
    return html`<span class="contrast" role="status" ?data-low=${ratio < 4.5}>${text(pickerMessages.contrast, { level, ratio: ratio.toFixed(1), hex: behind.slice(0, 7).toUpperCase() })}</span>`;
  }

  override render(): TemplateResult {
    const i18n = this.deps.i18n;
    const k = (ref: Parameters<typeof kitText>[1]): string => kitText(i18n, ref);
    const current = this.value.toUpperCase();
    const docs = rankDocumentColors(this.documentColors);
    const custom = this.customOpen
      ? html`<div
            class="area"
            role="slider"
            tabindex="0"
            aria-label=${k(pickerMessages.saturation)}
            aria-valuemin="0"
            aria-valuemax="100"
            aria-valuenow=${Math.round(this.hsv.s * 100)}
            aria-valuetext=${`${Math.round(this.hsv.s * 100)} % saturation, ${Math.round(this.hsv.v * 100)} % brightness`}
            style=${`--_hue:${hsvToHex({ h: this.hsv.h, s: 1, v: 1 })}`}
            @pointerdown=${(e: PointerEvent) => this.onArea(e)}
            @keydown=${(e: KeyboardEvent) => this.onAreaKey(e)}
          >
            <span class="thumb" style=${`left:${this.hsv.s * 100}%;top:${(1 - this.hsv.v) * 100}%;background:${hsvToHex(this.hsv)}`}></span>
          </div>
          <input
            class="hue"
            type="range"
            min="0"
            max="360"
            aria-label=${k(pickerMessages.hue)}
            .value=${String(Math.round(this.hsv.h))}
            @input=${(e: Event) => {
              this.hsv = { ...this.hsv, h: Number((e.target as HTMLInputElement).value) };
              this.preview(hsvToHex(this.hsv));
            }}
            @change=${() => this.commitColor(hsvToHex(this.hsv))}
          />`
      : nothing;
    return html`<div class="value">
        <sf-swatch color=${this.mixed ? '' : this.value} ?unresolved=${this.mixed || this.unresolved} .opacity=${this.opacity}></sf-swatch>
        <label class="hex" ?data-invalid=${this.error}
          ><span aria-hidden="true">#</span
          ><input
            aria-label=${this.label === '' ? k(pickerMessages.hex) : `${this.label} ${k(pickerMessages.hex)}`}
            aria-invalid=${this.error ? 'true' : 'false'}
            maxlength="7"
            spellcheck="false"
            .value=${this.text}
            placeholder=${this.mixed ? k(kitMessages.mixed) : ''}
            @input=${(e: Event) => this.onHexInput(e)}
            @keydown=${(e: KeyboardEvent) => e.key === 'Enter' && this.commitText()}
            @blur=${() => this.commitText()}
        /></label>
        <sf-number-field
          label=${k(pickerMessages.opacity)}
          label-hidden
          unit="%"
          min="0"
          max="100"
          .value=${Math.round(this.opacity * 100)}
          @sf-change=${(e: CustomEvent<NumberChangeDetail>) => {
            const next = Math.min(1, Math.max(0, (e.detail.value ?? this.opacity * 100) / 100));
            this.opacity = next;
            if (this.value !== '') this.commitColor(this.value, next);
          }}
        ></sf-number-field>
        ${this.canPick
          ? html`<button type="button" class="icon" aria-label=${k(pickerMessages.eyedropper)} @click=${() => void this.pick()}><sf-icon .icon=${pipetteIcon}></sf-icon></button>`
          : nothing}
      </div>
      ${this.error ? html`<span class="error" role="status">${k(kitMessages.invalidColor)}</span>` : nothing}
      ${this.renderContrast(current, (ref, args) => kitText(i18n, ref, args))}
      ${this.token !== undefined && !this.unresolved
        ? html`<button type="button" class="link" @click=${() => emit<ColorChangeDetail>(this, 'sf-change', { kind: 'detach', hex: current })}>${k(pickerMessages.detachToken)}</button>`
        : nothing}
      ${this.unresolved && this.fallback !== undefined
        ? html`<button type="button" class="link" @click=${() => this.commitColor(this.fallback ?? '')}>${kitText(i18n, pickerMessages.replaceWith, { hex: this.fallback.toUpperCase() })}</button>`
        : nothing}
      ${this.grid(
        'docs',
        k(pickerMessages.documentColors),
        docs.map((c) => ({ hex: c.hex, name: `${c.hex.toUpperCase()} · ${c.uses} ${c.uses === 1 ? 'use' : 'uses'}`, pressed: c.hex.toUpperCase() === current && this.token === undefined, pick: () => this.commitColor(c.hex) })),
        this.captions,
      )}
      ${this.grid(
        'brand',
        k(pickerMessages.brandColors),
        this.brand.map((c) => ({
          hex: c.hex,
          name: `@${c.name}`,
          pressed: this.token === c.name,
          pick: () => {
            this.token = c.name;
            emit<ColorChangeDetail>(this, 'sf-change', { kind: 'token', token: c.name });
          },
        })),
      )}
      ${this.grid('palette', k(pickerMessages.paletteColors), this.palette.map((hex) => ({ hex, name: hex.toUpperCase(), pressed: false, pick: () => this.commitColor(hex) })))}
      ${this.grid('recent', k(pickerMessages.recentColors), this.recent.slice(0, MAX_RECENT_COLORS).map((hex) => ({ hex, name: hex.toUpperCase(), pressed: false, pick: () => this.commitColor(hex) })))}
      <button type="button" class="toggle" aria-expanded=${this.customOpen ? 'true' : 'false'} @click=${() => (this.customOpen = !this.customOpen)}>
        ${k(pickerMessages.customColor)}<sf-icon .icon=${this.customOpen ? chevronDownIcon : chevronRightIcon}></sf-icon>
      </button>
      ${custom}`;
  }
}

/** Relative luminance of `#rrggbb` (WCAG 2.2). */
function luminance(hex: string): number {
  const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * (v[0] ?? 0) + 0.7152 * (v[1] ?? 0) + 0.0722 * (v[2] ?? 0);
}

/** The WCAG contrast ratio of two `#rrggbb` colours (1…21), or undefined when either is not one. */
export function contrastRatio(a: string, b: string): number | undefined {
  if (!/^#[0-9a-f]{6}/i.test(a) || !/^#[0-9a-f]{6}/i.test(b)) return undefined;
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** The tag's level for a ratio: AAA ≥ 7, AA ≥ 4.5, AA large ≥ 3, else ×. */
export function contrastLevel(ratio: number): 'AAA' | 'AA' | 'AA large' | '×' {
  return ratio >= 7 ? 'AAA' : ratio >= 4.5 ? 'AA' : ratio >= 3 ? 'AA large' : '×';
}

export function defineColorPopover(registry: CustomElementRegistry = customElements): void {
  defineIconElement(registry);
  defineSwatch(registry);
  defineNumberField(registry);
  if (registry.get(colorPopoverSpec.tag) === undefined) defineComponent(SfColorPopoverElement, registry);
}
