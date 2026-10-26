/**
 * The Studio spec (D19: canvas-first) — the maximal editor: the Canvas lens over the whole asset, the
 * full toolbar, chat as a contextual side panel, the tabbed dock (Layers, Pages, Assets, Milestones, Brand),
 * Typography in the inspector, the HUD and every editor capability, at Pro density. Studio is a spec,
 * not a screen: the mode switcher applies `studioSpecFor(lens)` (modes are well-known specs, D4/D16), and
 * the runtime only changes what differs.
 *
 * **The scope follows the selection** (B8): with elements selected Studio's spec is scoped to them
 * (`{ kind: 'selection', nodes }`) and gains the selection's HUD actions (align, booleans, masks, repeat,
 * text, rotate, describe) and inspector panels (Fill / stroke / effects, Repeat). Contributions declare the
 * scopes they apply to, so these come from `STUDIO_SCOPE_HUD` / `STUDIO_SCOPE_PANELS`.
 *
 * The per-lens and per-scope toolbars, HUD rows and extra panels are variant tables (data), never a branch on
 * mode.
 */
import { editDocumentCapability, proposeSpecCapability } from './capabilities.js';
import type { ActionId, LensContributionId, ScopeKind, ToolId } from './contributions.js';
import { defineEditorSpec, type EditorSpec, type PanelPlacement } from './schema.js';
import { StudioIds } from './studio-ids.js';

const { lens: L, tool: T, panel: P, hud: H } = StudioIds;

/**
 * B8: the M1b HUD actions Studio places on a selection, by feature (ids are their capability ids). Contributed by B1
 * (`elementHudActions`), B7 (`repeatHudActions`), B2 (`textHudActions`), B3 and B10a (`toolHudActions`), B6 (`describeHudAction`).
 * Kept here, not in `StudioIds`, so features that import the ids do not carry them.
 */
export const STUDIO_SELECTION_HUD = Object.freeze({
  elements: [
    'instaflow/align-left',
    'instaflow/align-center-x',
    'instaflow/align-right',
    'instaflow/align-top',
    'instaflow/align-center-y',
    'instaflow/align-bottom',
    'instaflow/center-in-container',
    'instaflow/distribute-h-spacing',
    'instaflow/distribute-v-spacing',
    'instaflow/tidy-up',
    'instaflow/boolean-union',
    'instaflow/boolean-subtract',
    'instaflow/boolean-intersect',
    'instaflow/boolean-exclude',
    'instaflow/mask-clip',
    'instaflow/distribute-h-centers',
    'instaflow/distribute-v-centers',
    'instaflow/boolean-release',
    'instaflow/flatten',
    'instaflow/outline-stroke',
    'instaflow/mask-alpha',
    'instaflow/mask-luminance',
    'instaflow/mask-invert',
    'instaflow/mask-release',
    'instaflow/apply-token',
    // B12: structure actions (all `more`; B11b also places them in the pill, the context menu and Layers).
    'instaflow/group',
    'instaflow/ungroup',
    'instaflow/frame-selection',
    'instaflow/bring-forward',
    'instaflow/send-backward',
    'instaflow/bring-to-front',
    'instaflow/send-to-back',
    'instaflow/rename',
    'instaflow/hide',
    'instaflow/show-all',
    'instaflow/image-crop',
    'instaflow/image-crop-reset',
  ],
  repeat: ['instaflow/repeat-radial', 'instaflow/repeat-grid', 'instaflow/repeat-mirror', 'instaflow/repeat-edit', 'instaflow/repeat-expand', 'instaflow/repeat-release'],
  text: ['instaflow/text-font', 'instaflow/text-size', 'instaflow/text-fit'],
  tools: ['instaflow/rotate-90-cw', 'instaflow/rotate-90-ccw', 'instaflow/flip-horizontal', 'instaflow/flip-vertical', 'instaflow/free-transform-hud'],
  a11y: ['instaflow/describe-canvas'],
} as const);
const S = STUDIO_SELECTION_HUD;

/** Toolbar per lens, in order. */
export const STUDIO_LENS_TOOLS: Readonly<Record<LensContributionId, readonly ToolId[]>> = Object.freeze({
  // B11b: no Pen until its controller exists (STUDIO-UX-SPEC §4.1); the shape family follows Shape.
  [L.canvas]: [T.select, T.frame, T.shape, T.ellipse, T.polygon, T.star, T.line, T.text, T.hand],
  [L.pixel]: [T.select, T.brush, T.heal, T.crop, T.hand],
  [L.timeline]: [T.select, T.split, T.hand],
  [L.flow]: [T.select, T.connect, T.hand],
  [L.pages]: [T.select, T.shape, T.ellipse, T.polygon, T.star, T.line, T.text, T.hand],
});

