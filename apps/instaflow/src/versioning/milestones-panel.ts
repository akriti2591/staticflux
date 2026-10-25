/**
 * `<if-milestones-panel>` — the History & Milestones panel (UX §7), built only from kit components
 * under Clean Pop: a "Create milestone" form, the milestone list (`<sf-tree>`, flat, multiselect)
 * and an APG toolbar of actions on the selection. B0 docks it (this file never lays out a screen).
 *
 * Keyboard (nothing is pointer-only):
 * - Tab: name → note → Create milestone → list → actions toolbar (one tab stop each).
 * - Name field: Enter creates. List: ↑/↓/Home/End move, Space / Ctrl+click adds a second
 *   milestone (compare two), Enter opens the focused milestone read-only.
 * - Toolbar: ←/→ between Open, Compare, Pin (toggle, `aria-pressed`), Rename and New document.
 * - Rename: Enter saves, Escape cancels; focus returns to the list.
 * Results are announced in a polite live region.
 *
 * Buttons use only the design's variants: one `primary` (Create milestone), `secondary` for the
 * actions that open something, `ghost` for in-row toggles (Pin, Rename, Cancel).
 */
import { I18nToken, type MessageArgs, type MessageRef } from '@staticflux/i18n';
import { defineButton } from '@staticflux/kit/button';
import { defineTextField } from '@staticflux/kit/text-field';
import { defineToolbar } from '@staticflux/kit/toolbar';
import { defineTree, type TreeNode } from '@staticflux/kit/tree';
import { component, defineComponent, SfElement } from '@staticflux/ui';
import { themeTokens as t } from '@staticflux/ui/theme';
import { css, html, nothing, type TemplateResult } from 'lit';
import type { MilestoneEntry } from './milestones.js';
import { versioningMessages as m, versioningText } from './messages.js';
import type { MilestoneId } from './records.js';
import { LATEST } from './compare.js';
import { MAX_MILESTONE_NAME, MilestonesPanelModelToken } from './tokens.js';

export const MILESTONES_PANEL_TAG = 'if-milestones-panel';

const panelSpec = component({
  tag: MILESTONES_PANEL_TAG,
  deps: { render: { model: MilestonesPanelModelToken }, lazy: { i18n: I18nToken } },
  description: 'History & Milestones panel: create, list, pin, rename, open read-only, compare, new document from milestone.',
});

/** The tree rows for a milestone list (pure). */
export function milestoneNodes(list: readonly MilestoneEntry[], format: (iso: string) => string, pinnedLabel: string): TreeNode[] {
  return list.map((entry) => ({
    id: entry.id,
    label: entry.name,
    badge: entry.pinned ? `${pinnedLabel} · ${format(entry.createdAt)}` : format(entry.createdAt),
    draggable: false,
  }));
}

