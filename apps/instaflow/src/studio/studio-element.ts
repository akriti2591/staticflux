/**
 * `<if-studio>` — the Studio frame (STUDIO-UX-SPEC §1–§4, `docs/instaflow/design/StudioCP.dc.html`; B0, rebuilt by
 * B11b): the top bar (the mark → Home, the design title renamed in place, the lens switcher `Canvas · Pages`, the save
 * state → Milestones, `View ▾`, `Milestone`, `⋯`, `Export`), the tabbed left dock, the **canvas room** (the mist dot
 * grid fills the whole region; the page is a white card with a shadow and a non-printing label, drawn behind the
 * transparent canvas; the floating tool picker, the selection pill, the zoom pill) and the inspector. Every control is
 * a kit component under the active theme (Clean Pop).
 *
 * The dock, the tools and the inspector panels are laid out from the mounted editor spec (`studio.port`); the selection
 * pill (`<if-hud>`) and the page card read `model` (the editor's mirrors, set by the app); every edit goes out through
 * `port`. Nothing here decides: it shows and forwards.
 */
import type { ShortcutRegistry } from '@staticflux/a11y';
import { createScope, type Scope } from '@staticflux/core';
import { defineButton } from '@staticflux/kit/button';
import { defineDock } from '@staticflux/kit/dock';
import { defineIconElement } from '@staticflux/kit/icon';
import { defineIconButton } from '@staticflux/kit/icon-button';
import { defineInlineEdit } from '@staticflux/kit/inline-edit';
import { chevronDownIcon } from '@staticflux/kit/icons/chevron-down';
import { downloadIcon } from '@staticflux/kit/icons/download';
import { ellipsisIcon } from '@staticflux/kit/icons/ellipsis';
import { minusIcon } from '@staticflux/kit/icons/minus';
import { plusIcon } from '@staticflux/kit/icons/plus';
import { defineMenu } from '@staticflux/kit/menu';
import { definePopover, type SfPopoverElement } from '@staticflux/kit/popover';
import { defineSegmented, type SegmentOption } from '@staticflux/kit/segmented';
import { defineTabs } from '@staticflux/kit/tabs';
import { defineTag } from '@staticflux/kit/tag';
import { defineTextField } from '@staticflux/kit/text-field';
import type { SpecLayoutEntry, SpecSlotKey } from '@staticflux/shell/spec';
import { component, defineComponent, SfElement } from '@staticflux/ui';
import { themeTokens as t } from '@staticflux/ui/theme';
import { css, html, nothing, type PropertyValues, type TemplateResult } from 'lit';
import type { PageSummary, SelectionSummary } from '../app/scene-summary.js';
import { DENSITY_RANK, type Density, type PanelContext, type PanelPlacementId, type ScopeKind, type ToolId } from '../spec/contributions.js';
import type { SpecProposal } from '../spec/proposals.js';
import { StudioIds } from '../spec/studio-ids.js';
import type { FontChoice, TypographySummary } from '../text/typography.js';
import { toolIcon } from '../theme/icons.js';
import { lensMarkStyle, lensOf } from '../theme/lenses.js';
import { instaflowMark } from '../theme/logo.js';
import { circleIcon } from '@staticflux/kit/icons/circle';
import { pentagonIcon } from '@staticflux/kit/icons/pentagon';
import { starIcon } from '@staticflux/kit/icons/star';
import type { IconDef } from '@staticflux/kit/icon';
import type { DocumentColor } from '@staticflux/kit/color-popover';
import type { CanvasPort, CanvasSession } from './canvas.js';
import { type CommandEntry, defineCommandBar, type IfCommandBarElement } from './command-bar.js';
import { defineHud, type HudAction, type HudPort, type IfHudElement } from './hud.js';
import type { Studio } from './studio.js';

/** User-facing strings (props override them; i18n lands with the app shell). */
export const studioMessages = Object.freeze({
  home: 'Home',
  title: 'Design title',
  untitled: 'Untitled design',
  lens: 'Lens',
  densities: { focus: 'Focus', standard: 'Standard', pro: 'Pro' } as Readonly<Record<Density, string>>,
  densityLines: { focus: 'Just your work.', standard: 'Your work, with the panels that explain it.', pro: 'Everything, with numbers.' } as Readonly<Record<Density, string>>,
  saved: 'Saved',
  saveHint: 'Instaflow saves as you work. Create a milestone to keep a named version.',
  view: 'View',
  zoomFit: 'Zoom to fit',
  zoomSelection: 'Zoom to selection',
  zoom100: 'Zoom to 100 %',
  zoom: 'Zoom',
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  density: 'Density',
  milestone: 'Milestone',
  milestoneName: 'Milestone name',
  create: 'Create',
  more: 'More',
  saveTemplate: 'Save as template…',
  rename: 'Rename…',
  copyLink: 'Copy link',
  export: 'Export',
  dock: 'Dock',
  tools: 'Tools',
  shapes: 'Shapes',
  canvas: 'Canvas',
  canvasSurface: 'Canvas surface',
  pageLabel: (p: PageSummary) => `${p.name} · ${p.width} × ${p.height}`,
  proposal: 'Proposed editor',
  open: 'Open',
  dismiss: 'Dismiss',
  canvasFailed: 'The canvas could not start. The rest of Studio still works.',
});

