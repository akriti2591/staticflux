import { contrastRatio } from '@staticflux/ui/theme';
import { describe, expect, it } from 'vitest';
import { cleanPopPalette } from './clean-pop.js';
import { LENS_IDS, lenses, lensMarkStyle, lensOf, lensPalette, lensTag } from './lenses.js';

describe('lens palette', () => {
  it('has the four lenses in display order with the approved colours and shapes', () => {
    expect(LENS_IDS).toEqual(['layout', 'pixel', 'video', 'flow']);
    expect(lenses().map((l) => [l.id, l.color, l.onColor, l.shape])).toEqual([
      ['layout', '#FF5C39', '#16151A', 'square'],
      ['pixel', '#FFC23D', '#16151A', 'circle'],
      ['video', '#3D5AFE', '#FFFFFF', 'frame'],
      ['flow', '#00B37E', '#16151A', 'pill'],
    ]);
  });

  it('is frozen data keyed by id', () => {
    for (const id of LENS_IDS) {
      expect(lensOf(id)).toBe(lensPalette[id]);
      expect(lensOf(id).id).toBe(id);
      expect(Object.isFrozen(lensOf(id))).toBe(true);
    }
    expect(Object.isFrozen(lensPalette)).toBe(true);
  });

  it('gives every lens its own colour and its own shape (never colour alone)', () => {
    expect(new Set(lenses().map((l) => l.color)).size).toBe(LENS_IDS.length);
    expect(new Set(lenses().map((l) => l.shape)).size).toBe(LENS_IDS.length);
  });

  it('on-colours reach 4.5:1 on their lens colour (type tags)', () => {
    for (const lens of lenses()) {
      const ratio = contrastRatio(lens.onColor, lens.color);
      expect(ratio.ok && ratio.value >= 4.5, `${lens.id}: ${lens.onColor} on ${lens.color}`).toBe(true);
    }
  });

  it('keeps lens colours apart from the primary action fill', () => {
    for (const lens of lenses()) expect(lens.color.toLowerCase()).not.toBe(cleanPopPalette.primary.toLowerCase());
  });

  it('marks: square, circle, wide rounded frame, pill geometry', () => {
    const { layout, pixel, video, flow } = lensPalette;
    expect(layout.mark).toEqual({ width: 10, height: 10, radius: 3 });
    expect(pixel.mark.radius * 2).toBe(pixel.mark.width);
    expect(video.mark.width).toBeGreaterThan(video.mark.height);
    expect(video.mark.radius).toBeLessThan(video.mark.height / 2);
    expect(flow.mark.radius * 2).toBe(flow.mark.height);
  });

  it('lensMarkStyle draws a decorative mark, scalable', () => {
    expect(lensMarkStyle(lensOf('video'))).toBe('display:inline-block;flex:none;inline-size:14px;block-size:9px;border-radius:3px;background:#3D5AFE');
    expect(lensMarkStyle(lensOf('pixel'), 2)).toContain('inline-size:20px;block-size:20px;border-radius:10px');
  });

  it('lensTag gives sf-tag colour props', () => {
    expect(lensTag(lensOf('flow'))).toEqual({ color: '#00B37E', ink: '#16151A' });
  });
});
