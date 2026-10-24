/**
 * `<studio-desktop-editor>` — the expanded/medium editor UI. Declares its three
 * dependency kinds (ARCHITECTURE §3.5):
 *   render     — the shared document store (placeholder until ready)
 *   lazy       — co-editor presence (reactive when it arrives)
 *   functional — exportPdf, pre-warmed on hover/focus of the Export button (`on-intent`)
 */
import { AnnouncerToken } from '@staticflux/a11y';
import { SurfaceManagerToken } from '@staticflux/messaging';
import { RouterToken } from '@staticflux/router';
import { SurfaceEnvironmentToken } from '@staticflux/surface';
import { component, type ComponentHooksOf, defineComponent, SfElement } from '@staticflux/ui';
import { css, html, type TemplateResult } from 'lit';
import { ReadinessToken } from '../../adapters/perf-runtime.js';
import { CapabilityInvokerToken, DocumentStoreToken, Features, InsertTextCapability, PresenceToken, SummarizeCapability } from '../../app/contracts.js';
import { ShareDialogRoute } from '../../app/routes.js';
import { SavedToast } from '../../app/surfaces.js';
import { defineBlockList } from '../../ui/block-list.js';
import { attachMinimap } from './minimap.js';
import { ExportPdfToken } from './tokens.js';

const TABS = ['content', 'comments', 'history'] as const;

const editorSpec = component({
  tag: 'studio-desktop-editor',
  deps: {
    render: { doc: DocumentStoreToken, invoker: CapabilityInvokerToken, router: RouterToken, readiness: ReadinessToken, surfaceEnv: SurfaceEnvironmentToken },
    lazy: { presence: PresenceToken, announcer: AnnouncerToken, surfaces: SurfaceManagerToken },
    functional: { exportPdf: { token: ExportPdfToken, init: 'on-intent' } },
  },
  placeholder: () => html`<sf-skeleton lines="6"></sf-skeleton>`,
  size: { block: '320px' },
});

export class StudioDesktopEditor extends SfElement<typeof editorSpec> {
  static override readonly spec = editorSpec;
  static override styles = css`
    :host { display: grid; grid-template-columns: 1fr 170px; gap: var(--sf-space-3, 12px); }
    header { grid-column: 1 / -1; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    input.title { font-size: 1.4em; flex: 1; min-inline-size: 12ch; }
    [role='tablist'] { display: flex; gap: 4px; grid-column: 1; }
    [aria-selected='true'] { font-weight: bold; }
    .presence { display: flex; gap: 4px; }
    .chip { padding: 2px 6px; border-radius: 999px; background: var(--sf-color-surface, #eef); font-size: 0.8em; }
    .minimap { min-block-size: 220px; position: relative; }
    .status { opacity: 0.7; }
  `;

  private summary = '';

  protected override wireDeps(on: ComponentHooksOf<typeof editorSpec>): void {
    on.onReady('readiness', (readiness) => {
      readiness.rendered(Features.studioDesktop.id, this);
    });
    on.whileVisible((scope) => {
      // Rich surface only while visible: hidden features cost zero frames (R12.16).
      void this.updateComplete.then(async () => {
        const host = this.renderRoot.querySelector<HTMLElement>('.minimap');
        if (host === null || scope.disposed || !this.ready) return;
        const attached = await attachMinimap(host, this.deps.surfaceEnv, () => this.deps.doc.blocks, scope.signal);
        if (!attached.ok) {
          host.textContent = 'Minimap unavailable on this device.';
          return;
        }
        scope.defer(() => attached.value.dispose());
      });
    });
  }

  override render(): TemplateResult {
    const { doc, presence } = this.deps;
    const tab = doc.tab.get() ?? 'content';
    const participants = presence.value === undefined ? [] : Object.entries(presence.value.view.participants).filter(([, p]) => !p.local);
    return html`
      <header>
        <input class="title" aria-label="Title" .value=${doc.title} ?readonly=${doc.readOnly} @change=${(e: Event) => doc.rename((e.target as HTMLInputElement).value)} />
        <span class="status" role="status">${doc.readOnly ? 'Read-only' : doc.pendingSave ? 'Saving…' : 'Saved'}</span>
        <span class="presence" aria-label="Co-editors">${participants.map(([id, p]) => html`<span class="chip" title=${id}>${p.state.name ?? id}</span>`)}</span>
        <button @click=${() => void this.addParagraph()} ?disabled=${doc.readOnly}>Add paragraph</button>
        <button data-sf-intent=${this.intent('exportPdf')} @click=${() => void this.export()}>Export PDF</button>
        <button data-testid="summarize" @click=${() => void this.summarize()}>Summarize (Pro)</button>
        <button @click=${() => void this.deps.router.openDialogRoute(ShareDialogRoute)}>Share</button>
      </header>
      <div>
        <div role="tablist" aria-label="Document views">
          ${TABS.map((t) => html`<button role="tab" aria-selected=${t === tab ? 'true' : 'false'} @click=${() => doc.tab.set(t === 'content' ? undefined : t)}>${t}</button>`)}
        </div>
        ${tab === 'content' ? html`<studio-block-list></studio-block-list>` : html`<p>${tab === 'comments' ? 'No comments yet.' : 'History is kept by the CRDT.'}</p>`}
        ${this.summary === '' ? '' : html`<p class="summary">${this.summary}</p>`}
      </div>
      <div class="minimap" aria-hidden="false"></div>
    `;
  }

  private async addParagraph(): Promise<void> {
    await this.deps.invoker.invoke(InsertTextCapability, { text: 'New paragraph' });
  }

  private async summarize(): Promise<void> {
    const result = await this.deps.invoker.invoke(SummarizeCapability, {});
    if (result.ok) {
      this.summary = result.value.summary;
      this.requestUpdate();
    }
  }

  private async export(): Promise<void> {
    const exporter = await this.deps.exportPdf.get();
    if (!exporter.ok) return;
    const exported = await exporter.value.export();
    if (exported.ok) {
      this.deps.announcer.value?.announce('Export ready', { politeness: 'polite' });
      const scope = this.connectionScope;
      if (scope !== undefined) this.deps.surfaces.value?.request(SavedToast, { owner: { scope, level: 'component' }, props: { message: 'PDF exported' } });
    }
  }
}

export function defineDesktopEditor(): void {
  defineBlockList();
  const defined = defineComponent(StudioDesktopEditor);
  if (!defined.ok) throw defined.error;
}
