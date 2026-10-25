/**
 * `<if-export-panel>` — the Export panel (Instaflow M1c C1; IF-29.14–29.16), built only from `@staticflux/kit` under
 * Clean Pop: the format (PNG, PDF, SVG), the PNG scale (1×, 2×, 3×), what to export (page, selection, all pages), a
 * transparent-background toggle, Export (or Cancel while one runs) and the status (progress, the files, or why it
 * failed) in a polite live region. Main thread only (Lit). It renders an `ExportPanelPort` (the export service) and
 * runs exports through the port, which runs the `instaflow/export` capability (the same pipeline agents use).
 *
 * Keyboard first: three kit segmented controls (arrow keys), then the toggle and the Export button (Enter / Space);
 * `Mod+Shift+E` exports from anywhere in Studio. Studio's top-bar "Share" opens this panel.
 *
 * The contribution: `exportPanel` (`instaflow/export`, dock); the host binds its port with `bindExportPanel`.
 */
import { defineButton } from '@staticflux/kit/button';
import { defineInspector } from '@staticflux/kit/inspector';
import { defineSegmented, type SegmentOption } from '@staticflux/kit/segmented';
import { defineStatus } from '@staticflux/kit/status';
import { component, defineComponent, SfElement } from '@staticflux/ui';
import { themeTokens as t } from '@staticflux/ui/theme';
import { css, html, nothing, type TemplateResult } from 'lit';
import { definePanel, type PanelContribution } from '../spec/contributions.js';
import { StudioIds } from '../spec/studio-ids.js';
import { EXPORT_FORMAT_IDS, EXPORT_FORMATS, EXPORT_SCALES, type ExportFormat, type ExportOptions, type ExportScale, type ExportScope, DEFAULT_EXPORT_OPTIONS } from './formats.js';
import type { ExportStatus } from './service.js';

export const EXPORT_PANEL_ID = StudioIds.panel.export;
export const EXPORT_RUN_EVENT = 'if-export-run';
export const EXPORT_CANCEL_EVENT = 'if-export-cancel';

const spec = component({ tag: 'if-export-panel', placeholder: () => nothing, description: 'Export panel: PNG, PDF and SVG (Instaflow C1).' });

/** What the panel reads and runs (the export service on main). */
export interface ExportPanelPort {
  status(): ExportStatus;
  subscribe(listener: () => void): () => void;
  run(options: ExportOptions): void;
  cancel(): void;
}

/** The scope choices, as the panel names them (data). */
export const EXPORT_SCOPE_LABELS: Readonly<Record<ExportScope, string>> = Object.freeze({ page: 'Page', selection: 'Selection', pages: 'All pages' });

const FORMAT_OPTIONS: readonly SegmentOption<ExportFormat>[] = EXPORT_FORMAT_IDS.map((f) => ({ value: f, label: EXPORT_FORMATS[f].label }));
const SCALE_OPTIONS: readonly SegmentOption[] = EXPORT_SCALES.map((s) => ({ value: String(s), label: `${s}×` }));
const SCOPE_OPTIONS: readonly SegmentOption<ExportScope>[] = (Object.keys(EXPORT_SCOPE_LABELS) as ExportScope[]).map((s) => ({ value: s, label: EXPORT_SCOPE_LABELS[s] }));

/** "24 KB", "1.2 MB". */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** The status line (words carry the state; the status dot only repeats it). */
export function statusText(status: ExportStatus): { readonly text: string; readonly tone: 'neutral' | 'success' | 'danger'; readonly busy: boolean } {
  switch (status.kind) {
    case 'idle':
      return { text: 'Exports render from a snapshot and change nothing in the design.', tone: 'neutral', busy: false };
    case 'running': {
      const p = status.progress;
      const pct = p === undefined ? '' : ` · ${Math.round(p.fraction * 100)}%`;
      const page = p === undefined || p.pages <= 1 ? '' : ` page ${p.page + 1} of ${p.pages}`;
      return { text: `Exporting ${EXPORT_FORMATS[status.options.format].label}${page}${pct}`, tone: 'neutral', busy: true };
    }
    case 'done': {
      const files = status.files;
      const what = files.length === 1 ? `${files[0]?.name} (${formatBytes(files[0]?.size ?? 0)})` : `${files.length} files`;
      const missing = status.missingImages.length === 0 ? '' : ` · ${status.missingImages.length} image${status.missingImages.length === 1 ? '' : 's'} missing`;
      return { text: `Exported ${what}${missing}`, tone: 'success', busy: false };
    }
    case 'failed':
      return { text: `Export failed: ${status.message}`, tone: 'danger', busy: false };
    case 'cancelled':
      return { text: 'Export cancelled.', tone: 'neutral', busy: false };
  }
}

