/**
 * `@staticflux/kit/feedback` — the feedback blocks of OVERLAYS-FEEDBACK §3 and the one `SfError` → UI mapping.
 *
 * - `errorFeedback(error, copy?)` — mechanical (§3.2): the **message** is the first line, the **fix** is a button
 *   (an action the app can run), a link (a place) or plain advice, and the **code is never shown** — it goes to
 *   `diagnosticsText` (`Copy diagnostics`, DevTools). The app passes person-facing copy per error definition; an
 *   `SfError`'s own `fix` is developer text and is never rendered.
 * - `feedbackLevel(origin)` — the level by origin, not by code (§3.1): a field commit → inline, a region's load →
 *   section, a capability run → toast, a condition fact → banner, a boot failure → blocking.
 * - `<sf-banner tone message>` — a persistent condition: a 40 px in-flow bar at the top of its region, one sentence,
 *   one action (`action-label`, `sf-action`), `×` only when informational and `dismissible` (§3.1).
 * - `<sf-blocking-error heading message fix-label>` — the dead-surface card: the primary fix, `Copy diagnostics`,
 *   `Reload` (`sf-fix`, `sf-copy-diagnostics`, `sf-reload`). Request it with `defineBlockingErrorSurface`
 *   (`surface-defs`) and `replace: true`: it is the one thing that replaces an open dialog.
 * - `<sf-progress-row label value max>` — work ≥ 2 s (§3.4): a determinate bar when steps are countable, indeterminate
 *   otherwise, the step named in words, `Cancel` (`sf-cancel`, abort the job's signal).
 */
import type { SfError } from '@staticflux/core';
import { I18nToken } from '@staticflux/i18n';
import { component, defineComponent, SfElement } from '@staticflux/ui';
import { css, html, nothing, type TemplateResult } from 'lit';
import { defineButton } from './button.js';
import { defineIconElement } from './icon.js';
import { defineIconButton } from './icon-button.js';
import { circleAlertIcon } from './icons/circle-alert.js';
import { infoIcon } from './icons/info.js';
import { triangleAlertIcon } from './icons/triangle-alert.js';
import { xIcon } from './icons/x.js';
import { emit } from './internal/events.js';
import { baseStyles, t } from './internal/styles.js';
import { kitMessages, kitText } from './messages.js';

// ------------------------------------------------------------------ mapping

/** What a person can do about an error: run it, go there, or read advice (§3.2). */
export type UserFix =
  | { readonly kind: 'action'; readonly label: string }
  | { readonly kind: 'link'; readonly label: string; readonly href: string }
  | { readonly kind: 'advice'; readonly text: string };

export interface ErrorCopy {
  /** Person-facing first line (what happened); defaults to the error's message. */
  readonly message?: string;
  readonly fix?: UserFix;
}

export interface ErrorFeedback {
  readonly message: string;
  readonly fix: UserFix | undefined;
  /** For `Copy diagnostics` only: never rendered in the surface. */
  readonly diagnostics: string;
}

/** The text `Copy diagnostics` puts on the clipboard: code, kind, message, details, trace (never shown inline). */
export function diagnosticsText(error: SfError): string {
  const lines = [`${error.code} (${error.kind})`, error.message];
  if (Object.keys(error.details).length > 0) lines.push(JSON.stringify(error.details));
  if (error.traceId !== undefined) lines.push(`trace ${error.traceId}`);
  return lines.join('\n');
}

/** `SfError` → message line + fix + diagnostics (the code is never part of what is shown). */
export function errorFeedback(error: SfError, copy: ErrorCopy = {}): ErrorFeedback {
  return { message: copy.message ?? error.message, fix: copy.fix, diagnostics: diagnosticsText(error) };
}

export type FeedbackOrigin = 'field' | 'region' | 'capability' | 'condition' | 'boot';
export type FeedbackLevel = 'inline' | 'section' | 'toast' | 'banner' | 'blocking';

const LEVELS: Readonly<Record<FeedbackOrigin, FeedbackLevel>> = Object.freeze({ field: 'inline', region: 'section', capability: 'toast', condition: 'banner', boot: 'blocking' });

/** The lowest level an error's origin allows (§3.1). */
export function feedbackLevel(origin: FeedbackOrigin): FeedbackLevel {
  return LEVELS[origin];
}

// ------------------------------------------------------------------ banner

export type BannerTone = 'info' | 'warning' | 'danger';

const bannerSpec = component({
  tag: 'sf-banner',
  deps: { lazy: { i18n: I18nToken } },
  placeholder: () => html``,
  description: 'Persistent condition bar: tone icon, one sentence, one action, × only when informational.',
});

