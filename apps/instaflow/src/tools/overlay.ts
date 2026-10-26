/**
 * The tool overlay (IF-24.17–24.18): selection frame, round handles, hover outline, marquee, smart guides and
 * equal-spacing distance labels as **editor chrome**. It is encoded into its own non-printing scene (like B1's
 * `gridOverlayBatch`), so export and the document never see it. Colours come from the active theme (Clean Pop
 * `accent` for selection and guides, `surface1` for handle fills, `accentSubtle` for the marquee): never hard-coded.
 * B10a: the pivot (reference point) is a ring with a cross hair; in transform mode the frame is drawn twice as thick.
 * Distance labels are data for the shell to show with kit tags (`guideLabelTemplate` in `overlay-labels.ts`, main
 * thread only: this file stays Lit-free for the editor worker, B9).
 */
import type { Box } from '@staticflux/document/spatial-index';
import type { NodeId } from '@staticflux/document/v2';
import type { ThemeDef } from '@staticflux/ui/theme';
import { createSceneWriter, type SceneNode, type SceneTransform } from '../render/scene-ir.js';
import { colorToRgba, type Rgba8 } from '../elements/values.js';
import { cleanPopTheme } from '../theme/clean-pop.js';
import type { Guide, GuideLabel } from './snapping.js';
import type { SelectionFrame, TransformHandle } from './transform.js';

export interface ToolOverlay {
  readonly frame?: SelectionFrame;
  readonly handles: readonly TransformHandle[];
  readonly hover?: { readonly node: NodeId; readonly bounds: Box };
  readonly marquee?: Box;
  readonly guides: readonly Guide[];
  readonly labels: readonly GuideLabel[];
  /** B10a: a transform session is active (Mod+T). */
  readonly transforming?: boolean;
}

export const EMPTY_OVERLAY: ToolOverlay = Object.freeze({ handles: [], guides: [], labels: [] });

export interface OverlayColors {
  readonly selection: Rgba8;
  readonly handleFill: Rgba8;
  readonly guide: Rgba8;
  readonly marquee: Rgba8;
}

const rgba = (value: unknown, fallback: Rgba8): Rgba8 => (typeof value === 'string' ? (colorToRgba(value) ?? fallback) : fallback);

/** Overlay colours from a theme's colour tokens (default Clean Pop). */
export function overlayColors(theme: ThemeDef = cleanPopTheme): OverlayColors {
  const c = theme.values.color as Readonly<Record<string, unknown>>;
  const black: Rgba8 = [0, 0, 0, 255];
  const accent = rgba(c['accent'], black);
  const subtle = rgba(c['accentSubtle'], accent);
  return { selection: accent, handleFill: rgba(c['surface1'], [255, 255, 255, 255]), guide: accent, marquee: [subtle[0], subtle[1], subtle[2], 128] };
}

/**
 * The text being edited (TEXT-FONTS §3.2 drawing): the caret and the selection rects in **block px**, with the block's
 * page transform (rotated text gets a rotated caret). Drawn above the content, never exported.
 */
export interface TextEditOverlay {
  readonly transform: SceneTransform;
  /** The caret bar (absent while a range is selected). */
  readonly caret?: { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number };
  /** One rect per line of the selection (`selectionRects`, bidi aware). */
  readonly selection: readonly { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number }[];
}

export interface TextEditColors {
  readonly caret: Rgba8;
  readonly selection: Rgba8;
}

/** Caret in ink (`text`), selection in the accent at 24 % alpha (TEXT-FONTS §3.2). */
export function textEditColors(theme: ThemeDef = cleanPopTheme): TextEditColors {
  const c = theme.values.color as Readonly<Record<string, unknown>>;
  const accent = rgba(c['accent'], [0, 0, 0, 255]);
  return { caret: rgba(c['text'], [0, 0, 0, 255]), selection: [accent[0], accent[1], accent[2], 61] };
}

/** Scene IR for the text being edited (same id and `clear` options as `toolOverlayBatch`). */
export function textEditBatch(
  edit: TextEditOverlay,
  options: { readonly colors?: TextEditColors; readonly firstId?: number; readonly clear?: boolean; readonly ids?: number[] } = {},
): Uint8Array {
  const colors = options.colors ?? textEditColors();
  const w = createSceneWriter();
  if (options.clear !== false) w.clear();
  let id = options.firstId ?? 1;
  const [a, b, c, d, e, f] = edit.transform;
  const rect = (r: { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number }, color: Rgba8): void => {
    const width = r.x1 - r.x0;
    const height = r.y1 - r.y0;
    if (!(width > 0) || !(height > 0)) return;
    options.ids?.push(id);
    // The rect's origin moved into the block transform: page = T · (x0, y0) + T's linear part · (x, y).
    w.upsert({ id: id++, transform: [a, b, c, d, a * r.x0 + c * r.y0 + e, b * r.x0 + d * r.y0 + f], geometry: { kind: 'rect', w: width, h: height }, fill: { kind: 'solid', color } });
  };
  for (const r of edit.selection) rect(r, colors.selection);
  if (edit.caret !== undefined) rect(edit.caret, colors.caret);
  return w.finish();
}

/** Screen-pixel widths of the overlay strokes. */
export const OVERLAY_WIDTHS = Object.freeze({ frame: 1.5, transformFrame: 3, hover: 1.5, guide: 1, handle: 1.5, tick: 4, pivotCross: 1 });