/** The camera commands of the View menu and the zoom pill (the editor runs them). */
export type CameraAction = 'fit-page' | 'fit-selection' | 'zoom-100' | 'zoom-in' | 'zoom-out' | 'zoom-50' | 'zoom-200';

/** What the chrome shows (the editor's mirrors, set by the app as they post). */
export interface StudioChromeModel {
  readonly title: string;
  readonly page: PageSummary | undefined;
  readonly selection: SelectionSummary | undefined;
  /** Page-space bounds of the selection frame. */
  readonly frame: { readonly x: number; readonly y: number; readonly w: number; readonly h: number } | undefined;
  readonly camera: { readonly tx: number; readonly ty: number; readonly zoom: number };
  /** B3's gesture state (`idle` when nothing is being dragged). */
  readonly gesture: string;
  readonly editing: boolean;
  readonly typography: TypographySummary | undefined;
  readonly fonts: readonly FontChoice[];
  readonly colors: readonly DocumentColor[];
  readonly actions: ReadonlyMap<string, HudAction>;
  /** Capabilities that run with nothing selected (undo, redo): the command bar always lists them. */
  readonly globalActions: readonly string[];
  /** C1's exporter exists here (the Export button renders only then). */
  readonly exportAvailable: boolean;
  /** Templates can be saved here. */
  readonly templatesAvailable: boolean;
}

/** What the chrome runs (the app implements it over capabilities and mirrors). */
export interface StudioChromePort extends HudPort {
  renameTitle(title: string): void;
  camera(action: CameraAction): void;
  openExport(): void;
  createMilestone(name: string): void;
  saveAsTemplate(): void;
  copyLink(): void;
  /** Leave Studio for `href` after saving (the Home link). */
  navigate(href: string): void;
}

export const EMPTY_CHROME: StudioChromeModel = Object.freeze({
  title: '',
  page: undefined,
  selection: undefined,
  frame: undefined,
  camera: { tx: 0, ty: 0, zoom: 1 },
  gesture: 'idle',
  editing: false,
  typography: undefined,
  fonts: [],
  colors: [],
  actions: new Map(),
  globalActions: [],
  exportAvailable: false,
  templatesAvailable: false,
});

/** The tool picker's shape family (one button, a menu, STUDIO-UX-SPEC §4.1). */
const SHAPE_FAMILY: readonly ToolId[] = [StudioIds.tool.shape, StudioIds.tool.ellipse, StudioIds.tool.polygon, StudioIds.tool.star, StudioIds.tool.line];
const TOOL_ICONS: Readonly<Record<string, IconDef>> = {
  [StudioIds.tool.select]: toolIcon('select'),
  [StudioIds.tool.frame]: toolIcon('frame'),
  [StudioIds.tool.shape]: toolIcon('shape'),
  [StudioIds.tool.text]: toolIcon('text'),
  [StudioIds.tool.hand]: toolIcon('hand'),
  [StudioIds.tool.ellipse]: circleIcon,
  [StudioIds.tool.polygon]: pentagonIcon,
  [StudioIds.tool.star]: starIcon,
  [StudioIds.tool.line]: minusIcon,
};

/** Lenses shown in M1 (STUDIO-UX-SPEC §2.1: the layout lenses that exist). */
export const M1_LENSES: readonly string[] = [StudioIds.lens.canvas, StudioIds.lens.pages];

/** Gap between the pill and the selection, and the pill's margin from the canvas edges (§4.2.2). */
export const HUD_GAP = 12;
export const HUD_MARGIN = 8;
/** The tool picker's bottom edge (16 px from the top, 42 px tall): the pill never overlaps it. */
export const TOOL_PICKER_BOTTOM = 16 + 42;
/** The rotate handle sits 24 px below the frame on a stem: a pill below the selection clears it. */
const ROTATE_CLEARANCE = 36;

/**
 * Where the pill goes (§4.2.2), in canvas-region pixels: centred above the selection's screen bounds with a 12 px gap,
 * below when there is no room above (the tool picker counts), clamped to the region; undefined when the selection is
 * entirely off-screen. Pure.
 */
export function hudPosition(
  frame: { readonly x: number; readonly y: number; readonly w: number; readonly h: number },
  camera: { readonly tx: number; readonly ty: number; readonly zoom: number },
  region: { readonly width: number; readonly height: number },
  pill: { readonly width: number; readonly height: number },
): { readonly left: number; readonly top: number } | undefined {
  const x = frame.x * camera.zoom + camera.tx;
  const y = frame.y * camera.zoom + camera.ty;
  const w = frame.w * camera.zoom;
  const h = frame.h * camera.zoom;
  if (x + w < 0 || y + h < 0 || x > region.width || y > region.height) return undefined;
  const visibleTop = Math.max(y, 0);
  const above = visibleTop - HUD_GAP - pill.height;
  const top = above >= TOOL_PICKER_BOTTOM + HUD_MARGIN ? above : Math.min(y + h + ROTATE_CLEARANCE, region.height - pill.height - HUD_MARGIN);
  const left = Math.min(Math.max(x + w / 2 - pill.width / 2, HUD_MARGIN), Math.max(HUD_MARGIN, region.width - pill.width - HUD_MARGIN));
  return { left, top: Math.max(TOOL_PICKER_BOTTOM + HUD_MARGIN, top) };
}

const studioComponent = component({
  tag: 'if-studio',
  placeholder: () => nothing,
  description: 'Instaflow Studio frame: top bar, dock, the canvas room with the page card, tool picker and selection pill, inspector (B11b).',
});