/**
 * HUD row per lens (UX §2: fixed manipulations, ✦ generative, Animate, Ask). Actions of tone `more` collapse into
 * the HUD's one "More actions" menu, so the row has no separate More slot (B8).
 */
export const STUDIO_LENS_HUD: Readonly<Record<LensContributionId, readonly ActionId[]>> = Object.freeze({
  // B11b: no assistant or motion actions until they run (STUDIO-UX-SPEC §2.2, Appendix A).
  [L.canvas]: [],
  [L.pixel]: [H.removeBackground, H.ask],
  [L.timeline]: [H.animate, H.ask],
  [L.flow]: [H.ask],
  [L.pages]: [],
});

/** Panels every Studio lens shares (selection, undo, chat and the dock persist across lenses, UX §4). */
export const STUDIO_PANELS: readonly PanelPlacement[] = Object.freeze([
  // B11b: only built panels are placed (nothing visible is inert): no Chat (M2) or Brand (B-4) placeholder; Export is
  // the top bar's Export dialog, not a dock tab.
  // B11b: Layers is a real list now (STUDIO-UX-SPEC §3.1), the dock's first tab.
  { panel: P.layers, dock: 'dock' },
  { panel: P.pages, dock: 'dock' },
  { panel: P.assets, dock: 'dock' },
  { panel: P.milestones, dock: 'dock' },
  // B11b: one inspector with every section of the selection kind (STUDIO-UX-SPEC §5) replaces the per-feature panels.
  { panel: P.inspector, dock: 'inspector' },
]);

/** Extra panels per lens. */
export const STUDIO_LENS_PANELS: Readonly<Record<LensContributionId, readonly PanelPlacement[]>> = Object.freeze({
  [L.canvas]: [],
  [L.pixel]: [{ panel: P.adjust, dock: 'inspector' }],
  [L.timeline]: [],
  [L.flow]: [],
  [L.pages]: [],
});

/** HUD actions a scope adds per lens (B8: the selection's actions, by feature, direct ones first). */
export const STUDIO_SCOPE_HUD: Readonly<Partial<Record<ScopeKind, Readonly<Record<LensContributionId, readonly ActionId[]>>>>> = Object.freeze({
  selection: {
    [L.canvas]: [...S.repeat.slice(0, 3), ...S.elements, ...S.text, ...S.repeat.slice(3), ...S.tools, ...S.a11y],
    [L.pages]: [...S.text, ...S.a11y],
  },
});

/** Panels a scope adds per lens (B8: the selection's inspectors). */
export const STUDIO_SCOPE_PANELS: Readonly<Partial<Record<ScopeKind, Readonly<Record<LensContributionId, readonly PanelPlacement[]>>>>> = Object.freeze({
  selection: {
    // B11b: the inspector panel shows the selection's sections itself (Transform first, as in design tools).
    [L.canvas]: [],
  },
});

export const STUDIO_CAPABILITIES = Object.freeze([editDocumentCapability.id, proposeSpecCapability.id]);

export const studioSpec: EditorSpec = defineEditorSpec({
  id: 'instaflow/studio',
  label: 'Studio',
  lens: L.canvas,
  scope: { kind: 'asset' },
  tools: STUDIO_LENS_TOOLS[L.canvas] ?? [],
  panels: [...STUDIO_PANELS, ...(STUDIO_LENS_PANELS[L.canvas] ?? [])],
  hud: STUDIO_LENS_HUD[L.canvas] ?? [],
  capabilities: STUDIO_CAPABILITIES,
  // B11b: Standard is the default density (STUDIO-UX-SPEC §14.3).
  density: 'standard',
});

/** Studio under another lens (a mode switch is a spec change). Keeps the base's scope, density and pins. */
export function studioSpecFor(lens: LensContributionId, base: EditorSpec = studioSpec): EditorSpec {
  const scope = base.scope.kind;
  return defineEditorSpec({
    ...base,
    lens,
    tools: STUDIO_LENS_TOOLS[lens] ?? [],
    panels: [...STUDIO_PANELS, ...(STUDIO_LENS_PANELS[lens] ?? []), ...(STUDIO_SCOPE_PANELS[scope]?.[lens] ?? [])],
    hud: [...(STUDIO_LENS_HUD[lens] ?? []), ...(STUDIO_SCOPE_HUD[scope]?.[lens] ?? [])],
  });
}
