/**
 * Editor contributions (D7, D16): the closed vocabulary editor specs are made of. Every M1b work
 * package delivers its features as headless services plus these contributions — a lens, tools, panels
 * and HUD actions — and never builds its own screen layout (M1B-NOTES). Contributions are frozen data;
 * applicability (`lenses`, `scopes`) is data too, never a mode check in feature code (IF-17.4).
 *
 * Each kind has a multi token (`ToolContributionsToken`, …) and a unit helper (`toolContribution(item)`),
 * so a feature contributes with one line: `composeUnits([toolContribution(selectTool)])`.
 */
import type { KeyCombo } from '@staticflux/a11y';
import type { CapabilityId } from '@staticflux/capabilities';
import { contribution, token } from '@staticflux/core';
import type { GateResource } from '@staticflux/ui';
import type { LensId } from '../theme/lenses.js';

/** Contribution ids are namespaced: `instaflow/<name>` for first-party, `<extension>/<name>` otherwise. */
export type ContributionId = `${string}/${string}`;
export type LensContributionId = ContributionId;
export type ToolId = ContributionId;
export type PanelId = ContributionId;
export type ActionId = ContributionId;

/** Densities (UX §3): Focus (default for new users), Standard, Pro. */
export const DENSITIES = ['focus', 'standard', 'pro'] as const;
export type Density = (typeof DENSITIES)[number];

/** Rank of a density: a panel with `minDensity: 'pro'` shows only at Pro. */
export const DENSITY_RANK: Readonly<Record<Density, number>> = Object.freeze({ focus: 0, standard: 1, pro: 2 });

/** What a spec edits (ScopeRef kinds). */
export const SCOPE_KINDS = ['asset', 'page', 'selection', 'time-range', 'layer'] as const;
export type ScopeKind = (typeof SCOPE_KINDS)[number];

/**
 * Where a panel docks (Studio design `StudioCP.dc.html`): `side` is the contextual side panel (chat),
 * `dock` the tabbed left dock (Layers, Pages, Assets, Brand), `inspector` the right column (Properties),
 * `tray` the bottom tray (filmstrip, tracks).
 */
export const PANEL_PLACEMENTS = ['side', 'dock', 'inspector', 'tray'] as const;
export type PanelPlacementId = (typeof PANEL_PLACEMENTS)[number];

interface ContributionBase<Kind extends string> {
  readonly kind: Kind;
  readonly id: ContributionId;
  readonly label: string;
  readonly description?: string;
  /** Hidden and rejected in specs unless the gate allows it. UX, not security (R6.16). */
  readonly gate?: GateResource;
  /** Lenses it applies under (default: every lens). */
  readonly lenses?: readonly LensContributionId[];
  /** Scope kinds it applies to (default: every scope). */
  readonly scopes?: readonly ScopeKind[];
}

/** A lens: a kind of editing with its own colour and shape (theme lens palette). */
export interface LensContribution extends Omit<ContributionBase<'instaflow/lens'>, 'lenses'> {
  /** The lens palette entry (colour + shape) it is drawn with. */
  readonly palette: LensId;
  /** Lens switch shortcut (UX §9: `1`–`4`; Pages `5`). */
  readonly shortcut?: KeyCombo;
}

/** A tool in the toolbar (the tool behaviour itself is B3's). */
export interface ToolContribution extends ContributionBase<'instaflow/tool'> {
  /** Short glyph shown in the button (decorative; the label is the accessible name). */
  readonly glyph: string;
  readonly shortcut?: KeyCombo;
}

/** What a panel renders with. */
export interface PanelContext {
  readonly density: Density;
  readonly lens: LensContributionId;
  readonly scope: ScopeKind;
}

/** A docked panel. `placements[0]` is its default place. */
export interface PanelContribution extends ContributionBase<'instaflow/panel'> {
  readonly placements: readonly PanelPlacementId[];
  /** Lowest density it shows at; below it the panel stays mounted but collapsed (Properties: `pro`). */
  readonly minDensity: Density;
  /** The panel body (a Lit renderable). */
  readonly render: (context: PanelContext) => unknown;
}

/** HUD tone (UX §2): direct manipulations, ✦ generative/agent actions, `⋯ More`. */
export const HUD_TONES = ['direct', 'agent', 'more'] as const;
export type HudTone = (typeof HUD_TONES)[number];

/** A contextual action offered on the selection. Runs `capability` (when set) through the capability pipeline. */
export interface HudActionContribution extends ContributionBase<'instaflow/hud-action'> {
  readonly tone: HudTone;
  readonly capability?: CapabilityId;
  readonly shortcut?: KeyCombo;
}

export type EditorContribution = LensContribution | ToolContribution | PanelContribution | HudActionContribution;

type Init<C extends { kind: string }> = Omit<C, 'kind'>;

/* @__NO_SIDE_EFFECTS__ */
export function defineLens(init: Init<LensContribution>): LensContribution {
  return Object.freeze({ ...init, kind: 'instaflow/lens' });
}

/* @__NO_SIDE_EFFECTS__ */
export function defineTool(init: Init<ToolContribution>): ToolContribution {
  return Object.freeze({ ...init, kind: 'instaflow/tool' });
}

/* @__NO_SIDE_EFFECTS__ */
export function definePanel(init: Omit<Init<PanelContribution>, 'minDensity'> & { readonly minDensity?: Density }): PanelContribution {
  return Object.freeze({ ...init, minDensity: init.minDensity ?? 'focus', kind: 'instaflow/panel' });
}

/* @__NO_SIDE_EFFECTS__ */
export function defineHudAction(init: Init<HudActionContribution>): HudActionContribution {
  return Object.freeze({ ...init, kind: 'instaflow/hud-action' });
}

export const LensContributionsToken = /* @__PURE__ */ token('instaflow/lens-contributions').multi<LensContribution>();
export const ToolContributionsToken = /* @__PURE__ */ token('instaflow/tool-contributions').multi<ToolContribution>();
export const PanelContributionsToken = /* @__PURE__ */ token('instaflow/panel-contributions').multi<PanelContribution>();
export const HudActionContributionsToken = /* @__PURE__ */ token('instaflow/hud-action-contributions').multi<HudActionContribution>();

/* @__NO_SIDE_EFFECTS__ */
export function lensContribution(item: LensContribution) {
  return contribution({ id: `${item.id}-lens`, provides: LensContributionsToken, scope: 'app', create: () => item, description: `Lens ${item.label}.` });
}

/* @__NO_SIDE_EFFECTS__ */
export function toolContribution(item: ToolContribution) {
  return contribution({ id: `${item.id}-tool`, provides: ToolContributionsToken, scope: 'app', create: () => item, description: `Tool ${item.label}.` });
}

/* @__NO_SIDE_EFFECTS__ */
export function panelContribution(item: PanelContribution) {
  return contribution({ id: `${item.id}-panel`, provides: PanelContributionsToken, scope: 'app', create: () => item, description: `Panel ${item.label}.` });
}

/* @__NO_SIDE_EFFECTS__ */
export function hudActionContribution(item: HudActionContribution) {
  return contribution({ id: `${item.id}-hud`, provides: HudActionContributionsToken, scope: 'app', create: () => item, description: `HUD action ${item.label}.` });
}
