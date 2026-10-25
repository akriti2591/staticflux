/**
 * `<sf-inline-edit label="Design title" .value=${title}>` — inline rename (FOUNDATIONS §4.19):
 * the name shows as text; editing swaps in a field over it with the text pre-selected.
 *
 * - **Start:** `edit()` (menus, `Mod+Shift+R`, Enter / F2 on a focused row — the app's keys), or the
 *   `trigger`: `dblclick` (default) on the text, `click` (the text is a real button: click, Enter,
 *   Space or F2 start editing — the Studio title), `none`.
 * - **Finish:** Enter saves, blur saves, Escape cancels (and stops there, so a surrounding dialog or
 *   canvas does not also handle it). The value is trimmed; empty (when `required`, the default) or
 *   longer than `maxlength` is refused inline with an error line (`aria-invalid`, `role="alert"`)
 *   and editing continues; a refused blur restores the previous name.
 * - **Events:** `sf-edit-start`; `sf-change` `{ value, previous }` only when the name changed (one
 *   undo step for the app); `sf-cancel`. The element never writes anywhere itself.
 *
 * Lifecycle: `kit/inline-edit` (`viewing → editing → viewing`), LIFECYCLES §37.
 */
import { createMachine, defineMachine, err, ok, type Result } from '@staticflux/core';
import { I18nToken } from '@staticflux/i18n';
import { component, defineComponent, SfElement } from '@staticflux/ui';
import { css, html, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { InvalidNameError } from './errors.js';
import { emit } from './internal/events.js';
import { uniqueId } from './internal/ids.js';
import { baseStyles, focusRing, srOnly, t } from './internal/styles.js';
import { kitMessages, kitText } from './messages.js';

export type InlineEditTrigger = 'dblclick' | 'click' | 'none';

export interface NameRules {
  /** Refuse empty (after trimming). Default true. */
  readonly required?: boolean;
  readonly maxLength?: number | undefined;
}

export interface InlineEditChangeDetail {
  readonly value: string;
  readonly previous: string;
}

export const inlineEditMachine = defineMachine({
  id: 'kit/inline-edit',
  initial: 'viewing',
  states: ['viewing', 'editing'],
  transitions: {
    viewing: { start: 'editing' },
    editing: { commit: 'viewing', cancel: 'viewing', refuse: 'editing' },
  },
});

/** Trim and check a name (pure). SF-KIT-002 with `details.reason` `required | too-long`. */
export function validateName(text: string, rules: NameRules = {}): Result<string> {
  const value = text.trim();
  if ((rules.required ?? true) && value === '') return err(InvalidNameError({ message: 'A name is required.', details: { reason: 'required' } }));
  if (rules.maxLength !== undefined && value.length > rules.maxLength)
    return err(InvalidNameError({ message: `Names are at most ${rules.maxLength} characters.`, details: { reason: 'too-long', maxLength: rules.maxLength } }));
  return ok(value);
}

const inlineEditSpec = component({
  tag: 'sf-inline-edit',
  deps: { lazy: { i18n: I18nToken } },
  placeholder: () => nothing,
  description: 'Inline rename: text that becomes a pre-selected field; Enter/blur save, Escape cancels, empty refused inline.',
});

export class SfInlineEditElement extends SfElement<typeof inlineEditSpec> {
  static override readonly spec = inlineEditSpec;
  static override properties = {
    value: {},
    label: {},
    placeholder: {},
    required: { type: Boolean },
    maxlength: { type: Number },
    trigger: {},
    editing: { type: Boolean, reflect: true },
    error: { state: true },
  };
  static override styles = [
    baseStyles,
    focusRing,
    srOnly,
    css`
      :host {
        display: inline-grid;
        min-inline-size: 0;
        max-inline-size: 100%;
        font: inherit;
        color: inherit;
      }
      .text {
        all: unset;
        box-sizing: border-box;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        padding-inline: ${t.space.xs.css};
        border-radius: ${t.radius.sm.css};
        font: inherit;
        color: inherit;
      }
      button.text {
        cursor: text;
      }
      button.text:hover {
        background: ${t.color.surfaceHover.css};
      }
      button.text:focus-visible {
        outline: 2px solid ${t.color.focusRing.css};
        outline-offset: 2px;
      }
      .placeholder {
        color: ${t.color.textSubtle.css};
      }
      input {
        all: unset;
        box-sizing: border-box;
        min-inline-size: 8ch;
        inline-size: 100%;
        padding-inline: ${t.space.xs.css};
        border-radius: ${t.radius.md.css};
        background: ${t.color.surfaceSunken.css};
        border: 1px solid ${t.color.controlEdge.css};
        font: inherit;
        color: ${t.color.text.css};
      }
      input:focus {
        outline: 2px solid ${t.color.focusRing.css};
        outline-offset: 2px;
      }
      :host([invalid]) input {
        border-color: ${t.color.danger.css};
      }
      .error {
        font-size: ${t.type.sizeSm.css};
        font-weight: ${t.font.weightRegular.css};
        color: ${t.color.dangerText.css};
      }
      @media (forced-colors: active) {
        input {
          border-color: FieldText;
        }
      }
    `,
  ];

  declare value: string;
  /** Accessible name of the field (and of the `click` trigger: "Rename {label}"). */
  declare label: string;
  /** Shown when the value is empty (e.g. "Untitled design"). */
  declare placeholder: string;
  declare required: boolean;
  declare maxlength: number | undefined;
  declare trigger: InlineEditTrigger;
  declare editing: boolean;
  /** The inline error shown under the field ('' when none). */
  declare error: string;
  private readonly machine = createMachine(inlineEditMachine);
  private readonly errorId = uniqueId('sf-inline-edit-error');
  private draft = '';
  private settling = false;

  constructor() {
    super();
    this.value = '';
    this.label = '';
    this.placeholder = '';
    this.required = true;
    this.maxlength = undefined;
    this.trigger = 'dblclick';
    this.editing = false;
    this.error = '';
  }

  get input(): HTMLInputElement | null {
    return this.shadowRoot?.querySelector('input') ?? null;
  }

  /** `viewing | editing`. */
  get state(): string {
    return this.machine.state;
  }

  /** Start editing (no-op while editing). Focuses the field and selects the text. */
  edit(): void {
    if (!this.machine.can('start')) return;
    this.machine.send('start');
    this.draft = this.value;
    this.error = '';
    this.editing = true;
    emit(this, 'sf-edit-start', {});
    void this.updateComplete.then(() => {
      const input = this.input;
      input?.focus();
      input?.select();
    });
  }

  /** Save the draft. Returns false (and shows why) when the name is refused. */
  save(): boolean {
    if (!this.machine.is('editing')) return true;
    const checked = validateName(this.input?.value ?? this.draft, { required: this.required, maxLength: this.maxlength });
    if (!checked.ok) {
      this.machine.send('refuse');
      const reason = checked.error.details?.['reason'];
      this.error = reason === 'too-long' ? kitText(this.deps.i18n, kitMessages.nameTooLong, { max: String(this.maxlength ?? 0) }) : kitText(this.deps.i18n, kitMessages.nameRequired);
      return false;
    }
    const previous = this.value;
    this.leave('commit');
    if (checked.value !== previous) {
      this.value = checked.value;
      emit<InlineEditChangeDetail>(this, 'sf-change', { value: checked.value, previous });
    }
    return true;
  }

  /** Leave editing without saving. */
  cancel(): void {
    if (!this.machine.is('editing')) return;
    this.leave('cancel');
    emit(this, 'sf-cancel', {});
  }

  private leave(event: 'commit' | 'cancel'): void {
    this.machine.send(event);
    this.settling = true; // the field's blur on removal must not save again
    this.error = '';
    this.editing = false;
    void this.updateComplete.then(() => {
      this.settling = false;
      if (this.trigger === 'click') this.shadowRoot?.querySelector<HTMLElement>('button.text')?.focus();
    });
  }

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has('error')) this.toggleAttribute('invalid', this.error !== '');
    // An app may set `editing` directly.
    if (changed.has('editing') && this.editing && this.machine.is('viewing')) {
      this.editing = false;
      this.edit();
    }
  }

  private onKeydown(event: KeyboardEvent): void {
    event.stopPropagation(); // typing never reaches canvas or list shortcuts
    if (event.key === 'Enter') {
      event.preventDefault();
      this.save();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.cancel();
    }
  }

  private onBlur(): void {
    if (this.settling || !this.machine.is('editing')) return;
    if (!this.save()) this.cancel();
  }

  private onTriggerKey(event: KeyboardEvent): void {
    if (event.key === 'F2') {
      event.preventDefault();
      this.edit();
    }
  }

  override render(): TemplateResult {
    if (this.editing) {
      return html`<input
          part="input"
          aria-label=${this.label}
          aria-invalid=${this.error === '' ? nothing : 'true'}
          aria-describedby=${this.error === '' ? nothing : this.errorId}
          maxlength=${this.maxlength ?? nothing}
          .value=${this.draft}
          @input=${(e: Event) => {
            this.draft = (e.target as HTMLInputElement).value;
            this.error = '';
          }}
          @keydown=${this.onKeydown}
          @blur=${this.onBlur}
        />${this.error === '' ? nothing : html`<span class="error" id=${this.errorId} part="error" role="alert">${this.error}</span>`}`;
    }
    const empty = this.value === '';
    const content = empty ? html`<span class="placeholder">${this.placeholder}</span>` : this.value;
    if (this.trigger === 'click') {
      return html`<button class="text" part="text" type="button" aria-label=${kitText(this.deps.i18n, kitMessages.renameLabel, { label: this.label, value: empty ? this.placeholder : this.value })} @click=${() => this.edit()} @keydown=${this.onTriggerKey}>
        ${content}
      </button>`;
    }
    return html`<span class="text" part="text" @dblclick=${this.trigger === 'dblclick' ? () => this.edit() : nothing}>${content}</span>`;
  }
}

export function defineInlineEdit(registry: CustomElementRegistry = customElements): void {
  if (registry.get(inlineEditSpec.tag) === undefined) defineComponent(SfInlineEditElement, registry);
}
