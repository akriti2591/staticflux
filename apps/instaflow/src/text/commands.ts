/**
 * Text's ids, HUD commands and the Text tool's create action (B2; IF-21.26–21.29). Lit-free, so the editor worker
 * imports it (B9); `contributions.ts` re-exports it with the tool, panel and HUD contributions.
 */
import { err, type Result } from '@staticflux/core';
import type { JsonValue, NodeId, PartOp } from '@staticflux/document/v2';
import { P } from '../elements/components.js';
import { StudioIds } from '../spec/studio-ids.js';
import { TextRangeError } from './errors.js';
import type { CharStyle, ParagraphStyle } from './model.js';
import { createTextOps } from './rich-text.js';
import type { TypographyService } from './typography.js';

/** Stable ids (specs, saved specs and pins refer to them). */
export const TextIds = Object.freeze({
  tool: StudioIds.tool.text,
  panel: StudioIds.panel.typography,
  hud: { font: 'instaflow/text-font', size: 'instaflow/text-size', fit: 'instaflow/text-fit' },
} as const);

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
