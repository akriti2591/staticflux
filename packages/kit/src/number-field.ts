/**
 * `<sf-number-field label="W" unit="px" .value=${920}>` — a number you can type or drag
 * (FOUNDATIONS §4.5, STUDIO-UX-SPEC §5.3): X Y W H, angle, size, radius, count, opacity.
 *
 * - **Type:** numbers, expressions (`+10` and `*2` / `/2` apply to the current value,
 *   `(100 + 20) / 2`), percentages (`50%` of `percentOf`, or the value itself in a `%` field) and
 *   units listed in `units` (`2in`, `10mm`), converted to the field's unit. Enter commits, Tab
 *   and blur commit, Escape restores. Invalid text stays in the field with an inline error
 *   (`aria-invalid`) until fixed or restored.
 * - **Drag:** the label is the scrub handle (`ew-resize`): ±1 step per 2 px, Shift ×10, Alt ×0.1,
 *   previewed live (`sf-input`) and committed once on release (`sf-change`, one undo step for the
 *   app). Escape during a drag restores the start value.
 * - **Keys:** ↑/↓ step (Shift ×10, Alt ×0.1) and commit; double-click selects the text.
 * - **Mixed:** `mixed` shows the `Mixed` placeholder (a multi-selection that disagrees). Typing sets
 *   every value (`{ value }`); scrubbing and ↑/↓ add the same delta to each (`{ value: undefined, delta }`).
 * - **Clamp:** `min` / `max`, and `wrap="angle"` normalises to (−180, 180].
 *
 * The input is an APG spinbutton (`aria-valuenow`, `aria-valuetext` with the unit, or "Mixed").
 */