const dateFormat = /* @__PURE__ */ new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export class IfMilestonesPanelElement extends SfElement<typeof panelSpec> {
  static override readonly spec = panelSpec;
  static override properties = {
    selected: { state: true },
    draftName: { state: true },
    draftNote: { state: true },
    renaming: { state: true },
    renameDraft: { state: true },
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
    .title {
      margin: 0;
      font-family: ${t.font.familyDisplay.css};
      font-weight: ${t.font.weightDisplay.css};
      font-size: ${t.type.sizeLg.css};
    }
    .form,
    .rename-form {
      display: flex;
      flex-direction: column;
      gap: ${t.space.sm.css};
    }
    .form sf-button {
      align-self: flex-start;
    }
    .list {
      block-size: 240px;
    }
    .empty {
      margin: 0;
      color: ${t.color.textMuted.css};
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

  declare selected: readonly MilestoneId[];
  declare draftName: string;
  declare draftNote: string;
  declare renaming: MilestoneId | undefined;
  declare renameDraft: string;
  declare error: string;
  declare announcement: string;

  constructor() {
    super();
    this.selected = [];
    this.draftName = '';
    this.draftNote = '';
    this.renaming = undefined;
    this.renameDraft = '';
    this.error = '';
    this.announcement = '';
  }

  private text<P>(ref: MessageRef<P>, ...args: MessageArgs<P>): string {
    return versioningText(this.deps.i18n, ref, ...args);
  }

  /** Focus the name field (the "Milestone" command's prompt, `Mod+Alt+S`). */
  promptCreate(): void {
    (this.renderRoot.querySelector('sf-text-field.name') as HTMLElement | null)?.focus();
  }

  private entry(id: MilestoneId | undefined): MilestoneEntry | undefined {
    return id === undefined ? undefined : this.deps.model.milestones().find((e) => e.id === id);
  }

  private async create(): Promise<void> {
    const created = await this.deps.model.create(this.draftName, this.draftNote.trim().length === 0 ? undefined : this.draftNote);
    if (!created.ok) {
      this.error = created.error.message;
      return;
    }
    this.error = '';
    this.draftName = '';
    this.draftNote = '';
    this.selected = [created.value.id];
    this.announcement = this.text(m.created, { name: created.value.name });
  }

  private async open(id: MilestoneId | undefined): Promise<void> {
    const entry = this.entry(id);
    if (entry === undefined) return;
    const opened = await this.deps.model.open(entry.id);
    this.announcement = opened.ok ? this.text(m.opened, { name: entry.name }) : opened.error.message;
  }

  private async compare(): Promise<void> {
    const [first, second] = this.selected;
    if (first === undefined) return;
    // Older on the left: the list is newest first.
    const order = this.deps.model.milestones().map((e) => e.id);
    const pair = second === undefined ? ([first, LATEST] as const) : order.indexOf(first) > order.indexOf(second) ? ([first, second] as const) : ([second, first] as const);
    const session = await this.deps.model.compare(pair[0], pair[1]);
    this.announcement = session.ok ? this.text(m.comparing) : session.error.message;
  }

  private async togglePin(): Promise<void> {
    const entry = this.entry(this.selected[0]);
    if (entry === undefined) return;
    const pinned = await this.deps.model.pin(entry.id, !entry.pinned);
    this.announcement = pinned.ok ? this.text(entry.pinned ? m.unpinnedNow : m.pinnedNow, { name: entry.name }) : pinned.error.message;
  }

  private startRename(): void {
    const entry = this.entry(this.selected[0]);
    if (entry === undefined) return;
    this.renaming = entry.id;
    this.renameDraft = entry.name;
    this.error = '';
    void this.updateComplete.then(() => (this.renderRoot.querySelector('sf-text-field.rename-field') as HTMLElement | null)?.focus());
  }

  private endRename(): void {
    this.renaming = undefined;
    void this.updateComplete.then(() => (this.renderRoot.querySelector('sf-tree') as HTMLElement | null)?.focus());
  }

  private async saveRename(): Promise<void> {
    const id = this.renaming;
    if (id === undefined) return;
    const renamed = await this.deps.model.rename(id, this.renameDraft);
    if (!renamed.ok) {
      this.error = renamed.error.message;
      return;
    }
    this.error = '';
    this.announcement = this.text(m.renamed, { name: this.renameDraft.trim() });
    this.endRename();
  }

  private async newDocument(): Promise<void> {
    const entry = this.entry(this.selected[0]);
    if (entry === undefined) return;
    const made = await this.deps.model.newDocument(entry.id);
    this.announcement = made.ok ? this.text(m.newDocumentCreated, { name: entry.name }) : made.error.message;
  }

  private renderForm(busy: boolean): TemplateResult {
    return html`<div class="form">
      <sf-text-field
        class="name"
        label=${this.text(m.nameLabel)}
        maxlength=${MAX_MILESTONE_NAME}
        .value=${this.draftName}
        error=${this.renaming === undefined ? this.error : ''}
        @input=${(e: Event) => (this.draftName = (e.composedPath()[0] as HTMLInputElement).value)}
        @keydown=${(e: KeyboardEvent) => {
          if (e.key === 'Enter' && !busy) {
            e.preventDefault();
            void this.create();
          }
        }}
      ></sf-text-field>
      <sf-text-field
        class="note"
        label=${this.text(m.noteLabel)}
        multiline
        rows="2"
        .value=${this.draftNote}
        @input=${(e: Event) => (this.draftNote = (e.composedPath()[0] as HTMLTextAreaElement).value)}
      ></sf-text-field>
      <sf-button class="create" variant="primary" ?disabled=${busy} @click=${() => void this.create()}>${this.text(busy ? m.creating : m.create)}</sf-button>
    </div>`;
  }

  private renderRename(): TemplateResult | typeof nothing {
    if (this.renaming === undefined) return nothing;
    return html`<div class="rename-form">
      <sf-text-field
        class="rename-field"
        label=${this.text(m.renameLabel)}
        maxlength=${MAX_MILESTONE_NAME}
        .value=${this.renameDraft}
        error=${this.error}
        @input=${(e: Event) => (this.renameDraft = (e.composedPath()[0] as HTMLInputElement).value)}
        @keydown=${(e: KeyboardEvent) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void this.saveRename();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            this.endRename();
          }
        }}
      ></sf-text-field>
      <div class="row">
        <sf-button class="save-name" variant="primary" size="sm" @click=${() => void this.saveRename()}>${this.text(m.save)}</sf-button>
        <sf-button class="cancel-name" variant="ghost" size="sm" @click=${() => this.endRename()}>${this.text(m.cancel)}</sf-button>
      </div>
    </div>`;
  }

  override render(): TemplateResult {
    const { model } = this.deps;
    const list = model.milestones();
    const busy = model.busy() !== 'idle';
    const known = new Set(list.map((e) => e.id));
    const selected = this.selected.filter((id) => known.has(id));
    const one = selected.length === 1;
    const first = this.entry(selected[0]);
    return html`<section class="panel" aria-labelledby="milestones-title">
      <h2 class="title" id="milestones-title">${this.text(m.panelTitle)}</h2>
      ${this.renderForm(busy)}
      ${list.length === 0
        ? html`<p class="empty">${this.text(m.empty)}</p>`
        : html`<sf-tree
            class="list"
            label=${this.text(m.listLabel)}
            multiselect
            .nodes=${milestoneNodes(list, (iso) => dateFormat.format(new Date(iso)), this.text(m.pinned))}
            .selected=${new Set(selected)}
            @sf-select=${(e: CustomEvent<{ ids: readonly string[] }>) => (this.selected = e.detail.ids.filter((id): id is MilestoneId => known.has(id as MilestoneId)).slice(-2))}
            @sf-activate=${(e: CustomEvent<{ id: string }>) => void this.open(e.detail.id as MilestoneId)}
          ></sf-tree>`}
      <sf-toolbar label=${this.text(m.actions)}>
        <sf-button class="open" variant="secondary" size="sm" ?disabled=${!one || busy} @click=${() => void this.open(selected[0])}>${this.text(m.open)}</sf-button>
        <sf-button class="compare" variant="secondary" size="sm" ?disabled=${selected.length === 0 || busy} @click=${() => void this.compare()}
          >${this.text(selected.length === 2 ? m.compareTwo : m.compareLatest)}</sf-button
        >
        <sf-button class="pin" variant="ghost" size="sm" .pressed=${first?.pinned ?? false} ?disabled=${!one || busy} @click=${() => void this.togglePin()}>${this.text(m.pin)}</sf-button>
        <sf-button class="rename" variant="ghost" size="sm" ?disabled=${!one || busy} @click=${() => this.startRename()}>${this.text(m.rename)}</sf-button>
        <sf-button class="new-document" variant="secondary" size="sm" ?disabled=${!one || busy} @click=${() => void this.newDocument()}>${this.text(m.newDocument)}</sf-button>
      </sf-toolbar>
      ${this.renderRename()}
      <p class="sr-only" role="status" aria-live="polite">${this.announcement}</p>
    </section>`;
  }
}

export function defineMilestonesPanel(registry: CustomElementRegistry = customElements): void {
  defineButton(registry);
  defineTextField(registry);
  defineToolbar(registry);
  defineTree(registry);
  if (registry.get(MILESTONES_PANEL_TAG) === undefined) defineComponent(IfMilestonesPanelElement, registry);
}