const motionStyle = (entry: SpecLayoutEntry): string => `--if-motion:${entry.step.durationMs}ms;--if-ease:${entry.step.easing}`;
const isExiting = (entry: SpecLayoutEntry): boolean => entry.phase === 'exiting';

export class IfStudioElement extends SfElement<typeof studioComponent> {
  static override readonly spec = studioComponent;
  static override properties = {
    studio: { attribute: false },
    canvas: { attribute: false },
    shortcuts: { attribute: false },
    assetTitle: { attribute: 'asset-title' },
    projectTitle: { attribute: 'project-title' },
    homeHref: { attribute: 'home-href' },
    canvasError: { state: true },
    status: { attribute: false },
    zoom: { type: Number },
    expanded: { state: true },
    dockTab: { state: true },
    model: { attribute: false },
    port: { attribute: false },
    hudHidden: { state: true },
  };
  static override styles = [
    css`
      :host {
        display: flex;
        flex-direction: column;
        block-size: 100%;
        min-block-size: 0;
        background: ${t.color.canvas.css};
        color: ${t.color.text.css};
        font-family: ${t.font.family.css};
        font-size: ${t.type.sizeSm.css};
      }
      header {
        display: flex;
        align-items: center;
        gap: ${t.space.md.css};
        min-block-size: 56px;
        padding-inline: 14px;
        border-block-end: 1px solid ${t.color.border.css};
        background: ${t.color.canvas.css};
      }
      .home {
        display: inline-flex;
        border-radius: ${t.radius.sm.css};
      }
      .home:focus-visible,
      .surface:focus-visible,
      .saved:focus-visible,
      .page-label:focus-visible {
        outline: 2px solid ${t.color.focusRing.css};
        outline-offset: 2px;
      }
      .title {
        font-family: ${t.font.familyDisplay.css};
        font-weight: ${t.font.weightDisplay.css};
        font-size: 15px;
        min-inline-size: 0;
      }
      .modes {
        margin-inline: auto;
      }
      .saved {
        display: inline-flex;
        align-items: center;
        border: 0;
        background: transparent;
        padding: 0;
        font: inherit;
        color: ${t.color.textMuted.css};
        cursor: pointer;
        border-radius: ${t.radius.sm.css};
      }
      .body {
        flex: 1;
        display: flex;
        min-block-size: 0;
      }
      aside {
        display: flex;
        min-block-size: 0;
      }
      main {
        position: relative;
        flex: 1;
        min-inline-size: 0;
        overflow: hidden;
        background-color: #e4e9ef;
        background-image: radial-gradient(#c3ccd7 1px, transparent 1px);
        background-size: 20px 20px;
      }
      .page-card {
        position: absolute;
        background: #ffffff;
        box-shadow:
          0 2px 6px rgba(22, 21, 26, 0.1),
          0 24px 56px rgba(22, 21, 26, 0.18);
        pointer-events: none;
      }
      .page-label {
        position: absolute;
        z-index: 2;
        border: 0;
        padding: 0;
        background: transparent;
        font: inherit;
        font-size: 12px;
        color: ${t.color.textMuted.css};
        cursor: default;
        white-space: nowrap;
        border-radius: ${t.radius.sm.css};
      }
      .surface {
        position: absolute;
        inset: 0;
        z-index: 1;
      }
      .tools {
        position: absolute;
        z-index: 2;
        inset-block-start: 16px;
        inset-inline-start: 50%;
        transform: translateX(-50%);
        display: inline-flex;
        align-items: center;
        gap: 2px;
        padding: 4px;
        background: ${t.color.surface2.css};
        border-radius: ${t.radius.full.css};
        box-shadow:
          0 1px 2px rgba(22, 21, 26, 0.08),
          0 10px 28px rgba(22, 21, 26, 0.18);
      }
      .zoom {
        position: absolute;
        z-index: 2;
        inset-inline-start: 16px;
        inset-block-end: 24px;
        display: inline-flex;
        align-items: center;
        gap: 2px;
        padding: 3px;
        background: ${t.color.surface2.css};
        border: 1px solid ${t.color.border.css};
        border-radius: ${t.radius.full.css};
        font-family: ${t.font.familyMono.css};
        font-size: 12px;
      }
      .command-bar {
        position: absolute;
        z-index: 2;
        inset-block-end: 24px;
        inset-inline-start: 50%;
        transform: translateX(-50%);
      }
      if-hud[data-hidden] {
        visibility: hidden;
      }
      .milestone-form {
        display: grid;
        gap: ${t.space.sm.css};
        inline-size: 236px;
      }
      .proposal {
        position: absolute;
        z-index: 3;
        inset-inline-end: ${t.space.lg.css};
        inset-block-start: ${t.space.lg.css};
        inline-size: 240px;
        display: flex;
        flex-direction: column;
        gap: ${t.space.sm.css};
        padding: ${t.space.md.css};
        background: ${t.color.surface2.css};
        border: 1px solid ${t.color.border.css};
        border-radius: ${t.radius.lg.css};
        box-shadow: ${t.shadow.level2.css};
      }
      .proposal .actions {
        display: flex;
        gap: ${t.space.xs.css};
      }
      .muted {
        color: ${t.color.textMuted.css};
      }
      [role='alert'] {
        position: absolute;
        z-index: 3;
        inset-block-end: 80px;
        inset-inline: 0;
        text-align: center;
        color: ${t.color.dangerText.css};
      }
      [data-phase='entering'] {
        animation: if-enter var(--if-motion, 0ms) var(--if-ease, ease) both;
      }
      [data-phase='exiting'] {
        animation: if-exit var(--if-motion, 0ms) var(--if-ease, ease) both;
        pointer-events: none;
      }
      @keyframes if-enter {
        from {
          opacity: 0;
          transform: scale(0.96);
        }
      }
      @keyframes if-exit {
        to {
          opacity: 0;
          transform: scale(0.96);
        }
      }
      @media (prefers-reduced-motion: reduce) {
        [data-phase] {
          animation: none;
        }
      }
    `,
  ];

