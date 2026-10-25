/**
 * `<sf-copy-field label="Link" value="https://…">` — a read-only field with a `Copy` button (OVERLAYS-FEEDBACK §2.3
 * Share link row, NAVIGATION-DEEPLINKS Copy link): the button reads `Copied` for 1.5 s, inline and toast-free, because
 * the feedback is next to the gesture. Clicking the field selects its text. A refused clipboard shows the advice
 * inline (`ClipboardWriteError`, SF-KIT-004) and keeps the text selectable. Fires `sf-copy` `{ ok, error? }`.
 *
 * `.write` replaces the clipboard port (tests, apps with their own clipboard bridge); it returns a `Result`.
 */
import { err, ok, type Result, type SfError, toSfError } from '@staticflux/core';
import { I18nToken } from '@staticflux/i18n';
import { component, defineComponent, SfElement } from '@staticflux/ui';
import { css, html, nothing, type TemplateResult } from 'lit';
import { defineButton } from './button.js';
import { ClipboardWriteError } from './errors.js';
import { defineIconElement } from './icon.js';
import { checkIcon } from './icons/check.js';
import { copyIcon } from './icons/copy.js';
import { emit } from './internal/events.js';
import { fieldStyles } from './internal/field-styles.js';
import { uniqueId } from './internal/ids.js';
import { baseStyles, t } from './internal/styles.js';
import { feedbackMessages } from './feedback-messages.js';
import { kitMessages, kitText } from './messages.js';

/** How long the button reads `Copied` (ms). */
export const COPIED_MS = 1500;

export type ClipboardWrite = (text: string) => Promise<Result<void, SfError>>;

/** The browser clipboard as a `Result` port (refusals become SF-KIT-004). */
export function browserClipboardWrite(nav: Navigator | undefined = globalThis.navigator): ClipboardWrite {
  return async (text) => {
    const clipboard = nav?.clipboard;
    if (clipboard === undefined) return err(ClipboardWriteError({ details: { reason: 'no-clipboard-api' } }));
    try {
      await clipboard.writeText(text);
      return ok(undefined);
    } catch (cause) {
      return err(ClipboardWriteError({ cause, details: { reason: toSfError(cause).message } }));
    }
  };
}

export interface CopyDetail {
  readonly ok: boolean;
  readonly error?: SfError;
}

const copyFieldSpec = component({
  tag: 'sf-copy-field',
  deps: { lazy: { i18n: I18nToken } },
  placeholder: () => html``,
  description: 'Read-only field with a Copy button that reads Copied for 1.5 s; inline advice when the clipboard refuses.',
});

export class SfCopyFieldElement extends SfElement<typeof copyFieldSpec> {
  static override readonly spec = copyFieldSpec;
  static override properties = {
    label: {},
    value: {},
    labelHidden: { type: Boolean, attribute: 'label-hidden' },
    write: { attribute: false },
    copied: { state: true },
    failed: { state: true },
  };
  static override styles = [
    baseStyles,
    fieldStyles,
    css`
      .row {
        display: flex;
        gap: ${t.space.sm.css};
        align-items: center;
      }
      .field {
        flex: 1;
        min-block-size: ${t.size.control.css};
      }
      input {
        font-family: ${t.font.familyMono.css};
        font-size: ${t.type.sizeSm.css};
        text-overflow: ellipsis;
      }
      .sr-only {
        position: absolute;
        inline-size: 1px;
        block-size: 1px;
        overflow: hidden;
        clip-path: inset(50%);
        white-space: nowrap;
      }
    `,
  ];

  declare label: string;
  declare value: string;
  declare labelHidden: boolean;
  declare write: ClipboardWrite;
  declare copied: boolean;
  declare failed: boolean;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly inputId = uniqueId('sf-copy');
  private readonly errorId = uniqueId('sf-copy-error');

  constructor() {
    super();
    this.label = '';
    this.value = '';
    this.labelHidden = false;
    this.write = browserClipboardWrite();
    this.copied = false;
    this.failed = false;
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    clearTimeout(this.timer);
  }

  /** Copy the value; the button reads `Copied` for 1.5 s on success. */
  async copy(): Promise<Result<void, SfError>> {
    const result = await this.write(this.value);
    clearTimeout(this.timer);
    this.failed = !result.ok;
    this.copied = result.ok;
    if (result.ok) this.timer = setTimeout(() => (this.copied = false), COPIED_MS);
    else this.renderRoot.querySelector('input')?.select();
    emit<CopyDetail>(this, 'sf-copy', result.ok ? { ok: true } : { ok: false, error: result.error });
    return result;
  }

  override render(): TemplateResult {
    const i18n = this.deps.i18n;
    return html`<label class=${this.labelHidden ? 'sr-only' : 'label'} for=${this.inputId}>${this.label}</label>
      <div class="row">
        <div class="field">
          <input
            id=${this.inputId}
            readonly
            .value=${this.value}
            aria-describedby=${this.failed ? this.errorId : nothing}
            @focus=${(e: Event) => (e.target as HTMLInputElement).select()}
            @click=${(e: Event) => (e.target as HTMLInputElement).select()}
          />
        </div>
        <sf-button size="sm" variant="secondary" @click=${() => void this.copy()}
          ><sf-icon slot="start" .icon=${this.copied ? checkIcon : copyIcon}></sf-icon>${this.copied ? kitText(i18n, feedbackMessages.copied) : kitText(i18n, feedbackMessages.copy)}</sf-button
        >
      </div>
      <span class="sr-only" role="status">${this.copied ? kitText(i18n, feedbackMessages.copied) : ''}</span>
      ${this.failed ? html`<span class="error" id=${this.errorId} role="status">${kitText(i18n, feedbackMessages.copyFailed)}</span>` : nothing}`;
  }
}

export function defineCopyField(registry: CustomElementRegistry = customElements): void {
  defineButton(registry);
  defineIconElement(registry);
  if (registry.get(copyFieldSpec.tag) === undefined) defineComponent(SfCopyFieldElement, registry);
}