export class IfExportPanelElement extends SfElement<typeof spec> {
  static override readonly spec = spec;
  static override properties = { status: { attribute: false }, options: { attribute: false } };
  static override styles = css`
    :host {
      display: block;
      font-family: ${t.font.family.css};
      color: ${t.color.text.css};
    }
    .stack {
      display: grid;
      gap: ${t.space.sm.css};
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: ${t.space.xs.css};
    }
  `;

  declare status: ExportStatus;
  /** The person's current choice (panel state; never in the document). */
  declare options: ExportOptions;

  constructor() {
    super();
    this.status = { kind: 'idle' };
    this.options = DEFAULT_EXPORT_OPTIONS;
  }

  private set(patch: Partial<ExportOptions>): void {
    this.options = { ...this.options, ...patch };
  }

  /** Run an export with the current choice (the button, `Mod+Shift+E`). */
  exportNow(): void {
    this.dispatchEvent(new CustomEvent<ExportOptions>(EXPORT_RUN_EVENT, { detail: this.options, bubbles: true, composed: true }));
  }

  override render(): TemplateResult {
    const o = this.options;
    const running = this.status.kind === 'running';
    const s = statusText(this.status);
    const format = EXPORT_FORMATS[o.format];
    return html`<sf-inspector-group label="Export">
      <div class="stack">
        <sf-segmented label="Format" data-control="format" .options=${FORMAT_OPTIONS} .value=${o.format} @sf-change=${(e: CustomEvent<{ value: ExportFormat }>) => this.set({ format: e.detail.value })}></sf-segmented>
        ${format.scales
          ? html`<sf-segmented label="Scale" data-control="scale" .options=${SCALE_OPTIONS} .value=${String(o.scale)} @sf-change=${(e: CustomEvent<{ value: string }>) => this.set({ scale: Number(e.detail.value) as ExportScale })}></sf-segmented>`
          : nothing}
        <sf-segmented label="Export" data-control="scope" .options=${SCOPE_OPTIONS} .value=${o.scope} @sf-change=${(e: CustomEvent<{ value: ExportScope }>) => this.set({ scope: e.detail.value })}></sf-segmented>
        <div class="actions">
          <sf-button size="sm" variant="ghost" data-control="transparent" .pressed=${o.transparent} @click=${() => this.set({ transparent: !o.transparent })}>Transparent background</sf-button>
        </div>
        <div class="actions">
          ${running
            ? html`<sf-button size="sm" data-control="cancel" @click=${() => this.dispatchEvent(new CustomEvent(EXPORT_CANCEL_EVENT, { bubbles: true, composed: true }))}>Cancel</sf-button>`
            : html`<sf-button size="sm" variant="primary" data-control="export" @click=${() => this.exportNow()}>Export ${format.label}</sf-button>`}
        </div>
        <sf-status tone=${s.tone} ?busy=${s.busy} data-control="status">${s.text}</sf-status>
      </div>
    </sf-inspector-group>`;
  }
}

/** Bind a mounted `<if-export-panel>` to the export service (status in, runs and cancels out). Returns unbind. */
export function bindExportPanel(element: IfExportPanelElement, port: ExportPanelPort): () => void {
  const refresh = (): void => {
    element.status = port.status();
  };
  const onRun = (event: Event): void => port.run((event as CustomEvent<ExportOptions>).detail);
  const onCancel = (): void => port.cancel();
  refresh();
  const stop = port.subscribe(refresh);
  const bound = new AbortController();
  element.addEventListener(EXPORT_RUN_EVENT, onRun, { signal: bound.signal });
  element.addEventListener(EXPORT_CANCEL_EVENT, onCancel, { signal: bound.signal });
  return () => {
    stop();
    bound.abort();
  };
}

/** Define the panel element and the kit components it uses. */
export function defineExportPanel(registry: CustomElementRegistry = customElements): void {
  defineButton(registry);
  defineSegmented(registry);
  defineStatus(registry);
  defineInspector(registry);
  if (registry.get(spec.tag) === undefined) defineComponent(IfExportPanelElement, registry);
}

/** The Export panel (dock); the host binds it with `bindExportPanel`. */
export const exportPanel: PanelContribution = /* @__PURE__ */ definePanel({
  id: EXPORT_PANEL_ID,
  label: 'Export',
  description: 'Export the page, the selection or every page as PNG (1×–3×, transparent), PDF (real text) or SVG (C1).',
  placements: ['dock', 'side'],
  minDensity: 'standard',
  render: () => {
    defineExportPanel();
    return html`<if-export-panel></if-export-panel>`;
  },
});
