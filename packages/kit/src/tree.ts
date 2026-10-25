/**
 * `<sf-tree label="Layers" .nodes=${nodes}>` — a virtualized tree view (WAI-ARIA APG
 * Tree View) for layers, outlines and asset folders.
 *
 * - **Virtualized:** only the rows in the viewport (+ overscan) are in the DOM; rows have
 *   a fixed height (the density token `size.row`, read from CSS) so 50 000 rows cost as
 *   much as 30. Focus uses `aria-activedescendant` on the tree, so recycled rows never hold
 *   focus; each row has `aria-level`, `aria-setsize`, `aria-posinset`, `aria-expanded`.
 * - **Keyboard:** ↑/↓, Home/End, → expands / enters, ← collapses / goes to the parent,
 *   Enter activates (`sf-activate`), Space selects, type-ahead by first letter;
 *   **Alt+↑/↓ moves the item** among its siblings (the keyboard equivalent of dragging —
 *   nothing is drag-only). Single selection follows focus; `multiselect` uses Space and
 *   Ctrl/⌘/Shift-click.
 * - **Drag-reorder hooks:** rows are draggable (`node.draggable !== false`); `canDrop(source,
 *   target, position)` filters targets (never into the item's own subtree); dropping fires a
 *   cancelable `sf-reorder` `{ id, targetId, position: 'before' | 'after' | 'inside' }`. The
 *   tree never mutates `nodes`: the app applies the move (through its document/undo model).
 * - Events: `sf-select` `{ ids, id }`, `sf-toggle` `{ id, expanded }`, `sf-activate` `{ id }`,
 *   `sf-reorder`, `sf-drag-start` (cancelable).
 */
import { createMachine, defineMachine } from '@staticflux/core';
import { component, defineComponent, SfElement } from '@staticflux/ui';
import { css, html, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { directionOf } from './internal/direction.js';
import { emit } from './internal/events.js';
import { uniqueId } from './internal/ids.js';
import { baseStyles, t } from './internal/styles.js';
import { typeaheadIndex } from './internal/typeahead.js';
import { defineIconElement } from './icon.js';
import { chevronDownIcon } from './icons/chevron-down.js';

export interface TreeNode {
  readonly id: string;
  readonly label: string;
  readonly children?: readonly TreeNode[];
  readonly icon?: unknown;
  /** Trailing text (e.g. `✦`, a type, a count). */
  readonly badge?: string;
  readonly draggable?: boolean;
  readonly disabled?: boolean;
}

export interface TreeRow {
  readonly node: TreeNode;
  /** 1-based depth. */
  readonly level: number;
  readonly parentId: string | undefined;
  /** 1-based position among siblings, and sibling count. */
  readonly posinset: number;
  readonly setsize: number;
  /** `undefined` for leaves. */
  readonly expanded: boolean | undefined;
}

export type DropPosition = 'before' | 'after' | 'inside';

export interface ReorderDetail {
  readonly id: string;
  readonly targetId: string;
  readonly position: DropPosition;
}

export type CanDrop = (source: TreeNode, target: TreeNode, position: DropPosition) => boolean;

/** Visible rows for the expanded set, depth-first (pure). */
export function flattenTree(nodes: readonly TreeNode[], expanded: ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (list: readonly TreeNode[], level: number, parentId: string | undefined): void => {
    list.forEach((node, index) => {
      const hasChildren = (node.children?.length ?? 0) > 0;
      const open = hasChildren && expanded.has(node.id);
      rows.push({ node, level, parentId, posinset: index + 1, setsize: list.length, expanded: hasChildren ? open : undefined });
      if (open) walk(node.children ?? [], level + 1, node.id);
    });
  };
  walk(nodes, 1, undefined);
  return rows;
}

/** Rows to render for a scroll position (pure). `end` is exclusive. */
export function visibleRange(scrollTop: number, viewportHeight: number, rowHeight: number, count: number, overscan = 6): { readonly start: number; readonly end: number } {
  if (count === 0 || rowHeight <= 0) return { start: 0, end: 0 };
  const first = Math.floor(Math.max(0, scrollTop) / rowHeight);
  const visible = Math.ceil(Math.max(viewportHeight, rowHeight) / rowHeight);
  return { start: Math.max(0, first - overscan), end: Math.min(count, first + visible + overscan) };
}

/** Where a drop at `offsetY` within a row lands: top quarter before, bottom quarter after, middle inside (if allowed). */
export function dropPositionAt(offsetY: number, rowHeight: number, allowInside: boolean): DropPosition {
  if (!allowInside) return offsetY < rowHeight / 2 ? 'before' : 'after';
  if (offsetY < rowHeight / 4) return 'before';
  if (offsetY > (rowHeight * 3) / 4) return 'after';
  return 'inside';
}

/** Is `id` inside the subtree of `ancestor` (or the node itself)? */
export function isInSubtree(ancestor: TreeNode, id: string): boolean {
  if (ancestor.id === id) return true;
  return (ancestor.children ?? []).some((child) => isInSubtree(child, id));
}

/** Find a node by id (depth-first). */
export function findNode(nodes: readonly TreeNode[], id: string): TreeNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const inner = findNode(node.children ?? [], id);
    if (inner !== undefined) return inner;
  }
  return undefined;
}

