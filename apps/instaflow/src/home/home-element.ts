/**
 * `<if-home>` — the Home surface (D17; C0 IF-28.17–28.22; design `docs/instaflow/design/HomeCP.dc.html`), built only
 * from kit components under Clean Pop: the top bar (logo, "New design", the one primary action), the hero, Quick
 * actions (D18 capability cards), "Jump back in" (recent designs), Templates and Files. Lens colour and shape mark each
 * card's kind (the typed lens palette). No engine, no GPU, no CRDT: everything here reads `HomeModel`.
 *
 * Every card is a real link (so middle click and "open in new tab" work), and a plain click or Enter runs the card's
 * capability instead (the same pipeline agents call), which resolves the same href and navigates.
 *
 * Keyboard: Tab walks the top bar, then each section's cards in reading order (one stop per card); Enter opens.
 * "Try again" is the keyboard path out of a failed read. Results and problems go to a polite live region.
 */
import type { Result, SfError } from '@staticflux/core';
import { I18nToken, type MessageArgs, type MessageRef } from '@staticflux/i18n';
import { defineButton } from '@staticflux/kit/button';
import { defineCard } from '@staticflux/kit/card';
import { defineTag } from '@staticflux/kit/tag';
import { component, defineComponent, SfElement } from '@staticflux/ui';
import { themeTokens as t } from '@staticflux/ui/theme';
import { css, html, nothing, type TemplateResult } from 'lit';
import type { LibraryAssetKind } from '../library/kinds.js';
import { lensMarkStyle, lensOf, lenses, lensTag } from '../theme/lenses.js';
import type { HomeActionOutput, HomeQuickAction } from './capabilities.js';
import { aspectOf } from './formats.js';
import type { HomeEntry } from './index-record.js';
import { homeMessages as m, homeText, relativeTime } from './messages.js';
import { homeHref, newDesignHref } from './routes.js';
import { HomeModelToken } from './tokens.js';

export const HOME_TAG = 'if-home';

const homeSpec = component({
  tag: HOME_TAG,
  deps: { render: { model: HomeModelToken }, lazy: { i18n: I18nToken } },
  description: 'Home: new design, quick actions, recent designs, templates and files of the workspace (no engine).',
});

/** Kind → label (data; everything that is not a design or a template is media in M1). */
const KIND_LABELS: Readonly<Partial<Record<LibraryAssetKind, 'kindComposition' | 'kindTemplate'>>> = { composition: 'kindComposition', template: 'kindTemplate' };

