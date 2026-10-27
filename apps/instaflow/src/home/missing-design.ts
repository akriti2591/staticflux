/**
 * `<if-missing-design>` — what a Studio URL shows when its design cannot open (B11c; NAVIGATION-DEEPLINKS §4: "one
 * level up, once announced, never blocking"). A Home-shell page at the same URL, no engine (D17):
 *
 * - **Not on this device** (`IF-HOME-002`, no such design): `This design isn't on this device`, the sentence "Designs
 *   live in this browser profile or in the folder you chose." and `Go to Home` (primary). `Open a folder…` waits for
 *   D8's folder workspace and is not shown.
 * - **In the trash**: `This design is in the trash` with `Restore` (primary: a Home journal op the session applies
 *   before it opens the design, then the page reloads into Studio) and `Go to Home`. NAVIGATION §4 asks for a
 *   read-only Studio with a banner; M1 has no read-only Studio, so the page offers the way back instead (handoff note).
 *
 * The host does the work: `if-restore` (detail `{ asset }`); `Go to Home` asks with `if-navigate` (cancelable, detail
 * `{ href }`) and navigates itself when nobody cancels.
 */
import { defineButton } from '@staticflux/kit/button';
import { component, defineComponent, SfElement } from '@staticflux/ui';
import { themeTokens as t } from '@staticflux/ui/theme';
import { css, html, nothing, type TemplateResult } from 'lit';
import { instaflowMark } from '../theme/logo.js';

export const MISSING_DESIGN_TAG = 'if-missing-design';

export const missingDesignMessages = Object.freeze({
  home: 'Instaflow Home',
  missing: 'This design isn’t on this device',
  missingLine: 'Designs live in this browser profile or in the folder you chose.',
  trashed: 'This design is in the trash',
  trashedLine: (title: string) => (title === '' ? 'Restore it to keep working on it.' : `Restore “${title}” to keep working on it.`),
  goHome: 'Go to Home',
  restore: 'Restore',
  restoring: 'Restoring…',
});
const m = missingDesignMessages;

const spec = component({ tag: MISSING_DESIGN_TAG, placeholder: () => nothing, description: 'The page a Studio link shows when its design is not on this device or is in the trash (B11c).' });

export class IfMissingDesignElement extends SfElement<typeof spec> {
  static override readonly spec = spec;
  static override properties = {
    asset: {},
    trashed: { type: Boolean, reflect: true },
    designTitle: { attribute: 'design-title' },
    homeHref: { attribute: 'home-href' },
    busy: { state: true },
  };
  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      min-block-size: 100vh;
      background: ${t.color.canvas.css};
      color: ${t.color.text.css};
      font-family: ${t.font.family.css};
    }
    header {
      display: flex;
      align-items: center;
      min-block-size: 64px;
      padding-inline: 24px;
    }
    .brand {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      color: ${t.color.text.css};
      text-decoration: none;
      border-radius: ${t.radius.md.css};
      font-family: ${t.font.familyDisplay.css};
      font-weight: ${t.font.weightDisplay.css};
      font-size: 21px;
      letter-spacing: -0.02em;
    }
    a:focus-visible {
      outline: 2px solid ${t.color.focusRing.css};
      outline-offset: 2px;
    }
    main {
      flex: 1;
      display: grid;
      place-content: center;
      justify-items: center;
      gap: ${t.space.md.css};
      padding: 24px 16px 96px;
      text-align: center;
    }
    h1 {
      margin: 0;
      font-family: ${t.font.familyDisplay.css};
      font-weight: ${t.font.weightDisplay.css};
      font-size: 32px;
      letter-spacing: -0.02em;
    }
    p {
      margin: 0;
      max-inline-size: 420px;
      color: ${t.color.textMuted.css};
      font-size: ${t.type.sizeMd.css};
    }
    .actions {
      display: flex;
      gap: ${t.space.sm.css};
      margin-block-start: ${t.space.sm.css};
    }
  `;

  declare asset: string;
  declare trashed: boolean;
  declare designTitle: string;
  declare homeHref: string;
  declare busy: boolean;

  constructor() {
    super();
    this.asset = '';
    this.trashed = false;
    this.designTitle = '';
    this.homeHref = '/';
    this.busy = false;
  }

  /** Put the focus on the primary action (the page replaces Studio; nothing else is focused). */
  async focusPrimary(): Promise<void> {
    await this.updateComplete;
    this.renderRoot.querySelector<HTMLElement>('sf-button[variant="primary"]')?.focus();
  }

  private restore(): void {
    if (this.busy) return;
    this.busy = true;
    const proceed = this.dispatchEvent(new CustomEvent('if-restore', { detail: { asset: this.asset }, bubbles: true, composed: true, cancelable: true }));
    if (!proceed) this.busy = false;
  }

  private goHome(): void {
    const proceed = this.dispatchEvent(new CustomEvent('if-navigate', { detail: { href: this.homeHref }, bubbles: true, composed: true, cancelable: true }));
    if (proceed) globalThis.location?.assign(this.homeHref);
  }

  /** The host failed to restore: the button works again. */
  restoreFailed(): void {
    this.busy = false;
  }

  override render(): TemplateResult {
    const home = html`<sf-button class="go-home" variant=${this.trashed ? 'secondary' : 'primary'} @click=${() => this.goHome()}>${m.goHome}</sf-button>`;
    return html`<header><a class="brand" href=${this.homeHref} aria-label=${m.home}>${instaflowMark(28)}<span aria-hidden="true">instaflow</span></a></header>
      <main>
        <h1>${this.trashed ? m.trashed : m.missing}</h1>
        <p>${this.trashed ? m.trashedLine(this.designTitle) : m.missingLine}</p>
        <div class="actions">
          ${this.trashed ? html`<sf-button class="restore" variant="primary" ?disabled=${this.busy} @click=${() => this.restore()}>${this.busy ? m.restoring : m.restore}</sf-button>` : nothing} ${home}
        </div>
      </main>`;
  }
}

export function defineMissingDesign(registry: CustomElementRegistry = customElements): void {
  defineButton(registry);
  if (registry.get(spec.tag) === undefined) defineComponent(IfMissingDesignElement, registry);
}

declare global {
  interface HTMLElementTagNameMap {
    'if-missing-design': IfMissingDesignElement;
  }
}
