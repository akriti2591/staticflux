/**
 * `<if-library-panel>` — the Assets panel (UX §4 dock: "Assets / Library"), built only from kit
 * components under Clean Pop: Import (the one primary action), search, a filter switcher, the asset
 * list (`<sf-tree>`, flat), a preview of the selected asset, an APG toolbar of actions and an inline
 * rename form. Lens colour and shape mark each row's kind (the typed lens palette). B0 docks it (the
 * `instaflow/assets` panel contribution); this file never lays out a screen.
 *
 * Keyboard (nothing is pointer-only; dropping files has the Import button as its keyboard path):
 * - Tab: Import → search → filter → list → actions toolbar (one tab stop each).
 * - Filter: ←/→ (APG radio group). List: ↑/↓/Home/End/type-ahead; Enter places the asset; Delete moves
 *   it to the trash (restores it in Trash); F2 renames.
 * - Toolbar: ←/→ between Place, Favorite (toggle, `aria-pressed`), Rename and Trash/Restore.
 * - Rename: Enter saves, Escape cancels; focus returns to the list.
 * Results go to a polite live region.
 */
import { I18nToken, type MessageArgs, type MessageRef } from '@staticflux/i18n';
import { defineButton } from '@staticflux/kit/button';
import { defineSegmented, type SegmentOption } from '@staticflux/kit/segmented';
import { defineTextField } from '@staticflux/kit/text-field';
import { defineToolbar } from '@staticflux/kit/toolbar';
import { defineTree, type TreeNode } from '@staticflux/kit/tree';
import { component, defineComponent, SfElement } from '@staticflux/ui';
import { themeTokens as t } from '@staticflux/ui/theme';
import { css, html, nothing, type TemplateResult } from 'lit';
import { lensMarkStyle, lensOf } from '../theme/lenses.js';
import type { IngestFile } from './ingest.js';
import { ASSET_KIND_LENS } from './kinds.js';
import { LIBRARY_FILTERS, type LibraryFilter, MAX_TITLE } from './library.js';
import type { LibraryEntry } from './library-doc.js';
import { libraryMessages as m, libraryText } from './messages.js';
import type { ImportSummary } from './panel-model.js';
import type { AssetId } from './records.js';
import { LibraryPanelModelToken } from './tokens.js';

export const LIBRARY_PANEL_TAG = 'if-library-panel';

const panelSpec = component({
  tag: LIBRARY_PANEL_TAG,
  deps: { render: { model: LibraryPanelModelToken }, lazy: { i18n: I18nToken } },
  description: 'Assets panel: import, search, filter, preview, place, favorite, rename, trash and restore library assets.',
});

/** Filter labels (data: one message per filter). */
const FILTER_LABELS = {
  all: m.filterAll,
  images: m.filterImages,
  video: m.filterVideo,
  audio: m.filterAudio,
  designs: m.filterDesigns,
  favorites: m.filterFavorites,
  trash: m.filterTrash,
} as const satisfies Readonly<Record<LibraryFilter, unknown>>;

/** The tree rows for entries (pure): title, lens mark of the kind, size and favourite badge. */
export function libraryNodes(entries: readonly LibraryEntry[], favoriteLabel: string): TreeNode[] {
  return entries.map((entry) => {
    const { width, height } = entry.media ?? {};
    const badge = [width !== undefined && height !== undefined ? `${width}×${height}` : '', entry.favorite ? favoriteLabel : ''].filter((s) => s.length > 0).join(' · ');
    return {
      id: entry.asset,
      label: entry.title,
      icon: html`<span aria-hidden="true" style=${lensMarkStyle(lensOf(ASSET_KIND_LENS[entry.kind]))}></span>`,
      ...(badge.length === 0 ? {} : { badge }),
      draggable: false,
    };
  });
}

export class IfLibraryPanelElement extends SfElement<typeof panelSpec> {
  static override readonly spec = panelSpec;
  static override properties = {
    selected: { state: true },
    renaming: { state: true },
    renameDraft: { state: true },
    search: { state: true },
    error: { state: true },
    announcement: { state: true },
  };
  static override styles = css`
    :host {
      display: block;
      color: ${t.color.text.css};
      font-family: ${t.font.family.css};
    }
    .panel {
      display: flex;
      flex-direction: column;
      gap: ${t.space.md.css};
      padding: ${t.space.md.css};
    }
    .head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: ${t.space.sm.css};
    }
    .title {
      margin: 0;
      font-family: ${t.font.familyDisplay.css};
      font-weight: ${t.font.weightDisplay.css};
      font-size: ${t.type.sizeLg.css};
    }
    .list {
      block-size: 240px;
    }
    .empty,
    .pending,
    .caption {
      margin: 0;
      color: ${t.color.textMuted.css};
    }
    .preview {
      display: block;
      inline-size: 100%;
      block-size: 160px;
      object-fit: contain;
      border-radius: ${t.radius.md.css};
      background: ${t.color.neutral3.css};
    }
    .rename-form {
      display: flex;
      flex-direction: column;
      gap: ${t.space.sm.css};
    }
    .row {
      display: flex;
      gap: ${t.space.sm.css};
    }
    .sr-only {
      position: absolute;
      inline-size: 1px;
      block-size: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }
  `;

