/**
 * Text's contributions to the editor spec runtime (B0, D16; IF-21.26–21.29): the Text tool (B3 hosts tool behaviour;
 * this provides the creation and editing actions it calls), the Typography inspector panel, and the text HUD actions
 * (Font, Size, Fit to box). All data; nothing here lays out a screen. Wired to the real B0 tokens.
 */
import { contribution, err, type Result } from '@staticflux/core';
import type { JsonValue, NodeId, PartOp } from '@staticflux/document/v2';
import { html } from 'lit';
import { defineHudAction, definePanel, defineTool, hudActionContribution, PanelContributionsToken, type PanelContribution, toolContribution } from '../spec/contributions.js';
import { P } from '../elements/components.js';
import { StudioIds } from '../spec/studio-contributions.js';
import { TextRangeError } from './errors.js';
import type { CharStyle, ParagraphStyle } from './model.js';
import { createTextOps } from './rich-text.js';
import { defineTypographyPanel, TYPOGRAPHY_PANEL_TAG } from './typography-panel.js';
import { type TypographyService, TypographyServiceToken } from './typography.js';

/** Stable ids (specs, saved specs and pins refer to them). */
export const TextIds = Object.freeze({
  tool: StudioIds.tool.text,
  panel: StudioIds.panel.typography,
  hud: { font: 'instaflow/text-font', size: 'instaflow/text-size', fit: 'instaflow/text-fit' },
} as const);

/** Text edits in the layout lenses (the same lenses as Studio's Text tool and Typography slot). */
const LENSES = [StudioIds.lens.canvas, StudioIds.lens.pages];

/** The Text tool (`T`): click to create a text element, click into text to edit it (B3 runs the pointer flow). */
export const textTool = /* @__PURE__ */ defineTool({
  id: TextIds.tool,
  label: 'Text',
  glyph: 'T',
  shortcut: 'T',
  lenses: LENSES,
  description: 'Create and edit text: click to place, drag to set a width, click into text to edit.',
});

export const typographyPanel: PanelContribution = /* @__PURE__ */ definePanel({
  id: TextIds.panel,
  label: 'Typography',
  placements: ['inspector', 'side'],
  // The inspector column is Pro (UX §3), like Properties: Focus and Standard keep it closed.
  minDensity: 'pro',
  lenses: LENSES,
  scopes: ['selection', 'asset', 'page'],
  description: 'Font, size, style, alignment, line height and colour of the selected text.',
  render: () => html`<if-typography-panel></if-typography-panel>`,
});

export const textHudActions = Object.freeze([
  defineHudAction({ id: TextIds.hud.font, label: 'Font', tone: 'direct', lenses: LENSES, scopes: ['selection'], description: 'Pick the font of the selected text.' }),
  defineHudAction({ id: TextIds.hud.size, label: 'Size', tone: 'direct', lenses: LENSES, scopes: ['selection'], description: 'Set the font size of the selected text.' }),
  defineHudAction({ id: TextIds.hud.fit, label: 'Fit to box', tone: 'direct', lenses: LENSES, scopes: ['selection'], description: 'Scale the text so it fits its box.' }),
]);

/**
 * What a HUD action does with the typography service (data: B0 dispatches by id; Font and Size open their pickers,
 * which call `setFont` / `setSize`). `undefined` = the HUD opens the action's picker.
 */
export const TEXT_HUD_COMMANDS: Readonly<Record<string, ((service: TypographyService) => Result<void>) | undefined>> = Object.freeze({
  [TextIds.hud.font]: undefined,
  [TextIds.hud.size]: undefined,
  [TextIds.hud.fit]: (service: TypographyService) => service.fitToBox(),
});

export interface PlaceTextOptions {
  readonly node: NodeId;
  readonly parent: NodeId | null;
  /** Click point (parent space). */
  readonly x: number;
  readonly y: number;
  /** Drag width; omitted = auto-width box. */
  readonly width?: number;
  readonly text?: string;
  readonly style?: CharStyle;
  readonly paragraph?: ParagraphStyle;
  /** Spatial paths (default B1's `spatial.*`). */
  readonly spatial?: { readonly x: string; readonly y: string; readonly w: string };
}

const SPATIAL = { x: P.x, y: P.y, w: P.w } as const;

/** The Text tool's create action: a text element at the click point (auto width) or with the dragged width. */
export function placeTextOps(options: PlaceTextOptions): Result<PartOp[]> {
  if (!Number.isFinite(options.x) || !Number.isFinite(options.y) || (options.width !== undefined && !(options.width > 0))) {
    return err(TextRangeError({ message: 'A text box needs a finite position and a positive width.', details: { x: options.x, y: options.y } }));
  }
  const paths = options.spatial ?? SPATIAL;
  const props: Record<string, JsonValue> = { [paths.x]: options.x, [paths.y]: options.y, 'text.box': options.width === undefined ? 'auto-width' : 'auto-height' };
  if (options.width !== undefined) props[paths.w] = options.width;
  return createTextOps({
    node: options.node,
    parent: options.parent,
    props,
    ...(options.text === undefined ? {} : { text: options.text }),
    ...(options.style === undefined ? {} : { style: options.style }),
    ...(options.paragraph === undefined ? {} : { paragraph: options.paragraph }),
  });
}

/* @__NO_SIDE_EFFECTS__ */
function typographyPanelUnit() {
  return contribution({
    id: `${TextIds.panel}-panel`,
    provides: PanelContributionsToken,
    scope: 'app',
    deps: { required: { typography: TypographyServiceToken } },
    create: () => {
      defineTypographyPanel();
      return typographyPanel;
    },
    description: 'Panel Typography (needs the typography service).',
  });
}

/** Units contributing text's tool, panel and HUD actions (the panel needs `TypographyServiceToken` bound). */
export function textContributionUnits() {
  return [toolContribution(textTool), typographyPanelUnit(), ...textHudActions.map((a) => hudActionContribution(a))] as const;
}

export { TYPOGRAPHY_PANEL_TAG };