const BANNER_ICONS = { info: infoIcon, warning: triangleAlertIcon, danger: circleAlertIcon } as const;

export class SfBannerElement extends SfElement<typeof bannerSpec> {
  static override readonly spec = bannerSpec;
  static override properties = {
    tone: { reflect: true },
    message: {},
    actionLabel: { attribute: 'action-label' },
    dismissible: { type: Boolean },
    label: {},
  };
  static override styles = [
    baseStyles,
    css`
      :host {
        display: flex;
        align-items: center;
        gap: ${t.space.sm.css};
        min-block-size: 40px;
        padding-inline: ${t.space.lg.css};
        background: ${t.color.infoSubtle.css};
        color: ${t.color.text.css};
        border-block-end: 1px solid ${t.color.border.css};
      }
      :host([tone='warning']) {
        background: ${t.color.warningSubtle.css};
      }
      :host([tone='danger']) {
        background: ${t.color.dangerSubtle.css};
      }
      .message {
        flex: 1;
        min-inline-size: 0;
      }
      @media (forced-colors: active) {
        :host {
          border: 1px solid CanvasText;
        }
      }
    `,
  ];

  declare tone: BannerTone;
  declare message: string;
  declare actionLabel: string;
  /** Informational banners may offer `×`; warnings and dangers stay while their condition holds. */
  declare dismissible: boolean;
  /** Region name when it has controls (default: the message). */
  declare label: string;

  constructor() {
    super();
    this.tone = 'info';
    this.message = '';
    this.actionLabel = '';
    this.dismissible = false;
    this.label = '';
  }

  /** `×` is offered only for informational banners (§3.1). */
  get canDismiss(): boolean {
    return this.dismissible && this.tone === 'info';
  }

  protected override willUpdate(): void {
    const controls = this.actionLabel !== '' || this.canDismiss;
    this.setAttribute('role', controls ? 'region' : 'status');
    if (controls) this.setAttribute('aria-label', this.label || this.message);
    else this.removeAttribute('aria-label');
  }

  override render(): TemplateResult {
    return html`<sf-icon .icon=${BANNER_ICONS[this.tone]}></sf-icon>
      <span class="message" role=${this.actionLabel !== '' || this.canDismiss ? 'status' : nothing}>${this.message}<slot></slot></span>
      ${this.actionLabel === '' ? nothing : html`<sf-button size="sm" variant="secondary" @click=${() => emit(this, 'sf-action', {})}>${this.actionLabel}</sf-button>`}
      ${this.canDismiss
        ? html`<sf-icon-button size="sm" .tooltip=${false} label=${kitText(this.deps.i18n, kitMessages.dismiss)} @click=${() => emit(this, 'sf-dismiss', {})}><sf-icon .icon=${xIcon}></sf-icon></sf-icon-button>`
        : nothing}`;
  }
}

// ------------------------------------------------------------------ blocking error

const blockingSpec = component({
  tag: 'sf-blocking-error',
  deps: { lazy: { i18n: I18nToken } },
  placeholder: () => html``,
  description: 'Blocking full-surface error: one calm card with the fix, Copy diagnostics and Reload.',
});

export class SfBlockingErrorElement extends SfElement<typeof blockingSpec> {
  static override readonly spec = blockingSpec;
  static override properties = { heading: {}, message: {}, fixLabel: { attribute: 'fix-label' }, diagnostics: {} };
  static override styles = [
    baseStyles,
    css`
      :host {
        display: grid;
        place-items: center;
        block-size: 100%;
        min-block-size: 100vh;
        padding: ${t.space.xl.css};
        background: ${t.color.canvas.css};
      }
      .card {
        display: grid;
        gap: ${t.space.md.css};
        max-inline-size: 420px;
        padding: ${t.space.xl.css};
        border-radius: 22px;
        background: ${t.color.surface3.css};
        box-shadow: ${t.shadow.level3.css};
      }
      h2 {
        margin: 0;
        font-family: ${t.font.familyDisplay.css};
        font-size: 20px;
      }
      p {
        margin: 0;
        color: ${t.color.textMuted.css};
        line-height: ${t.type.lineNormal.css};
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: ${t.space.sm.css};
      }
    `,
  ];

  declare heading: string;
  declare message: string;
  declare fixLabel: string;
  /** Text for `Copy diagnostics` (`errorFeedback(error).diagnostics`); never shown. */
  declare diagnostics: string;

  constructor() {
    super();
    this.heading = '';
    this.message = '';
    this.fixLabel = '';
    this.diagnostics = '';
  }