  declare selected: AssetId | undefined;
  declare renaming: AssetId | undefined;
  declare renameDraft: string;
  declare search: string;
  declare error: string;
  declare announcement: string;

  constructor() {
    super();
    this.selected = undefined;
    this.renaming = undefined;
    this.renameDraft = '';
    this.search = '';
    this.error = '';
    this.announcement = '';
  }

  private text<P>(ref: MessageRef<P>, ...args: MessageArgs<P>): string {
    return libraryText(this.deps.i18n, ref, ...args);
  }

  private current(): LibraryEntry | undefined {
    const rows = this.deps.model.rows();
    return rows.find((e) => e.asset === this.selected);
  }

  private announceImport(summary: ImportSummary): void {
    const parts = [
      ...(summary.imported.length > 0 ? [this.text(m.imported, { count: summary.imported.length })] : []),
      ...summary.deduplicated.map((e) => this.text(m.alreadyThere, { name: e.title })),
      ...summary.failed.map((f) => this.text(m.importFailed, { name: f.name, message: f.error.message })),
    ];
    this.announcement = parts.join('. ');
    const first = summary.imported[0] ?? summary.deduplicated[0];
    if (first !== undefined) this.selected = first.asset;
  }

  /** Open the file picker and import (the Import button; also the keyboard path for dropping files). */
  async importFromPicker(): Promise<void> {
    const summary = await this.deps.model.pickAndImport();
    if (summary.ok) this.announceImport(summary.value);
    else if (summary.error.code !== 'SF-CORE-002') this.announcement = summary.error.message;
  }

  /** Import dropped or pasted files. */
  async importFiles(files: readonly IngestFile[]): Promise<void> {
    const summary = await this.deps.model.importFiles(files);
    if (summary.ok) this.announceImport(summary.value);
    else this.announcement = summary.error.message;
  }

  private async place(): Promise<void> {
    const entry = this.current();
    if (entry === undefined || entry.trashedAt !== undefined) return;
    const placed = await this.deps.model.place(entry.asset);
    this.announcement = placed.ok ? this.text(m.placed, { title: entry.title }) : placed.error.message;
  }

  private toggleFavorite(): void {
    const entry = this.current();
    if (entry === undefined) return;
    const toggled = this.deps.model.toggleFavorite(entry.asset);
    this.announcement = toggled.ok ? this.text(toggled.value ? m.favorited : m.unfavorited, { title: entry.title }) : toggled.error.message;
  }

  private trashOrRestore(): void {
    const entry = this.current();
    if (entry === undefined) return;
    const live = entry.trashedAt === undefined;
    const done = live ? this.deps.model.trash([entry.asset]) : this.deps.model.restore([entry.asset]);
    this.announcement = done.ok ? this.text(live ? m.trashed : m.restored, { title: entry.title }) : done.error.message;
    if (done.ok) this.selected = undefined;
  }

  private startRename(): void {
    const entry = this.current();
    if (entry === undefined) return;
    this.renaming = entry.asset;
    this.renameDraft = entry.title;
    this.error = '';
    void this.updateComplete.then(() => (this.renderRoot.querySelector('sf-text-field.rename-field') as HTMLElement | null)?.focus());
  }

  private endRename(): void {
    this.renaming = undefined;
    void this.updateComplete.then(() => (this.renderRoot.querySelector('sf-tree') as HTMLElement | null)?.focus());
  }

  private saveRename(): void {
    const asset = this.renaming;
    if (asset === undefined) return;
    const renamed = this.deps.model.rename(asset, this.renameDraft);
    if (!renamed.ok) {
      this.error = renamed.error.message;
      return;
    }
    this.error = '';
    this.announcement = this.text(m.renamed, { title: this.renameDraft.trim() });
    this.endRename();
  }