  declare studio: Studio | undefined;
  declare canvas: CanvasPort | undefined;
  declare shortcuts: ShortcutRegistry | undefined;
  declare assetTitle: string;
  declare projectTitle: string;
  declare homeHref: string;
  declare canvasError: string | undefined;
  /** What the top bar's save state shows (B5's `<if-save-status>`); the static "Saved" until set. */
  declare status: unknown;
  /** The canvas zoom (1 = 100 %) shown in the zoom pill. */
  declare zoom: number;
  /** Regions the person expanded although the density collapses them. */
  declare expanded: ReadonlySet<PanelPlacementId>;
  declare dockTab: SpecSlotKey | undefined;
  declare model: StudioChromeModel;
  declare port: StudioChromePort | undefined;
  declare hudHidden: boolean;
  private wired: Scope | undefined;
  private canvasSession: CanvasSession | undefined;
  private hudFrozen = false;
  private hudTimer: ReturnType<typeof setTimeout> | undefined;
  private lastGesture = 'idle';
  private shapeTool: ToolId = StudioIds.tool.shape;

  constructor() {
    super();
    this.studio = undefined;
    this.canvas = undefined;
    this.shortcuts = undefined;
    this.assetTitle = '';
    this.projectTitle = '';
    this.homeHref = '/';
    this.canvasError = undefined;
    this.status = undefined;
    this.zoom = 1;
    this.expanded = new Set();
    this.dockTab = undefined;
    this.model = EMPTY_CHROME;
    this.port = undefined;
    this.hudHidden = false;
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    clearTimeout(this.hudTimer);
    const wired = this.wired;
    this.wired = undefined;
    void wired?.dispose();
    const session = this.canvasSession;
    this.canvasSession = undefined;
    void session?.stop();
  }

  protected override willUpdate(changed: PropertyValues): void {
    // The pill hides during gestures and comes back 120 ms after one ends, at the new place (§4.2.2).
    if (changed.has('model')) {
      const gesture = this.model.gesture;
      if (gesture !== 'idle') {
        clearTimeout(this.hudTimer);
        this.hudHidden = true;
      } else if (this.lastGesture !== 'idle') {
        clearTimeout(this.hudTimer);
        this.hudTimer = setTimeout(() => {
          this.hudHidden = false;
        }, 120);
      }
      this.lastGesture = gesture;
    }
  }

  protected override updated(changed: PropertyValues): void {
    super.updated(changed);
    if (this.wired === undefined && this.studio !== undefined && this.isConnected) this.wire(this.studio);
    this.placeHud();
  }

  /** Focus the first item of the selection pill (`Alt+Enter`). */
  focusHud(): void {
    this.query<IfHudElement>('if-hud')?.focusFirst();
  }

  /** Focus the design title (`⋯ › Rename…`, F-29). */
  focusTitle(): void {
    const edit = this.query<HTMLElement & { edit?: () => void }>('.title');
    edit?.edit?.();
  }

  /** Open the command bar with its filter focused (`Mod+K`, §4.4). */
  focusCommandBar(): void {
    this.query<IfCommandBarElement>('if-command-bar')?.open();
  }

  /** Focus the canvas surface (`Escape`). */
  focusCanvas(): void {
    this.query<HTMLElement>('.surface')?.focus();
  }

  /** Show a dock panel by contribution id: its tab selected, the dock expanded, focus on its tab. False when not docked. */
  async showPanel(id: string): Promise<boolean> {
    const entry = this.studio?.port.entries('panel@dock').find((e) => e.slot.id === id && !isExiting(e));
    if (entry === undefined) return false;
    this.dockTab = entry.slot.key;
    this.setExpanded('dock', false);
    await this.updateComplete;
    this.query<HTMLElement>(`sf-tab[value="${entry.slot.key}"]`)?.focus();
    return true;
  }

  /** The current canvas session (after the canvas port started). */
  get canvasActive(): CanvasSession | undefined {
    return this.canvasSession;
  }

  private query<E extends Element>(selector: string): E | null {
    return this.renderRoot.querySelector<E>(selector);
  }

  private wire(studio: Studio): void {
    const scope = createScope('instaflow/studio-element');
    this.wired = scope;
    if (this.shortcuts !== undefined) {
      const bound = studio.bindShortcuts(this.shortcuts, { focusHud: () => this.focusHud(), focusCommandBar: () => this.focusCommandBar(), focusCanvas: () => this.focusCanvas() }, scope);
      if (bound.ok) this.shortcuts.attach(this, scope);
    }
    const surface = this.query<HTMLElement>('.surface');
    if (this.canvas !== undefined && surface !== null) {
      void this.canvas.start(surface, scope.signal).then((started) => {
        if (!started.ok) {
          this.canvasError = studioMessages.canvasFailed;
          return;
        }
        if (scope.signal.aborted) void started.value.stop();
        else this.canvasSession = started.value;
      });
    }
  }