import { createMachine, defineMachine, err, ok, type Result } from '@staticflux/core';
import { I18nToken } from '@staticflux/i18n';
import { component, defineComponent, SfElement } from '@staticflux/ui';
import { css, html, LitElement, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { live } from 'lit/directives/live.js';
import { InvalidNumberInputError } from './errors.js';
import type { ControlSize } from './internal/button-styles.js';
import { emit } from './internal/events.js';
import { ConnectedListeners } from './internal/listeners.js';
import { fieldStyles } from './internal/field-styles.js';
import { uniqueId } from './internal/ids.js';
import { baseStyles, controlStyles, srOnly, t } from './internal/styles.js';
import { kitMessages, kitText } from './messages.js';

/** Accepted units: how many field units one of them is (`{ px: 1, in: 96, mm: 96 / 25.4 }`). */
export type NumberUnits = Readonly<Record<string, number>>;

export interface NumberParseContext {
  /** The current value: `+10`, `*2`, `/2` apply to it. */
  readonly current?: number | undefined;
  /** The field's own unit (always accepted, factor 1). */
  readonly unit?: string;
  readonly units?: NumberUnits;
  /** `50%` means half of this. Without it `%` is only accepted in a `%` field (the number itself). */
  readonly percentOf?: number;
}

export interface NumberModifiers {
  readonly shiftKey?: boolean;
  readonly altKey?: boolean;
}

export interface NumberLimits {
  readonly min?: number | undefined;
  readonly max?: number | undefined;
  readonly wrap?: 'angle' | undefined;
}

/** Payload of `sf-input` (live scrub preview) and `sf-change` (commit). */
export interface NumberChangeDetail {
  /** The new value; `undefined` when a mixed field was scrubbed or stepped (apply `delta` to each). */
  readonly value: number | undefined;
  /** The change from the value at the start of the gesture (`undefined` when a value was typed). */
  readonly delta: number | undefined;
  readonly source: 'type' | 'scrub' | 'step';
}

/** Scrub gesture (LIFECYCLES §37): a press on the label becomes a drag after the first move. */
export const numberScrubMachine = defineMachine({
  id: 'kit/number-scrub',
  initial: 'idle',
  states: ['idle', 'pressed', 'scrubbing'],
  transitions: {
    idle: { press: 'pressed' },
    pressed: { move: 'scrubbing', release: 'idle', cancel: 'idle' },
    scrubbing: { move: 'scrubbing', release: 'idle', cancel: 'idle' },
  },
});

/** Step multiplier for the modifier keys (Shift ×10, Alt ×0.1). */
export function stepMultiplier(modifiers: NumberModifiers): number {
  if (modifiers.shiftKey === true) return 10;
  if (modifiers.altKey === true) return 0.1;
  return 1;
}

/** Round to `precision` decimals without float noise (`0.1 + 0.2` → `0.3`). */
export function roundTo(value: number, precision: number): number {
  const factor = 10 ** Math.max(0, Math.min(10, Math.trunc(precision)));
  return Math.round((value + Number.EPSILON * Math.sign(value)) * factor) / factor;
}

/** Normalise an angle in degrees to (−180, 180]. */
export function normalizeAngle(degrees: number): number {
  const r = ((degrees % 360) + 360) % 360;
  return r > 180 ? r - 360 : r;
}

/** Clamp (or wrap angles) to the field's limits. */
export function clampNumber(value: number, limits: NumberLimits): number {
  let v = limits.wrap === 'angle' ? normalizeAngle(value) : value;
  if (limits.min !== undefined && v < limits.min) v = limits.min;
  if (limits.max !== undefined && v > limits.max) v = limits.max;
  return v;
}

/** The value change of a scrub: 1 step per 2 px of horizontal travel, times the modifier multiplier. */
export function scrubDelta(dx: number, step: number, modifiers: NumberModifiers, precision = 2): number {
  return roundTo(Math.trunc(dx / 2) * step * stepMultiplier(modifiers), precision);
}

/** Display text: at most `precision` decimals, no trailing zeros, `-0` as `0`. */
export function formatNumberValue(value: number, precision = 2): string {
  const rounded = roundTo(value, precision);
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

type Token = { readonly kind: 'num'; readonly value: number; readonly unit: string } | { readonly kind: 'op'; readonly op: string };

function tokenize(text: string): Token[] | undefined {
  const tokens: Token[] = [];
  const re = /\s*(?:(\d+(?:[.,]\d*)?|[.,]\d+)\s*([a-z%°]*)|([-+*/()]))/iy;
  let index = 0;
  const source = text.trim();
  while (index < source.length) {
    re.lastIndex = index;
    const m = re.exec(source);
    if (m === null) return undefined;
    index = re.lastIndex;
    if (m[1] !== undefined) tokens.push({ kind: 'num', value: Number(m[1].replace(',', '.')), unit: (m[2] ?? '').toLowerCase() });
    else if (m[3] !== undefined) tokens.push({ kind: 'op', op: m[3] });
  }
  return tokens;
}

/**
 * Parse what a person typed into a number field (pure). Grammar: `+ - * /`, parentheses, unary
 * minus, numbers with an optional unit. A leading `+`, `*` or `/` applies to `current`.
 * Returns SF-KIT-001 for anything else (empty text, unknown unit, division by zero).
 */
export function parseNumberInput(text: string, context: NumberParseContext = {}): Result<number> {
  const invalid = (why: string): Result<number> => err(InvalidNumberInputError({ message: `Not a number: "${text}" (${why}).`, details: { text } }));
  let source = text.trim();
  if (source === '') return invalid('empty');
  const relative = /^[+*/]/.test(source) && context.current !== undefined && Number.isFinite(context.current);
  if (relative) source = `${String(context.current)}${source}`;
  const tokens = tokenize(source);
  if (tokens === undefined || tokens.length === 0) return invalid('unexpected characters');
  const unit = (context.unit ?? '').toLowerCase();
  const factors = new Map<string, number>(Object.entries(context.units ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  let pos = 0;
  let failure: string | undefined;
  const fail = (why: string): number => {
    failure ??= why;
    return Number.NaN;
  };
  const convert = (value: number, u: string): number => {
    if (u === '' || u === unit) return value;
    if (u === '%') {
      if (context.percentOf !== undefined) return (value / 100) * context.percentOf;
      return fail('percent needs a reference');
    }
    if (u === '°' || u === 'deg') return unit === '°' || unit === 'deg' ? value : fail(`unknown unit "${u}"`);
    const factor = factors.get(u);
    return factor === undefined ? fail(`unknown unit "${u}"`) : value * factor;
  };
  const peekOp = (): string | undefined => {
    const token = tokens[pos];
    return token?.kind === 'op' ? token.op : undefined;
  };
  const factor = (): number => {
    const token = tokens[pos];
    if (token === undefined) return fail('incomplete expression');
    if (token.kind === 'num') {
      pos += 1;
      return convert(token.value, token.unit);
    }
    if (token.op === '-' || token.op === '+') {
      pos += 1;
      const inner = factor();
      return token.op === '-' ? -inner : inner;
    }
    if (token.op === '(') {
      pos += 1;
      const inner = expression();
      if (peekOp() !== ')') return fail('missing ")"');
      pos += 1;
      return inner;
    }
    return fail(`unexpected "${token.op}"`);
  };
  const term = (): number => {
    let value = factor();
    for (let op = peekOp(); op === '*' || op === '/'; op = peekOp()) {
      pos += 1;
      const rhs = factor();
      if (op === '/' && rhs === 0) return fail('division by zero');
      value = op === '*' ? value * rhs : value / rhs;
    }
    return value;
  };
  const expression = (): number => {
    let value = term();
    for (let op = peekOp(); op === '+' || op === '-'; op = peekOp()) {
      pos += 1;
      const rhs = term();
      value = op === '+' ? value + rhs : value - rhs;
    }
    return value;
  };
  const value = expression();
  if (failure !== undefined) return invalid(failure);
  if (pos !== tokens.length) return invalid('unexpected trailing input');
  if (!Number.isFinite(value)) return invalid('not finite');
  return ok(value);
}

// ------------------------------------------------------------------ element

const numberFieldSpec = component({
  tag: 'sf-number-field',
  deps: { lazy: { i18n: I18nToken } },
  placeholder: () => nothing,
  description: 'Scrubbable number field: units, expressions, ↑/↓ steps, mixed values, one commit per gesture.',
});

export class SfNumberFieldElement extends SfElement<typeof numberFieldSpec> {
  static override readonly spec = numberFieldSpec;
  static override shadowRootOptions: ShadowRootInit = { ...LitElement.shadowRootOptions, delegatesFocus: true };
  static override properties = {
    label: {},
    labelHidden: { type: Boolean, attribute: 'label-hidden' },
    value: { type: Number },
    mixed: { type: Boolean, reflect: true },
    unit: {},
    units: { attribute: false },
    min: { type: Number },
    max: { type: Number },
    step: { type: Number },
    precision: { type: Number },
    wrap: {},
    percentOf: { type: Number, attribute: 'percent-of' },
    disabled: { type: Boolean, reflect: true },
    scrub: { type: Boolean },
    size: { reflect: true },
    text: { state: true },
    error: { state: true },
  };
  static override styles = [
    baseStyles,
    srOnly,
    controlStyles,
    fieldStyles,
    css`
      :host {
        grid-template-columns: auto minmax(0, 1fr);
        align-items: center;
        column-gap: ${t.space.sm.css};
      }
      :host([label-hidden]) {
        grid-template-columns: minmax(0, 1fr);
      }
      .label {
        cursor: ew-resize;
        user-select: none;
        touch-action: none;
        min-inline-size: 1ch;
      }
      :host([disabled]) .label {
        cursor: default;
      }
      .field {
        min-block-size: var(--kit-height);
      }
      input {
        font-family: ${t.font.familyMono.css};
        font-variant-numeric: tabular-nums;
      }
      .unit {
        font-family: ${t.font.familyMono.css};
        font-size: ${t.type.sizeSm.css};
        color: ${t.color.textMuted.css};
      }
      .error {
        grid-column: 1 / -1;
      }
    `,
  ];

  declare label: string;
  declare labelHidden: boolean;
  declare value: number | undefined;
  declare mixed: boolean;
  /** Unit shown as a muted suffix and assumed for typed numbers (`px`, `°`, `%`). */
  declare unit: string;
  /** Other accepted units and their factor to `unit`. */
  declare units: NumberUnits;
  declare min: number | undefined;
  declare max: number | undefined;
  declare step: number;
  declare precision: number;
  declare wrap: 'angle' | undefined;
  declare percentOf: number | undefined;
  declare disabled: boolean;
  /** Drag the label to change the value (default true). */
  declare scrub: boolean;
  declare size: ControlSize;
  /** Text being typed (undefined = show the value). */
  declare private text: string | undefined;
  /** The inline error shown under the field ('' when none). */
  declare error: string;
  private readonly ids = { input: uniqueId('sf-num'), error: uniqueId('sf-num-error') };
  private readonly scrubbing = createMachine(numberScrubMachine);
  private scrubStart: { readonly x: number; readonly value: number | undefined; readonly pointer: number } | undefined;
  private lastDelta = 0;

  constructor() {
    super();
    this.label = '';
    this.labelHidden = false;
    this.value = undefined;
    this.mixed = false;
    this.unit = '';
    this.units = {};
    this.min = undefined;
    this.max = undefined;
    this.step = 1;
    this.precision = 2;
    this.wrap = undefined;
    this.percentOf = undefined;
    this.disabled = false;
    this.scrub = true;
    this.size = 'md';
    this.text = undefined;
    this.error = '';
    // Escape anywhere cancels a drag in progress.
    new ConnectedListeners(this, (signal) => this.ownerDocument.addEventListener('keydown', this.onDocumentKey, { capture: true, signal }));
  }

  get input(): HTMLInputElement | null {
    return this.shadowRoot?.querySelector('input') ?? null;
  }

  /** The scrub gesture's state (`idle | pressed | scrubbing`). */
  get scrubState(): string {
    return this.scrubbing.state;
  }

  override focus(options?: FocusOptions): void {
    this.input?.focus(options);
  }

  /** Select the text (double-click does the same). */
  select(): void {
    this.input?.select();
  }

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has('error')) this.toggleAttribute('invalid', this.error !== '');
  }

  private get limits(): NumberLimits {
    return { min: this.min, max: this.max, wrap: this.wrap };
  }

  private get displayText(): string {
    if (this.text !== undefined) return this.text;
    if (this.mixed || this.value === undefined || !Number.isFinite(this.value)) return '';
    return formatNumberValue(this.value, this.precision);
  }

  private finish(value: number | undefined, delta: number | undefined, source: NumberChangeDetail['source'], type: 'sf-input' | 'sf-change'): void {
    if (type === 'sf-change' && value !== undefined) {
      this.value = value;
      this.mixed = false;
    }
    emit<NumberChangeDetail>(this, type, { value, delta, source });
  }

  /** Commit what was typed. Returns false (and shows the error) when it does not parse. */
  commitText(): boolean {
    if (this.text === undefined) return true;
    const text = this.text;
    if (text.trim() === '' && this.mixed) {
      this.text = undefined;
      return true;
    }
    const parsed = parseNumberInput(text, { current: this.mixed ? undefined : this.value, unit: this.unit, units: this.units, ...(this.percentOf === undefined ? {} : { percentOf: this.percentOf }) });
    if (!parsed.ok) {
      this.error = kitText(this.deps.i18n, kitMessages.numberInvalid);
      return false;
    }
    const value = roundTo(clampNumber(parsed.value, this.limits), this.precision);
    this.text = undefined;
    this.error = '';
    this.finish(value, undefined, 'type', 'sf-change');
    return true;
  }

  /** Throw away typed text and any error. */
  restore(): void {
    this.text = undefined;
    this.error = '';
  }

  private stepBy(direction: 1 | -1, modifiers: NumberModifiers): void {
    const delta = roundTo(direction * this.step * stepMultiplier(modifiers), this.precision);
    this.text = undefined;
    this.error = '';
    if (this.mixed || this.value === undefined) {
      this.finish(undefined, delta, 'step', 'sf-change');
      return;
    }
    const value = roundTo(clampNumber(this.value + delta, this.limits), this.precision);
    this.finish(value, roundTo(value - this.value, this.precision), 'step', 'sf-change');
  }

  private onKeydown(event: KeyboardEvent): void {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      if (this.text !== undefined && !this.commitText()) return;
      this.stepBy(event.key === 'ArrowUp' ? 1 : -1, event);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      this.commitText();
    } else if (event.key === 'Escape') {
      if (this.text === undefined && this.error === '') return;
      event.preventDefault();
      event.stopPropagation();
      this.restore();
    }
  }

  private scrubValue(dx: number, modifiers: NumberModifiers): { readonly value: number | undefined; readonly delta: number } {
    const start = this.scrubStart?.value;
    const delta = scrubDelta(dx, this.step, modifiers, this.precision);
    if (start === undefined) return { value: undefined, delta };
    const value = roundTo(clampNumber(start + delta, this.limits), this.precision);
    return { value, delta: roundTo(value - start, this.precision) };
  }

  private onLabelPointerDown(event: PointerEvent): void {
    if (!this.scrub || this.disabled || event.button !== 0) return;
    event.preventDefault();
    if (this.text !== undefined && !this.commitText()) return;
    this.scrubbing.send('press');
    this.scrubStart = { x: event.clientX, value: this.mixed ? undefined : this.value, pointer: event.pointerId };
    this.lastDelta = 0;
    (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
  }

  private onLabelPointerMove(event: PointerEvent): void {
    const start = this.scrubStart;
    if (start === undefined || event.pointerId !== start.pointer) return;
    const dx = event.clientX - start.x;
    if (this.scrubbing.is('pressed') && Math.abs(dx) < 2) return;
    this.scrubbing.send('move');
    const { value, delta } = this.scrubValue(dx, event);
    if (delta === this.lastDelta) return;
    this.lastDelta = delta;
    if (value !== undefined) this.text = formatNumberValue(value, this.precision);
    this.finish(value, delta, 'scrub', 'sf-input');
  }

  private onLabelPointerUp(event: PointerEvent): void {
    const start = this.scrubStart;
    if (start === undefined || event.pointerId !== start.pointer) return;
    const wasScrubbing = this.scrubbing.is('scrubbing');
    this.scrubbing.send('release');
    this.scrubStart = undefined;
    this.text = undefined;
    if (!wasScrubbing) {
      this.focus();
      return;
    }
    const { value, delta } = this.scrubValue(event.clientX - start.x, event);
    if (delta !== 0) this.finish(value, delta, 'scrub', 'sf-change');
  }

  /** Cancel a drag in progress: the start value comes back (`sf-input` with delta 0). */
  cancelScrub(): void {
    if (this.scrubbing.is('idle')) return;
    const start = this.scrubStart;
    this.scrubbing.send('cancel');
    this.scrubStart = undefined;
    this.text = undefined;
    if (this.lastDelta !== 0) this.finish(start?.value, 0, 'scrub', 'sf-input');
    this.lastDelta = 0;
  }

  private readonly onDocumentKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && !this.scrubbing.is('idle')) {
      event.preventDefault();
      event.stopPropagation();
      this.cancelScrub();
    }
  };

  override render(): TemplateResult {
    const mixedText = kitText(this.deps.i18n, kitMessages.mixed);
    const value = this.value;
    const valueText = this.mixed || value === undefined ? mixedText : `${formatNumberValue(value, this.precision)}${this.unit === '' ? '' : ` ${this.unit}`}`;
    return html`<label
        class="label ${this.labelHidden ? 'sr-only' : ''}"
        for=${this.ids.input}
        part="label"
        @pointerdown=${this.onLabelPointerDown}
        @pointermove=${this.onLabelPointerMove}
        @pointerup=${this.onLabelPointerUp}
        @pointercancel=${() => this.cancelScrub()}
        @click=${(e: Event) => e.preventDefault()}
        >${this.label}</label
      >
      <div class="field control" part="field">
        <input
          id=${this.ids.input}
          class="focus-target"
          type="text"
          inputmode="decimal"
          role="spinbutton"
          autocomplete="off"
          spellcheck="false"
          aria-valuenow=${this.mixed || value === undefined ? nothing : value}
          aria-valuemin=${this.min ?? nothing}
          aria-valuemax=${this.max ?? nothing}
          aria-valuetext=${valueText}
          aria-invalid=${this.error === '' ? nothing : 'true'}
          aria-describedby=${this.error === '' ? nothing : this.ids.error}
          placeholder=${this.mixed ? mixedText : nothing}
          ?disabled=${this.disabled}
          .value=${live(this.displayText)}
          @input=${(e: Event) => {
            e.stopPropagation();
            this.text = (e.target as HTMLInputElement).value;
            this.error = '';
          }}
          @change=${(e: Event) => e.stopPropagation()}
          @keydown=${this.onKeydown}
          @blur=${() => this.commitText()}
          @dblclick=${() => this.select()}
        />${this.unit === '' ? nothing : html`<span class="unit" aria-hidden="true">${this.unit}</span>`}
      </div>
      ${this.error === '' ? nothing : html`<div class="error" id=${this.ids.error} part="error" role="alert">${this.error}</div>`}`;
  }
}

export function defineNumberField(registry: CustomElementRegistry = customElements): void {
  if (registry.get(numberFieldSpec.tag) === undefined) defineComponent(SfNumberFieldElement, registry);
}
