/**
 * `<if-layers-panel>` — Layers, a real list (B11b, STUDIO-UX-SPEC §3.1): the open page as a collapsible group, its
 * elements top-most first (paint order reversed, Figma), frames and groups nested, each row with its kind icon, name,
 * a mono tag (a repeat's count) and the hover-revealed Hide and Lock toggles (kept visible while on). Built on the kit
 * tree (APG tree view: virtualised, keyboard, drag reorder hooks, inline rename).
 *
 * - Selection syncs both ways: the canvas selection highlights and scrolls to its rows; selecting rows selects on the
 *   canvas (Shift+click a range, Mod+click toggles). Hovering a row outlines the element on the canvas, hovering the canvas
 *   outlines the row.
 * - Rename: double-click or Enter on a row (F2 too) → an inline field; one step `Rename`.
 * - Reorder: drag a row (before / after / into a frame or group) or `Alt+↑ / ↓`; one step `Reorder`.
 * - Keys on a focused row: `Mod+Shift+H` hide / show, `Mod+Shift+L` lock / unlock (the eye and lock are pointer
 *   conveniences); `Delete` deletes. Filter field: by name, or `text:`, `image:` … for a kind; Escape clears it.
 * - Empty: one line with the Shape and Text tools as links.
 *
 * It holds no document logic: the scene mirror gives the rows, `LayersPort` runs capabilities and mirror actions.
 */