  /** Place the pill from the selection frame (frozen while one of its popovers is open). */
  private placeHud(): void {
    const hud = this.query<IfHudElement>('if-hud');
    const region = this.query<HTMLElement>('main');
    const frame = this.model.frame;
    if (hud === null || region === null) return;
    if (this.hudFrozen) return;
    const pill = hud.getBoundingClientRect();
    const box = region.getBoundingClientRect();
    const at = frame === undefined ? undefined : hudPosition(frame, this.model.camera, { width: box.width, height: box.height }, { width: pill.width, height: pill.height });
    if (at === undefined || this.hudHidden) hud.setAttribute('data-hidden', '');
    else {
      hud.removeAttribute('data-hidden');
      hud.style.left = `${Math.round(at.left)}px`;
      hud.style.top = `${Math.round(at.top)}px`;
    }
  }

  private context(): PanelContext {
    const context = this.studio?.port.mountedContext ?? {};
    return { density: (context['density'] as Density | undefined) ?? 'standard', lens: context['lens'] as PanelContext['lens'], scope: (context['scope'] as ScopeKind | undefined) ?? 'asset' };
  }

  private collapsed(region: PanelPlacementId, entries: readonly SpecLayoutEntry[], density: Density): boolean {
    if (this.expanded.has(region)) return false;
    const studio = this.studio;
    return !entries.some((e) => DENSITY_RANK[density] >= DENSITY_RANK[studio?.registries.panel(e.slot.id)?.minDensity ?? 'focus']);
  }

  private setExpanded(region: PanelPlacementId, collapsed: boolean): void {
    const next = new Set(this.expanded);
    if (collapsed) next.delete(region);
    else next.add(region);
    this.expanded = next;
  }

  override render(): TemplateResult | typeof nothing {
    const studio = this.studio;
    if (studio === undefined) return nothing;
    const context = this.context();
    return html`${this.renderTopBar(studio, context.density)}
      <div class="body">
        ${this.renderDock(context)}
        <main aria-label=${studioMessages.canvas}>
          ${this.renderPage()}
          <div class="surface" tabindex="0" role="application" aria-roledescription="canvas" aria-label=${studioMessages.canvasSurface}></div>
          ${this.renderTools(studio)} ${this.renderHud(context.density)} ${this.renderZoom()} ${this.renderCommandBar(studio)}
          ${this.canvasError === undefined ? nothing : html`<p role="alert">${this.canvasError}</p>`} ${this.renderProposal(studio.proposals.pending)}
        </main>
        ${this.renderPanels('inspector', context)}
      </div>`;
  }

  private renderTopBar(studio: Studio, density: Density): TemplateResult {
    const lensEntry = studio.port.entries('lens@default').find((e) => !isExiting(e));
    const options: SegmentOption[] = studio.registries.lenses
      .filter((lens) => M1_LENSES.includes(lens.id))
      .map((lens) => ({ value: lens.id, label: lens.label, icon: html`<span aria-hidden="true" style=${lensMarkStyle(lensOf(lens.palette))}></span>` }));
    const port = this.port;
    const title = this.model.title || this.assetTitle;
    return html`<header>
      <a class="home" href=${this.homeHref} aria-label=${studioMessages.home} @click=${(e: MouseEvent) => this.onHome(e)}>${instaflowMark(26)}</a>
      <sf-inline-edit class="title" trigger="click" label=${studioMessages.title} placeholder=${studioMessages.untitled} .value=${title} @sf-change=${(e: CustomEvent<{ value: string }>) => port?.renameTitle(e.detail.value)}></sf-inline-edit>
      <sf-segmented
        class="modes"
        label=${studioMessages.lens}
        .options=${options}
        value=${lensEntry?.slot.id ?? ''}
        data-slot=${lensEntry?.slot.key ?? nothing}
        data-group="lens@default"
        @sf-change=${(e: CustomEvent<{ value: string }>) => void studio.switchLens(e.detail.value as `${string}/${string}`)}
      ></sf-segmented>
      <button class="saved" type="button" title=${studioMessages.saveHint} @click=${() => void this.showPanel(StudioIds.panel.milestones)}>
        ${this.status === undefined ? html`<span role="status">${studioMessages.saved}</span>` : this.status}
      </button>
      ${this.renderViewMenu(studio, density)} ${this.renderMilestone()} ${this.renderOverflow()}
      ${this.model.exportAvailable
        ? html`<sf-button variant="primary" @click=${() => port?.openExport()}><sf-icon .icon=${downloadIcon} size="16"></sf-icon> ${studioMessages.export}</sf-button>`
        : nothing}
    </header>`;
  }

