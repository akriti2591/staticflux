/**
 * `<if-pages-panel>` — the Pages panel (dock tab "Pages"; the filmstrip of the Pages lens, UX §4): the
 * story in order, built only from kit components under Clean Pop. Selecting a page shows it through the
 * lens controller (the camera follows: page view in Pages, centred in Canvas); reordering moves the page
 * in the story (one undoable commit). Every row carries the Layout lens mark (pages are layout).
 *
 * Keyboard: ↑/↓/Home/End/type-ahead move through pages and show each; Enter shows the focused page;
 * **Alt+↑/↓ moves the page** in the story (the tree's keyboard reorder); the toolbar (←/→) has Previous,
 * Next and Fit all. Studio-wide PageUp / PageDown do the same from the canvas (`bindLensShortcuts`).
 */
import { I18nToken, type MessageArgs, type MessageRef } from '@staticflux/i18n';
import { defineButton } from '@staticflux/kit/button';
import { defineToolbar } from '@staticflux/kit/toolbar';
import { defineTree, type DropPosition, type ReorderDetail, type TreeNode } from '@staticflux/kit/tree';
import { component, defineComponent, SfElement } from '@staticflux/ui';
import { themeTokens as t } from '@staticflux/ui/theme';
import type { NodeId } from '@staticflux/document/v2';
import { css, html, type TemplateResult } from 'lit';
import { lensMarkStyle, lensOf } from '../theme/lenses.js';
import type { PageFrame } from './lens-feature.js';
import { lensMessages as m, lensText } from './messages.js';
import { LensControllerToken, StoryWriterToken } from './tokens.js';

export const PAGES_PANEL_TAG = 'if-pages-panel';

const panelSpec = component({
  tag: PAGES_PANEL_TAG,
  deps: { render: { controller: LensControllerToken, story: StoryWriterToken }, lazy: { i18n: I18nToken } },
  description: 'Pages panel: the story in order; show a page, reorder pages, previous / next / fit all.',
});

/** Frames in story order (the panel lists the story whatever the lens's navigation order; pure). */
export function storyFrames(frames: readonly PageFrame[]): PageFrame[] {
  return [...frames].sort((a, b) => a.index - b.index);
}

/** Tree rows for the story (pure). `nameOf` names unnamed pages ("Page 3"). */
export function pageNodes(frames: readonly PageFrame[], nameOf: (frame: PageFrame) => string): TreeNode[] {
  return storyFrames(frames).map((frame) => ({
    id: frame.page,
    label: nameOf(frame),
    icon: html`<span aria-hidden="true" style=${lensMarkStyle(lensOf('layout'))}></span>`,
    badge: `${Math.round(frame.rect.w)}×${Math.round(frame.rect.h)}`,
  }));
}

/** The story index a reorder drop asks for (pure): the position in the list without the moved page. */
export function reorderTarget(order: readonly NodeId[], detail: ReorderDetail): number | undefined {
  if (detail.position === 'inside' || detail.id === detail.targetId) return undefined;
  const without = order.filter((id) => id !== detail.id);
  const at = without.indexOf(detail.targetId);
  if (at < 0) return undefined;
  return detail.position === 'before' ? at : at + 1;
}

const noInside = (_source: TreeNode, _target: TreeNode, position: DropPosition): boolean => position !== 'inside';

export class IfPagesPanelElement extends SfElement<typeof panelSpec> {
  static override readonly spec = panelSpec;
  static override properties = { announcement: { state: true } };
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
    .list {
      block-size: 240px;
    }
    .empty {
      margin: 0;
      color: ${t.color.textMuted.css};
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

  declare announcement: string;

  constructor() {
    super();
    this.announcement = '';
  }

  private text<P>(ref: MessageRef<P>, ...args: MessageArgs<P>): string {
    return lensText(this.deps.i18n, ref, ...args);
  }

  private nameOf(frame: PageFrame): string {
    return frame.name ?? this.text(m.pageName, { number: frame.index + 1 });
  }

  private announce(frame: PageFrame | undefined): void {
    const count = this.deps.controller.arrangement()?.frames.length ?? 0;
    if (frame !== undefined) this.announcement = this.text(m.showing, { number: frame.index + 1, count, name: this.nameOf(frame) });
  }

  private show(page: NodeId): void {
    const shown = this.deps.controller.goTo(page);
    if (shown.ok) this.announce(shown.value);
    else this.announcement = shown.error.message;
  }

  private step(delta: number): void {
    const shown = this.deps.controller.step(delta);
    if (shown.ok) this.announce(shown.value);
    else this.announcement = shown.error.message;
  }

  private reorder(e: CustomEvent<ReorderDetail>): void {
    const frames = storyFrames(this.deps.controller.arrangement()?.frames ?? []);
    const to = reorderTarget(
      frames.map((f) => f.page),
      e.detail,
    );
    if (to === undefined) return;
    const moved = this.deps.story.movePage(e.detail.id, to);
    const frame = frames.find((f) => f.page === e.detail.id);
    this.announcement = moved.ok ? this.text(m.moved, { name: frame === undefined ? e.detail.id : this.nameOf(frame), number: to + 1 }) : moved.error.message;
  }

  override render(): TemplateResult {
    const { controller } = this.deps;
    const arrangement = controller.arrangement();
    const frames = arrangement?.frames ?? [];
    const current = controller.current();
    const body =
      arrangement === undefined
        ? html`<p class="empty">${this.text(m.noComposition)}</p>`
        : frames.length === 0
          ? html`<p class="empty">${this.text(m.empty)}</p>`
          : html`<sf-tree
              class="list"
              label=${this.text(m.listLabel)}
              .nodes=${pageNodes(frames, (f) => this.nameOf(f))}
              .selected=${new Set(current === undefined ? [] : [current])}
              .canDrop=${noInside}
              @sf-select=${(e: CustomEvent<{ ids: readonly string[] }>) => {
                const page = e.detail.ids[0];
                if (page !== undefined && page !== controller.current()) this.show(page);
              }}
              @sf-activate=${(e: CustomEvent<{ id: string }>) => this.show(e.detail.id)}
              @sf-reorder=${(e: CustomEvent<ReorderDetail>) => this.reorder(e)}
            ></sf-tree>`;
    return html`<section class="panel" aria-labelledby="pages-title">
      <h2 class="title" id="pages-title">${this.text(m.panelTitle)}</h2>
      ${body}
      <sf-toolbar label=${this.text(m.actions)}>
        <sf-button class="previous" variant="secondary" size="sm" ?disabled=${frames.length === 0} @click=${() => this.step(-1)}>${this.text(m.previous)}</sf-button>
        <sf-button class="next" variant="secondary" size="sm" ?disabled=${frames.length === 0} @click=${() => this.step(1)}>${this.text(m.next)}</sf-button>
        <sf-button class="overview" variant="ghost" size="sm" ?disabled=${arrangement === undefined} @click=${() => void controller.overview()}>${this.text(m.overview)}</sf-button>
      </sf-toolbar>
      <p class="sr-only" role="status" aria-live="polite">${this.announcement}</p>
    </section>`;
  }
}

export function definePagesPanel(registry: CustomElementRegistry = customElements): void {
  defineButton(registry);
  defineToolbar(registry);
  defineTree(registry);
  if (registry.get(PAGES_PANEL_TAG) === undefined) defineComponent(IfPagesPanelElement, registry);
}