import { defineButton } from '@staticflux/kit/button';
import { defineIconElement } from '@staticflux/kit/icon';
import { eyeIcon } from '@staticflux/kit/icons/eye';
import { eyeOffIcon } from '@staticflux/kit/icons/eye-off';
import { lockIcon } from '@staticflux/kit/icons/lock';
import { lockOpenIcon } from '@staticflux/kit/icons/lock-open';
import { defineTextField } from '@staticflux/kit/text-field';
import { defineTree, type DropPosition, type RenameDetail, type ReorderDetail, type SfTreeElement, type TreeNode } from '@staticflux/kit/tree';
import type { NodeId } from '@staticflux/document/v2';
import { component, defineComponent, SfElement } from '@staticflux/ui';
import { themeTokens as t } from '@staticflux/ui/theme';
import { css, html, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { LAYER_KIND_NAMES, type LayerKindName, type LayerRow, type PageSummary } from '../app/scene-summary.js';
import { definePanel, type PanelContribution } from '../spec/contributions.js';
import { StudioIds } from '../spec/studio-ids.js';
import { layerKindIcon } from '../theme/icons.js';

export const layersMessages = Object.freeze({
  layers: 'Layers',
  filter: 'Filter layers',
  empty: 'Nothing here yet.',
  draw: 'Draw a shape',
  addText: 'add text',
  hide: 'Hide',
  show: 'Show',
  lock: 'Lock',
  unlock: 'Unlock',
  noMatch: 'No layers match.',
});

/** What the panel shows (the scene mirror, set by the app). */
export interface LayersModel {
  readonly page: PageSummary | undefined;
  readonly layers: readonly LayerRow[];
  readonly selection: readonly NodeId[];
  /** The element under the pointer on the canvas. */
  readonly hover: NodeId | undefined;
}

export const EMPTY_LAYERS: LayersModel = Object.freeze({ page: undefined, layers: [], selection: [], hover: undefined });

/** What the panel runs. */
export interface LayersPort {
  select(nodes: readonly NodeId[]): void;
  /** Nothing selected: the page (the inspector shows Page). */
  selectPage(): void;
  rename(node: NodeId, name: string): void;
  /** Move `nodes` into `parent` before `before` (document order; null = on top). */
  move(nodes: readonly NodeId[], parent: NodeId, before: NodeId | null): void;
  hide(nodes: readonly NodeId[], hidden: boolean): void;
  lock(nodes: readonly NodeId[], locked: boolean): void;
  remove(nodes: readonly NodeId[]): void;
  hover(node: NodeId | undefined): void;
  /** The empty state's links: `shape` or `text`. */
  pickTool(tool: 'shape' | 'text'): void;
}

const KIND_PREFIXES: Readonly<Record<string, readonly LayerKindName[]>> = {
  text: ['text'],
  image: ['image'],
  frame: ['frame'],
  group: ['group'],
  shape: ['rectangle', 'ellipse', 'polygon', 'star', 'line', 'path'],
  rectangle: ['rectangle'],
  ellipse: ['ellipse'],
  repeat: ['repeat'],
  boolean: ['boolean'],
  mask: ['mask'],
};

/** Rows matching a filter (`text:`-style kind prefixes, else a name substring), with their ancestors. Pure. */
export function filterLayers(rows: readonly LayerRow[], query: string): readonly LayerRow[] {
  const q = query.trim().toLowerCase();
  if (q === '') return rows;
  const prefix = /^([a-z]+):\s*(.*)$/.exec(q);
  const kinds = prefix === null ? undefined : KIND_PREFIXES[prefix[1] as string];
  const text = prefix === null || kinds === undefined ? q : (prefix[2] ?? '');
  const matches = (r: LayerRow): boolean => (kinds === undefined || kinds.includes(r.kind)) && (text === '' || r.name.toLowerCase().includes(text));
  const walk = (list: readonly LayerRow[]): LayerRow[] =>
    list.flatMap((r) => {
      const children = walk(r.children);
      return matches(r) || children.length > 0 ? [{ ...r, children }] : [];
    });
  return walk(rows);
}

/** Display order is top-most first; a drop maps to the document's `before` (paint order). Pure. */
export function dropTarget(layers: readonly LayerRow[], pageId: NodeId, detail: ReorderDetail): { readonly parent: NodeId; readonly before: NodeId | null } | undefined {
  if (detail.position === 'inside') return detail.targetId === pageId ? { parent: pageId, before: null } : { parent: detail.targetId, before: null };
  const find = (list: readonly LayerRow[], parent: NodeId): { siblings: readonly LayerRow[]; parent: NodeId } | undefined => {
    if (list.some((r) => r.id === detail.targetId)) return { siblings: list, parent };
    for (const r of list) {
      const inner = find(r.children, r.id);
      if (inner !== undefined) return inner;
    }
    return undefined;
  };
  if (detail.targetId === pageId) return { parent: pageId, before: null };
  const found = find(layers, pageId);
  if (found === undefined) return undefined;
  const siblings = found.siblings.filter((r) => r.id !== detail.id);
  const at = siblings.findIndex((r) => r.id === detail.targetId);
  // Below the target in the list = under it in paint order = before it in the document.
  if (detail.position === 'after') return { parent: found.parent, before: detail.targetId };
  // Above the target = after it in the document = before the sibling shown above it (none: on top).
  return { parent: found.parent, before: siblings[at - 1]?.id ?? null };
}

/** Containers that hold one of `nodes` (expanded so a canvas selection's row is visible). */
function ancestorsOf(rows: readonly LayerRow[], nodes: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  const walk = (list: readonly LayerRow[], path: readonly string[]): void => {
    for (const r of list) {
      if (nodes.has(r.id)) for (const p of path) out.add(p);
      walk(r.children, [...path, r.id]);
    }
  };
  walk(rows, []);
  return out;
}

const findRow = (rows: readonly LayerRow[], id: string): LayerRow | undefined => {
  for (const r of rows) {
    if (r.id === id) return r;
    const inner = findRow(r.children, id);
    if (inner !== undefined) return inner;
  }
  return undefined;
};

const spec = component({ tag: 'if-layers-panel', placeholder: () => nothing, description: 'Instaflow Layers: the open page’s elements as a tree (B11b).' });

export class IfLayersPanelElement extends SfElement<typeof spec> {
  static override readonly spec = spec;
  static override properties = {
    model: { attribute: false },
    port: { attribute: false },
    query: { state: true },
    expanded: { state: true },
  };
  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      gap: ${t.space.sm.css};
      min-block-size: 0;
      block-size: 100%;
      font-family: ${t.font.family.css};
      color: ${t.color.text.css};
    }
    sf-tree {
      flex: 1;
      min-block-size: 240px;
    }
    .act {
      display: inline-flex;
      padding: 2px;
      border-radius: ${t.radius.sm.css};
      color: ${t.color.textMuted.css};
      cursor: pointer;
    }
    .act:hover {
      color: ${t.color.text.css};
      background: ${t.color.surfaceHover.css};
    }
    .tag {
      font-family: ${t.font.familyMono.css};
    }
    p {
      margin: 0;
      color: ${t.color.textMuted.css};
      font-size: 13px;
    }
    .link {
      all: unset;
      color: ${t.color.accentText.css};
      text-decoration: underline;
      cursor: pointer;
      border-radius: ${t.radius.sm.css};
    }
    .link:focus-visible {
      outline: 2px solid ${t.color.focusRing.css};
      outline-offset: 2px;
    }
  `;

  declare model: LayersModel;
  declare port: LayersPort | undefined;
  declare query: string;
  declare expanded: ReadonlySet<string>;
  private lastSelection = '';

  constructor() {
    super();
    this.model = EMPTY_LAYERS;
    this.port = undefined;
    this.query = '';
    this.expanded = new Set();
  }

  protected override willUpdate(changed: PropertyValues): void {
    if (!changed.has('model')) return;
    const page = this.model.page?.id;
    const want = new Set(this.expanded);
    if (page !== undefined) want.add(page);
    for (const id of ancestorsOf(this.model.layers, new Set(this.model.selection))) want.add(id);
    if (want.size !== this.expanded.size) this.expanded = want;
  }

  protected override updated(changed: PropertyValues): void {
    super.updated(changed);
    const key = this.model.selection.join();
    if (key === this.lastSelection) return;
    this.lastSelection = key;
    const first = this.model.selection[0];
    const tree = this.tree();
    // Scroll the canvas selection's row into view without re-selecting it.
    if (first !== undefined && tree !== null) void tree.updateComplete.then(() => tree.focusRow(first, { select: false }));
  }

  private tree(): SfTreeElement | null {
    return this.renderRoot.querySelector<SfTreeElement>('sf-tree');
  }

  private nodes(rows: readonly LayerRow[], port: LayersPort): TreeNode[] {
    return rows.map((r) => {
      const toggles = html`<span class="act" aria-hidden="true" title=${r.hidden ? layersMessages.show : layersMessages.hide} @click=${() => port.hide([r.id], !r.hidden)}
          ><sf-icon .icon=${r.hidden ? eyeOffIcon : eyeIcon} size="14"></sf-icon></span
        ><span class="act" aria-hidden="true" title=${r.locked ? layersMessages.unlock : layersMessages.lock} @click=${() => port.lock([r.id], !r.locked)}
          ><sf-icon .icon=${r.locked ? lockIcon : lockOpenIcon} size="14"></sf-icon
        ></span>`;
      // The kind icon names the kind and the hidden / locked state for assistive tech (the eye and lock are pointer-only).
      const spoken = [LAYER_KIND_NAMES[r.kind], ...(r.hidden ? ['hidden'] : []), ...(r.locked ? ['locked'] : [])].join(', ');
      return {
        id: r.id,
        label: r.name,
        icon: html`<sf-icon .icon=${layerKindIcon(r.kind)} size="14" label=${spoken}></sf-icon>`,
        ...(r.meta === undefined ? {} : { badge: r.meta }),
        trailing: toggles,
        trailingPinned: r.hidden || r.locked,
        muted: r.hidden,
        ...(r.children.length > 0 ? { children: this.nodes(r.children, port) } : {}),
      };
    });
  }

  private onSelect(e: CustomEvent<{ ids: readonly string[] }>, port: LayersPort): void {
    const page = this.model.page?.id;
    const ids = e.detail.ids.filter((id) => id !== page);
    if (ids.length === 0 && page !== undefined && e.detail.ids.includes(page)) port.selectPage();
    else port.select(ids);
  }

  private onReorder(e: CustomEvent<ReorderDetail>, port: LayersPort): void {
    e.preventDefault(); // the tree never mutates: the document does, then the mirror posts the new rows
    const page = this.model.page?.id;
    if (page === undefined || e.detail.id === page) return;
    const target = dropTarget(this.model.layers, page, e.detail);
    if (target !== undefined) port.move([e.detail.id], target.parent, target.before);
  }

  private onKey(e: KeyboardEvent, port: LayersPort): void {
    const tree = this.tree();
    if (tree === null || e.composedPath()[0] instanceof HTMLInputElement) return;
    const page = this.model.page?.id;
    const ids = [...tree.selected].filter((id) => id !== page);
    const row = ids[0] === undefined ? undefined : findRow(this.model.layers, ids[0]);
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'F2' && ids.length === 1) {
      e.preventDefault();
      tree.renaming = ids[0];
    } else if (mod && e.shiftKey && e.key.toLowerCase() === 'h' && row !== undefined) {
      e.preventDefault();
      e.stopPropagation();
      port.hide(ids, !row.hidden);
    } else if (mod && e.shiftKey && e.key.toLowerCase() === 'l' && row !== undefined) {
      e.preventDefault();
      e.stopPropagation();
      port.lock(ids, !row.locked);
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && ids.length > 0) {
      e.preventDefault();
      port.remove(ids);
    }
  }

  private onHover(e: PointerEvent, port: LayersPort): void {
    const row = e.composedPath().find((el): el is HTMLElement => el instanceof HTMLElement && el.getAttribute('role') === 'treeitem');
    const id = row?.dataset['id'];
    port.hover(id === undefined || id === this.model.page?.id ? undefined : id);
  }

  override render(): TemplateResult | typeof nothing {
    const port = this.port;
    const page = this.model.page;
    if (port === undefined || page === undefined) return nothing;
    const rows = filterLayers(this.model.layers, this.query);
    const empty = this.model.layers.length === 0;
    const pageNode: TreeNode = { id: page.id, label: page.name, draggable: false, ...(rows.length > 0 ? { children: this.nodes(rows, port) } : {}) };
    return html`<sf-text-field
        label=${layersMessages.filter}
        label-hidden
        placeholder=${layersMessages.filter}
        .value=${this.query}
        @input=${(e: Event) => (this.query = (e.composedPath()[0] as HTMLInputElement).value ?? '')}
        @keydown=${(e: KeyboardEvent) => {
          if (e.key === 'Escape' && this.query !== '') {
            e.stopPropagation();
            this.query = '';
          }
        }}
      ></sf-text-field>
      ${empty
        ? html`<p>
            ${layersMessages.empty} <button type="button" class="link" @click=${() => port.pickTool('shape')}>${layersMessages.draw}</button> (R) or
            <button type="button" class="link" @click=${() => port.pickTool('text')}>${layersMessages.addText}</button> (T).
          </p>`
        : rows.length === 0
          ? html`<p role="status">${layersMessages.noMatch}</p>`
          : nothing}
      <sf-tree
        label=${layersMessages.layers}
        multiselect
        .nodes=${[pageNode]}
        .expanded=${this.expanded}
        .selected=${new Set(this.model.selection)}
        .highlighted=${this.model.hover}
        .canDrop=${(source: TreeNode, target: TreeNode, position: DropPosition) => source.id !== page.id && !(target.id === page.id && position !== 'inside') && (position !== 'inside' || target.id === page.id || isContainer(this.model.layers, target.id))}
        @sf-select=${(e: CustomEvent<{ ids: readonly string[] }>) => this.onSelect(e, port)}
        @sf-toggle=${(e: CustomEvent<{ id: string; expanded: boolean }>) => {
          const next = new Set(this.expanded);
          if (e.detail.expanded) next.add(e.detail.id);
          else next.delete(e.detail.id);
          this.expanded = next;
        }}
        @sf-activate=${(e: CustomEvent<{ id: string }>) => {
          const tree = this.tree();
          if (tree !== null && e.detail.id !== page.id) tree.renaming = e.detail.id;
        }}
        @sf-rename=${(e: CustomEvent<RenameDetail>) => port.rename(e.detail.id, e.detail.value)}
        @sf-reorder=${(e: CustomEvent<ReorderDetail>) => this.onReorder(e, port)}
        @keydown=${(e: KeyboardEvent) => this.onKey(e, port)}
        @pointerover=${(e: PointerEvent) => this.onHover(e, port)}
        @pointerleave=${() => port.hover(undefined)}
      ></sf-tree>`;
  }
}

const isContainer = (rows: readonly LayerRow[], id: string): boolean => {
  const r = findRow(rows, id);
  return r !== undefined && (r.kind === 'frame' || r.kind === 'group');
};

/** Layers as a spec panel (the dock's first tab); the host binds the element (`bindPanel`). */
export const layersPanel: PanelContribution = definePanel({
  id: StudioIds.panel.layers,
  label: 'Layers',
  description: 'The open page’s elements, top-most first: select, rename, reorder, hide and lock.',
  placements: ['dock', 'side'],
  minDensity: 'standard',
  render: () => html`<if-layers-panel></if-layers-panel>`,
});

/** Define `<if-layers-panel>` and the kit components it renders. */
export function defineLayersPanel(registry: CustomElementRegistry = customElements): void {
  defineButton(registry);
  defineIconElement(registry);
  defineTextField(registry);
  defineTree(registry);
  if (registry.get(spec.tag) === undefined) defineComponent(IfLayersPanelElement, registry);
}

declare global {
  interface HTMLElementTagNameMap {
    'if-layers-panel': IfLayersPanelElement;
  }
}