  private onListKey(e: KeyboardEvent): void {
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      this.trashOrRestore();
    } else if (e.key === 'F2') {
      e.preventDefault();
      this.startRename();
    }
  }

  private onDrop(e: DragEvent): void {
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length === 0) return;
    e.preventDefault();
    void this.importFiles(files);
  }

  private renderPending(): TemplateResult | typeof nothing {
    const pending = this.deps.model.pending();
    if (pending.length === 0) return nothing;
    return html`${pending.map((p) => html`<p class="pending">${this.text(m.importing, { name: p.name, percent: p.size === 0 ? 0 : Math.min(100, Math.round((p.bytesRead / p.size) * 100)) })}</p>`)}`;
  }

  private renderPreview(entry: LibraryEntry | undefined): TemplateResult | typeof nothing {
    if (entry === undefined) return nothing;
    const url = this.deps.model.thumbnail(entry.asset);
    return url === undefined
      ? html`<p class="caption">${this.text(m.noPreview)}</p>`
      : html`<img class="preview" src=${url} alt=${this.text(m.previewLabel, { title: entry.title })} />`;
  }

  private renderRename(): TemplateResult | typeof nothing {
    if (this.renaming === undefined) return nothing;
    return html`<div class="rename-form">
      <sf-text-field
        class="rename-field"
        label=${this.text(m.renameLabel)}
        maxlength=${MAX_TITLE}
        .value=${this.renameDraft}
        error=${this.error}
        @input=${(e: Event) => (this.renameDraft = (e.composedPath()[0] as HTMLInputElement).value)}
        @keydown=${(e: KeyboardEvent) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            this.saveRename();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            this.endRename();
          }
        }}
      ></sf-text-field>
      <div class="row">
        <sf-button class="save-title" variant="primary" size="sm" @click=${() => this.saveRename()}>${this.text(m.save)}</sf-button>
        <sf-button class="cancel-title" variant="ghost" size="sm" @click=${() => this.endRename()}>${this.text(m.cancel)}</sf-button>
      </div>
    </div>`;
  }

  override render(): TemplateResult {
    const { model } = this.deps;
    const query = model.query();
    const rows = model.rows();
    const entry = this.current();
    const filters: SegmentOption<LibraryFilter>[] = LIBRARY_FILTERS.map((value) => ({ value, label: this.text(FILTER_LABELS[value]) }));
    const inTrash = entry?.trashedAt !== undefined;
    return html`<section
      class="panel"
      aria-labelledby="library-title"
      @dragover=${(e: DragEvent) => e.preventDefault()}
      @drop=${(e: DragEvent) => this.onDrop(e)}
    >
      <div class="head">
        <h2 class="title" id="library-title">${this.text(m.panelTitle)}</h2>
        <sf-button class="import" variant="primary" size="sm" @click=${() => void this.importFromPicker()}>${this.text(m.import)}</sf-button>
      </div>
      <sf-text-field
        class="search"
        label=${this.text(m.searchLabel)}
        .value=${this.search}
        @input=${(e: Event) => {
          this.search = (e.composedPath()[0] as HTMLInputElement).value;
          model.setQuery({ text: this.search });
        }}
      ></sf-text-field>
      <sf-segmented class="filter" label=${this.text(m.filterLabel)} .options=${filters} .value=${query.filter} @sf-change=${(e: CustomEvent<{ value: LibraryFilter }>) => model.setQuery({ filter: e.detail.value })}></sf-segmented>
      ${this.renderPending()}
      ${rows.length === 0
        ? html`<p class="empty">${this.text(query.filter === 'trash' ? m.emptyTrash : m.empty)}</p>`
        : html`<sf-tree
            class="list"
            label=${this.text(m.listLabel)}
            .nodes=${libraryNodes(rows, this.text(m.favoriteBadge))}
            .selected=${new Set(entry === undefined ? [] : [entry.asset])}
            @sf-select=${(e: CustomEvent<{ ids: readonly string[] }>) => (this.selected = e.detail.ids[0] as AssetId | undefined)}
            @sf-activate=${(e: CustomEvent<{ id: string }>) => {
              this.selected = e.detail.id as AssetId;
              void this.place();
            }}
            @keydown=${(e: KeyboardEvent) => this.onListKey(e)}
          ></sf-tree>`}
      ${this.renderPreview(entry)}
      <sf-toolbar label=${this.text(m.actions)}>
        <sf-button class="place" variant="secondary" size="sm" ?disabled=${entry === undefined || inTrash} @click=${() => void this.place()}>${this.text(m.place)}</sf-button>
        <sf-button class="favorite" variant="ghost" size="sm" .pressed=${entry?.favorite ?? false} ?disabled=${entry === undefined || inTrash} @click=${() => this.toggleFavorite()}>${this.text(m.favorite)}</sf-button>
        <sf-button class="rename" variant="ghost" size="sm" ?disabled=${entry === undefined} @click=${() => this.startRename()}>${this.text(m.rename)}</sf-button>
        <sf-button class="trash" variant="ghost" size="sm" ?disabled=${entry === undefined} @click=${() => this.trashOrRestore()}>${this.text(inTrash ? m.restore : m.trash)}</sf-button>
      </sf-toolbar>
      ${this.renderRename()}
      <p class="sr-only" role="status" aria-live="polite">${this.announcement}</p>
    </section>`;
  }
}

export function defineLibraryPanel(registry: CustomElementRegistry = customElements): void {
  defineButton(registry);
  defineSegmented(registry);
  defineTextField(registry);
  defineToolbar(registry);
  defineTree(registry);
  if (registry.get(LIBRARY_PANEL_TAG) === undefined) defineComponent(IfLibraryPanelElement, registry);
}