  private renderViewMenu(studio: Studio, density: Density): TemplateResult {
    const port = this.port;
    const run = (value: string): void => {
      if (value.startsWith('density:')) void studio.setDensity(value.slice('density:'.length) as Density);
      else port?.camera(value as CameraAction);
    };
    return html`<sf-menu label=${studioMessages.view} @sf-select=${(e: CustomEvent<{ value: string }>) => run(e.detail.value)}>
      <sf-button slot="trigger" variant="ghost">${studioMessages.view} <sf-icon .icon=${chevronDownIcon} size="16"></sf-icon></sf-button>
      <sf-menu-group label=${studioMessages.zoom}>
        <sf-menu-item value="fit-page" shortcut="Shift+1">${studioMessages.zoomFit}</sf-menu-item>
        ${this.model.selection !== undefined && this.model.selection.nodes.length > 0 ? html`<sf-menu-item value="fit-selection" shortcut="Shift+2">${studioMessages.zoomSelection}</sf-menu-item>` : nothing}
        <sf-menu-item value="zoom-100" shortcut="Shift+0">${studioMessages.zoom100}</sf-menu-item>
        <sf-menu-item value="zoom-in" shortcut="Mod+=">${studioMessages.zoomIn}</sf-menu-item>
        <sf-menu-item value="zoom-out" shortcut="Mod+-">${studioMessages.zoomOut}</sf-menu-item>
      </sf-menu-group>
      <sf-menu-group label=${studioMessages.density}>
        ${(['focus', 'standard', 'pro'] as const).map(
          (d) => html`<sf-menu-item type="radio" value=${`density:${d}`} ?checked=${d === density}>${studioMessages.densities[d]} · ${studioMessages.densityLines[d]}</sf-menu-item>`,
        )}
      </sf-menu-group>
    </sf-menu>`;
  }

  private renderMilestone(): TemplateResult {
    const port = this.port;
    let name = '';
    const create = (popover: SfPopoverElement | null): void => {
      port?.createMilestone(name.trim());
      popover?.removeAttribute('open');
      if (popover !== null) popover.open = false;
    };
    return html`<sf-popover label=${studioMessages.milestone}>
      <sf-button slot="trigger">${studioMessages.milestone}</sf-button>
      <form
        class="milestone-form"
        @submit=${(e: SubmitEvent) => {
          e.preventDefault();
          create((e.currentTarget as HTMLElement).closest('sf-popover') as SfPopoverElement | null);
        }}
      >
        <sf-text-field label=${studioMessages.milestoneName} placeholder="Milestone" @input=${(e: Event) => (name = (e.composedPath()[0] as HTMLInputElement).value ?? '')}></sf-text-field>
        <sf-button type="submit" variant="primary">${studioMessages.create}</sf-button>
      </form>
    </sf-popover>`;
  }

  private renderOverflow(): TemplateResult {
    const port = this.port;
    const actions: Readonly<Record<string, () => void>> = {
      'save-template': () => port?.saveAsTemplate(),
      rename: () => this.focusTitle(),
      'copy-link': () => port?.copyLink(),
    };
    return html`<sf-menu label=${studioMessages.more} @sf-select=${(e: CustomEvent<{ value: string }>) => actions[e.detail.value]?.()}>
      <sf-icon-button slot="trigger" variant="ghost" label=${studioMessages.more}><sf-icon .icon=${ellipsisIcon} size="18"></sf-icon></sf-icon-button>
      ${this.model.templatesAvailable ? html`<sf-menu-item value="save-template">${studioMessages.saveTemplate}</sf-menu-item>` : nothing}
      <sf-menu-item value="rename">${studioMessages.rename}</sf-menu-item>
      <sf-menu-item value="copy-link" shortcut="Mod+Alt+L">${studioMessages.copyLink}</sf-menu-item>
    </sf-menu>`;
  }

  /** The page card (behind the transparent canvas) and its label (STUDIO-UX-SPEC §1). */
  private renderPage(): TemplateResult | typeof nothing {
    const page = this.model.page;
    if (page === undefined) return nothing;
    const { tx, ty, zoom } = this.model.camera;
    const card = `left:${tx}px;top:${ty}px;width:${page.width * zoom}px;height:${page.height * zoom}px`;
    return html`<div class="page-card" style=${card} aria-hidden="true"></div>
      <span class="page-label" style=${`left:${tx}px;top:${ty - 28}px`} data-if-page-label>${studioMessages.pageLabel(page)}</span>`;
  }

  private renderTools(studio: Studio): TemplateResult {
    const entries = studio.port.entries('tool@default').filter((e) => !isExiting(e));
    const active = studio.activeTool;
    const family = entries.filter((e) => SHAPE_FAMILY.includes(e.slot.id));
    if (active !== undefined && SHAPE_FAMILY.includes(active)) this.shapeTool = active;
    const shape = family.find((e) => e.slot.id === this.shapeTool) ?? family[0];
    const button = (entry: SpecLayoutEntry): TemplateResult => {
      const tool = studio.registries.tool(entry.slot.id);
      return html`<sf-icon-button
        label=${entry.slot.contribution.label}
        shortcut=${tool?.shortcut ?? nothing}
        variant="ghost"
        .pressed=${entry.slot.id === active}
        data-slot=${entry.slot.key}
        data-group="tool@default"
        data-phase=${entry.phase}
        style=${motionStyle(entry)}
        @click=${() => studio.selectTool(entry.slot.id)}
        ><sf-icon .icon=${TOOL_ICONS[entry.slot.id] ?? toolIcon('select')} size="18"></sf-icon
      ></sf-icon-button>`;
    };
    let shapeDone = false;
    return html`<div class="tools" role="toolbar" aria-label=${studioMessages.tools}>
      ${entries.map((entry) => {
        if (!SHAPE_FAMILY.includes(entry.slot.id)) return button(entry);
        if (shapeDone || shape === undefined) return nothing;
        shapeDone = true;
        return html`${button(shape)}
          ${family.length > 1
            ? html`<sf-menu label=${studioMessages.shapes} @sf-select=${(e: CustomEvent<{ value: ToolId }>) => void studio.selectTool(e.detail.value)}>
                <sf-icon-button slot="trigger" size="sm" variant="ghost" label=${studioMessages.shapes}><sf-icon .icon=${chevronDownIcon} size="16"></sf-icon></sf-icon-button>
                ${family.map((f) => {
                  const tool = studio.registries.tool(f.slot.id);
                  return html`<sf-menu-item value=${f.slot.id} type="radio" ?checked=${f.slot.id === this.shapeTool} .icon=${TOOL_ICONS[f.slot.id]} shortcut=${tool?.shortcut ?? nothing}>${f.slot.contribution.label}</sf-menu-item>`;
                })}
              </sf-menu>`
            : nothing}`;
      })}
    </div>`;
  }