/** A plain activation (no modifier, primary button): Home runs the capability; anything else is the browser's. */
export function isPlainActivation(e: MouseEvent): boolean {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

export class IfHomeElement extends SfElement<typeof homeSpec> {
  static override readonly spec = homeSpec;
  static override properties = {
    announcement: { state: true },
    now: { attribute: false },
  };
  static override styles = css`
    :host {
      display: block;
      min-block-size: 100%;
      background: ${t.color.canvas.css};
      color: ${t.color.text.css};
      font-family: ${t.font.family.css};
      font-size: ${t.type.sizeMd.css};
      line-height: ${t.type.lineNormal.css};
    }
    .top {
      display: flex;
      align-items: center;
      gap: ${t.space.lg.css};
      flex-wrap: wrap;
      min-block-size: 64px;
      padding-inline: 28px;
      box-sizing: border-box;
    }
    .brand {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      color: ${t.color.text.css};
      text-decoration: none;
      border-radius: ${t.radius.md.css};
      font-family: ${t.font.familyDisplay.css};
      font-weight: ${t.font.weightDisplay.css};
      font-size: 21px;
      letter-spacing: -0.02em;
    }
    .brand:focus-visible {
      outline: 2px solid ${t.color.focusRing.css};
      outline-offset: 2px;
    }
    .top sf-button {
      margin-inline-start: auto;
    }
    main {
      display: flex;
      flex-direction: column;
      gap: 44px;
      max-inline-size: 1180px;
      margin-inline: auto;
      padding: 40px 28px 64px;
      box-sizing: border-box;
    }
    .hero {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 20px;
      text-align: center;
    }
    h1 {
      margin: 0;
      max-inline-size: 900px;
      font-family: ${t.font.familyDisplay.css};
      font-weight: ${t.font.weightDisplay.css};
      font-size: clamp(40px, 6vw, 72px);
      line-height: 1;
      letter-spacing: -0.035em;
    }
    .bold {
      padding-inline: 10px;
      border-radius: 14px;
      background: var(--if-home-bold, transparent);
      color: var(--if-home-bold-ink, inherit);
    }
    .lead {
      margin: 0;
      max-inline-size: 560px;
      color: ${t.color.textMuted.css};
      font-size: ${t.type.sizeLg.css};
    }
    section {
      display: flex;
      flex-direction: column;
      gap: ${t.space.lg.css};
    }
    h2 {
      margin: 0;
      font-family: ${t.font.familyDisplay.css};
      font-weight: ${t.font.weightDisplay.css};
      font-size: 24px;
      letter-spacing: -0.01em;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(min(220px, 100%), 1fr));
      gap: 14px;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .grid > li {
      display: contents;
    }
    .quick sf-card {
      min-block-size: 136px;
    }
    .card-title {
      font-family: ${t.font.familyDisplay.css};
      font-weight: 700;
      font-size: 17px;
      letter-spacing: -0.01em;
    }
    .muted {
      color: ${t.color.textMuted.css};
      font-size: ${t.type.sizeSm.css};
    }
    .tile {
      --kit-card-padding: 0;
      --kit-card-gap: 10px;
    }
    .tile::part(card) {
      border: 0;
      background: transparent;
    }
    .thumb {
      position: relative;
      display: grid;
      place-items: center;
      align-self: stretch;
      block-size: 158px;
      border-radius: ${t.radius.lg.css};
      background: ${t.color.neutral3.css};
      overflow: hidden;
    }
    .page {
      max-block-size: 118px;
      max-inline-size: 70%;
      block-size: 118px;
      border-radius: ${t.radius.sm.css};
      background: ${t.color.surface1.css};
      box-shadow: ${t.shadow.level1.css};
    }
    .thumb sf-tag {
      position: absolute;
      inset-block-start: 10px;
      inset-inline-start: 10px;
    }
    .tile-text {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding-inline: 2px;
    }
    .tile-title {
      font-weight: ${t.font.weightSemibold.css};
    }
    .files {
      display: flex;
      flex-direction: column;
      margin: 0;
      padding: 0;
      list-style: none;
      border: 1px solid ${t.color.border.css};
      border-radius: ${t.radius.lg.css};
      background: ${t.color.surface2.css};
      overflow: hidden;
    }
    .file {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto auto;
      align-items: center;
      gap: ${t.space.md.css};
      min-block-size: 52px;
      padding-inline: ${t.space.lg.css};
    }
    .file + .file {
      border-block-start: 1px solid ${t.color.border.css};
    }
    .file a {
      color: ${t.color.text.css};
      font-weight: ${t.font.weightMedium.css};
      text-decoration: none;
      border-radius: ${t.radius.sm.css};
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .file a:hover {
      text-decoration: underline;
    }
    .file a:focus-visible {
      outline: 2px solid ${t.color.focusRing.css};
      outline-offset: 2px;
    }
    .file .name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .empty {
      margin: 0;
      color: ${t.color.textMuted.css};
    }
    .problem {
      display: flex;
      align-items: center;
      gap: ${t.space.md.css};
      flex-wrap: wrap;
    }
    .sr-only {
      position: absolute;
      inline-size: 1px;
      block-size: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }
    @media (forced-colors: active) {
      .thumb,
      .files {
        border: 1px solid CanvasText;
      }
    }
  `;

  declare announcement: string;
  /** The clock for "Edited …" (tests pin it; defaults to the time of each render). */
  declare now: number | undefined;

  constructor() {
    super();
    this.announcement = '';
    this.now = undefined;
  }

  private text<P>(ref: MessageRef<P>, ...args: MessageArgs<P>): string {
    return homeText(this.deps.i18n, ref, ...args);
  }

  /** Run one of Home's actions; a failure is spoken (navigation is the success path). */
  private async run(action: () => Promise<Result<HomeActionOutput>>, title: string): Promise<void> {
    this.announcement = this.text(m.opening, { title });
    const done = await action();
    if (!done.ok) this.announcement = (done.error as SfError).message;
  }

  /** A card's click: plain activations run the capability; modified ones keep the link's browser behaviour. */
  private activate(e: MouseEvent, action: () => Promise<Result<HomeActionOutput>>, title: string): void {
    if (!isPlainActivation(e)) return;
    e.preventDefault();
    void this.run(action, title);
  }

  override render(): TemplateResult {
    const model = this.deps.model;
    const [layout] = lenses();
    const state = model.state;
    const home = homeHref();
    return html`<header class="top">
        <a class="brand" href=${home.ok ? home.value : nothing} aria-current="page" aria-label=${this.text(m.home)}>${logo()}<span aria-hidden="true">instaflow</span></a>
        <sf-button variant="primary" @click=${() => void this.run(() => model.newDesign(), this.text(m.newDesign))}>＋ ${this.text(m.newDesign)}</sf-button>
      </header>
      <main aria-busy=${state === 'loading' ? 'true' : 'false'}>
        <section class="hero" aria-labelledby="hero">
          <h1 id="hero" style=${`--if-home-bold:${layout?.color ?? 'transparent'};--if-home-bold-ink:${layout?.onColor ?? 'inherit'}`}>
            ${this.text(m.heroBefore)} <span class="bold">${this.text(m.heroBold)}</span> ${this.text(m.heroAfter)}
          </h1>
          <p class="lead">${this.text(m.heroLead)}</p>
        </section>
        ${state === 'failed' ? this.renderProblem() : nothing}
        ${this.renderQuick(model.quickActions)}
        ${this.renderRecents(model.recents())}
        ${this.renderTemplates(model.templates())}
        ${this.renderFiles(model.files())}
        ${state === 'loading' ? html`<p class="empty" role="status">${this.text(m.loading)}</p>` : nothing}
      </main>
      <div class="sr-only" role="status" aria-live="polite">${this.announcement}</div>`;
  }

  private renderProblem(): TemplateResult {
    return html`<div class="problem" role="alert">
      <span>${this.text(m.failed, { message: this.deps.model.error?.message ?? '' })}</span>
      <sf-button @click=${() => void this.deps.model.refresh()}>${this.text(m.retry)}</sf-button>
    </div>`;
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

  private renderTile(entry: HomeEntry, meta: string, action: () => Promise<Result<HomeActionOutput>>): TemplateResult {
    const lens = lensOf(entry.lens);
    const tag = lensTag(lens);
    const href = this.deps.model.hrefOf(entry);
    return html`<li>
      <sf-card class="tile" data-asset=${entry.asset} href=${href ?? nothing} @click=${(e: MouseEvent) => this.activate(e, action, entry.title)}>
        <span class="thumb" aria-hidden="true">
          <span class="page" style=${`aspect-ratio:${aspectOf(entry.format)}`}></span>
          <sf-tag .color=${tag.color} .ink=${tag.ink}>${this.kindLabel(entry.kind)}</sf-tag>
        </span>
        <span class="tile-text">
          <span class="tile-title">${entry.title}</span>
          <span class="muted">${meta}</span>
        </span>
      </sf-card>
    </li>`;
  }

  private kindLabel(kind: LibraryAssetKind): string {
    return this.text(m[KIND_LABELS[kind] ?? 'kindMedia']);
  }

  private edited(entry: HomeEntry): string {
    const when = relativeTime(entry.editedAt, this.now ?? Date.now(), this.ownerDocument.documentElement.lang || undefined);
    const size = entry.format === undefined ? '' : ` · ${this.text(m.size, { width: entry.format.width, height: entry.format.height })}`;
    return `${this.text(m.edited, { when })}${size}`;
  }

  private renderRecents(entries: readonly HomeEntry[]): TemplateResult {
    const model = this.deps.model;
    return html`<section aria-labelledby="recent">
      <h2 id="recent">${this.text(m.recents)}</h2>
      ${entries.length === 0
        ? html`<p class="empty">${this.text(m.recentsEmpty)}</p>`
        : html`<ul class="grid" role="list">
            ${entries.map((entry) => this.renderTile(entry, this.edited(entry), () => model.open(entry.asset)))}
          </ul>`}
    </section>`;
  }

  private renderTemplates(entries: readonly HomeEntry[]): TemplateResult {
    const model = this.deps.model;
    return html`<section aria-labelledby="templates">
      <h2 id="templates">${this.text(m.templates)}</h2>
      ${entries.length === 0
        ? html`<p class="empty">${this.text(m.templatesEmpty)}</p>`
        : html`<ul class="grid" role="list">
            ${entries.map((entry) => this.renderTile(entry, this.text(m.templateMeta), () => model.useTemplate(entry.asset)))}
          </ul>`}
    </section>`;
  }

  private renderFiles(entries: readonly HomeEntry[]): TemplateResult {
    const model = this.deps.model;
    const ACTIONS: Readonly<Partial<Record<LibraryAssetKind, (asset: string) => Promise<Result<HomeActionOutput>>>>> = {
      composition: (asset) => model.open(asset),
      template: (asset) => model.useTemplate(asset),
    };
    return html`<section aria-labelledby="files">
      <h2 id="files">${this.text(m.files)}</h2>
      ${entries.length === 0
        ? html`<p class="empty">${this.text(m.filesEmpty)}</p>`
        : html`<ul class="files" role="list" aria-label=${this.text(m.filesList)}>
            ${entries.map((entry) => {
              const href = model.hrefOf(entry);
              const run = ACTIONS[entry.kind];
              const lens = lensOf(entry.lens);
              const tag = lensTag(lens);
              return html`<li class="file" data-asset=${entry.asset}>
                <span aria-hidden="true" style=${lensMarkStyle(lens, 1.4)}></span>
                ${href === undefined || run === undefined
                  ? html`<span class="name">${entry.title}</span>`
                  : html`<a href=${href} @click=${(e: MouseEvent) => this.activate(e, () => run(entry.asset), entry.title)}>${entry.title}</a>`}
                <sf-tag .color=${tag.color} .ink=${tag.ink}>${this.kindLabel(entry.kind)}</sf-tag>
                <span class="muted">${this.edited(entry)}</span>
              </li>`;
            })}
          </ul>`}
    </section>`;
  }
}

/** The logo: the four lens marks (decorative; the link is named). */
function logo(): TemplateResult {
  const [layout, pixel, video, flow] = lenses();
  return html`<svg width="28" height="28" viewBox="0 0 32 32" aria-hidden="true">
    <rect x="2" y="2" width="13" height="13" rx="4" fill=${layout?.color ?? 'currentColor'}></rect>
    <circle cx="23.5" cy="8.5" r="6.5" fill=${pixel?.color ?? 'currentColor'}></circle>
    <rect x="2" y="19" width="13" height="9" rx="3" fill=${video?.color ?? 'currentColor'}></rect>
    <rect x="17" y="17" width="13" height="13" rx="6.5" fill=${flow?.color ?? 'currentColor'}></rect>
  </svg>`;
}

/** Define `<if-home>` and the kit components it renders. */
export function defineHome(registry: CustomElementRegistry = customElements): void {
  defineButton(registry);
  defineCard(registry);
  defineTag(registry);
  if (registry.get(homeSpec.tag) === undefined) defineComponent(IfHomeElement, registry);
}

declare global {
  interface HTMLElementTagNameMap {
    'if-home': IfHomeElement;
  }
}
