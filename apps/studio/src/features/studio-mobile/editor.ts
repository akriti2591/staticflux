/**
 * `<studio-mobile-editor>` — compact editor UI over the same document store as the
 * desktop variant (per-mode variant, R18.5): one column, no minimap, presence lazy.
 */
import { component, type ComponentHooksOf, defineComponent, SfElement } from '@staticflux/ui';
import { css, html, type TemplateResult } from 'lit';
import { CapabilityInvokerToken } from '../../adapters/capabilities-router.js';
import { ReadinessToken } from '../../adapters/perf-runtime.js';
import { DocumentStoreToken, Features, InsertTextCapability, PresenceToken } from '../../app/contracts.js';
import { defineBlockList } from '../../ui/block-list.js';

const mobileSpec = component({
  tag: 'studio-mobile-editor',
  deps: {
    render: { doc: DocumentStoreToken, invoker: CapabilityInvokerToken, readiness: ReadinessToken },
    lazy: { presence: PresenceToken },
  },
  placeholder: () => html`<sf-skeleton lines="5"></sf-skeleton>`,
  size: { block: '280px' },
});

export class StudioMobileEditor extends SfElement<typeof mobileSpec> {
  static override readonly spec = mobileSpec;
  static override styles = css`
    :host { display: grid; gap: var(--sf-space-2, 8px); }
    input { font-size: 1.2em; width: 100%; box-sizing: border-box; }
  `;

  protected override wireDeps(on: ComponentHooksOf<typeof mobileSpec>): void {
    on.onReady('readiness', (readiness) => readiness.rendered(Features.studioMobile.id, this));
  }

  override render(): TemplateResult {
    const { doc, presence } = this.deps;
    const others = presence.value === undefined ? 0 : Object.values(presence.value.view.participants).filter((p) => !p.local).length;
    return html`
      <input aria-label="Title" .value=${doc.title} ?readonly=${doc.readOnly} @change=${(e: Event) => doc.rename((e.target as HTMLInputElement).value)} />
      <small role="status">${doc.pendingSave ? 'Saving…' : 'Saved'}${others > 0 ? ` · ${others} co-editing` : ''}</small>
      <studio-block-list></studio-block-list>
      <button @click=${() => void this.deps.invoker.invoke(InsertTextCapability, { text: 'New paragraph' })}>Add paragraph</button>
    `;
  }
}

export function defineMobileEditor(): void {
  defineBlockList();
  const defined = defineComponent(StudioMobileEditor);
  if (!defined.ok) throw defined.error;
}
