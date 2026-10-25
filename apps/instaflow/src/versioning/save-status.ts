/**
 * `<if-save-status>` — the top bar's save indicator (UX §7, IF-5.2): "● Saved", "Saving…",
 * "Not saved yet: <cause>" (after 2 s without an acknowledgement) or "Saved in this browser ·
 * folder not updated" (the folder mirror is behind). A kit `<sf-status>`: a polite live region,
 * so changes are announced, and the words always carry the state (never the dot alone).
 */
import { I18nToken } from '@staticflux/i18n';
import { defineStatus, type StatusTone } from '@staticflux/kit/status';
import { component, defineComponent, SfElement } from '@staticflux/ui';
import { css, html, type TemplateResult } from 'lit';
import type { SaveState } from './latest.js';
import { versioningMessages as m, versioningText } from './messages.js';
import { LatestServiceToken } from './tokens.js';

export const SAVE_STATUS_TAG = 'if-save-status';

const saveStatusSpec = component({
  tag: SAVE_STATUS_TAG,
  deps: { render: { latest: LatestServiceToken }, lazy: { i18n: I18nToken } },
  description: 'Top-bar save indicator: saved, saving, not saved yet (with cause), folder mirror behind.',
});

export interface SaveStatusView {
  readonly tone: StatusTone;
  readonly busy: boolean;
  readonly label: string;
}

/** What the indicator shows for a save state (pure). */
export function saveStatusView(state: SaveState, text: (key: 'saved' | 'saving' | 'notSaved' | 'notSavedUnknown' | 'mirrorBehind', cause?: string) => string): SaveStatusView {
  if (state.status === 'saved') return { tone: 'success', busy: false, label: text('saved') };
  if (state.status === 'offline-mirror-behind') return { tone: 'warning', busy: false, label: text('mirrorBehind') };
  if (!state.stalled) return { tone: 'neutral', busy: true, label: text('saving') };
  return { tone: 'warning', busy: false, label: state.cause === undefined ? text('notSavedUnknown') : text('notSaved', state.cause.message) };
}

export class IfSaveStatusElement extends SfElement<typeof saveStatusSpec> {
  static override readonly spec = saveStatusSpec;
  static override styles = css`
    :host {
      display: inline-flex;
    }
  `;

  override render(): TemplateResult {
    const i18n = this.deps.i18n;
    const view = saveStatusView(this.deps.latest.state(), (key, cause) => (key === 'notSaved' ? versioningText(i18n, m.notSaved, { cause: cause ?? '' }) : versioningText(i18n, m[key])));
    return html`<sf-status tone=${view.tone} ?busy=${view.busy}>${view.label}</sf-status>`;
  }
}

export function defineSaveStatus(registry: CustomElementRegistry = customElements): void {
  defineStatus(registry);
  if (registry.get(SAVE_STATUS_TAG) === undefined) defineComponent(IfSaveStatusElement, registry);
}