  private renderHud(density: Density): TemplateResult | typeof nothing {
    const port = this.port;
    if (port === undefined) return nothing;
    return html`<if-hud
      ?data-hidden=${this.hudHidden}
      .summary=${this.model.selection}
      .typography=${this.model.typography}
      .fonts=${this.model.fonts}
      .actions=${this.model.actions}
      .documentColors=${this.model.colors}
      .port=${port}
      ?pro=${density === 'pro'}
      @if-hud-freeze=${(e: CustomEvent<{ frozen: boolean }>) => {
        this.hudFrozen = e.detail.frozen;
        if (!this.hudFrozen) this.placeHud();
      }}
    ></if-hud>`;
  }

  private renderZoom(): TemplateResult {
    const port = this.port;
    return html`<div role="group" aria-label=${studioMessages.zoom} class="zoom">
      <sf-icon-button label=${studioMessages.zoomOut} shortcut="Mod+-" size="sm" variant="ghost" @click=${() => port?.camera('zoom-out')}><sf-icon .icon=${minusIcon} size="16"></sf-icon></sf-icon-button>
      <sf-menu label=${studioMessages.zoom} @sf-select=${(e: CustomEvent<{ value: CameraAction }>) => port?.camera(e.detail.value)}>
        <sf-button slot="trigger" size="sm" variant="ghost">${Math.round(this.zoom * 100)}%</sf-button>
        <sf-menu-item value="fit-page" shortcut="Shift+1">${studioMessages.zoomFit}</sf-menu-item>
        ${this.model.selection !== undefined && this.model.selection.nodes.length > 0 ? html`<sf-menu-item value="fit-selection" shortcut="Shift+2">${studioMessages.zoomSelection}</sf-menu-item>` : nothing}
        <sf-menu-item value="zoom-50">50 %</sf-menu-item>
        <sf-menu-item value="zoom-100" shortcut="Shift+0">100 %</sf-menu-item>
        <sf-menu-item value="zoom-200">200 %</sf-menu-item>
      </sf-menu>
      <sf-icon-button label=${studioMessages.zoomIn} shortcut="Mod+=" size="sm" variant="ghost" @click=${() => port?.camera('zoom-in')}><sf-icon .icon=${plusIcon} size="16"></sf-icon></sf-icon-button>
    </div>`;
  }

  /** The command bar (§4.4) over what can run now; its rows run here. */
  private renderCommandBar(studio: Studio): TemplateResult {
    const tools: CommandEntry[] = studio.port
      .entries('tool@default')
      .filter((e) => !isExiting(e))
      .map((e) => {
        const shortcut = studio.registries.tool(e.slot.id)?.shortcut;
        return { value: `tool:${e.slot.id}`, title: e.slot.contribution.label, ...(shortcut === undefined ? {} : { shortcut }) };
      });
    const hasSelection = this.model.selection !== undefined && this.model.selection.nodes.length > 0;
    const camera: CommandEntry[] = [
      { value: 'camera:fit-page', title: studioMessages.zoomFit, shortcut: 'Shift+1' },
      ...(hasSelection ? [{ value: 'camera:fit-selection', title: studioMessages.zoomSelection, shortcut: 'Shift+2' }] : []),
      { value: 'camera:zoom-100', title: studioMessages.zoom100, shortcut: 'Shift+0' },
      { value: 'camera:zoom-in', title: studioMessages.zoomIn, shortcut: 'Mod+=' },
      { value: 'camera:zoom-out', title: studioMessages.zoomOut, shortcut: 'Mod+-' },
    ];
    const sources = { selection: this.model.selection, actions: this.model.actions, globalActions: this.model.globalActions, tools, camera, recent: [] };
    return html`<if-command-bar class="command-bar" .sources=${sources} @if-command=${(e: CustomEvent<{ value: string }>) => this.runCommand(studio, e.detail.value)}></if-command-bar>`;
  }

  private runCommand(studio: Studio, value: string): void {
    const [kind, ...rest] = value.split(':');
    const id = rest.join(':');
    const run: Readonly<Record<string, () => void>> = {
      // Commands that need no selection run without one (their inputs take no nodes).
      cap: () => (this.model.globalActions.includes(id) ? this.port?.invoke(id, {}, []) : this.port?.invoke(id)),
      tool: () => void studio.selectTool(id as ToolId),
      camera: () => this.port?.camera(id as CameraAction),
    };
    run[kind ?? '']?.();
  }

