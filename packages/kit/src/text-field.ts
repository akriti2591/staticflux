/**
 * `<sf-text-field label="Title">` — a labelled text input (or `multiline` textarea).
 * Label, hint, error and the native control live in one shadow root, so `<label for>`
 * and `aria-describedby` resolve (ids never cross a shadow boundary). `label-hidden` keeps
 * the label for assistive technology only (toolbars, inspector rows). `error` sets
 * `aria-invalid` and announces the message. The native `input` event bubbles out
 * (composed); `change` and `sf-change` (`{ value }`) are re-dispatched from the host.
 * Participates in forms through ElementInternals where available.
 */
import { component, defineComponent, SfElement } from '@staticflux/ui';
import { html, LitElement, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { live } from 'lit/directives/live.js';
import type { ControlSize } from './internal/button-styles.js';
import { emit } from './internal/events.js';
import { fieldStyles } from './internal/field-styles.js';
import { baseStyles, controlStyles, srOnly } from './internal/styles.js';

export type TextFieldType = 'text' | 'search' | 'email' | 'url' | 'tel' | 'password' | 'number';

const textFieldSpec = component({
  tag: 'sf-text-field',
  placeholder: () => nothing,
  description: 'Labelled text input / textarea with hint, error (aria-invalid) and form association.',
});

let fieldCounter = 0;

export class SfTextFieldElement extends SfElement<typeof textFieldSpec> {
  static override readonly spec = textFieldSpec;
  static readonly formAssociated = true;
  static override shadowRootOptions: ShadowRootInit = { ...LitElement.shadowRootOptions, delegatesFocus: true };
  static override properties = {
    label: {},
    labelHidden: { type: Boolean, attribute: 'label-hidden' },
    value: {},
    placeholder: {},
    type: {},
    name: { reflect: true },
    disabled: { type: Boolean, reflect: true },
    readonly: { type: Boolean, reflect: true },
    required: { type: Boolean, reflect: true },
    hint: {},
    error: {},
    multiline: { type: Boolean },
    rows: { type: Number },
    size: { reflect: true },
    autocomplete: {},
    maxlength: { type: Number },
  };
  static override styles = [baseStyles, srOnly, controlStyles, fieldStyles];

  declare label: string;
  declare labelHidden: boolean;
  declare value: string;
  declare placeholder: string;
  declare type: TextFieldType;
  declare name: string;
  declare disabled: boolean;
  declare readonly: boolean;
  declare required: boolean;
  declare hint: string;
  declare error: string;
  declare multiline: boolean;
  declare rows: number;
  declare size: ControlSize;
  declare autocomplete: string;
  declare maxlength: number | undefined;
  private readonly ids: { readonly control: string; readonly hint: string; readonly error: string };
  private readonly internals: ElementInternals | undefined;

  constructor() {
    super();
    fieldCounter += 1;
    this.ids = { control: `f${fieldCounter}`, hint: `h${fieldCounter}`, error: `e${fieldCounter}` };
    this.internals = typeof this.attachInternals === 'function' ? this.attachInternals() : undefined;
    this.label = '';
    this.labelHidden = false;
    this.value = '';
    this.placeholder = '';
    this.type = 'text';
    this.name = '';
    this.disabled = false;
    this.readonly = false;
    this.required = false;
    this.hint = '';
    this.error = '';
    this.multiline = false;
    this.rows = 3;
    this.size = 'md';
    this.autocomplete = '';
    this.maxlength = undefined;
  }

  /** The native input / textarea. */
  get control(): HTMLInputElement | HTMLTextAreaElement | null {
    return this.shadowRoot?.querySelector<HTMLInputElement | HTMLTextAreaElement>('input, textarea') ?? null;
  }

  override focus(options?: FocusOptions): void {
    const control = this.control;
    if (control === null) super.focus(options);
    else control.focus(options);
  }

  /** Select the text (e.g. when a rename starts). */
  select(): void {
    this.control?.select();
  }

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has('error')) this.toggleAttribute('invalid', this.error !== '');
    if (changed.has('value')) this.internals?.setFormValue(this.value);
  }

  private onInput(event: Event): void {
    this.value = (event.target as HTMLInputElement).value;
    // The native `input` event is composed and continues to the host's listeners.
  }

  private onChange(): void {
    this.dispatchEvent(new Event('change', { bubbles: true }));
    emit(this, 'sf-change', { value: this.value });
  }

  override render(): TemplateResult {
    const describedBy = [this.hint === '' ? '' : this.ids.hint, this.error === '' ? '' : this.ids.error].filter((id) => id !== '').join(' ');
    const common = {
      describedBy: describedBy === '' ? nothing : describedBy,
      invalid: this.error === '' ? nothing : 'true',
    };
    const control = this.multiline
      ? html`<textarea
          id=${this.ids.control}
          class="focus-target"
          rows=${this.rows}
          name=${this.name || nothing}
          placeholder=${this.placeholder || nothing}
          maxlength=${this.maxlength ?? nothing}
          aria-describedby=${common.describedBy}
          aria-invalid=${common.invalid}
          ?disabled=${this.disabled}
          ?readonly=${this.readonly}
          ?required=${this.required}
          .value=${live(this.value)}
          @input=${this.onInput}
          @change=${this.onChange}
        ></textarea>`
      : html`<input
          id=${this.ids.control}
          class="focus-target"
          type=${this.type}
          name=${this.name || nothing}
          placeholder=${this.placeholder || nothing}
          autocomplete=${this.autocomplete || nothing}
          maxlength=${this.maxlength ?? nothing}
          aria-describedby=${common.describedBy}
          aria-invalid=${common.invalid}
          ?disabled=${this.disabled}
          ?readonly=${this.readonly}
          ?required=${this.required}
          .value=${live(this.value)}
          @input=${this.onInput}
          @change=${this.onChange}
        />`;
    return html`<label class="label ${this.labelHidden ? 'sr-only' : ''}" for=${this.ids.control} part="label">${this.label}</label>
      <div class="field control" part="field"><slot name="start"></slot>${control}<slot name="end"></slot></div>
      ${this.hint === '' ? nothing : html`<div class="hint" id=${this.ids.hint} part="hint">${this.hint}</div>`}
      ${this.error === '' ? nothing : html`<div class="error" id=${this.ids.error} part="error" role="alert">${this.error}</div>`}`;
  }
}

export function defineTextField(registry: CustomElementRegistry = customElements): void {
  if (registry.get(textFieldSpec.tag) === undefined) defineComponent(SfTextFieldElement, registry);
}
