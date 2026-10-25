/**
 * The Studio spec (D19: canvas-first) — the maximal editor: the Canvas lens over the whole asset, the
 * full toolbar, chat as a contextual side panel, the tabbed dock (Layers, Pages, Assets, Brand),
 * Properties in the inspector, the HUD and every editor capability, at Pro density. Studio is a spec,
 * not a screen: the mode switcher applies `studioSpecFor(lens)` (modes are well-known specs, D4/D16), and
 * the runtime only changes what differs.
 *
 * The per-lens toolbars, HUD rows and extra panels are variant tables (data), never a branch on mode.
 */
import { editDocumentCapability, proposeSpecCapability } from './capabilities.js';
import type { ActionId, LensContributionId, ToolId } from './contributions.js';
import { defineEditorSpec, type EditorSpec, type PanelPlacement } from './schema.js';
import { StudioIds } from './studio-contributions.js';

const { lens: L, tool: T, panel: P, hud: H } = StudioIds;

/** Toolbar per lens, in order. */
export const STUDIO_LENS_TOOLS: Readonly<Record<LensContributionId, readonly ToolId[]>> = Object.freeze({
  [L.canvas]: [T.select, T.frame, T.shape, T.text, T.pen, T.hand],
  [L.pixel]: [T.select, T.brush, T.heal, T.crop, T.hand],
  [L.timeline]: [T.select, T.split, T.hand],
  [L.flow]: [T.select, T.connect, T.hand],
});

/** HUD row per lens (UX §2: fixed manipulations, ✦ generative, Animate, More, Ask). */
export const STUDIO_LENS_HUD: Readonly<Record<LensContributionId, readonly ActionId[]>> = Object.freeze({
  [L.canvas]: [H.rewrite, H.animate, H.more, H.ask],
  [L.pixel]: [H.removeBackground, H.more, H.ask],
  [L.timeline]: [H.animate, H.more, H.ask],
  [L.flow]: [H.more, H.ask],
});

/** Panels every Studio lens shares (selection, undo, chat and the dock persist across lenses, UX §4). */
export const STUDIO_PANELS: readonly PanelPlacement[] = Object.freeze([
  { panel: P.chat, dock: 'side' },
  { panel: P.layers, dock: 'dock' },
  { panel: P.pages, dock: 'dock' },
  { panel: P.assets, dock: 'dock' },
  { panel: P.brand, dock: 'dock' },
  { panel: P.properties, dock: 'inspector' },
]);

/** Extra panels per lens. */
export const STUDIO_LENS_PANELS: Readonly<Record<LensContributionId, readonly PanelPlacement[]>> = Object.freeze({
  [L.canvas]: [],
  [L.pixel]: [{ panel: P.adjust, dock: 'inspector' }],
  [L.timeline]: [],
  [L.flow]: [],
});

export const STUDIO_CAPABILITIES = Object.freeze([editDocumentCapability.id, proposeSpecCapability.id]);

export const studioSpec: EditorSpec = defineEditorSpec({
  id: 'instaflow/studio',
  label: 'Studio',
  lens: L.canvas,
  scope: { kind: 'asset' },
  tools: STUDIO_LENS_TOOLS[L.canvas] ?? [],
  panels: STUDIO_PANELS,
  hud: STUDIO_LENS_HUD[L.canvas] ?? [],
  capabilities: STUDIO_CAPABILITIES,
  density: 'pro',
});

/** Studio under another lens (a mode switch is a spec change). Keeps the base's scope, density and pins. */
export function studioSpecFor(lens: LensContributionId, base: EditorSpec = studioSpec): EditorSpec {
  return defineEditorSpec({
    ...base,
    lens,
    tools: STUDIO_LENS_TOOLS[lens] ?? [],
    panels: [...STUDIO_PANELS, ...(STUDIO_LENS_PANELS[lens] ?? [])],
    hud: STUDIO_LENS_HUD[lens] ?? [],
  });
}
