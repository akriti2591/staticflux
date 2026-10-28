/**
 * `<if-home>` — the Home surface (D17; C0 IF-28.17–28.22; B11c IF-36.35–36.40, HOME-FILES §1–§4; design
 * `docs/instaflow/design/HomeCP.dc.html`), built only from kit components under Clean Pop. No engine, no GPU, no CRDT:
 * everything here reads and runs `HomeModel`.
 *
 * - **Header** (§1.1): the logo lockup (link to Home), the nav switcher `Home · Files · Templates · Trash`, the search
 *   field (`/` focuses it; it filters every list live, Enter opens Files with the query), `＋ New design` with its `▾`
 *   formats menu.
 * - **Pages** (one boot; `model.view`): Home (hero and formats row, quick actions, Jump back in or the first-run welcome
 *   card, Templates, Projects), Files (filter, project, sort, grid / list, import, bulk selection), a project, Templates,
 *   Trash (grouped by day, restore, delete forever, empty trash with an inline confirm).
 * - **Every file operation** (§3) lives in three places that agree: the card's `⋯` menu, the context menu (right-click,
 *   `Shift+F10`, the Menu key) and the keyboard on a focused card (`F2` / `Mod+Shift+R` rename, `Mod+D` duplicate,
 *   `Delete` / `Backspace` trash). Non-local results toast with Undo (`Mod+Z` runs the newest toast's Undo on Home).
 * - **Import** (§3.1): `Import` in Files, `Mod+I`, dropping files anywhere on the page column, or pasting files.
 * - **Storage** (§4): the footer's usage line; a banner when the workspace is full.
 *
 * Every card is a real link (middle click and "open in new tab" work), and a plain click or Enter runs the card's
 * capability instead (the same pipeline agents call). Keyboard: one native focusable per action, reading order; the
 * card's actions follow its link. Results and problems go to a polite live region.
 */
import type { Result, SfError } from '@staticflux/core';
import { I18nToken, type MessageArgs, type MessageRef } from '@staticflux/i18n';
import { defineButton } from '@staticflux/kit/button';
import { defineCard } from '@staticflux/kit/card';
import { defineConfirmRow } from '@staticflux/kit/confirm-row';
import { defineFeedback } from '@staticflux/kit/feedback';
import { defineIconElement } from '@staticflux/kit/icon';
import { defineIconButton } from '@staticflux/kit/icon-button';
import { chevronDownIcon } from '@staticflux/kit/icons/chevron-down';
import { chevronLeftIcon } from '@staticflux/kit/icons/chevron-left';
import { ellipsisIcon } from '@staticflux/kit/icons/ellipsis';
import { folderIcon } from '@staticflux/kit/icons/folder';
import { imageIcon } from '@staticflux/kit/icons/image';
import { starIcon } from '@staticflux/kit/icons/star';
import { typeIcon } from '@staticflux/kit/icons/type';
import { settingsIcon } from '@staticflux/kit/icons/settings';
import { uploadIcon } from '@staticflux/kit/icons/upload';
import { xIcon } from '@staticflux/kit/icons/x';
import { defineInlineEdit, type InlineEditChangeDetail } from '@staticflux/kit/inline-edit';
import { defineMenu, type SfMenuElement } from '@staticflux/kit/menu';
import { definePopover, type SfPopoverElement } from '@staticflux/kit/popover';
import { defineSegmented } from '@staticflux/kit/segmented';
import { defineTag } from '@staticflux/kit/tag';
import { defineTextField } from '@staticflux/kit/text-field';
import { component, defineComponent, SfElement } from '@staticflux/ui';
import { html, nothing, type TemplateResult } from 'lit';
import { type Toasts, ToastsToken } from '../app/feedback.js';
import type { DeviceSettings } from '../settings/device-settings.js';
import { defineSettings, diagnosticsText, type SettingsSection } from '../settings/settings-element.js';
import { HINT_STORAGE_PREFIXES, readShortcutsSnapshot, resetHintsOnDevice } from '../settings/shortcuts-snapshot.js';
import type { LibraryAssetKind } from '../library/kinds.js';
import { lensMarkStyle, lensOf, lenses, lensTag } from '../theme/lenses.js';
import { instaflowMark } from '../theme/logo.js';
import type { HomeActionOutput, HomeQuickAction } from './capabilities.js';
import { type FilesPrefs, filesList, type ProjectFilter, readFilesPrefs, selectRange, trashByDay, writeFilesPrefs } from './files-view.js';
import { browserStorage, formatBytes, markFirstRunSeen, readFirstRun, readStorageFacts, requestPersistence, type StorageFacts, type StoragePort } from './first-run.js';
import { aspectOf, CUSTOM_FORMAT, DESIGN_FORMATS, type DesignFormatId, groupDigits, NEW_DESIGN_CHIPS } from './formats.js';
import type { HomeEntry, ProjectSummary } from './index-record.js';
import { previewBlob } from './previews.js';
import { homeStyles } from './home-styles.js';
import { homeMessages as m, homeText, relativeTime } from './messages.js';
import type { HomeModel, ImportSummary } from './model.js';
import { HOME_SHORTCUTS } from './shortcuts.js';
import { defineNewDesign, type IfNewDesignElement, type NewDesignCreateDetail } from './new-design.js';
import { FILES_FILTERS, FILES_LAYOUTS, FILES_SORTS, type FilesFilter, type FilesLayout, type FilesSort, type HomeView, homeViewHref, newDesignHref, studioHref } from './routes.js';
import { HomeModelToken } from './tokens.js';

export const HOME_TAG = 'if-home';

const homeSpec = component({
  tag: HOME_TAG,
  deps: { render: { model: HomeModelToken }, lazy: { i18n: I18nToken, toasts: ToastsToken } },
  description: 'Home: new design, quick actions, recent designs, templates, projects, files and the trash of the workspace (no engine).',
});

/** Kind → label (data). */
const KIND_LABELS: Readonly<Partial<Record<LibraryAssetKind, 'kindComposition' | 'kindTemplate' | 'kindImage' | 'kindVector' | 'kindFont'>>> = {
  composition: 'kindComposition',
  template: 'kindTemplate',
  image: 'kindImage',
  vector: 'kindVector',
  font: 'kindFont',
};
/** Kind → the icon on a media card or row (data; designs show their page shape). */
const KIND_ICONS: Readonly<Partial<Record<LibraryAssetKind, typeof imageIcon>>> = { image: imageIcon, vector: imageIcon, font: typeIcon };

/** The nav switcher (data): the page and its label. */
const NAV: readonly { readonly kind: 'home' | 'files' | 'templates' | 'trash'; readonly label: 'navHome' | 'navFiles' | 'navTemplates' | 'navTrash' }[] = [
  { kind: 'home', label: 'navHome' },
  { kind: 'files', label: 'navFiles' },
  { kind: 'templates', label: 'navTemplates' },
  { kind: 'trash', label: 'navTrash' },
];
const FILTER_LABELS: Readonly<Record<FilesFilter, 'filterAll' | 'filterDesigns' | 'filterTemplates' | 'filterMedia' | 'filterFavourites'>> = {
  all: 'filterAll',
  designs: 'filterDesigns',
  templates: 'filterTemplates',
  media: 'filterMedia',
  favourites: 'filterFavourites',
};
const SORT_LABELS: Readonly<Record<FilesSort, 'sortEdited' | 'sortCreated' | 'sortName' | 'sortKind'>> = { edited: 'sortEdited', created: 'sortCreated', name: 'sortName', kind: 'sortKind' };
const LAYOUT_LABELS: Readonly<Record<FilesLayout, 'layoutGrid' | 'layoutList'>> = { grid: 'layoutGrid', list: 'layoutList' };

/** The file menu's rows (DENSITY §8.4), per kind of entry and state: data, not branches. */
export type FileAction = 'open' | 'open-tab' | 'use' | 'edit-template' | 'rename' | 'duplicate' | 'move' | 'favourite' | 'unfavourite' | 'export' | 'copy-link' | 'trash' | 'restore' | 'delete-forever';
export function fileActions(entry: HomeEntry): readonly FileAction[] {
  if (entry.trashedAt !== undefined) return ['restore', 'delete-forever'];
  const fav: FileAction = entry.favorite === true ? 'unfavourite' : 'favourite';
  const PER_KIND: Readonly<Partial<Record<LibraryAssetKind, readonly FileAction[]>>> = {
    composition: ['open', 'open-tab', 'rename', 'duplicate', 'move', fav, 'export', 'copy-link', 'trash'],
    template: ['use', 'edit-template', 'rename', 'duplicate', 'move', fav, 'trash'],
  };
  return PER_KIND[entry.kind] ?? ['rename', 'move', fav, 'trash'];
}
const ACTION_LABELS: Readonly<Record<FileAction, keyof typeof m & `menu${string}`>> = {
  open: 'menuOpen',
  'open-tab': 'menuOpenNewTab',
  use: 'menuUse',
  'edit-template': 'menuEditTemplate',
  rename: 'menuRename',
  duplicate: 'menuDuplicate',
  move: 'menuMove',
  favourite: 'menuFavourite',
  unfavourite: 'menuUnfavourite',
  export: 'menuExport',
  'copy-link': 'menuCopyLink',
  trash: 'menuTrash',
  restore: 'menuRestore',
  'delete-forever': 'menuDeleteForever',
};
const ACTION_SHORTCUTS: Readonly<Partial<Record<FileAction, string>>> = { rename: 'F2', duplicate: 'Mod+D', trash: 'Delete' };

/** The page placeholder fits 70 % × 118 px with the design's aspect (contain). */
function pageStyle(format: { readonly width: number; readonly height: number } | undefined): string {
  const ratio = format === undefined ? 4 / 5 : format.width / format.height;
  return `aspect-ratio:${aspectOf(format)};inline-size:min(70%, ${Math.round(118 * ratio)}px)`;
}