export const treeDragMachine = defineMachine({
  id: 'kit/tree-drag',
  initial: 'idle',
  states: ['idle', 'dragging'],
  transitions: {
    idle: { start: 'dragging' },
    dragging: { over: 'dragging', drop: 'idle', cancel: 'idle' },
  },
});

const DRAG_TYPE = 'application/x-sf-tree-node';

function rowDomId(base: string, id: string): string {
  return `${base}-${id.replace(/[^\w-]/g, (c) => `_${c.charCodeAt(0).toString(36)}`)}`;
}

const treeSpec = component({
  tag: 'sf-tree',
  placeholder: () => nothing,
  description: 'Virtualized tree view (APG): activedescendant focus, keyboard + drag reorder hooks.',
});

export class SfTreeElement extends SfElement<typeof treeSpec> {
  static override readonly spec = treeSpec;
  static override properties = {
    nodes: { attribute: false },
    expanded: { attribute: false },
    selected: { attribute: false },
    label: {},
    multiselect: { type: Boolean },
    canDrop: { attribute: false },
    rowHeight: { type: Number, attribute: 'row-height' },
    activeId: { state: true },
    scrollTop: { state: true },
    viewportHeight: { state: true },
    drop: { state: true },
  };
  static override styles = [
    baseStyles,
    css`
      :host {
        display: block;
        min-block-size: 0;
        contain: content;
      }
      .viewport {
        block-size: 100%;
        overflow: auto;
        outline: none;
        border-radius: ${t.radius.sm.css};
      }
      .viewport:focus-visible {
        outline: 2px solid ${t.color.focusRing.css};
        outline-offset: -2px;
      }
      .spacer {
        position: relative;
      }
      .window {
        position: absolute;
        inset-inline: 0;
        inset-block-start: 0;
      }
      .row {
        display: flex;
        align-items: center;
        gap: ${t.space.xs.css};
        block-size: var(--kit-row);
        padding-inline-end: ${t.space.sm.css};
        border-radius: ${t.radius.sm.css};
        color: ${t.color.text.css};
        white-space: nowrap;
        cursor: default;
        user-select: none;
      }
      .row:hover {
        background: ${t.color.surfaceHover.css};
      }
      .row[aria-selected='true'] {
        background: ${t.color.surfaceSelected.css};
      }
      .row.active {
        box-shadow: inset 0 0 0 2px ${t.color.focusRing.css};
      }
      .viewport:not(:focus-within) .row.active {
        box-shadow: none;
      }
      .row[aria-disabled='true'] {
        color: ${t.color.textDisabled.css};
      }
      .twisty {
        flex: none;
        display: inline-flex;
        justify-content: center;
        inline-size: ${t.size.icon.css};
        color: ${t.color.textMuted.css};
        transition: transform ${t.motion.durationFast.css} ${t.motion.easeStandard.css};
      }
      .row[aria-expanded='false'] .twisty {
        transform: rotate(-90deg);
      }
      .label {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .badge {
        color: ${t.color.textMuted.css};
        font-size: ${t.type.sizeXs.css};
      }
      .row[data-drop='before'] {
        box-shadow: inset 0 2px 0 ${t.color.accent.css};
      }
      .row[data-drop='after'] {
        box-shadow: inset 0 -2px 0 ${t.color.accent.css};
      }
      .row[data-drop='inside'] {
        background: ${t.color.accentSubtle.css};
      }
      @media (forced-colors: active) {
        .row[aria-selected='true'] {
          background: Highlight;
          color: HighlightText;
        }
      }
    `,
  ];