  private renderPanels(region: PanelPlacementId, context: PanelContext): TemplateResult | typeof nothing {
    const studio = this.studio as Studio;
    const entries = studio.port.entries(`panel@${region}`);
    if (entries.length === 0) return nothing;
    const label = entries.find((e) => !isExiting(e))?.slot.contribution.label ?? entries[0]?.slot.contribution.label ?? region;
    const side = region === 'inspector' ? 'end' : 'start';
    return html`<aside aria-label=${label} data-region=${region}>
      <sf-dock side=${side} label=${label} ?collapsed=${this.collapsed(region, entries, context.density)} @sf-collapse=${(e: CustomEvent<{ collapsed: boolean }>) => this.setExpanded(region, e.detail.collapsed)}>
        ${entries.map((entry) => this.renderPanel(entry, context))}
      </sf-dock>
    </aside>`;
  }

  private renderPanel(entry: SpecLayoutEntry, context: PanelContext): TemplateResult {
    const studio = this.studio as Studio;
    const panel = studio.registries.panel(entry.slot.id);
    const label = entry.slot.contribution.label;
    const below = panel !== undefined && DENSITY_RANK[context.density] < DENSITY_RANK[panel.minDensity];
    return html`<sf-panel label=${label} ?collapsed=${below} data-slot=${entry.slot.key} data-group=${`panel@${entry.slot.placement}`} data-phase=${entry.phase} style=${motionStyle(entry)} ?inert=${isExiting(entry)}>
      ${panel?.render(context) ?? nothing}
    </sf-panel>`;
  }

  /** The dock's tab changed; `sf-change` from controls inside its panels (composed, bubbling) is not a tab change. */
  private pickDockTab(e: CustomEvent<{ value: SpecSlotKey }>): void {
    if (e.target === e.currentTarget) this.dockTab = e.detail.value;
  }

  private renderDock(context: PanelContext): TemplateResult | typeof nothing {
    const studio = this.studio as Studio;
    const entries = studio.port.entries('panel@dock');
    if (entries.length === 0) return nothing;
    const present = entries.filter((e) => !isExiting(e));
    const selected = present.find((e) => e.slot.key === this.dockTab)?.slot.key ?? present[0]?.slot.key;
    return html`<aside aria-label=${studioMessages.dock} data-region="dock">
      <sf-dock side="start" label=${studioMessages.dock} ?collapsed=${this.collapsed('dock', entries, context.density)} @sf-collapse=${(e: CustomEvent<{ collapsed: boolean }>) => this.setExpanded('dock', e.detail.collapsed)}>
        <sf-tabs label=${studioMessages.dock} .value=${selected ?? ''} @sf-change=${(e: CustomEvent<{ value: SpecSlotKey }>) => this.pickDockTab(e)}>
          ${present.map((entry) => html`<sf-tab value=${entry.slot.key} data-slot=${entry.slot.key} data-group="panel@dock" data-phase=${entry.phase} style=${motionStyle(entry)}>${entry.slot.contribution.label}</sf-tab>`)}
          ${present.map((entry) => {
            const panel = studio.registries.panel(entry.slot.id);
            return html`<sf-tab-panel value=${entry.slot.key}>${panel?.render(context) ?? nothing}</sf-tab-panel>`;
          })}
        </sf-tabs>
      </sf-dock>
    </aside>`;
  }

  private renderProposal(proposal: SpecProposal | undefined): TemplateResult | typeof nothing {
    if (proposal === undefined || proposal.state !== 'previewing') return nothing;
    const diff = proposal.preview?.diff;
    const changes = diff === undefined ? 0 : diff.mount.length + diff.move.length + diff.unmount.length;
    return html`<section class="proposal" aria-label=${studioMessages.proposal}>
      <sf-tag tone="agent">✦ ${proposal.source.displayName ?? proposal.source.id} proposes</sf-tag>
      <span>${proposal.spec?.label ?? proposal.spec?.id}</span>
      ${proposal.reason === undefined ? nothing : html`<span class="muted">${proposal.reason}</span>`}
      <span class="muted">${changes} changes</span>
      <div class="actions">
        <sf-button size="sm" variant="agent" @click=${() => void proposal.open()}>${studioMessages.open}</sf-button>
        <sf-button size="sm" @click=${() => proposal.decline()}>${studioMessages.dismiss}</sf-button>
      </div>
    </section>`;
  }

  /**
   * The Home link (C0): a plain click asks the host first (`if-navigate`, cancelable) so it can save before leaving;
   * a host that cancels it navigates itself. Modified clicks (new tab) stay the browser's.
   */
  private onHome(e: MouseEvent): void {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const proceed = this.dispatchEvent(new CustomEvent('if-navigate', { detail: { href: this.homeHref }, bubbles: true, composed: true, cancelable: true }));
    if (!proceed) e.preventDefault();
  }
}

/** Define `<if-studio>` and the kit components it renders. */
export function defineStudio(registry: CustomElementRegistry = customElements): void {
  defineButton(registry);
  defineIconElement(registry);
  defineIconButton(registry);
  defineInlineEdit(registry);
  defineMenu(registry);
  definePopover(registry);
  defineSegmented(registry);
  defineTabs(registry);
  defineTag(registry);
  defineTextField(registry);
  defineDock(registry);
  defineHud(registry);
  defineCommandBar(registry);
  if (registry.get(studioComponent.tag) === undefined) defineComponent(IfStudioElement, registry);
}

declare global {
  interface HTMLElementTagNameMap {
    'if-studio': IfStudioElement;
    'if-hud': IfHudElement;
  }
}