/** A plain activation (no modifier, primary button): Home runs the capability; anything else is the browser's. */
export function isPlainActivation(e: MouseEvent): boolean {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

/** Bulk trash asks first from this many files (HOME-FILES §3: no confirmation for ≤ 5). */
export const BULK_TRASH_CONFIRM_FROM = 6;
/** The drag payload of cards dragged onto a project. */
export const ASSETS_DRAG_TYPE = 'application/x-instaflow-assets';
/** Wait this long on a title click for a second click (double-click renames). */
const TITLE_DOUBLE_CLICK_MS = 260;

/** What a card's or row's menu acts on. */
interface MenuTarget {
  readonly assets: readonly string[];
  readonly entry: HomeEntry;
}

/** What waits for an inline confirm. */
type Confirming =
  | { readonly kind: 'empty-trash' }
  | { readonly kind: 'delete'; readonly asset: string }
  | { readonly kind: 'bulk-trash' }
  | { readonly kind: 'delete-project'; readonly name: string };

/** Makes an object URL for an entry's preview: a design's cover or a small image (lazy; undefined when it cannot). */
export type PreviewSource = (entry: HomeEntry) => Promise<string | undefined>;

export class IfHomeElement extends SfElement<typeof homeSpec> {
  static override readonly spec = homeSpec;
  static override properties = {
    announcement: { state: true },
    now: { attribute: false },
    storage: { attribute: false },
    previews: { attribute: false },
    query: { state: true },
    renaming: { state: true },
    renamingProject: { state: true },
    creatingProject: { state: true },
    selection: { state: true },
    confirming: { state: true },
    menu: { state: true },
    prefs: { state: true },
    projectFilter: { state: true },
    dropping: { state: true },
    dropProject: { state: true },
    welcome: { state: true },
    facts: { state: true },
    full: { state: true },
    shown: { state: true },
    importing: { state: true },
    settings: { attribute: false },
  };
  static override styles = homeStyles;

  declare announcement: string;
  /** The clock for "Edited …" (tests pin it; defaults to the time of each render). */
  declare now: number | undefined;
  /** `navigator.storage` (tests pass a fake; null: none). */
  declare storage: StoragePort | null | undefined;
  /** Media previews (the boot's lazy blob reader). */
  declare previews: PreviewSource | undefined;
  declare query: string;
  declare renaming: string | undefined;
  declare renamingProject: boolean;
  declare creatingProject: boolean;
  declare selection: ReadonlySet<string>;
  declare confirming: Confirming | undefined;
  declare menu: MenuTarget | undefined;
  declare prefs: FilesPrefs;
  declare projectFilter: ProjectFilter;
  declare dropping: boolean;
  declare dropProject: string | undefined;
  /** The first-run card: shown, answered (kept / refused) for this session, or gone. */
  declare welcome: 'card' | 'kept' | 'refused' | 'gone';
  declare facts: StorageFacts | undefined;
  /** A write failed for lack of space (the banner). */
  declare full: boolean;
  /** Preview URLs by previewed blob (a newer cover is a new key, so the card updates). */
  declare shown: ReadonlyMap<string, string>;
  /** An import in progress (the inline progress row; Cancel aborts the rest). */
  declare importing: { readonly done: number; readonly total: number; readonly controller: AbortController } | undefined;
  /** This device's settings (density, units, hints); Settings writes them. */
  declare settings: DeviceSettings | undefined;

  private anchor: string | undefined;
  private titleTimer: ReturnType<typeof setTimeout> | undefined;
  private listeners: AbortController | undefined;
  private moveAfterCreate: readonly string[] = [];
  private previewing = new Set<string>();

  constructor() {
    super();
    this.announcement = '';
    this.now = undefined;
    this.storage = undefined;
    this.previews = undefined;
    this.query = '';
    this.renaming = undefined;
    this.renamingProject = false;
    this.creatingProject = false;
    this.selection = new Set();
    this.confirming = undefined;
    this.menu = undefined;
    this.prefs = readFilesPrefs(globalThis.localStorage);
    this.projectFilter = { kind: 'any' };
    this.dropping = false;
    this.dropProject = undefined;
    this.welcome = readFirstRun(globalThis.localStorage).seen ? 'gone' : 'card';
    this.facts = undefined;
    this.full = false;
    this.shown = new Map();
    this.importing = undefined;
    this.settings = undefined;
  }

  /** Pro turns Home into a working file manager (DENSITY-DISCLOSURE §4); Focus and Standard look the same here. */
  private get pro(): boolean {
    return this.settings?.current.density === 'pro';
  }

  override updated(): void {
    this.toggleAttribute('pro', this.pro);
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.listeners = new AbortController();
    const signal = this.listeners.signal;
    const doc = this.ownerDocument;
    doc.addEventListener('keydown', (e) => this.onGlobalKey(e), { signal });
    doc.addEventListener('paste', (e) => this.onPaste(e), { signal });
    void this.readFacts();
  }

  override firstUpdated(): void {
    this.deps.toasts?.trigger(); // resolve the toasts now, so the first operation's toast is not late
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.listeners?.abort();
    clearTimeout(this.titleTimer);
  }

  private get port(): StoragePort | undefined {
    return this.storage === null ? undefined : (this.storage ?? browserStorage());
  }

  private async readFacts(): Promise<void> {
    this.facts = await readStorageFacts(this.port);
  }

  private text<P>(ref: MessageRef<P>, ...args: MessageArgs<P>): string {
    return homeText(this.deps.i18n, ref, ...args);
  }

  private get toasts(): Toasts | undefined {
    return this.deps.toasts?.value;
  }

  /** Run `fn` with the toasts (they resolve lazily; the first toast of a session waits for them). */
  private toast(fn: (toasts: Toasts) => unknown): void {
    const handle = this.deps.toasts;
    if (handle === undefined) return;
    if (handle.value !== undefined) fn(handle.value);
    else void handle.whenReady().then((r) => (r.ok ? fn(r.value) : undefined));
  }

  private say(message: string): void {
    this.announcement = message;
  }

  /** Report a failed operation: the live region always, a toast when there is a toast host. */
  private problem(error: SfError): void {
    this.say(error.message);
    if (error.kind === 'quota') this.full = true;
    this.toast((t) => t.error(error));
  }

  /** The result's value in a box (so a `void` success is not mistaken for a failure), or undefined after reporting it. */
  private async attempt<T>(run: Promise<Result<T>>): Promise<{ readonly value: T } | undefined> {
    const done = await run;
    if (done.ok) return { value: done.value };
    this.problem(done.error as SfError);
    return undefined;
  }

  /** Run one of Home's opening actions; a failure is spoken (navigation is the success path). */
  private async run(action: () => Promise<Result<HomeActionOutput>>, title: string): Promise<void> {
    this.say(this.text(m.opening, { title }));
    const done = await action();
    if (!done.ok) this.say((done.error as SfError).message);
  }

  /** A card's click: plain activations run the capability; modified ones keep the link's browser behaviour. */
  private activate(e: MouseEvent, action: () => Promise<Result<HomeActionOutput>>, title: string): void {
    if (!isPlainActivation(e)) return;
    e.preventDefault();
    void this.run(action, title);
  }

  private go(view: HomeView, e?: MouseEvent): void {
    if (e !== undefined) {
      if (!isPlainActivation(e)) return;
      e.preventDefault();
    }
    this.selection = new Set();
    this.confirming = undefined;
    this.deps.model.go(view);
  }

  // ---------------------------------------------------------------- render

  override render(): TemplateResult {
    const model = this.deps.model;
    const view = model.view;
    return html`${this.renderHeader(view)}
      <main
        class=${this.dropping ? 'drop' : ''}
        aria-busy=${model.state === 'loading' ? 'true' : 'false'}
        @dragover=${(e: DragEvent) => this.onDragOver(e)}
        @dragleave=${(e: DragEvent) => this.onDragLeave(e)}
        @drop=${(e: DragEvent) => void this.onDrop(e)}
      >
        ${this.full ? html`<sf-banner tone="danger" message=${this.text(m.storageFull)} action-label=${this.text(m.openTrash)} @sf-action=${() => this.go({ kind: 'trash' })}></sf-banner>` : nothing}
        ${model.state === 'failed' ? this.renderProblem() : nothing}
        ${this.importing === undefined
          ? nothing
          : html`<sf-progress-row
              class="import-progress"
              label=${this.text(m.importing, { done: this.importing.done, total: this.importing.total })}
              .value=${this.importing.done}
              max=${this.importing.total}
              cancellable
              cancel-label=${this.text(m.cancel)}
              @sf-cancel=${() => this.importing?.controller.abort()}
            ></sf-progress-row>`}
        ${this.renderView(view)}
        ${model.state === 'loading' ? html`<p class="empty" role="status">${this.text(m.loading)}</p>` : nothing}
        ${this.dropping ? html`<p class="sr-only" role="status">${this.text(m.dropFiles)}</p>` : nothing}
      </main>
      ${this.renderFooter()} ${this.pro ? nothing : this.renderBulk()} ${this.renderFileMenu()}
      <sf-popover class="new-project-popover" label=${this.text(m.newProject)} @sf-toggle=${(e: CustomEvent<{ open: boolean }>) => (e.detail.open ? undefined : (this.moveAfterCreate = []))}>
        <form class="new-project" @submit=${(e: SubmitEvent) => this.onPopoverProject(e)}>
          <sf-text-field class="popover-name" label=${this.text(m.newProjectName)} @keydown=${(e: KeyboardEvent) => (e.key === 'Enter' ? void this.onPopoverProject(e) : undefined)}></sf-text-field>
          <sf-button variant="primary" size="sm" type="submit">${this.text(m.createProject)}</sf-button>
        </form>
      </sf-popover>
      <input class="picker" type="file" multiple hidden accept="image/*,.svg,.ttf,.otf,.woff,.woff2" @change=${(e: Event) => void this.onPicked(e)} />
      <if-new-design .templates=${model.templates()} .last=${model.recents()[0]?.format} .defaultUnit=${this.settings?.current.units ?? 'px'} @if-create=${(e: CustomEvent<NewDesignCreateDetail>) => void this.onCreate(e.detail)}></if-new-design>
      <div class="sr-only" role="status" aria-live="polite">${this.announcement}</div>`;
  }

  private renderHeader(view: HomeView): TemplateResult {
    const home = homeViewHref({ kind: 'home' });
    const current = view.kind === 'project' ? 'home' : view.kind;
    return html`<header class="top">
      <a class="brand" href=${home.ok ? home.value : '/'} aria-label=${this.text(m.logo)} @click=${(e: MouseEvent) => this.go({ kind: 'home' }, e)}>${instaflowMark(28)}<span aria-hidden="true">instaflow</span></a>
      <nav aria-label=${this.text(m.nav)}>
        <ul class="nav" role="list">
          ${NAV.map((item) => {
            const href = homeViewHref(item.kind === 'files' ? { kind: 'files', ...this.filesView() } : { kind: item.kind });
            return html`<li><a href=${href.ok ? href.value : nothing} aria-current=${current === item.kind ? 'page' : nothing} @click=${(e: MouseEvent) => this.go(item.kind === 'files' ? { kind: 'files', ...this.filesView() } : { kind: item.kind }, e)}>${this.text(m[item.label])}</a></li>`;
          })}
        </ul>
      </nav>
      <sf-text-field
        class="search"
        label=${this.text(m.search)}
        label-hidden
        type="search"
        placeholder=${this.text(m.search)}
        .value=${this.query}
        @input=${(e: Event) => (this.query = (e.composedPath()[0] as HTMLInputElement).value ?? '')}
        @keydown=${(e: KeyboardEvent) => this.onSearchKey(e)}
      ></sf-text-field>
      <sf-icon-button class="settings-link" variant="ghost" label=${this.text(m.settings)} .pressed=${view.kind === 'settings'} @click=${() => this.go({ kind: 'settings' })}
        ><sf-icon .icon=${settingsIcon} size="18"></sf-icon
      ></sf-icon-button>
      <div class="new" role="group" aria-label=${this.text(m.newDesign)}>
        <sf-button class="new-design" variant="primary" @click=${() => void this.openNewDesign()}>＋ ${this.text(m.newDesign)}</sf-button>
        <sf-menu label=${this.text(m.newFormats)} align="end" @sf-select=${(e: CustomEvent<{ value: string }>) => this.onFormatMenu(e.detail.value)}>
          <sf-icon-button slot="trigger" variant="primary" label=${this.text(m.newFormats)}><sf-icon .icon=${chevronDownIcon} size="16"></sf-icon></sf-icon-button>
          ${NEW_DESIGN_CHIPS.map((id) => html`<sf-menu-item value=${id}>${DESIGN_FORMATS[id].title} · ${groupDigits(DESIGN_FORMATS[id].size.width)} × ${groupDigits(DESIGN_FORMATS[id].size.height)}</sf-menu-item>`)}
          <div role="separator"></div>
          <sf-menu-item value=${CUSTOM_FORMAT}>${this.text(m.customSize)}</sf-menu-item>
        </sf-menu>
      </div>
    </header>`;
  }

  /** Files' remembered state as view params (the nav link and the URL carry them). */
  private filesView(): { readonly filter?: FilesFilter; readonly sort?: FilesSort; readonly layout?: FilesLayout } {
    const p = this.prefs;
    return { ...(p.filter === 'all' ? {} : { filter: p.filter }), ...(p.sort === 'edited' ? {} : { sort: p.sort }), ...(p.layout === 'grid' ? {} : { layout: p.layout }) };
  }

  private renderView(view: HomeView): TemplateResult {
    const PAGES: Readonly<Record<HomeView['kind'], () => TemplateResult>> = {
      home: () => this.renderHome(),
      files: () => this.renderFiles(view as Extract<HomeView, { kind: 'files' }>),
      project: () => this.renderProject((view as Extract<HomeView, { kind: 'project' }>).name),
      templates: () => this.renderTemplatesPage(),
      trash: () => this.renderTrash(),
      settings: () => this.renderSettings((view as Extract<HomeView, { kind: 'settings' }>).section ?? 'general'),
    };
    return PAGES[view.kind]();
  }

  private renderProblem(): TemplateResult {
    return html`<div class="problem" role="alert">
      <span>${this.text(m.failed, { message: this.deps.model.error?.message ?? '' })}</span>
      <sf-button @click=${() => void this.deps.model.refresh()}>${this.text(m.retry)}</sf-button>
    </div>`;
  }

  // ---------------------------------------------------------------- Home page

  private searched(entries: readonly HomeEntry[]): readonly HomeEntry[] {
    if (this.query.trim() === '') return entries;
    const found = new Set(this.deps.model.search(this.query).map((e) => e.asset));
    return entries.filter((e) => found.has(e.asset));
  }

  private renderHome(): TemplateResult {
    const model = this.deps.model;
    const [layout] = lenses();
    const searching = this.query.trim() !== '';
    const recents = this.searched(this.pro ? model.index.entries.filter((e) => e.kind === 'composition' && e.trashedAt === undefined).slice(0, 12) : model.recents());
    const templates = this.searched(model.templates());
    const projects = searching ? model.projects().filter((p) => p.name.toLocaleLowerCase().includes(this.query.trim().toLocaleLowerCase())) : model.projects();
    const firstRun = this.welcome !== 'gone';
    const nothingFound = searching && recents.length === 0 && templates.length === 0 && projects.length === 0;
    return html`<section class=${this.pro ? 'hero compact' : 'hero'} aria-labelledby="hero">
        <h1 id="hero" class=${this.pro ? 'sr-only' : ''} style=${`--if-home-bold:${layout?.color ?? 'transparent'};--if-home-bold-ink:${layout?.onColor ?? 'inherit'}`}>
          ${this.text(m.heroBefore)} <span class="bold">${this.text(m.heroBold)}</span> ${this.text(m.heroAfter)}
        </h1>
        ${this.pro ? nothing : html`<p class="lead">${this.text(m.heroLead)}</p>`}
        <ul class="formats" role="list" aria-label=${this.text(m.formats)}>
          ${NEW_DESIGN_CHIPS.map(
            (id) => html`<li>
              <sf-button variant="secondary" size=${this.pro ? 'sm' : 'md'} data-format=${id} @click=${() => void this.run(() => model.newDesign(id), DESIGN_FORMATS[id].title)}>
                <span aria-hidden="true" style=${lensMarkStyle(lensOf(DESIGN_FORMATS[id].lens), 1)}></span>
                ${DESIGN_FORMATS[id].title} <span class="size">${groupDigits(DESIGN_FORMATS[id].size.width)} × ${groupDigits(DESIGN_FORMATS[id].size.height)}</span>
              </sf-button>
            </li>`,
          )}
          <li><sf-button variant="secondary" size=${this.pro ? 'sm' : 'md'} data-format=${CUSTOM_FORMAT} @click=${() => void this.openNewDesign(CUSTOM_FORMAT, 'width')}>${this.text(m.customSizeShort)}</sf-button></li>
        </ul>
        ${firstRun ? html`<p class="muted first-run-hint">${this.text(m.formatsHint)}</p>` : nothing}
      </section>
      ${nothingFound ? this.renderNoResults() : nothing} ${searching ? nothing : this.renderQuick(model.quickActions)}
      ${firstRun && model.recents().length === 0 ? this.renderWelcome() : searching && recents.length === 0 ? nothing : this.renderRecents(recents)}
      ${templates.length === 0 ? nothing : this.renderTemplates(templates)} ${searching && projects.length === 0 ? nothing : this.renderProjects(projects)}`;
  }

  private renderNoResults(): TemplateResult {
    return html`<p class="empty no-results" role="status">${this.text(m.noResults, { query: this.query.trim() })} <sf-button size="sm" variant="ghost" @click=${() => (this.query = '')}>${this.text(m.clearSearch)}</sf-button></p>`;
  }

  private renderWelcome(): TemplateResult {
    const W: Readonly<Record<'card' | 'kept' | 'refused', () => TemplateResult>> = {
      card: () => html`<section class="welcome" aria-labelledby="welcome">
        <h2 id="welcome">${this.text(m.welcomeTitle)}</h2>
        <p>${this.text(m.welcomeText)}</p>
        <div class="row"><sf-button variant="primary" class="keep" @click=${() => void this.keepOnDevice()}>${this.text(m.welcomeKeep)}</sf-button></div>
        <sf-icon-button class="close" variant="ghost" label=${this.text(m.welcomeDismiss)} @click=${() => this.dismissWelcome()}><sf-icon .icon=${xIcon} size="16"></sf-icon></sf-icon-button>
      </section>`,
      kept: () => html`<p class="muted welcome-status" role="status">${this.text(m.welcomeKept)}</p>`,
      refused: () => html`<p class="muted welcome-status" role="status">${this.text(m.welcomeRefused)}</p>`,
    };
    return this.welcome === 'gone' ? html`` : W[this.welcome]();
  }

  private async keepOnDevice(): Promise<void> {
    markFirstRunSeen(globalThis.localStorage);
    const granted = await requestPersistence(this.port);
    this.welcome = granted ? 'kept' : 'refused';
    void this.readFacts();
  }

  private dismissWelcome(): void {
    markFirstRunSeen(globalThis.localStorage);
    this.welcome = 'gone';
  }

  private renderQuick(actions: readonly HomeQuickAction[]): TemplateResult {
    const model = this.deps.model;
    return html`<section class="quick" aria-labelledby="quick">
      <h2 id="quick">${this.text(m.quickActions)}</h2>
      <ul class="grid" role="list">
        ${actions.map((action) => {
          const href = newDesignHref(action.input.format === undefined ? {} : { format: action.input.format });
          return html`<li>
            <sf-card data-action=${action.id} href=${href.ok ? href.value : nothing} @click=${(e: MouseEvent) => this.activate(e, () => model.runQuickAction(action), action.title)}>
              <span aria-hidden="true" style=${`${lensMarkStyle(lensOf(action.lens), 3)};margin-block-end:10px`}></span>
              <span class="card-title">${action.title}</span>
              <span class="muted">${action.detail}</span>
            </sf-card>
          </li>`;
        })}
      </ul>
    </section>`;
  }

  private renderRecents(entries: readonly HomeEntry[]): TemplateResult {
    return html`<section aria-labelledby="recent">
      <h2 id="recent">${this.text(m.recents)}</h2>
      ${entries.length === 0 ? html`<p class="empty">${this.text(m.recentsEmptyCard)}</p>` : html`<ul class="grid" role="list">${entries.map((e) => this.renderCard(e))}</ul>`}
    </section>`;
  }

  private renderTemplates(entries: readonly HomeEntry[]): TemplateResult {
    return html`<section aria-labelledby="templates">
      <h2 id="templates">${this.text(m.templates)}</h2>
      ${this.pro
        ? html`<ul class="list compact" role="list">
            ${entries.map((e) => this.renderRow(e, false))}
          </ul>`
        : html`<ul class="grid" role="list">
            ${entries.map((e) => this.renderCard(e))}
          </ul>`}
    </section>`;
  }

  private renderProjects(projects: readonly ProjectSummary[]): TemplateResult {
    return html`<section aria-labelledby="projects">
      <div class="section-head">
        <h2 id="projects">${this.text(m.projects)}</h2>
        ${projects.length === 0 && !this.creatingProject ? nothing : html`<sf-button class="push" size="sm" variant="secondary" @click=${() => this.startProject()}>＋ ${this.text(m.newProject)}</sf-button>`}
      </div>
      ${projects.length === 0 && !this.creatingProject
        ? html`<p class="empty">${this.text(m.projectsEmpty)} <sf-button size="sm" variant="secondary" class="first-project" @click=${() => this.startProject()}>＋ ${this.text(m.newProject)}</sf-button></p>`
        : html`<ul class=${this.pro ? 'list compact projects-list' : 'grid'} role="list">
            ${this.creatingProject ? html`<li>${this.renderNewProjectCard()}</li>` : nothing} ${projects.map((p) => (this.pro ? this.renderProjectRow(p) : this.renderProjectCard(p)))}
          </ul>`}
    </section>`;
  }

  private renderNewProjectCard(): TemplateResult {
    return html`<form class="new-project" @submit=${(e: SubmitEvent) => this.onCreateProject(e)} @keydown=${(e: KeyboardEvent) => (e.key === 'Escape' ? this.stopProject() : undefined)}>
      <sf-text-field class="project-name" label=${this.text(m.newProjectName)} @keydown=${(e: KeyboardEvent) => (e.key === 'Enter' ? void this.onCreateProject(e) : undefined)}></sf-text-field>
      <div class="toolbar">
        <sf-button variant="primary" size="sm" type="submit">${this.text(m.createProject)}</sf-button>
        <sf-button variant="ghost" size="sm" @click=${() => this.stopProject()}>${this.text(m.cancel)}</sf-button>
      </div>
    </form>`;
  }

  private startProject(): void {
    this.creatingProject = true;
    void this.updateComplete.then(() => this.renderRoot.querySelector<HTMLElement>('sf-text-field.project-name')?.focus());
  }

  private stopProject(): void {
    this.creatingProject = false;
  }

  /** Submit (the field lives in a shadow root, so Enter in it is handled here, not by the form). */
  private async onCreateProject(e: Event): Promise<void> {
    e.preventDefault();
    const field = this.renderRoot.querySelector<HTMLElement & { value: string; error: string | undefined }>('sf-text-field.project-name');
    const name = field?.value?.trim() ?? '';
    const done = await this.deps.model.newProject(name);
    if (!done.ok) {
      if (field !== null) field.error = name === '' ? this.text(m.nameRequired) : (done.error as SfError).message;
      return;
    }
    this.creatingProject = false;
    this.say(this.text(m.projectCreated, { name }));
  }

  private renderProjectCard(p: ProjectSummary): TemplateResult {
    const href = homeViewHref({ kind: 'project', name: p.name });
    const when = relativeTime(p.editedAt, this.now ?? Date.now(), this.locale());
    return html`<li>
      <sf-card
        class="project-card"
        data-project=${p.name}
        href=${href.ok ? href.value : nothing}
        ?drop-target=${this.dropProject === p.name}
        @click=${(e: MouseEvent) => this.go({ kind: 'project', name: p.name }, e)}
        @dragover=${(e: DragEvent) => this.onProjectDragOver(e, p.name)}
        @dragleave=${() => (this.dropProject = undefined)}
        @drop=${(e: DragEvent) => void this.onProjectDrop(e, p.name)}
      >
        <sf-icon class="folder" .icon=${folderIcon} size="24"></sf-icon>
        <span class="card-title">${this.highlight(p.name)}</span>
        <span class="muted">${this.text(m.projectMeta, { count: p.count, when })}</span>
      </sf-card>
    </li>`;
  }

  /** A project as a compact row (Pro). */
  private renderProjectRow(p: ProjectSummary): TemplateResult {
    const href = homeViewHref({ kind: 'project', name: p.name });
    const when = relativeTime(p.editedAt, this.now ?? Date.now(), this.locale());
    return html`<li
      class="row project-row"
      data-project=${p.name}
      ?data-drop=${this.dropProject === p.name}
      @dragover=${(e: DragEvent) => this.onProjectDragOver(e, p.name)}
      @dragleave=${() => (this.dropProject = undefined)}
      @drop=${(e: DragEvent) => void this.onProjectDrop(e, p.name)}
    >
      <span class="mark" aria-hidden="true"><sf-icon .icon=${folderIcon} size="16"></sf-icon></span>
      <a class="tile-title" href=${href.ok ? href.value : nothing} @click=${(e: MouseEvent) => this.go({ kind: 'project', name: p.name }, e)}>${this.highlight(p.name)}</a>
      <span class="cell">${this.text(m.projectMeta, { count: p.count, when })}</span>
    </li>`;
  }

  // ---------------------------------------------------------------- cards and rows

  private locale(): string | undefined {
    return this.ownerDocument.documentElement.lang || undefined;
  }

  private kindLabel(kind: LibraryAssetKind): string {
    return this.text(m[KIND_LABELS[kind] ?? 'kindMedia']);
  }

  private meta(entry: HomeEntry): string {
    if (entry.kind === 'template') return this.text(m.templateMeta);
    const when = relativeTime(entry.editedAt, this.now ?? Date.now(), this.locale());
    const base = entry.pages !== undefined && entry.pages > 1 ? this.text(m.editedPages, { when, pages: entry.pages }) : this.text(m.edited, { when });
    const size = entry.format === undefined ? '' : ` · ${this.text(m.size, { width: entry.format.width, height: entry.format.height })}`;
    const project = this.pro && entry.folder !== undefined ? ` · ${entry.folder}` : '';
    return `${base}${size}${project}`;
  }

  /** The title with the search match marked. */
  private highlight(title: string): TemplateResult | string {
    const q = this.query.trim();
    if (q === '') return title;
    const at = title.toLocaleLowerCase().indexOf(q.toLocaleLowerCase());
    if (at < 0) return title;
    return html`${title.slice(0, at)}<mark>${title.slice(at, at + q.length)}</mark>${title.slice(at + q.length)}`;
  }

  /** What a click on a card does (data: designs open, templates start a design; media have no page). */
  private opener(entry: HomeEntry): (() => Promise<Result<HomeActionOutput>>) | undefined {
    const model = this.deps.model;
    const OPENERS: Readonly<Partial<Record<LibraryAssetKind, () => Promise<Result<HomeActionOutput>>>>> = {
      composition: () => model.open(entry.asset),
      template: () => model.useTemplate(entry.asset),
    };
    return OPENERS[entry.kind];
  }

  private thumb(entry: HomeEntry): TemplateResult {
    const tag = lensTag(lensOf(entry.lens));
    const preview = this.preview(entry);
    const icon = KIND_ICONS[entry.kind];
    return html`<span class="thumb" aria-hidden="true">
      ${preview !== undefined ? html`<img class=${entry.cover === undefined ? 'preview' : 'preview cover'} alt="" src=${preview} />` : icon !== undefined ? html`<sf-icon .icon=${icon} size="24"></sf-icon>` : html`<span class="page" style=${pageStyle(entry.format)}></span>`}
      <sf-tag .color=${tag.color} .ink=${tag.ink}>${this.kindLabel(entry.kind)}</sf-tag>
      ${entry.favorite === true ? html`<sf-icon class="star-mark" .icon=${starIcon} size="16" style="--sf-icon-fill:currentColor"></sf-icon>` : nothing}
    </span>`;
  }

  /** The entry's preview URL once loaded; asks for it the first time (#64: designs show their cover). */
  private preview(entry: HomeEntry): string | undefined {
    const key = previewBlob(entry)?.digest;
    if (key === undefined) return undefined;
    const url = this.shown.get(key);
    if (url === undefined) this.requestPreview(entry, key);
    return url;
  }

  private requestPreview(entry: HomeEntry, key: string): void {
    if (this.previews === undefined || this.previewing.has(key)) return;
    this.previewing.add(key);
    void this.previews(entry).then((url) => {
      if (url !== undefined) this.shown = new Map([...this.shown, [key, url]]);
    });
  }

  /** A design, template or media card (Home sections, Files, a project). */
  private renderCard(entry: HomeEntry, selectable = false): TemplateResult {
    const href = this.deps.model.hrefOf(entry);
    const open = this.opener(entry);
    const renaming = this.renaming === entry.asset;
    const selected = this.selection.has(entry.asset);
    return html`<li>
      <sf-card
        class="tile"
        data-asset=${entry.asset}
        href=${renaming || href === undefined ? nothing : href}
        label=${renaming ? nothing : entry.title}
        ?selected=${selected}
        ?selectable=${selectable}
        ?actions-shown=${this.menu?.entry.asset === entry.asset}
        draggable=${renaming ? 'false' : 'true'}
        @click=${(e: MouseEvent) => this.onCardClick(e, entry, open, selectable)}
        @dblclick=${(e: MouseEvent) => this.onCardDoubleClick(e, entry)}
        @keydown=${(e: KeyboardEvent) => this.onCardKey(e, entry, selectable)}
        @contextmenu=${(e: MouseEvent) => this.onContextMenu(e, entry)}
        @dragstart=${(e: DragEvent) => this.onCardDragStart(e, entry)}
      >
        ${this.thumb(entry)}
        <span class="tile-text">
          ${renaming ? this.renameField(entry) : html`<span class="tile-title">${this.highlight(entry.title)}</span>`}
          <span class="muted">${this.meta(entry)}</span>
        </span>
        ${selectable
          ? html`<input
              slot="leading"
              class="check"
              type="checkbox"
              aria-label=${this.text(m.selectFile, { title: entry.title })}
              .checked=${selected}
              @click=${(e: MouseEvent) => this.onCheck(e, entry.asset)}
            />`
          : nothing}
        ${entry.trashedAt === undefined
          ? html`<sf-icon-button
              slot="actions"
              class="card-action star"
              size="sm"
              variant="secondary"
              label=${this.text(entry.favorite === true ? m.favouriteOff : m.favouriteOn, { title: entry.title })}
              .pressed=${entry.favorite === true}
              @click=${(e: MouseEvent) => {
                e.stopPropagation();
                void this.toggleFavourite(entry);
              }}
              ><sf-icon .icon=${starIcon} size="16" style=${entry.favorite === true ? '--sf-icon-fill:currentColor' : ''}></sf-icon
            ></sf-icon-button>`
          : nothing}
        <sf-icon-button
          slot="actions"
          class="card-action more"
          size="sm"
          variant="secondary"
          label=${this.text(m.moreFor, { title: entry.title })}
          @click=${(e: MouseEvent) => {
            e.stopPropagation();
            this.openMenu(entry, e.currentTarget as HTMLElement);
          }}
          ><sf-icon .icon=${ellipsisIcon} size="16"></sf-icon
        ></sf-icon-button>
      </sf-card>
    </li>`;
  }

  private renameField(entry: HomeEntry): TemplateResult {
    return html`<sf-inline-edit
      class="rename"
      editing
      trigger="none"
      label=${this.text(m.titleLabel, { title: entry.title })}
      .value=${entry.title}
      maxlength="200"
      @sf-change=${(e: CustomEvent<InlineEditChangeDetail>) => void this.commitRename(entry, e.detail.value)}
      @sf-cancel=${() => this.endRename(entry.asset)}
      @keydown=${(e: KeyboardEvent) => e.stopPropagation()}
      @click=${(e: MouseEvent) => e.stopPropagation()}
    ></sf-inline-edit>`;
  }

  private startRename(entry: HomeEntry): void {
    clearTimeout(this.titleTimer);
    this.renaming = entry.asset;
    void this.updateComplete.then(() => this.renderRoot.querySelector<HTMLElement & { edit(): void }>(`[data-asset="${CSS.escape(entry.asset)}"] sf-inline-edit`)?.edit());
  }

  private endRename(asset: string): void {
    if (this.renaming !== asset) return;
    this.renaming = undefined;
    void this.updateComplete.then(() => this.focusCard(asset));
  }

  private async commitRename(entry: HomeEntry, title: string): Promise<void> {
    const previous = entry.title;
    this.endRename(entry.asset);
    const done = await this.attempt(this.deps.model.rename(entry.asset, title));
    if (done === undefined) return;
    const message = this.text(m.renamedTo, { title: title.trim() });
    this.say(message);
    this.toast((t) => t.undoable({ message, undo: () => void this.deps.model.rename(entry.asset, previous) }));
  }

  private focusCard(asset: string): void {
    const card = this.renderRoot.querySelector<HTMLElement>(`[data-asset="${CSS.escape(asset)}"]`);
    const link = card?.shadowRoot?.querySelector<HTMLElement>('a');
    (link ?? card?.querySelector<HTMLElement>('a, .more') ?? card)?.focus();
  }

  private onCardClick(e: MouseEvent, entry: HomeEntry, open: (() => Promise<Result<HomeActionOutput>>) | undefined, selectable: boolean): void {
    if (this.renaming === entry.asset) return;
    if (selectable && (e.shiftKey || e.metaKey || e.ctrlKey) && e.button === 0) {
      // Shift: a range from the last clicked; Mod: toggle (HOME-FILES §2.2). The browser's own modified clicks lose here.
      e.preventDefault();
      this.extendSelection(entry.asset, e.shiftKey ? 'range' : 'toggle');
      return;
    }
    if (open === undefined || !isPlainActivation(e)) return;
    e.preventDefault();
    const onTitle = e.composedPath().some((n) => (n as Element).classList?.contains('tile-title') === true);
    clearTimeout(this.titleTimer);
    if (onTitle && e.detail === 1) {
      // A click on the title may be the first of a double-click (rename): wait for it.
      this.titleTimer = setTimeout(() => void this.run(open, entry.title), TITLE_DOUBLE_CLICK_MS);
      return;
    }
    if (e.detail > 1) return;
    void this.run(open, entry.title);
  }

  private onCardDoubleClick(e: MouseEvent, entry: HomeEntry): void {
    const onTitle = e.composedPath().some((n) => (n as Element).classList?.contains('tile-title') === true);
    if (!onTitle || entry.trashedAt !== undefined) return;
    e.preventDefault();
    this.startRename(entry);
  }

  private onCardKey(e: KeyboardEvent, entry: HomeEntry, selectable: boolean): void {
    if (this.renaming === entry.asset) return;
    const mod = e.metaKey || e.ctrlKey;
    const KEYS: readonly (readonly [boolean, () => void])[] = [
      [e.key === 'F2' || (mod && e.shiftKey && e.key.toLowerCase() === 'r'), () => this.startRename(entry)],
      [mod && !e.shiftKey && e.key.toLowerCase() === 'd', () => void this.duplicate([entry.asset])],
      [!mod && (e.key === 'Delete' || e.key === 'Backspace'), () => void this.trash(this.targets(entry))],
      [(e.shiftKey && e.key === 'F10') || e.key === 'ContextMenu', () => this.openMenu(entry, e.currentTarget as HTMLElement, true)],
      [selectable && e.key === ' ', () => this.extendSelection(entry.asset, 'toggle')],
    ];
    const hit = KEYS.find(([when]) => when);
    if (hit === undefined || entry.trashedAt !== undefined) return;
    e.preventDefault();
    e.stopPropagation();
    hit[1]();
  }

  /** The selection when the entry is in it, else just the entry. */
  private targets(entry: HomeEntry): readonly string[] {
    return this.selection.has(entry.asset) ? [...this.selection] : [entry.asset];
  }

  private onCheck(e: MouseEvent, asset: string): void {
    e.stopPropagation();
    this.extendSelection(asset, e.shiftKey ? 'range' : 'toggle');
  }

  /** The order Files / the project shows (range selection walks it). */
  private visibleOrder(): readonly string[] {
    return [...this.renderRoot.querySelectorAll<HTMLElement>('[data-selectable-list] [data-asset]')].map((el) => el.dataset['asset'] as string);
  }

  private extendSelection(asset: string, how: 'toggle' | 'range' | 'all'): void {
    const next = new Set(this.selection);
    if (how === 'all') for (const a of this.visibleOrder()) next.add(a);
    else if (how === 'range') for (const a of selectRange(this.visibleOrder(), this.anchor, asset)) next.add(a);
    else if (next.has(asset)) next.delete(asset);
    else next.add(asset);
    if (how !== 'all') this.anchor = asset;
    this.selection = next;
    this.confirming = undefined;
  }

  // ---------------------------------------------------------------- the file menu (⋯ and context menu)

  private get fileMenu(): SfMenuElement | null {
    return this.renderRoot.querySelector<SfMenuElement>('sf-menu.file-menu');
  }

  private openMenu(entry: HomeEntry, anchor: HTMLElement, keyboard = false): void {
    this.menu = { entry, assets: this.targets(entry) };
    void this.updateComplete.then(() => {
      const menu = this.fileMenu;
      if (menu === null) return;
      menu.anchor = anchor;
      if (keyboard) {
        const r = anchor.getBoundingClientRect();
        menu.showAt({ x: r.left + 8, y: r.top + 8 }, { keyboard: true, returnTo: anchor });
      } else menu.show();
    });
  }

  private onContextMenu(e: MouseEvent, entry: HomeEntry): void {
    if (this.renaming === entry.asset) return;
    e.preventDefault();
    this.menu = { entry, assets: this.targets(entry) };
    const point = { x: e.clientX, y: e.clientY };
    const returnTo = e.currentTarget as HTMLElement;
    void this.updateComplete.then(() => this.fileMenu?.showAt(point, { returnTo }));
  }

  private renderFileMenu(): TemplateResult {
    const target = this.menu;
    const entry = target === undefined ? undefined : this.deps.model.entry(target.entry.asset);
    const actions = entry === undefined ? [] : fileActions(entry);
    const projects = this.deps.model.projects();
    const current = entry?.folder;
    return html`<sf-menu
      class="file-menu"
      label=${entry === undefined ? this.text(m.moreFor, { title: '' }) : this.text(m.moreFor, { title: entry.title })}
      @sf-select=${(e: CustomEvent<{ value: string }>) => void this.onFileMenu(e.detail.value)}
      @sf-toggle=${(e: CustomEvent<{ open: boolean }>) => (e.detail.open ? undefined : (this.menu = undefined))}
    >
      ${actions.map((action) =>
        action === 'move'
          ? html`<sf-menu-item value="move" .icon=${folderIcon}>${this.text(m.menuMove)}</sf-menu-item>
              <sf-menu slot="submenu" label=${this.text(m.menuMove)}>
                ${projects.map((p) => html`<sf-menu-item type="radio" value=${`move:${p.name}`} ?checked=${current === p.name}>${p.name}</sf-menu-item>`)}
                ${projects.length > 0 ? html`<div role="separator"></div>` : nothing}
                <sf-menu-item value="move-new">${this.text(m.newProjectEllipsis)}</sf-menu-item>
                <sf-menu-item type="radio" value="move:" ?checked=${current === undefined}>${this.text(m.noProject)}</sf-menu-item>
              </sf-menu>`
          : html`${action === 'trash' || action === 'delete-forever' ? html`<div role="separator"></div>` : nothing}<sf-menu-item value=${action} shortcut=${ACTION_SHORTCUTS[action] ?? nothing}>${this.text(m[ACTION_LABELS[action]])}</sf-menu-item>`,
      )}
    </sf-menu>`;
  }

  private async onFileMenu(value: string): Promise<void> {
    const target = this.menu;
    if (target === undefined) return;
    const entry = this.deps.model.entry(target.entry.asset) ?? target.entry;
    const model = this.deps.model;
    if (value.startsWith('move:')) {
      await this.move(target.assets, value.slice('move:'.length));
      return;
    }
    const RUN: Readonly<Record<string, () => unknown>> = {
      open: () => this.run(() => model.open(entry.asset), entry.title),
      export: () => this.run(() => model.open(entry.asset, 'export'), entry.title),
      'open-tab': () => this.openInNewTab(entry),
      use: () => this.run(() => model.useTemplate(entry.asset), entry.title),
      'edit-template': () => this.editTemplate(entry),
      rename: () => this.startRename(entry),
      duplicate: () => this.duplicate(target.assets),
      'move-new': () => this.newProjectFor(target.assets),
      favourite: () => this.toggleFavourite(entry),
      unfavourite: () => this.toggleFavourite(entry),
      'copy-link': () => this.copyLink(entry),
      trash: () => this.trash(target.assets),
      restore: () => this.restore(target.assets),
      'delete-forever': () => (this.confirming = { kind: 'delete', asset: entry.asset }),
    };
    await RUN[value]?.();
  }

  private openInNewTab(entry: HomeEntry): void {
    const href = this.deps.model.hrefOf(entry);
    if (href !== undefined) this.ownerDocument.defaultView?.open(href, '_blank', 'noopener');
  }

  private editTemplate(entry: HomeEntry): void {
    const href = studioHref(entry.asset);
    if (href.ok) this.ownerDocument.defaultView?.location.assign(href.value);
  }

  private async copyLink(entry: HomeEntry): Promise<void> {
    const href = studioHref(entry.asset);
    if (!href.ok) return;
    const url = new URL(href.value, this.ownerDocument.location.href).href;
    try {
      await navigator.clipboard.writeText(url);
      this.say(this.text(m.linkCopied));
      this.toast((t) => t.show({ message: this.text(m.linkCopied), dedupe: 'link-copied' }));
    } catch {
      this.say(this.text(m.linkBlocked));
      this.toast((t) => t.show({ message: this.text(m.linkBlocked), tone: 'warning' }));
    }
  }

  /** `Move to › New project…`: a small popover with the name; Create makes it and moves the files there. */
  private newProjectFor(assets: readonly string[]): void {
    this.moveAfterCreate = assets;
    const popover = this.renderRoot.querySelector<SfPopoverElement>('sf-popover.new-project-popover');
    if (popover === null) return;
    popover.anchor = this.renderRoot.querySelector(`[data-asset="${CSS.escape(assets[0] ?? '')}"]`) ?? this.renderRoot.querySelector('.bulk') ?? undefined;
    popover.show();
  }

  private async onPopoverProject(e: Event): Promise<void> {
    e.preventDefault();
    const field = this.renderRoot.querySelector<HTMLElement & { value: string; error: string | undefined }>('sf-text-field.popover-name');
    const name = field?.value?.trim() ?? '';
    const made = await this.deps.model.newProject(name);
    if (!made.ok) {
      if (field !== null) field.error = name === '' ? this.text(m.nameRequired) : (made.error as SfError).message;
      return;
    }
    const assets = this.moveAfterCreate;
    this.renderRoot.querySelector<SfPopoverElement>('sf-popover.new-project-popover')?.hide();
    if (field !== null) field.value = '';
    if (assets.length > 0) await this.move(assets, name);
  }

  // ---------------------------------------------------------------- operations with their toasts (HOME-FILES §3)

  private async toggleFavourite(entry: HomeEntry): Promise<void> {
    await this.attempt(this.deps.model.favorite(entry.asset, entry.favorite !== true));
  }

  private async duplicate(assets: readonly string[]): Promise<void> {
    const model = this.deps.model;
    const copies: { asset: string; title: string }[] = [];
    for (const asset of assets) {
      const entry = model.entry(asset);
      if (entry === undefined || (entry.kind !== 'composition' && entry.kind !== 'template')) continue;
      const copy = await this.attempt(model.duplicate(asset));
      if (copy !== undefined) copies.push(copy.value);
    }
    const first = copies[0];
    if (first === undefined) return;
    const message = this.text(m.duplicated, { title: first.title });
    this.say(message);
    this.toast((t) => t.undoable({ message, undo: () => void model.trash(copies.map((c) => c.asset)) }));
    this.selection = new Set();
    await this.updateComplete;
    this.focusCard(first.asset);
  }

  private async move(assets: readonly string[], project: string): Promise<void> {
    const model = this.deps.model;
    const before = new Map(assets.map((a) => [a, model.entry(a)?.folder ?? '']));
    const moving = assets.filter((a) => before.get(a) !== project);
    if (moving.length === 0) return;
    const done = await this.attempt(model.move(moving, project));
    if (done === undefined) return;
    const message = project === '' ? this.text(m.movedOut, { count: moving.length }) : this.text(m.movedTo, { count: moving.length, project });
    this.say(message);
    this.selection = new Set();
    this.toast((t) => t.undoable({
      message,
      undo: () => {
        const back = new Map<string, string[]>();
        for (const a of moving) back.set(before.get(a) ?? '', [...(back.get(before.get(a) ?? '') ?? []), a]);
        void (async () => {
          for (const [folder, list] of back) await model.move(list, folder);
        })();
      },
    }));
  }

  private async trash(assets: readonly string[], confirmed = false): Promise<void> {
    const model = this.deps.model;
    const live = assets.filter((a) => model.entry(a)?.trashedAt === undefined);
    if (live.length === 0) return;
    if (!confirmed && live.length >= BULK_TRASH_CONFIRM_FROM) {
      this.confirming = { kind: 'bulk-trash' };
      return;
    }
    const first = model.entry(live[0] as string);
    const done = await this.attempt(model.trash(live));
    if (done === undefined) return;
    this.confirming = undefined;
    this.selection = new Set([...this.selection].filter((a) => !live.includes(a)));
    const message = live.length === 1 ? this.text(m.trashedOne, { title: first?.title ?? '' }) : this.text(m.trashedMany, { count: live.length });
    this.say(message);
    this.toast((t) => t.undoable({ message, undo: () => void model.restore(live) }));
  }

  private async restore(assets: readonly string[]): Promise<void> {
    const model = this.deps.model;
    const first = model.entry(assets[0] ?? '');
    const done = await this.attempt(model.restore(assets));
    if (done === undefined) return;
    const message = this.text(m.restored, { count: assets.length, title: first?.title ?? '' });
    this.say(message);
    const open = first !== undefined && assets.length === 1 && first.kind === 'composition' ? first : undefined;
    this.toast((t) => t.show(open === undefined ? { message } : { message, action: { label: this.text(m.open), run: () => void model.open(open.asset) } }));
  }

  private async deleteForever(assets: readonly string[]): Promise<void> {
    const model = this.deps.model;
    const first = model.entry(assets[0] ?? '');
    const done = await this.attempt(model.deleteForever(assets));
    if (done === undefined) return;
    this.confirming = undefined;
    const message = this.text(m.deletedForever, { count: assets.length, title: first?.title ?? '' });
    this.say(message);
    this.toast((t) => t.show({ message }));
  }

  // ---------------------------------------------------------------- Files, project, templates, trash pages

  private setPrefs(next: Partial<FilesPrefs>): void {
    this.prefs = { ...this.prefs, ...next };
    writeFilesPrefs(globalThis.localStorage, this.prefs);
    const view = this.deps.model.view;
    if (view.kind !== 'files') return;
    // View params replace history (NAVIGATION §3): the URL shows the list state without new entries.
    this.deps.model.go({ kind: 'files', ...(view.query === undefined ? {} : { query: view.query }), ...this.filesView() }, { replace: true });
  }

  private renderFilesToolbar(withProject: boolean): TemplateResult {
    const p = this.prefs;
    const projects = this.deps.model.projects();
    const pf = this.projectFilter;
    const projectLabel = pf.kind === 'any' ? this.text(m.allProjects) : pf.kind === 'none' ? this.text(m.noProject) : pf.name;
    return html`<div class="toolbar" role="toolbar" aria-label=${this.text(m.filesFilter)}>
      <sf-segmented
        class="filter"
        label=${this.text(m.filesFilter)}
        size="sm"
        .options=${FILES_FILTERS.map((f) => ({ value: f, label: this.text(m[FILTER_LABELS[f]]) }))}
        .value=${p.filter}
        @sf-change=${(e: CustomEvent<{ value: FilesFilter }>) => this.setPrefs({ filter: e.detail.value })}
      ></sf-segmented>
      ${withProject
        ? html`<sf-menu class="project-filter" label=${this.text(m.project)} @sf-select=${(e: CustomEvent<{ value: string }>) => this.onProjectFilter(e.detail.value)}>
            <sf-button slot="trigger" size="sm" variant="secondary">${this.text(m.project)}: ${projectLabel} ▾</sf-button>
            <sf-menu-item type="radio" value="any" ?checked=${pf.kind === 'any'}>${this.text(m.allProjects)}</sf-menu-item>
            <sf-menu-item type="radio" value="none" ?checked=${pf.kind === 'none'}>${this.text(m.noProject)}</sf-menu-item>
            ${projects.length > 0 ? html`<div role="separator"></div>` : nothing}
            ${projects.map((proj) => html`<sf-menu-item type="radio" value=${`p:${proj.name}`} ?checked=${pf.kind === 'project' && pf.name === proj.name}>${proj.name}</sf-menu-item>`)}
          </sf-menu>`
        : nothing}
      <sf-menu class="sort" label=${this.text(m.sort)} @sf-select=${(e: CustomEvent<{ value: FilesSort }>) => this.setPrefs({ sort: e.detail.value })}>
        <sf-button slot="trigger" size="sm" variant="secondary">${this.text(m.sort)}: ${this.text(m[SORT_LABELS[p.sort]])} ▾</sf-button>
        ${FILES_SORTS.map((s) => html`<sf-menu-item type="radio" value=${s} ?checked=${p.sort === s}>${this.text(m[SORT_LABELS[s]])}</sf-menu-item>`)}
      </sf-menu>
      <sf-segmented
        class="layout"
        label=${this.text(m.layout)}
        size="sm"
        .options=${FILES_LAYOUTS.map((l) => ({ value: l, label: this.text(m[LAYOUT_LABELS[l]]) }))}
        .value=${this.layout()}
        @sf-change=${(e: CustomEvent<{ value: FilesLayout }>) => this.setPrefs({ layout: e.detail.value, chosen: true })}
      ></sf-segmented>
      <sf-button class="push import" size="sm" variant="secondary" @click=${() => this.pickFiles()}><sf-icon .icon=${uploadIcon} size="16"></sf-icon> ${this.text(m.import)}</sf-button>
    </div>`;
  }

  private onProjectFilter(value: string): void {
    this.projectFilter = value === 'any' ? { kind: 'any' } : value === 'none' ? { kind: 'none' } : { kind: 'project', name: value.slice(2) };
  }

  /** The grid or list of Files and the project view (bulk-selectable). */
  private renderEntries(entries: readonly HomeEntry[]): TemplateResult {
    if (entries.length === 0) return this.query.trim() !== '' ? this.renderNoResults() : html`<p class="empty">${this.text(m.filesNothing)}</p>`;
    if (this.layout() === 'grid') return html`<ul class="grid" role="list" data-selectable-list @keydown=${(e: KeyboardEvent) => this.onListKey(e)}>${entries.map((e) => this.renderCard(e, true))}</ul>`;
    return html`<ul class="list" role="list" data-selectable-list ?data-selecting=${this.selection.size > 0} aria-label=${this.text(m.filesList)} @keydown=${(e: KeyboardEvent) => this.onListKey(e)}>
      ${this.pro
        ? html`<li class="row head">
            <span></span><span></span>${this.sortHeader('name', m.colTitle)}${this.sortHeader('kind', m.colKind)}<span>${this.text(m.colProject)}</span>${this.sortHeader('edited', m.colEdited)}<span
              >${this.text(m.colSize)}</span
            ><span>${this.text(m.colPages)}</span><span></span>
          </li>`
        : html`<li class="row head" aria-hidden="true">
            <span></span><span></span><span>${this.text(m.colTitle)}</span><span>${this.text(m.colKind)}</span><span>${this.text(m.colProject)}</span><span>${this.text(m.colEdited)}</span
            ><span>${this.text(m.colSize)}</span><span></span>
          </li>`}
      ${entries.map((e) => this.renderRow(e))}
    </ul>`;
  }

  /** Files' layout: the person's choice, else List in Pro and Grid otherwise (DENSITY §4). */
  private layout(): FilesLayout {
    return this.prefs.chosen === true ? this.prefs.layout : this.pro ? 'list' : this.prefs.layout;
  }

  /** A sortable column header (Pro): a button that sorts by it, `aria-sort` on the active one. */
  private sortHeader(sort: FilesSort, label: typeof m.colTitle | typeof m.colKind | typeof m.colEdited): TemplateResult {
    const active = this.prefs.sort === sort;
    return html`<span role="columnheader" aria-sort=${active ? 'descending' : 'none'}
      ><button type="button" class="sort-head" aria-pressed=${active ? 'true' : 'false'} @click=${() => this.setPrefs({ sort })}>${this.text(label)}</button></span
    >`;
  }

  private onListKey(e: KeyboardEvent): void {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      this.extendSelection('', 'all');
    }
  }

  private renderRow(entry: HomeEntry, selectable = true): TemplateResult {
    const href = this.deps.model.hrefOf(entry);
    const open = this.opener(entry);
    const tag = lensTag(lensOf(entry.lens));
    const selected = this.selection.has(entry.asset);
    const renaming = this.renaming === entry.asset;
    const when = relativeTime(entry.editedAt, this.now ?? Date.now(), this.locale());
    const size = entry.format === undefined ? '' : this.text(m.size, { width: entry.format.width, height: entry.format.height });
    const icon = KIND_ICONS[entry.kind];
    const preview = this.preview(entry);
    return html`<li
      class="row"
      data-asset=${entry.asset}
      ?data-selected=${selected}
      @keydown=${(e: KeyboardEvent) => this.onCardKey(e, entry, true)}
      @contextmenu=${(e: MouseEvent) => this.onContextMenu(e, entry)}
      @dblclick=${(e: MouseEvent) => this.onCardDoubleClick(e, entry)}
    >
      ${selectable ? html`<input class="check" type="checkbox" aria-label=${this.text(m.selectFile, { title: entry.title })} .checked=${selected} @click=${(e: MouseEvent) => this.onCheck(e, entry.asset)} />` : html`<span></span>`}
      <span class="mark" aria-hidden="true"
        >${preview !== undefined ? html`<img class="preview" alt="" src=${preview} />` : icon !== undefined ? html`<sf-icon .icon=${icon} size="16"></sf-icon>` : html`<span style=${lensMarkStyle(lensOf(entry.lens), 1.4)}></span>`}</span
      >
      ${renaming
        ? this.renameField(entry)
        : href === undefined || open === undefined
          ? html`<span class="name tile-title">${this.highlight(entry.title)}</span>`
          : html`<a class="tile-title" href=${href} draggable="true" @dragstart=${(e: DragEvent) => this.onCardDragStart(e, entry)} @click=${(e: MouseEvent) => this.onCardClick(e, entry, open, true)}>${this.highlight(entry.title)}</a>`}
      <sf-tag .color=${tag.color} .ink=${tag.ink}>${this.kindLabel(entry.kind)}</sf-tag>
      <span class="cell">${entry.folder ?? this.text(m.noProject)}</span>
      <span class="cell">${when}</span>
      <span class="cell mono">${size}</span>
      ${this.pro && selectable ? html`<span class="cell mono pages">${entry.pages ?? (entry.kind === 'composition' ? '1' : '')}</span>` : nothing}
      <sf-icon-button
        class="more"
        size="sm"
        variant="ghost"
        label=${this.text(m.moreFor, { title: entry.title })}
        @click=${(e: MouseEvent) => {
          e.stopPropagation();
          this.openMenu(entry, e.currentTarget as HTMLElement);
        }}
        ><sf-icon .icon=${ellipsisIcon} size="16"></sf-icon
      ></sf-icon-button>
    </li>`;
  }

  private renderFiles(view: Extract<HomeView, { kind: 'files' }>): TemplateResult {
    const model = this.deps.model;
    const listed = filesList(model.files(), this.prefs, this.projectFilter);
    const entries = this.searched(listed);
    void view;
    return html`<section aria-labelledby="files-title">
      <h1 class="page-title" id="files-title">${this.text(m.filesTitle)}</h1>
      ${this.renderFilesToolbar(true)} ${this.pro ? this.renderBulk() : nothing}
      ${this.query.trim() !== '' && entries.length > 0 ? html`<p class="muted" role="status">${this.text(m.searchResults, { count: entries.length, query: this.query.trim() })}</p>` : nothing}
      ${this.renderEntries(entries)}
    </section>`;
  }

  private renderProject(name: string): TemplateResult {
    const model = this.deps.model;
    const project = model.projects().find((p) => p.name === name);
    const entries = this.searched(filesList(model.files(), this.prefs, { kind: 'project', name }));
    const home = homeViewHref({ kind: 'home' });
    const confirmingDelete = this.confirming?.kind === 'delete-project' && this.confirming.name === name;
    return html`<section aria-labelledby="project-title">
      <div class="project-head">
        <sf-icon-button class="back" variant="ghost" label=${this.text(m.projectBack)} @click=${() => this.go({ kind: 'home' })}><sf-icon .icon=${chevronLeftIcon} size="18"></sf-icon></sf-icon-button>
        <h1 class="page-title" id="project-title">
          ${this.renamingProject
            ? html`<sf-inline-edit
                class="project-rename"
                editing
                trigger="none"
                label=${this.text(m.renameProject)}
                .value=${name}
                maxlength="60"
                @sf-change=${(e: CustomEvent<InlineEditChangeDetail>) => void this.renameProject(name, e.detail.value)}
                @sf-cancel=${() => (this.renamingProject = false)}
              ></sf-inline-edit>`
            : html`<button class="title-button" type="button" aria-label=${`${this.text(m.renameProject)}: ${name}`} @click=${() => this.startProjectRename()}>${name}</button>`}
        </h1>
        <span class="muted">${this.text(m.projectCount, { count: project?.count ?? 0 })}</span>
        <sf-menu class="project-menu" label=${this.text(m.projectMenu)} @sf-select=${(e: CustomEvent<{ value: string }>) => this.onProjectMenu(name, e.detail.value, project?.count ?? 0)}>
          <sf-icon-button slot="trigger" variant="ghost" label=${this.text(m.projectMenu)}><sf-icon .icon=${ellipsisIcon} size="18"></sf-icon></sf-icon-button>
          <sf-menu-item value="rename">${this.text(m.renameProject)}</sf-menu-item>
          <div role="separator"></div>
          <sf-menu-item value="delete">${this.text(m.deleteProject)}</sf-menu-item>
        </sf-menu>
      </div>
      ${confirmingDelete
        ? html`<sf-confirm-row
            message=${this.text(m.deleteProjectConfirm)}
            confirm-label=${this.text(m.deleteProjectAction)}
            cancel-label=${this.text(m.cancel)}
            tone="danger"
            @sf-confirm=${() => void this.deleteProject(name)}
            @sf-cancel=${() => (this.confirming = undefined)}
          ></sf-confirm-row>`
        : nothing}
      ${project === undefined && home.ok ? html`<p class="empty">${this.text(m.noResults, { query: name })}</p>` : nothing} ${this.renderFilesToolbar(false)}
      ${this.pro ? this.renderBulk() : nothing}
      ${entries.length === 0 && this.query.trim() === '' ? html`<p class="empty">${this.text(m.projectEmpty)}</p>` : this.renderEntries(entries)}
    </section>`;
  }

  private startProjectRename(): void {
    this.renamingProject = true;
    void this.updateComplete.then(() => this.renderRoot.querySelector<HTMLElement & { edit(): void }>('sf-inline-edit.project-rename')?.edit());
  }

  private onProjectMenu(name: string, value: string, count: number): void {
    if (value === 'rename') this.startProjectRename();
    else if (value === 'delete') {
      if (count > 0) this.confirming = { kind: 'delete-project', name };
      else void this.deleteProject(name);
    }
  }

  private async renameProject(name: string, to: string): Promise<void> {
    this.renamingProject = false;
    const model = this.deps.model;
    const done = await this.attempt(model.renameProject(name, to));
    if (done === undefined) return;
    const next = to.trim();
    model.go({ kind: 'project', name: next });
    const message = this.text(m.projectRenamed, { name: next });
    this.say(message);
    this.toast((t) => t.undoable({
      message,
      undo: () =>
        void model.renameProject(next, name).then((r) => {
          if (r.ok && model.view.kind === 'project' && model.view.name === next) model.go({ kind: 'project', name });
        }),
    }));
  }

  private async deleteProject(name: string): Promise<void> {
    const model = this.deps.model;
    const members = model.files().filter((e) => e.folder === name).map((e) => e.asset);
    const done = await this.attempt(model.deleteProject(name));
    if (done === undefined) return;
    this.confirming = undefined;
    model.go({ kind: 'home' });
    const message = this.text(m.projectDeleted, { name });
    this.say(message);
    this.toast((t) => t.undoable({
      message,
      undo: () =>
        void (async () => {
          await model.newProject(name);
          if (members.length > 0) await model.move(members, name);
        })(),
    }));
  }

  private renderTemplatesPage(): TemplateResult {
    const entries = this.searched(this.deps.model.templates());
    return html`<section aria-labelledby="templates-title">
      <h1 class="page-title" id="templates-title">${this.text(m.templatesTitle)}</h1>
      ${entries.length === 0 ? (this.query.trim() !== '' ? this.renderNoResults() : html`<p class="empty">${this.text(m.templatesEmpty)}</p>`) : html`<ul class="grid" role="list">${entries.map((e) => this.renderCard(e))}</ul>`}
    </section>`;
  }

  private renderTrash(): TemplateResult {
    const model = this.deps.model;
    const trashed = this.searched(model.trashed());
    const groups = trashByDay(trashed, this.locale());
    const emptying = this.confirming?.kind === 'empty-trash';
    return html`<section aria-labelledby="trash-title">
      <div class="section-head">
        <h1 class="page-title" id="trash-title">${this.text(m.trashTitle)}</h1>
        ${model.trashed().length > 0 && !emptying ? html`<sf-button class="push empty-trash" size="sm" variant="secondary" @click=${() => (this.confirming = { kind: 'empty-trash' })}>${this.text(m.emptyTrash)}</sf-button>` : nothing}
      </div>
      <p class="muted">${this.text(m.trashKept)}</p>
      ${emptying
        ? html`<sf-confirm-row
            message=${this.text(m.emptyTrashConfirm, { count: model.trashed().length })}
            confirm-label=${this.text(m.deleteAction)}
            cancel-label=${this.text(m.cancel)}
            tone="danger"
            @sf-confirm=${() => void this.deleteForever(model.trashed().map((e) => e.asset))}
            @sf-cancel=${() => (this.confirming = undefined)}
          ></sf-confirm-row>`
        : nothing}
      ${trashed.length === 0
        ? this.query.trim() !== '' && model.trashed().length > 0
          ? this.renderNoResults()
          : html`<p class="empty">${this.text(m.trashEmpty)}</p>`
        : groups.map(
            (g) => html`<div class="trash-day">
              <h3>${g.label}</h3>
              <ul class="list" role="list">
                ${g.entries.map((e) => this.renderTrashRow(e))}
              </ul>
            </div>`,
          )}
    </section>`;
  }

  private renderTrashRow(entry: HomeEntry): TemplateResult {
    const tag = lensTag(lensOf(entry.lens));
    const when = relativeTime(entry.trashedAt ?? entry.editedAt, this.now ?? Date.now(), this.locale());
    const confirming = this.confirming?.kind === 'delete' && this.confirming.asset === entry.asset;
    return html`<li class="row trash-row" data-asset=${entry.asset} @contextmenu=${(e: MouseEvent) => this.onContextMenu(e, entry)}>
      <span class="mark" aria-hidden="true"><span style=${lensMarkStyle(lensOf(entry.lens), 1.4)}></span></span>
      <span class="name">${this.highlight(entry.title)}</span>
      <sf-tag .color=${tag.color} .ink=${tag.ink}>${this.kindLabel(entry.kind)}</sf-tag>
      <span class="cell">${this.text(m.trashedWhen, { when })}</span>
      <span class="trash-actions">
        ${confirming
          ? html`<sf-confirm-row
              message=${this.text(m.deleteForeverConfirm)}
              confirm-label=${this.text(m.deleteAction)}
              cancel-label=${this.text(m.cancel)}
              tone="danger"
              @sf-confirm=${() => void this.deleteForever([entry.asset])}
              @sf-cancel=${() => (this.confirming = undefined)}
            ></sf-confirm-row>`
          : html`<sf-button size="sm" variant="secondary" class="restore" aria-label=${`${this.text(m.restore)} ${entry.title}`} @click=${() => void this.restore([entry.asset])}>${this.text(m.restore)}</sf-button>
              <sf-button size="sm" variant="ghost" class="delete-forever" aria-label=${`${this.text(m.deleteForever)} ${entry.title}`} @click=${() => (this.confirming = { kind: 'delete', asset: entry.asset })}
                >${this.text(m.deleteForever)}</sf-button
              >`}
      </span>
    </li>`;
  }

  private renderBulk(): TemplateResult {
    const count = this.selection.size;
    if (count === 0) return html``;
    const assets = [...this.selection];
    const projects = this.deps.model.projects();
    return html`<div class="bulk" role="toolbar" aria-label=${this.text(m.bulkActions)}>
      ${this.confirming?.kind === 'bulk-trash'
        ? html`<sf-confirm-row
            message=${this.text(m.bulkTrashConfirm, { count })}
            confirm-label=${this.text(m.confirmTrash)}
            cancel-label=${this.text(m.cancel)}
            tone="danger"
            @sf-confirm=${() => void this.trash(assets, true)}
            @sf-cancel=${() => (this.confirming = undefined)}
          ></sf-confirm-row>`
        : html`<span role="status">${this.text(m.selected, { count })}</span>
            <sf-menu class="bulk-move" label=${this.text(m.menuMove)} side="top" @sf-select=${(e: CustomEvent<{ value: string }>) => (e.detail.value === 'move-new' ? this.newProjectFor(assets) : void this.move(assets, e.detail.value.slice('move:'.length)))}>
              <sf-button slot="trigger" size="sm" variant="secondary">${this.text(m.menuMove)} ▾</sf-button>
              ${projects.map((p) => html`<sf-menu-item value=${`move:${p.name}`}>${p.name}</sf-menu-item>`)} ${projects.length > 0 ? html`<div role="separator"></div>` : nothing}
              <sf-menu-item value="move-new">${this.text(m.newProjectEllipsis)}</sf-menu-item>
              <sf-menu-item value="move:">${this.text(m.noProject)}</sf-menu-item>
            </sf-menu>
            <sf-button size="sm" variant="secondary" class="bulk-duplicate" @click=${() => void this.duplicate(assets)}>${this.text(m.bulkDuplicate)}</sf-button>
            <sf-button size="sm" variant="secondary" class="bulk-trash" @click=${() => void this.trash(assets)}>${this.text(m.bulkTrash)}</sf-button>
            <sf-icon-button size="sm" variant="ghost" class="bulk-clear" label=${this.text(m.bulkClear)} @click=${() => (this.selection = new Set())}><sf-icon .icon=${xIcon} size="16"></sf-icon></sf-icon-button>`}
    </div>`;
  }

  private renderFooter(): TemplateResult {
    const usage = this.facts?.usage;
    const href = homeViewHref({ kind: 'settings', section: 'storage' });
    return html`<footer class="foot">
      ${usage === undefined ? nothing : html`<span class="storage">${this.text(m.storageUsed, { size: formatBytes(usage, this.locale()) })}</span> · `}<a
        class="settings-footer"
        href=${href.ok ? href.value : nothing}
        @click=${(e: MouseEvent) => this.go({ kind: 'settings', section: 'storage' }, e)}
        >${this.text(m.settings)}</a
      >
    </footer>`;
  }

  // ---------------------------------------------------------------- Settings (STUDIO §2.4, a page in Home's shell)

  private renderSettings(section: SettingsSection): TemplateResult {
    const model = this.deps.model;
    const studio = readShortcutsSnapshot(globalThis.localStorage);
    const fonts = model.files().filter((e) => e.kind === 'font').map((e) => e.title);
    return html`<section class="settings-page" aria-labelledby="settings-title">
      <h1 class="page-title" id="settings-title">${this.text(m.settings)}</h1>
      <if-settings
        section=${section}
        .settings=${this.settings}
        .storage=${this.port}
        .shortcuts=${[...studio, { heading: this.text(m.homeShortcuts), rows: HOME_SHORTCUTS }]}
        .userFonts=${fonts}
        .diagnostics=${() => diagnosticsText({ surface: 'Home', density: this.settings?.current.density ?? 'standard', extra: { Files: String(model.files().length), Trash: String(model.trashed().length) } })}
        @if-section=${(e: CustomEvent<{ section: SettingsSection }>) => model.go({ kind: 'settings', section: e.detail.section }, { replace: true })}
        @if-reset-hints=${() => {
          resetHintsOnDevice(globalThis.localStorage, HINT_STORAGE_PREFIXES);
          this.welcome = 'card';
        }}
        @if-open-trash=${() => this.go({ kind: 'trash' })}
        @click=${() => this.requestUpdate()}
      ></if-settings>
    </section>`;
  }

  // ---------------------------------------------------------------- New design

  /** The New design dialog (HOME-FILES §1.3): on the remembered choice, or a format; Custom size… focuses W. */
  async openNewDesign(format?: DesignFormatId | typeof CUSTOM_FORMAT, focus?: 'width'): Promise<void> {
    await this.updateComplete;
    await this.renderRoot.querySelector<IfNewDesignElement>('if-new-design')?.show({ ...(format === undefined ? {} : { format }), ...(focus === undefined ? {} : { focus }) });
  }

  private onFormatMenu(value: string): void {
    if (value === CUSTOM_FORMAT) void this.openNewDesign(CUSTOM_FORMAT, 'width');
    else if ((NEW_DESIGN_CHIPS as readonly string[]).includes(value)) void this.run(() => this.deps.model.newDesign(value as DesignFormatId), DESIGN_FORMATS[value as DesignFormatId].title);
  }

  private onCreate(detail: NewDesignCreateDetail): Promise<void> {
    const model = this.deps.model;
    return detail.kind === 'template' ? this.run(() => model.useTemplate(detail.template, detail.name), detail.name) : this.run(() => model.newDesign(detail.input), detail.input.name ?? this.text(m.newDesign));
  }

  // ---------------------------------------------------------------- search, keys, import

  private onSearchKey(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      const query = this.query.trim();
      this.go({ kind: 'files', ...(query === '' ? {} : { query }), ...this.filesView() });
    } else if (e.key === 'Escape' && this.query !== '') {
      e.stopPropagation();
      this.query = '';
    }
  }

  private typing(e: KeyboardEvent): boolean {
    const path = e.composedPath() as Element[];
    return path.some((n) => n.localName === 'input' || n.localName === 'textarea' || (n as HTMLElement).isContentEditable === true || n.localName === 'sf-text-field' || n.localName === 'sf-inline-edit');
  }

  private onGlobalKey(e: KeyboardEvent): void {
    if (e.defaultPrevented || this.renderRoot.querySelector<IfNewDesignElement>('if-new-design')?.open === true) return;
    const mod = e.metaKey || e.ctrlKey;
    if (!this.typing(e) && e.key === '/' && !mod) {
      e.preventDefault();
      this.renderRoot.querySelector<HTMLElement>('sf-text-field.search')?.focus();
    } else if (mod && !e.shiftKey && e.key.toLowerCase() === 'i') {
      e.preventDefault();
      this.pickFiles();
    } else if (mod && !e.shiftKey && e.key.toLowerCase() === 'z' && !this.typing(e)) {
      // Home has no document undo: Mod+Z runs the newest toast's Undo (OVERLAYS-FEEDBACK §3.5).
      if (this.toasts?.undoNewest() === true) e.preventDefault();
    } else if (e.key === 'Escape' && this.selection.size > 0 && !this.typing(e)) {
      this.selection = new Set();
    }
  }

  pickFiles(): void {
    this.renderRoot.querySelector<HTMLInputElement>('input.picker')?.click();
  }

  private async onPicked(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = '';
    await this.importFiles(files);
  }

  private onPaste(e: ClipboardEvent): void {
    if (this.typing(e as unknown as KeyboardEvent)) return;
    const files = [...(e.clipboardData?.files ?? [])];
    if (files.length === 0) return;
    e.preventDefault();
    void this.importFiles(files);
  }

  private dragsFiles(e: DragEvent): boolean {
    return [...(e.dataTransfer?.types ?? [])].includes('Files');
  }

  private onDragOver(e: DragEvent): void {
    if (!this.dragsFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer !== null) e.dataTransfer.dropEffect = 'copy';
    this.dropping = true;
  }

  private onDragLeave(e: DragEvent): void {
    if (e.relatedTarget === null || !(e.currentTarget as Element).contains(e.relatedTarget as Node)) this.dropping = false;
  }

  private async onDrop(e: DragEvent): Promise<void> {
    if (!this.dragsFiles(e)) return;
    e.preventDefault();
    this.dropping = false;
    const view = this.deps.model.view;
    await this.importFiles([...(e.dataTransfer?.files ?? [])], view.kind === 'project' ? view.name : undefined);
  }

  /** Import files (HOME-FILES §3.1); `project` defaults to the project on screen. */
  async importFiles(files: readonly File[], project?: string): Promise<ImportSummary | undefined> {
    if (files.length === 0) return undefined;
    const view = this.deps.model.view;
    const into = project ?? (view.kind === 'project' ? view.name : undefined);
    const controller = new AbortController();
    // The inline progress row shows for several files (HOME-FILES §3.1); Cancel stops the rest, what is stored stays.
    const onProgress = (n: number, total: number): void => {
      this.importing = total > 1 && n < total ? { done: n, total, controller } : undefined;
    };
    const done = await this.attempt(this.deps.model.importFiles(files, { ...(into === undefined ? {} : { project: into }), signal: controller.signal, onProgress }));
    this.importing = undefined;
    if (done === undefined) return undefined;
    this.reportImport(done.value);
    return done.value;
  }

  private reportImport(done: ImportSummary): void {
    const model = this.deps.model;
    const imported = done.imported;
    if (imported.length > 0) {
      const message = this.text(m.imported, { count: imported.length, title: imported[0]?.title ?? '' });
      this.say(message);
      this.toast((t) => t.undoable({ message, undo: () => void model.trash(imported.map((e) => e.asset)) }));
    }
    if (done.existing.length > 0) {
      const message = this.text(m.importedExisting, { count: done.existing.length, title: done.existing[0]?.title ?? '' });
      this.say(message);
      this.toast((t) => t.show({ message }));
    }
    const unsupported = done.skipped.filter((s) => s.reason !== 'failed');
    if (unsupported.length === 1 || (unsupported.length > 1 && imported.length === 0)) {
      const s = unsupported[0] as (typeof unsupported)[number];
      const message = this.text(s.reason === 'video' ? m.importVideo : m.importUnsupported, { name: s.name });
      this.say(message);
      this.toast((t) => t.show({ message, tone: 'warning' }));
    } else if (unsupported.length > 1) {
      const message = this.text(m.importSkipped, { count: unsupported.length });
      this.say(message);
      this.toast((t) => t.show({ message, tone: 'warning' }));
    }
    for (const failed of done.skipped.filter((s) => s.reason === 'failed')) {
      const message = this.text(m.importFailed, { name: failed.name, message: failed.error?.message ?? '' });
      this.say(message);
      if (failed.error?.kind === 'quota') this.full = true;
      this.toast((t) => t.show({ message, tone: 'danger' }));
    }
  }

  // ---------------------------------------------------------------- drag cards onto a project

  private onCardDragStart(e: DragEvent, entry: HomeEntry): void {
    if (e.dataTransfer === null || entry.trashedAt !== undefined) return;
    e.dataTransfer.setData(ASSETS_DRAG_TYPE, JSON.stringify(this.targets(entry)));
    e.dataTransfer.effectAllowed = 'copyMove';
  }

  private onProjectDragOver(e: DragEvent, name: string): void {
    if (![...(e.dataTransfer?.types ?? [])].includes(ASSETS_DRAG_TYPE)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer !== null) e.dataTransfer.dropEffect = 'move';
    this.dropProject = name;
  }

  private async onProjectDrop(e: DragEvent, name: string): Promise<void> {
    const raw = e.dataTransfer?.getData(ASSETS_DRAG_TYPE);
    this.dropProject = undefined;
    if (raw === undefined || raw === '') return;
    e.preventDefault();
    e.stopPropagation();
    let assets: unknown;
    try {
      assets = JSON.parse(raw);
    } catch {
      return;
    }
    if (Array.isArray(assets) && assets.every((a) => typeof a === 'string')) await this.move(assets as string[], name);
  }
}

/** Define `<if-home>` and the kit components it renders. */
export function defineHome(registry: CustomElementRegistry = customElements): void {
  defineButton(registry);
  defineCard(registry);
  defineTag(registry);
  defineIconElement(registry);
  defineIconButton(registry);
  defineMenu(registry);
  defineInlineEdit(registry);
  defineConfirmRow(registry);
  defineFeedback(registry);
  definePopover(registry);
  defineSegmented(registry);
  defineTextField(registry);
  defineNewDesign(registry);
  defineSettings(registry);
  if (registry.get(homeSpec.tag) === undefined) defineComponent(IfHomeElement, registry);
}

declare global {
  interface HTMLElementTagNameMap {
    'if-home': IfHomeElement;
  }
}