  declare nodes: readonly TreeNode[];
  /** Expanded node ids (the tree updates its own copy and fires `sf-toggle`). */
  declare expanded: ReadonlySet<string>;
  /** Selected node ids (the tree updates its own copy and fires `sf-select`). */
  declare selected: ReadonlySet<string>;
  declare label: string;
  declare multiselect: boolean;
  declare canDrop: CanDrop | undefined;
  /** Row height in px; 0 = read the density token `--sf-size-row`. */
  declare rowHeight: number;
  declare activeId: string | undefined;
  declare scrollTop: number;
  declare viewportHeight: number;
  declare drop: { readonly id: string; readonly position: DropPosition } | undefined;
  private readonly base = uniqueId('sf-tree');
  private readonly drag = createMachine(treeDragMachine);
  private dragSource: string | undefined;
  private anchorId: string | undefined;
  private resizeObserver: ResizeObserver | undefined;
  private measuredRow = 28;

  constructor() {
    super();
    this.nodes = [];
    this.expanded = new Set();
    this.selected = new Set();
    this.label = '';
    this.multiselect = false;
    this.canDrop = undefined;
    this.rowHeight = 0;
    this.activeId = undefined;
    this.scrollTop = 0;
    this.viewportHeight = 320;
    this.drop = undefined;
  }

  /** Visible rows (expanded state applied). */
  get rows(): TreeRow[] {
    return flattenTree(this.nodes, this.expanded);
  }

