// @vitest-environment node
import type { TemplateResult } from 'lit';
import { describe, expect, it } from 'vitest';
import { colorToRgba } from '../elements/values.js';
import { SCENE_IR_MAGIC } from '../render/scene-ir.js';
import { cleanPopTheme } from '../theme/clean-pop.js';
import { EMPTY_OVERLAY, overlayColors, toolOverlayBatch, type ToolOverlay } from './overlay.js';
import { guideLabelTemplate } from './overlay-labels.js';
import { transformHandles, type SelectionFrame } from './transform.js';

const frame: SelectionFrame = {
  corners: [
    [0, 0],
    [100, 0],
    [100, 50],
    [0, 50],
  ],
  rotation: 0,
  bounds: { minX: 0, minY: 0, maxX: 100, maxY: 50 },
  center: [50, 25],
};

const opCount = (batch: Uint8Array): number => new DataView(batch.buffer, batch.byteOffset).getUint32(8, true);

describe('tool overlay (non-printing chrome)', () => {
  it('takes its colours from the theme tokens, not from code', () => {
    const colors = overlayColors(cleanPopTheme);
    expect(colors.selection).toEqual(colorToRgba(String(cleanPopTheme.values.color.accent)));
    expect(colors.handleFill).toEqual(colorToRgba(String(cleanPopTheme.values.color.surface1)));
    expect(colors.marquee[3]).toBe(128);
    expect(overlayColors()).toEqual(colors);
  });

  it('encodes frame edges, round handles, hover, marquee and guides as scene IR', () => {
    const empty = toolOverlayBatch(EMPTY_OVERLAY, 1);
    expect([...empty.slice(0, 4)]).toEqual([...SCENE_IR_MAGIC]);
    expect(opCount(empty)).toBe(1);
    const overlay: ToolOverlay = {
      frame,
      handles: transformHandles(frame, 2),
      hover: { node: 'h', bounds: { minX: 200, minY: 0, maxX: 250, maxY: 50 } },
      marquee: { minX: -10, minY: -10, maxX: 10, maxY: 10 },
      guides: [
        { kind: 'line', axis: 'x', value: 100, from: 0, to: 300, line: 'edge' },
        { kind: 'line', axis: 'y', value: 25, from: 0, to: 300, line: 'center' },
        {
          kind: 'spacing',
          axis: 'x',
          gaps: [
            [100, 150],
            [200, 250],
          ],
          cross: 25,
          distance: 50,
        },
        { kind: 'spacing', axis: 'y', gaps: [[50, 80]], cross: 10, distance: 30 },
      ],
      labels: [],
    };
    // clear + hover + marquee + 2 guide lines + 3 × 3 spacing strokes + 4 frame edges + 8 resize handles
    expect(opCount(toolOverlayBatch(overlay, 2, { firstId: 9 }))).toBe(1 + 1 + 1 + 2 + 9 + 4 + 8);
    // Into a shared scene (B8): no CLEAR, and the ids written are reported for the next batch to remove.
    const ids: number[] = [];
    expect(opCount(toolOverlayBatch(overlay, 2, { firstId: 9, clear: false, ids }))).toBe(1 + 1 + 2 + 9 + 4 + 8);
    expect(ids).toEqual(Array.from({ length: 25 }, (_, i) => 9 + i));
  });

  it('renders distance labels as mono kit tags at their screen positions', () => {
    const t = guideLabelTemplate(
      [
        { x: 10, y: 20, text: '24' },
        { x: 30, y: 20, text: '24' },
      ],
      { tx: 5, ty: 0, zoom: 2 },
    );
    const items = t.values[0] as TemplateResult[];
    expect(items).toHaveLength(2);
    expect(items[0]?.strings.join('')).toContain('<sf-tag mono data-guide-label');
    expect(items[0]?.values).toEqual(['position:absolute;left:0;top:0;transform:translate(25px, 40px) translate(-50%, -50%)', '24']);
  });
});