const translate = (x: number, y: number): SceneTransform => [1, 0, 0, 1, x, y];

/**
 * Scene IR for the overlay at a zoom (page space; stroke widths stay constant on screen). By default the batch
 * starts with CLEAR (a scene of its own). `clear: false` writes into a shared scene instead (B8: the canvas raster
 * is opaque, so the overlay draws in the content scene above the page); `ids` receives the ids written, for the
 * next batch to remove.
 */
export function toolOverlayBatch(
  overlay: ToolOverlay,
  zoom: number,
  options: { readonly colors?: OverlayColors; readonly firstId?: number; readonly clear?: boolean; readonly ids?: number[] } = {},
): Uint8Array {
  const colors = options.colors ?? overlayColors();
  const w = createSceneWriter();
  if (options.clear !== false) w.clear();
  let id = options.firstId ?? 1;
  const s = 1 / zoom;
  const put = (node: Omit<SceneNode, 'id'>): void => {
    options.ids?.push(id);
    w.upsert({ id: id++, ...node });
  };
  const line = (x0: number, y0: number, x1: number, y1: number, width: number, color: Rgba8): void => {
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (len === 0) return;
    const cos = (x1 - x0) / len;
    const sin = (y1 - y0) / len;
    put({ transform: [cos, sin, -sin, cos, x0 + (sin * width) / 2, y0 - (cos * width) / 2], geometry: { kind: 'rect', w: len, h: width }, fill: { kind: 'solid', color } });
  };
  if (overlay.hover !== undefined) {
    const b = overlay.hover.bounds;
    put({ transform: translate(b.minX, b.minY), geometry: { kind: 'rect', w: b.maxX - b.minX, h: b.maxY - b.minY }, stroke: { width: OVERLAY_WIDTHS.hover * s, paint: { kind: 'solid', color: colors.selection } } });
  }
  if (overlay.marquee !== undefined) {
    const b = overlay.marquee;
    put({
      transform: translate(b.minX, b.minY),
      geometry: { kind: 'rect', w: b.maxX - b.minX, h: b.maxY - b.minY },
      fill: { kind: 'solid', color: colors.marquee },
      stroke: { width: OVERLAY_WIDTHS.guide * s, paint: { kind: 'solid', color: colors.selection } },
    });
  }
  for (const g of overlay.guides) {
    if (g.kind === 'line') {
      if (g.axis === 'x') line(g.value, g.from, g.value, g.to, OVERLAY_WIDTHS.guide * s, colors.guide);
      else line(g.from, g.value, g.to, g.value, OVERLAY_WIDTHS.guide * s, colors.guide);
      continue;
    }
    const tick = OVERLAY_WIDTHS.tick * s;
    for (const [a, b] of g.gaps) {
      if (g.axis === 'x') {
        line(a, g.cross, b, g.cross, OVERLAY_WIDTHS.guide * s, colors.guide);
        line(a, g.cross - tick, a, g.cross + tick, OVERLAY_WIDTHS.guide * s, colors.guide);
        line(b, g.cross - tick, b, g.cross + tick, OVERLAY_WIDTHS.guide * s, colors.guide);
      } else {
        line(g.cross, a, g.cross, b, OVERLAY_WIDTHS.guide * s, colors.guide);
        line(g.cross - tick, a, g.cross + tick, a, OVERLAY_WIDTHS.guide * s, colors.guide);
        line(g.cross - tick, b, g.cross + tick, b, OVERLAY_WIDTHS.guide * s, colors.guide);
      }
    }
  }
  if (overlay.frame !== undefined) {
    const [tl, tr, br, bl] = overlay.frame.corners;
    const edges = [tl, tr, br, bl, tl];
    for (let i = 0; i < 4; i++) {
      const a = edges[i] as readonly [number, number];
      const b = edges[i + 1] as readonly [number, number];
      line(a[0], a[1], b[0], b[1], (overlay.transforming === true ? OVERLAY_WIDTHS.transformFrame : OVERLAY_WIDTHS.frame) * s, colors.selection);
    }
  }
  for (const h of overlay.handles) {
    if (h.kind === 'pivot') {
      put({
        transform: translate(h.x - h.radius, h.y - h.radius),
        geometry: { kind: 'ellipse', w: 2 * h.radius, h: 2 * h.radius },
        stroke: { width: OVERLAY_WIDTHS.handle * s, paint: { kind: 'solid', color: colors.selection } },
      });
      const arm = h.radius * 1.8;
      line(h.x - arm, h.y, h.x + arm, h.y, OVERLAY_WIDTHS.pivotCross * s, colors.selection);
      line(h.x, h.y - arm, h.x, h.y + arm, OVERLAY_WIDTHS.pivotCross * s, colors.selection);
      continue;
    }
    if (h.kind !== 'resize') continue;
    put({
      transform: translate(h.x - h.radius, h.y - h.radius),
      geometry: { kind: 'ellipse', w: 2 * h.radius, h: 2 * h.radius },
      fill: { kind: 'solid', color: colors.handleFill },
      stroke: { width: OVERLAY_WIDTHS.handle * s, paint: { kind: 'solid', color: colors.selection } },
    });
  }
  return w.finish();
}