  get effectiveRowHeight(): number {
    return this.rowHeight > 0 ? this.rowHeight : this.measuredRow;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    const Observer = (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    this.resizeObserver = Observer === undefined ? undefined : new Observer(() => this.measureLayout());
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.resizeObserver?.disconnect();
  }

  protected override firstUpdated(): void {
    const viewport = this.viewport;
    if (viewport !== null) this.resizeObserver?.observe(viewport);
    this.measureLayout();
  }

  private get viewport(): HTMLElement | null {
    return this.renderRoot.querySelector<HTMLElement>('.viewport');
  }

  private measureLayout(): void {
    const viewport = this.viewport;
    if (viewport !== null && viewport.clientHeight > 0) this.viewportHeight = viewport.clientHeight;
    const token = Number.parseFloat(getComputedStyle(this).getPropertyValue('--sf-size-row'));
    if (Number.isFinite(token) && token > 0) this.measuredRow = token;
  }

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has('nodes') && this.activeId !== undefined && findNode(this.nodes, this.activeId) === undefined) this.activeId = undefined;
  }

  // ------------------------------------------------------------------ state changes

  /** Expand or collapse a node; fires `sf-toggle`. */
  setExpanded(id: string, expanded: boolean): void {
    if (this.expanded.has(id) === expanded) return;
    const next = new Set(this.expanded);
    if (expanded) next.add(id);
    else next.delete(id);
    this.expanded = next;
    emit(this, 'sf-toggle', { id, expanded });
  }

  /** Replace the selection; fires `sf-select`. */
  setSelection(ids: readonly string[], id: string): void {
    this.selected = new Set(ids);
    emit(this, 'sf-select', { ids: [...ids], id });
  }

  /** Move the active (focused) row and scroll it into view; single selection follows. */
  focusRow(id: string, options: { readonly select?: boolean } = {}): void {
    const rows = this.rows;
    const index = rows.findIndex((r) => r.node.id === id);
    if (index < 0) return;
    this.activeId = id;
    const rh = this.effectiveRowHeight;
    const top = index * rh;
    const viewport = this.viewport;
    if (viewport !== null) {
      if (top < viewport.scrollTop) viewport.scrollTop = top;
      else if (top + rh > viewport.scrollTop + this.viewportHeight) viewport.scrollTop = top + rh - this.viewportHeight;
      this.scrollTop = viewport.scrollTop;
    }
    if ((options.select ?? !this.multiselect) && rows[index]?.node.disabled !== true) this.setSelection([id], id);
  }

  /** Ask the app to move `id` relative to `targetId` (cancelable `sf-reorder`). Returns false when vetoed. */
  requestReorder(id: string, targetId: string, position: DropPosition): boolean {
    const source = findNode(this.nodes, id);
    const target = findNode(this.nodes, targetId);
    if (source === undefined || target === undefined || isInSubtree(source, targetId)) return false;
    if (this.canDrop !== undefined && !this.canDrop(source, target, position)) return false;
    return emit<ReorderDetail>(this, 'sf-reorder', { id, targetId, position }, { cancelable: true });
  }

  // ------------------------------------------------------------------ keyboard

  private onKeydown(event: KeyboardEvent): void {
    const rows = this.rows;
    if (rows.length === 0) return;
    let index = rows.findIndex((r) => r.node.id === this.activeId);
    if (index < 0) index = 0;
    const row = rows[index] as TreeRow;
    const rtl = directionOf(this) === 'rtl';
    const key = rtl && (event.key === 'ArrowLeft' || event.key === 'ArrowRight') ? (event.key === 'ArrowLeft' ? 'ArrowRight' : 'ArrowLeft') : event.key;
    const go = (i: number): void => {
      const target = rows[Math.min(Math.max(i, 0), rows.length - 1)];
      if (target !== undefined) this.focusRow(target.node.id);
    };
    if (event.altKey && (key === 'ArrowUp' || key === 'ArrowDown')) {
      event.preventDefault();
      const siblings = rows.filter((r) => r.parentId === row.parentId);
      const at = siblings.findIndex((r) => r.node.id === row.node.id);
      const neighbour = siblings[key === 'ArrowUp' ? at - 1 : at + 1];
      if (neighbour !== undefined) this.requestReorder(row.node.id, neighbour.node.id, key === 'ArrowUp' ? 'before' : 'after');
      return;
    }
    switch (key) {
      case 'ArrowDown':
        go(index + 1);
        break;
      case 'ArrowUp':
        go(index - 1);
        break;
      case 'Home':
        go(0);
        break;
      case 'End':
        go(rows.length - 1);
        break;
      case 'ArrowRight':
        if (row.expanded === false) this.setExpanded(row.node.id, true);
        else if (row.expanded === true) go(index + 1);
        break;
      case 'ArrowLeft':
        if (row.expanded === true) this.setExpanded(row.node.id, false);
        else if (row.parentId !== undefined) this.focusRow(row.parentId);
        break;
      case 'Enter':
        emit(this, 'sf-activate', { id: row.node.id });
        break;
      case ' ':
        this.toggleSelected(row.node.id);
        break;
      default: {
        if (event.key.length !== 1 || /\s/.test(event.key) || event.ctrlKey || event.metaKey) return;
        const next = typeaheadIndex(
          rows.map((r) => r.node.label),
          index,
          event.key,
        );
        if (next >= 0) go(next);
        else return;
      }
    }
    event.preventDefault();
  }

  private toggleSelected(id: string): void {
    if (!this.multiselect) {
      this.setSelection([id], id);
      return;
    }
    const next = new Set(this.selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.setSelection([...next], id);
  }

  private onRowClick(event: MouseEvent, row: TreeRow): void {
    if (row.node.disabled === true) return;
    const onTwisty = event.composedPath().some((target) => target instanceof Element && target.classList.contains('twisty'));
    if (onTwisty && row.expanded !== undefined) {
      this.setExpanded(row.node.id, !row.expanded);
      return;
    }
    this.activeId = row.node.id;
    if (this.multiselect && (event.ctrlKey || event.metaKey)) this.toggleSelected(row.node.id);
    else if (this.multiselect && event.shiftKey && this.anchorId !== undefined) {
      const rows = this.rows;
      const a = rows.findIndex((r) => r.node.id === this.anchorId);
      const b = rows.findIndex((r) => r.node.id === row.node.id);
      const [from, to] = a <= b ? [a, b] : [b, a];
      this.setSelection(
        rows.slice(from, to + 1).filter((r) => r.node.disabled !== true).map((r) => r.node.id),
        row.node.id,
      );
      return;
    } else this.setSelection([row.node.id], row.node.id);
    this.anchorId = row.node.id;
  }

  // ------------------------------------------------------------------ drag and drop

  private onDragStart(event: DragEvent, row: TreeRow): void {
    if (row.node.draggable === false || row.node.disabled === true || !emit(this, 'sf-drag-start', { id: row.node.id }, { cancelable: true })) {
      event.preventDefault();
      return;
    }
    this.drag.send('start');
    this.dragSource = row.node.id;
    event.dataTransfer?.setData(DRAG_TYPE, row.node.id);
    if (event.dataTransfer !== null) event.dataTransfer.effectAllowed = 'move';
  }

  private allowedDrop(target: TreeRow, position: DropPosition): boolean {
    const sourceId = this.dragSource;
    if (sourceId === undefined) return false;
    const source = findNode(this.nodes, sourceId);
    if (source === undefined || isInSubtree(source, target.node.id)) return false;
    return this.canDrop?.(source, target.node, position) ?? true;
  }

  private onDragOver(event: DragEvent, row: TreeRow): void {
    if (!this.drag.is('dragging')) return;
    const element = event.currentTarget as HTMLElement;
    const offset = event.clientY - element.getBoundingClientRect().top;
    const position = dropPositionAt(offset, this.effectiveRowHeight, true);
    if (!this.allowedDrop(row, position)) {
      this.drop = undefined;
      return;
    }
    event.preventDefault();
    this.drag.send('over');
    if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'move';
    if (this.drop?.id !== row.node.id || this.drop.position !== position) this.drop = { id: row.node.id, position };
  }

  private onDrop(event: DragEvent, row: TreeRow): void {
    event.preventDefault();
    const drop = this.drop;
    const source = this.dragSource;
    this.endDrag(true);
    if (drop !== undefined && source !== undefined && drop.id === row.node.id) this.requestReorder(source, drop.id, drop.position);
  }

  private endDrag(dropped: boolean): void {
    if (this.drag.is('dragging')) this.drag.send(dropped ? 'drop' : 'cancel');
    this.dragSource = undefined;
    this.drop = undefined;
  }

  // ------------------------------------------------------------------ render

  override render(): TemplateResult {
    const rows = this.rows;
    const rh = this.effectiveRowHeight;
    const range = visibleRange(this.scrollTop, this.viewportHeight, rh, rows.length);
    const windowRows = rows.slice(range.start, range.end);
    const active = rows.some((r) => r.node.id === this.activeId) ? this.activeId : rows[0]?.node.id;
    return html`<div
      class="viewport"
      part="viewport"
      role="tree"
      tabindex="0"
      aria-label=${this.label || nothing}
      aria-multiselectable=${this.multiselect ? 'true' : nothing}
      aria-activedescendant=${active === undefined || !windowRows.some((r) => r.node.id === active) ? nothing : rowDomId(this.base, active)}
      style=${`--kit-row:${rh}px`}
      @keydown=${(e: KeyboardEvent) => this.onKeydown(e)}
      @focus=${() => this.activeId === undefined && active !== undefined && (this.activeId = active)}
      @scroll=${(e: Event) => (this.scrollTop = (e.target as HTMLElement).scrollTop)}
      @dragend=${() => this.endDrag(false)}
    >
      <div class="spacer" style=${`block-size:${rows.length * rh}px`}>
        <div class="window" style=${`transform:translateY(${range.start * rh}px)`}>
          ${repeat(
            windowRows,
            (r) => r.node.id,
            (r) => html`<div
              class="row ${r.node.id === active ? 'active' : ''}"
              role="treeitem"
              id=${rowDomId(this.base, r.node.id)}
              aria-level=${r.level}
              aria-setsize=${r.setsize}
              aria-posinset=${r.posinset}
              aria-expanded=${r.expanded === undefined ? nothing : r.expanded ? 'true' : 'false'}
              aria-selected=${this.selected.has(r.node.id) ? 'true' : 'false'}
              aria-disabled=${r.node.disabled === true ? 'true' : nothing}
              data-id=${r.node.id}
              data-drop=${this.drop?.id === r.node.id ? this.drop.position : nothing}
              draggable=${r.node.draggable === false || r.node.disabled === true ? 'false' : 'true'}
              style=${`padding-inline-start:calc(${r.level - 1} * 16px + 4px)`}
              @click=${(e: MouseEvent) => this.onRowClick(e, r)}
              @dblclick=${() => emit(this, 'sf-activate', { id: r.node.id })}
              @dragstart=${(e: DragEvent) => this.onDragStart(e, r)}
              @dragover=${(e: DragEvent) => this.onDragOver(e, r)}
              @drop=${(e: DragEvent) => this.onDrop(e, r)}
            >
              <span class="twisty" aria-hidden="true">${r.expanded === undefined ? nothing : html`<sf-icon .icon=${chevronDownIcon}></sf-icon>`}</span>${r.node.icon ?? nothing}<span class="label">${r.node.label}</span>${r.node.badge === undefined
                ? nothing
                : html`<span class="badge">${r.node.badge}</span>`}
            </div>`,
          )}
        </div>
      </div>
    </div>`;
  }
}

export function defineTree(registry: CustomElementRegistry = customElements): void {
  defineIconElement(registry);
  if (registry.get(treeSpec.tag) === undefined) defineComponent(SfTreeElement, registry);
}