  protected override willUpdate(): void {
    this.setAttribute('data-sf-frame', '');
  }

  override render(): TemplateResult {
    const i18n = this.deps.i18n;
    return html`<div class="card" part="card">
      <h2>${this.heading}</h2>
      <p>${this.message}</p>
      <div class="actions">
        ${this.fixLabel === '' ? nothing : html`<sf-button variant="primary" autofocus @click=${() => emit(this, 'sf-fix', {})}>${this.fixLabel}</sf-button>`}
        <sf-button variant="secondary" @click=${() => emit(this, 'sf-copy-diagnostics', { text: this.diagnostics })}>${kitText(i18n, kitMessages.copyDiagnostics)}</sf-button>
        <sf-button variant="ghost" @click=${() => emit(this, 'sf-reload', {})}>${kitText(i18n, kitMessages.reload)}</sf-button>
      </div>
    </div>`;
  }
}

// ------------------------------------------------------------------ progress row

const progressSpec = component({
  tag: 'sf-progress-row',
  deps: { lazy: { i18n: I18nToken } },
  placeholder: () => html``,
  description: 'Progress row: determinate or indeterminate bar, the step in words, Cancel.',
});

/** Fraction done (0–1) or undefined when indeterminate. */
export function progressFraction(value: number | undefined, max: number): number | undefined {
  if (value === undefined || !Number.isFinite(value) || max <= 0) return undefined;
  return Math.min(1, Math.max(0, value / max));
}

export class SfProgressRowElement extends SfElement<typeof progressSpec> {
  static override readonly spec = progressSpec;
  static override properties = { label: {}, value: { type: Number }, max: { type: Number }, cancellable: { type: Boolean }, cancelLabel: { attribute: 'cancel-label' } };
  static override styles = [
    baseStyles,
    css`
      :host {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        align-items: center;
        gap: ${t.space.xs.css} ${t.space.md.css};
      }
      .label {
        font-size: ${t.type.sizeSm.css};
      }
      .track {
        grid-column: 1;
        block-size: 4px;
        border-radius: 2px;
        background: ${t.color.neutral4.css};
        overflow: hidden;
      }
      .bar {
        block-size: 100%;
        background: ${t.color.accent.css};
        transform-origin: left center;
      }
      .bar[data-indeterminate] {
        inline-size: 40%;
        animation: sf-progress ${t.motion.durationSlow.css} linear infinite;
        animation-duration: calc(${t.motion.durationSlow.css} * 6);
      }
      @keyframes sf-progress {
        from {
          transform: translateX(-100%);
        }
        to {
          transform: translateX(250%);
        }
      }
      sf-button {
        grid-column: 2;
        grid-row: 1 / span 2;
      }
      @media (forced-colors: active) {
        .bar {
          background: Highlight;
        }
      }
    `,
  ];

  declare label: string;
  /** Steps or bytes done; undefined = indeterminate. */
  declare value: number | undefined;
  declare max: number;
  declare cancellable: boolean;
  declare cancelLabel: string;

  constructor() {
    super();
    this.label = '';
    this.value = undefined;
    this.max = 1;
    this.cancellable = true;
    this.cancelLabel = '';
  }

  override render(): TemplateResult {
    const fraction = progressFraction(this.value, this.max);
    const cancel = this.cancelLabel === '' ? kitText(this.deps.i18n, kitMessages.cancel) : this.cancelLabel;
    return html`<span class="label" aria-hidden="true">${this.label}</span>
      <div
        class="track"
        role="progressbar"
        aria-label=${this.label}
        aria-valuemin="0"
        aria-valuemax=${fraction === undefined ? nothing : this.max}
        aria-valuenow=${fraction === undefined ? nothing : (this.value ?? 0)}
        aria-valuetext=${this.label}
      >
        <div class="bar" ?data-indeterminate=${fraction === undefined} style=${fraction === undefined ? '' : `inline-size:${(fraction * 100).toFixed(1)}%`}></div>
      </div>
      ${this.cancellable ? html`<sf-button size="sm" variant="secondary" @click=${() => emit(this, 'sf-cancel', {})}>${cancel}</sf-button>` : nothing}`;
  }
}

export function defineFeedback(registry: CustomElementRegistry = customElements): void {
  defineButton(registry);
  defineIconButton(registry);
  defineIconElement(registry);
  if (registry.get(bannerSpec.tag) === undefined) defineComponent(SfBannerElement, registry);
  if (registry.get(blockingSpec.tag) === undefined) defineComponent(SfBlockingErrorElement, registry);
  if (registry.get(progressSpec.tag) === undefined) defineComponent(SfProgressRowElement, registry);
}
