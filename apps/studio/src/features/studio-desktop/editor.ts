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
import { defineButton } from '@staticflux/kit/button';
import { defineTabs } from '@staticflux/kit/tabs';
import { defineTextField } from '@staticflux/kit/text-field';
import { defineToolbar } from '@staticflux/kit/toolbar';
import { component, type ComponentHooksOf, defineComponent, SfElement } from '@staticflux/ui';
import { themeTokens as t } from '@staticflux/ui/theme';
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
    :host { display: grid; grid-template-columns: 1fr 170px; gap: ${t.space.md.css}; }
    header { grid-column: 1 / -1; display: flex; gap: ${t.space.sm.css}; align-items: center; flex-wrap: wrap; }
    sf-text-field.title { flex: 1; min-inline-size: 12ch; font-size: ${t.type.sizeXl.css}; }
    sf-toolbar { flex: 1 1 100%; margin-inline: calc(-1 * ${t.space.sm.css}); }
    .presence { display: flex; gap: ${t.space.xs.css}; }
    .chip { padding-inline: ${t.space.sm.css}; border-radius: ${t.radius.full.css}; background: ${t.color.accentSubtle.css}; color: ${t.color.accentText.css}; font-size: ${t.type.sizeSm.css}; }
    .minimap { min-block-size: 220px; position: relative; border: 1px solid ${t.color.border.css}; border-radius: ${t.radius.md.css}; }
    .status { color: ${t.color.textMuted.css}; font-size: ${t.type.sizeSm.css}; }
    sf-tabs { margin-block-end: ${t.space.md.css}; }
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
        <sf-text-field class="title" label="Title" label-hidden .value=${doc.title} ?readonly=${doc.readOnly} @change=${(e: Event) => doc.rename((e.target as HTMLInputElement).value)}></sf-text-field>
        <span class="status" role="status">${doc.readOnly ? 'Read-only' : doc.pendingSave ? 'Saving…' : 'Saved'}</span>
        <span class="presence" aria-label="Co-editors">${participants.map(([id, p]) => html`<span class="chip" title=${id}>${p.state.name ?? id}</span>`)}</span>
        <sf-toolbar label="Document actions">
          <sf-button @click=${() => void this.addParagraph()} ?disabled=${doc.readOnly}>Add paragraph</sf-button>
          <sf-button data-sf-intent=${this.intent('exportPdf')} @click=${() => void this.export()}>Export PDF</sf-button>
          <sf-button data-testid="summarize" @click=${() => void this.summarize()}>Summarize (Pro)</sf-button>
          <sf-button variant="primary" @click=${() => void this.deps.router.openDialogRoute(ShareDialogRoute)}>Share</sf-button>
        </sf-toolbar>
      </header>
      <div>
        <sf-tabs label="Document views" .value=${tab} @sf-change=${(e: CustomEvent<{ value: string }>) => doc.tab.set(e.detail.value === 'content' ? undefined : (e.detail.value as Exclude<(typeof TABS)[number], 'content'>))}>
          ${TABS.map((name) => html`<sf-tab value=${name}>${name}</sf-tab>`)}
        </sf-tabs>
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
  defineButton();
  defineTextField();
  defineToolbar();
  defineTabs();
  defineBlockList();
  const defined = defineComponent(StudioDesktopEditor);
  if (!defined.ok) throw defined.error;
}
