/**
 * `<if-studio>` — the Studio frame (`docs/instaflow/design/StudioCP.dc.html`), laid out entirely from
 * the mounted editor spec: the top bar (home, breadcrumb, the lens mode switcher, save state, agent
 * chip, density, Milestone, Share), the contextual side panel (chat), the tabbed left dock, the canvas
 * region (tools, the HUD slot, the canvas surface behind the A7 modules, the command bar, zoom, a
 * proposed-editor card) and the inspector. Every slot is a kit component under the active theme
 * (Clean Pop): no app colours, no one-off control styles.
 *
 * It renders from the Studio controller's reactive layout model (`studio.port`), so a spec diff only
 * re-renders what changed; entering, moving and exiting slots carry `data-phase` and their 120–200 ms
 * motion (0 under reduced motion). Slot elements carry `data-slot` and `data-group` (`panel@dock`).
 */
import type { ShortcutRegistry } from '@staticflux/a11y';
import { createScope, type Scope } from '@staticflux/core';
import { defineButton } from '@staticflux/kit/button';
import { defineDock } from '@staticflux/kit/dock';
import { defineIconButton } from '@staticflux/kit/icon-button';
import { defineMenu } from '@staticflux/kit/menu';
import { defineSegmented, type SegmentOption } from '@staticflux/kit/segmented';
import { defineTabs } from '@staticflux/kit/tabs';
import { defineTag } from '@staticflux/kit/tag';
import { defineTextField } from '@staticflux/kit/text-field';
import { defineToolbar, type SfToolbarElement } from '@staticflux/kit/toolbar';
import type { SpecLayoutEntry, SpecSlotKey } from '@staticflux/shell/spec';
import { component, defineComponent, SfElement } from '@staticflux/ui';
import { themeTokens as t } from '@staticflux/ui/theme';
import { css, html, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { DENSITIES, DENSITY_RANK, type Density, type HudTone, type PanelContext, type PanelPlacementId, type ScopeKind } from '../spec/contributions.js';
import type { SpecProposal } from '../spec/proposals.js';
import { lensMarkStyle, lensOf, lenses } from '../theme/lenses.js';
import type { CanvasPort, CanvasSession } from './canvas.js';
import type { Studio } from './studio.js';

/** User-facing strings (props override them; i18n lands with the app shell). */
export const studioMessages = Object.freeze({
  home: 'Home',
  breadcrumb: 'Breadcrumb',
  mode: 'Mode',
  density: 'Density',
  densities: { focus: 'Focus', standard: 'Standard', pro: 'Pro' } as Readonly<Record<Density, string>>,
  saved: 'Saved',
  milestone: 'Milestone',
  share: 'Share',
  dock: 'Dock',
  tools: 'Tools',
  hud: 'Selection actions',
  canvas: 'Canvas',
  canvasSurface: 'Canvas surface',
  commandBar: 'Command bar',
  commandPlaceholder: 'Ask Claude or type a command',
  zoom: 'Zoom',
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  proposal: 'Proposed editor',
  open: 'Open',
  dismiss: 'Dismiss',
  pin: (label: string) => `Pin ${label}`,
  moreActions: 'More actions',
  canvasFailed: 'The canvas could not start. The rest of Studio still works.',
});

/**
 * How each HUD tone renders (UX §2): direct manipulations ghost, ✦ agent actions soft. Tone `more` actions all go
 * into the one "More actions" menu (`HUD_MORE`), so the bar stays short however many features contribute.
 */
const HUD_CONTROLS: Readonly<Record<Exclude<HudTone, 'more'>, (entry: SpecLayoutEntry, run: () => void) => TemplateResult>> = Object.freeze({
  direct: (entry, run) =>
    html`<sf-button size="sm" variant="ghost" data-slot=${entry.slot.key} data-group="hud@default" data-phase=${entry.phase} style=${motionStyle(entry)} ?inert=${isExiting(entry)} @click=${run}>${entry.slot.contribution.label}</sf-button>`,
  agent: (entry, run) =>
    html`<sf-button size="sm" variant="agent-soft" data-slot=${entry.slot.key} data-group="hud@default" data-phase=${entry.phase} style=${motionStyle(entry)} ?inert=${isExiting(entry)} @click=${run}>✦ ${entry.slot.contribution.label}</sf-button>`,
});

/** The More menu: one trigger, one item per `more` action (each item is its slot). */
const HUD_MORE = (entries: readonly SpecLayoutEntry[], run: (action: string) => void): TemplateResult | typeof nothing =>
  entries.length === 0
    ? nothing
    : html`<sf-menu label=${studioMessages.moreActions} data-hud-more @sf-select=${(e: CustomEvent<{ value: string }>) => run(e.detail.value)}>
        <sf-icon-button slot="trigger" label=${studioMessages.moreActions} size="sm" variant="ghost"><span aria-hidden="true">⋯</span></sf-icon-button>
        ${entries.map(
          (entry) =>
            html`<sf-menu-item value=${entry.slot.id} data-slot=${entry.slot.key} data-group="hud@default" data-phase=${entry.phase} ?disabled=${isExiting(entry)}>${entry.slot.contribution.label}</sf-menu-item>`,
        )}
      </sf-menu>`;

const AUTONOMY_LABEL = Object.freeze({ plan: 'Plan', ask: 'Ask', 'accept-edits': 'Accept edits', autopilot: 'Autopilot' });

const studioComponent = component({
  tag: 'if-studio',
  placeholder: () => nothing,
  description: 'Instaflow Studio frame, laid out from the mounted editor spec (M1b B0).',
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
        flex-wrap: wrap;
        align-items: center;
        gap: ${t.space.md.css};
        min-block-size: ${t.size.toolbar.css};
        padding-inline: ${t.space.md.css};
        border-block-end: 1px solid ${t.color.border.css};
      }
      .home {
        display: inline-flex;
        border-radius: ${t.radius.sm.css};
      }
      .home:focus-visible,
      .surface:focus-visible {
        outline: 2px solid ${t.color.focusRing.css};
        outline-offset: 2px;
      }
      nav {
        display: flex;
        align-items: center;
        gap: ${t.space.xs.css};
        color: ${t.color.textMuted.css};
      }
      .title {
        font-family: ${t.font.familyDisplay.css};
        font-weight: ${t.font.weightDisplay.css};
        font-size: ${t.type.sizeLg.css};
        color: ${t.color.text.css};
      }
      .modes {
        margin-inline: auto;
      }
      .saved {
        color: ${t.color.textMuted.css};
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
        display: grid;
        grid-template-rows: auto auto 1fr auto;
        gap: ${t.space.sm.css};
        padding: ${t.space.md.css};
        background-color: ${t.color.neutral4.css};
        background-image: radial-gradient(${t.color.neutral7.css} 1px, transparent 1px);
        background-size: 20px 20px;
      }
      .tools,
      .hud {
        justify-self: center;
        background: ${t.color.surface2.css};
        border-radius: ${t.radius.full.css};
        box-shadow: ${t.shadow.level1.css};
        padding: ${t.space.xs.css};
        max-inline-size: 100%;
      }
      .surface {
        position: relative;
        overflow: hidden;
        min-block-size: 0;
        border-radius: ${t.radius.md.css};
      }
      /*
       * The kit toolbar is an inline-size container, so it has no intrinsic width (B8): the tools pill gets its width
       * from its item count; the HUD spans the canvas region and always takes two rows however many actions a
       * selection brings (it scrolls, the canvas keeps its size). A fixed block size, not only a maximum: a HUD that
       * grew from one row (no selection) to two (a selection's actions) moved the surface 40 px under the pointer, so
       * a drag that started as the HUD re-laid out lost that distance (IF-33.20 smoke, colocated topology).
       */
      .tools {
        inline-size: calc(var(--if-items, 6) * (${t.size.controlLg.css} + ${t.space.xs.css}) + 2 * ${t.space.sm.css} + 2 * ${t.space.xs.css});
      }
      .hud {
        justify-self: stretch;
        block-size: calc(${t.size.toolbar.css} * 2);
        max-block-size: calc(${t.size.toolbar.css} * 2);
        overflow-y: auto;
        scrollbar-width: thin;
      }
      .bottom {
        display: flex;
        align-items: center;
        gap: ${t.space.md.css};
      }
      .zoom {
        display: inline-flex;
        align-items: center;
        gap: ${t.space.xs.css};
        padding: ${t.space.xs.css};
        background: ${t.color.surface2.css};
        border: 1px solid ${t.color.border.css};
        border-radius: ${t.radius.full.css};
        font-family: ${t.font.familyMono.css};
      }
      .command {
        flex: 1;
        display: flex;
        align-items: center;
        gap: ${t.space.sm.css};
        max-inline-size: 520px;
        margin-inline: auto;
        padding-inline: ${t.space.md.css} ${t.space.xs.css};
        background: ${t.color.surface2.css};
        border: 1px solid ${t.color.border.css};
        border-radius: ${t.radius.full.css};
        box-shadow: ${t.shadow.level1.css};
      }
      .command sf-text-field {
        flex: 1;
      }
      .proposal {
        position: absolute;
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
        color: ${t.color.dangerText.css};
      }
      [data-phase='entering'] {
        animation: if-enter var(--if-motion, 0ms) var(--if-ease, ease) both;
      }
      [data-phase='moving'] {
        animation: if-move var(--if-motion, 0ms) var(--if-ease, ease) both;
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
      @keyframes if-move {
        from {
          opacity: 0.5;
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
  /** The canvas zoom (1 = 100 %) shown in the zoom control. */
  declare zoom: number;
  /** Regions the person expanded although the density collapses them. */
  declare expanded: ReadonlySet<PanelPlacementId>;
  declare dockTab: SpecSlotKey | undefined;
  private wired: Scope | undefined;
  private canvasSession: CanvasSession | undefined;

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
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    const wired = this.wired;
    this.wired = undefined;
    void wired?.dispose();
    const session = this.canvasSession;
    this.canvasSession = undefined;
    void session?.stop();
  }

  protected override updated(changed: PropertyValues): void {
    super.updated(changed);
    if (this.wired === undefined && this.studio !== undefined && this.isConnected) this.wire(this.studio);
  }

  /** Focus the first HUD control (`Alt+Enter`). */
  focusHud(): void {
    const items = this.query<SfToolbarElement>('.hud')?.items ?? [];
    (items.find((item) => item.tabIndex === 0) ?? items[0])?.focus();
  }

  /** Focus the command bar (`Mod+K`). */
  focusCommandBar(): void {
    this.query<HTMLElement>('.command sf-text-field')?.focus();
  }

  /** Focus the canvas surface (`Escape`). */
  focusCanvas(): void {
    this.query<HTMLElement>('.surface')?.focus();
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

  private context(): PanelContext {
    const context = this.studio?.port.mountedContext ?? {};
    return { density: (context['density'] as Density | undefined) ?? 'focus', lens: context['lens'] as PanelContext['lens'], scope: (context['scope'] as ScopeKind | undefined) ?? 'asset' };
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
        ${this.renderPanels('side', context)} ${this.renderDock(context)}
        <main aria-label=${studioMessages.canvas}>
          ${this.renderTools(studio)} ${this.renderHud()}
          <div class="surface" tabindex="0" role="application" aria-roledescription="canvas" aria-label=${studioMessages.canvasSurface}></div>
          <div class="bottom">
            <div role="group" aria-label=${studioMessages.zoom} class="zoom">
              <sf-icon-button label=${studioMessages.zoomOut} size="sm" variant="ghost" @click=${() => this.emitIntent('zoom-out')}><span aria-hidden="true">−</span></sf-icon-button>
              <span>${Math.round(this.zoom * 100)}%</span>
              <sf-icon-button label=${studioMessages.zoomIn} size="sm" variant="ghost" @click=${() => this.emitIntent('zoom-in')}><span aria-hidden="true">+</span></sf-icon-button>
            </div>
            <div class="command">
              <span aria-hidden="true">✦</span>
              <sf-text-field label=${studioMessages.commandBar} label-hidden placeholder=${studioMessages.commandPlaceholder} @change=${(e: Event) => this.emitCommand(e)}></sf-text-field>
              <sf-tag mono>⌘K</sf-tag>
            </div>
          </div>
          ${this.canvasError === undefined ? nothing : html`<p role="alert">${this.canvasError}</p>`} ${this.renderProposal(studio.proposals.pending)}
        </main>
        ${this.renderPanels('inspector', context)}
      </div>
      ${this.renderPanels('tray', context)}`;
  }

  private renderTopBar(studio: Studio, density: Density): TemplateResult {
    const lensEntry = studio.port.entries('lens@default').find((e) => !isExiting(e));
    const options: SegmentOption[] = studio.registries.lenses.map((lens) => ({
      value: lens.id,
      label: lens.label,
      icon: html`<span aria-hidden="true" style=${lensMarkStyle(lensOf(lens.palette))}></span>`,
    }));
    const densities: SegmentOption[] = DENSITIES.map((d) => ({ value: d, label: studioMessages.densities[d] }));
    return html`<header>
      <a class="home" href=${this.homeHref} aria-label=${studioMessages.home}>${logo()}</a>
      <nav aria-label=${studioMessages.breadcrumb}><span>${this.projectTitle}</span><span aria-hidden="true">/</span><span class="title">${this.assetTitle}</span></nav>
      <sf-segmented
        class="modes"
        label=${studioMessages.mode}
        .options=${options}
        value=${lensEntry?.slot.id ?? ''}
        data-slot=${lensEntry?.slot.key ?? nothing}
        data-group="lens@default"
        @sf-change=${(e: CustomEvent<{ value: string }>) => void studio.switchLens(e.detail.value as `${string}/${string}`)}
      ></sf-segmented>
      ${this.status === undefined ? html`<span class="saved" role="status">${studioMessages.saved}</span>` : this.status}
      <sf-tag tone="agent">✦ Claude · ${AUTONOMY_LABEL[studio.proposals.autonomy]}</sf-tag>
      <sf-segmented label=${studioMessages.density} .options=${densities} value=${density} @sf-change=${(e: CustomEvent<{ value: Density }>) => void studio.setDensity(e.detail.value)}></sf-segmented>
      <sf-button @click=${() => this.emitIntent('milestone')}>${studioMessages.milestone}</sf-button>
      <sf-button variant="primary" @click=${() => this.emitIntent('share')}>${studioMessages.share}</sf-button>
    </header>`;
  }

  private renderTools(studio: Studio): TemplateResult {
    const entries = studio.port.entries('tool@default');
    const active = studio.activeTool;
    return html`<sf-toolbar class="tools" label=${studioMessages.tools} style=${`--if-items:${entries.length}`}>
      ${entries.map((entry) => {
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
          ?inert=${isExiting(entry)}
          @click=${() => studio.selectTool(entry.slot.id)}
          ><span aria-hidden="true">${tool?.glyph ?? entry.slot.contribution.label.slice(0, 1)}</span></sf-icon-button
        >`;
      })}
    </sf-toolbar>`;
  }

  private renderHud(): TemplateResult {
    const studio = this.studio as Studio;
    const entries = studio.port.entries('hud@default');
    const tone = (entry: SpecLayoutEntry): HudTone => studio.registries.hud(entry.slot.id)?.tone ?? 'direct';
    const more = entries.filter((entry) => tone(entry) === 'more');
    return html`<sf-toolbar class="hud" label=${studioMessages.hud}>
      ${entries.flatMap((entry) => {
        const kind = tone(entry);
        return kind === 'more' ? [] : [HUD_CONTROLS[kind](entry, () => this.emitAction(entry.slot.id))];
      })}
      ${HUD_MORE(more, (action) => this.emitAction(action))}
    </sf-toolbar>`;
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
    return html`<sf-panel
      label=${label}
      ?collapsed=${below}
      data-slot=${entry.slot.key}
      data-group=${`panel@${entry.slot.placement}`}
      data-phase=${entry.phase}
      style=${motionStyle(entry)}
      ?inert=${isExiting(entry)}
    >
      ${this.renderPin(entry.slot.key, label)} ${panel?.render(context) ?? nothing}
    </sf-panel>`;
  }

  private renderPin(slot: SpecSlotKey, label: string): TemplateResult {
    const studio = this.studio as Studio;
    return html`<sf-icon-button slot="actions" size="sm" variant="ghost" label=${studioMessages.pin(label)} .pressed=${studio.runtime.pinned.has(slot)} @click=${() => studio.togglePin(slot)}
      ><span aria-hidden="true">⚲</span></sf-icon-button
    >`;
  }

  private renderDock(context: PanelContext): TemplateResult | typeof nothing {
    const studio = this.studio as Studio;
    const entries = studio.port.entries('panel@dock');
    if (entries.length === 0) return nothing;
    const present = entries.filter((e) => !isExiting(e));
    const selected = present.find((e) => e.slot.key === this.dockTab)?.slot.key ?? present[0]?.slot.key;
    return html`<aside aria-label=${studioMessages.dock} data-region="dock">
      <sf-dock side="start" label=${studioMessages.dock} ?collapsed=${this.collapsed('dock', entries, context.density)} @sf-collapse=${(e: CustomEvent<{ collapsed: boolean }>) => this.setExpanded('dock', e.detail.collapsed)}>
        <sf-tabs label=${studioMessages.dock} .value=${selected ?? ''} @sf-change=${(e: CustomEvent<{ value: SpecSlotKey }>) => (this.dockTab = e.detail.value)}>
          ${present.map((entry) => html`<sf-tab value=${entry.slot.key} data-slot=${entry.slot.key} data-group="panel@dock" data-phase=${entry.phase} style=${motionStyle(entry)}>${entry.slot.contribution.label}</sf-tab>`)}
          ${present.map((entry) => {
            const panel = studio.registries.panel(entry.slot.id);
            return html`<sf-tab-panel value=${entry.slot.key}>${this.renderPin(entry.slot.key, entry.slot.contribution.label)} ${panel?.render(context) ?? nothing}</sf-tab-panel>`;
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

  private emitIntent(intent: 'zoom-in' | 'zoom-out' | 'milestone' | 'share'): void {
    this.dispatchEvent(new CustomEvent('if-intent', { detail: { intent }, bubbles: true, composed: true }));
  }

  private emitAction(action: string): void {
    this.dispatchEvent(new CustomEvent('if-hud-action', { detail: { action }, bubbles: true, composed: true }));
  }

  private emitCommand(event: Event): void {
    const field = event.currentTarget as { value?: string };
    const text = field.value ?? '';
    if (text.trim().length === 0) return;
    this.dispatchEvent(new CustomEvent('if-command', { detail: { text }, bubbles: true, composed: true }));
  }
}

/** The logo: the four lens marks (decorative; the link is named "Home"). */
function logo(): TemplateResult {
  const [layout, pixel, video, flow] = lenses();
  return html`<svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true">
    <rect x="2" y="2" width="13" height="13" rx="4" fill=${layout?.color ?? 'currentColor'}></rect>
    <circle cx="23.5" cy="8.5" r="6.5" fill=${pixel?.color ?? 'currentColor'}></circle>
    <rect x="2" y="19" width="13" height="9" rx="3" fill=${video?.color ?? 'currentColor'}></rect>
    <rect x="17" y="17" width="13" height="13" rx="6.5" fill=${flow?.color ?? 'currentColor'}></rect>
  </svg>`;
}

/** Define `<if-studio>` and the kit components it renders. */
export function defineStudio(registry: CustomElementRegistry = customElements): void {
  defineButton(registry);
  defineIconButton(registry);
  defineMenu(registry);
  defineSegmented(registry);
  defineTabs(registry);
  defineTag(registry);
  defineTextField(registry);
  defineToolbar(registry);
  defineDock(registry);
  if (registry.get(studioComponent.tag) === undefined) defineComponent(IfStudioElement, registry);
}

declare global {
  interface HTMLElementTagNameMap {
    'if-studio': IfStudioElement;
  }
}
