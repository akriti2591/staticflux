import { afterEach, describe, expect, it, vi } from 'vitest';
import { anchorFloating, computePosition, positionArea, supportsAnchorPositioning } from './position.js';

const viewport = { width: 1000, height: 800 };
const floating = { width: 200, height: 100 };

describe('computePosition', () => {
  it('places below, start-aligned, with an offset', () => {
    expect(computePosition({ anchor: { x: 100, y: 100, width: 80, height: 30 }, floating, viewport, side: 'block-end' })).toEqual({ x: 100, y: 134, side: 'block-end' });
  });

  it('aligns center and end, and mirrors start/end in RTL', () => {
    const anchor = { x: 400, y: 100, width: 100, height: 30 };
    expect(computePosition({ anchor, floating, viewport, side: 'block-end', align: 'center' }).x).toBe(350);
    expect(computePosition({ anchor, floating, viewport, side: 'block-end', align: 'end' }).x).toBe(300);
    expect(computePosition({ anchor, floating, viewport, side: 'block-end', align: 'start', dir: 'rtl' }).x).toBe(300);
    expect(computePosition({ anchor, floating, viewport, side: 'block-end', align: 'end', dir: 'rtl' }).x).toBe(400);
  });

  it('flips to the other side when the preferred side overflows', () => {
    const nearBottom = { x: 100, y: 740, width: 80, height: 30 };
    expect(computePosition({ anchor: nearBottom, floating, viewport, side: 'block-end' })).toMatchObject({ side: 'block-start', y: 636 });
    const nearTop = { x: 100, y: 10, width: 80, height: 30 };
    expect(computePosition({ anchor: nearTop, floating, viewport, side: 'block-start' }).side).toBe('block-end');
  });

  it('places beside the anchor on inline sides (RTL-aware) and clamps into the viewport', () => {
    const anchor = { x: 100, y: 100, width: 50, height: 50 };
    expect(computePosition({ anchor, floating, viewport, side: 'inline-end' })).toEqual({ x: 154, y: 100, side: 'inline-end' });
    expect(computePosition({ anchor: { x: 500, y: 100, width: 50, height: 50 }, floating, viewport, side: 'inline-end', dir: 'rtl' }).x).toBe(296);
    expect(computePosition({ anchor, floating, viewport, side: 'inline-start', align: 'center' })).toMatchObject({ side: 'inline-end', y: 75 });
    expect(computePosition({ anchor: { x: 950, y: 100, width: 40, height: 20 }, floating, viewport, side: 'block-end' }).x).toBe(792);
    expect(computePosition({ anchor: { x: 0, y: 0, width: 10, height: 10 }, floating: { width: 2000, height: 50 }, viewport, side: 'block-end' }).x).toBe(8);
  });

  it('#45: the 266 px colour popover from a swatch at the right edge, the bottom edge and the corner stays inside the viewport (8 px)', () => {
    const colour = { width: 266, height: 300 };
    const inside = (r: { x: number; y: number }): boolean => r.x >= 8 && r.y >= 8 && r.x + colour.width <= viewport.width - 8 && r.y + colour.height <= viewport.height - 8;
    const right = computePosition({ anchor: { x: 970, y: 100, width: 24, height: 24 }, floating: colour, viewport, side: 'block-end', offset: 8 });
    expect(right).toMatchObject({ side: 'block-end', x: 726, y: 132 });
    const bottom = computePosition({ anchor: { x: 300, y: 770, width: 24, height: 24 }, floating: colour, viewport, side: 'block-end', offset: 8 });
    expect(bottom).toMatchObject({ side: 'block-start', x: 300, y: 462 });
    const corner = computePosition({ anchor: { x: 970, y: 770, width: 24, height: 24 }, floating: colour, viewport, side: 'block-end', offset: 8 });
    expect(corner).toMatchObject({ side: 'block-start', x: 726, y: 462 });
    for (const r of [right, bottom, corner]) expect(inside(r)).toBe(true);
  });
});

describe('anchor positioning', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('detects support and maps sides to position-area', () => {
    expect(supportsAnchorPositioning({} as never)).toBe(false);
    expect(supportsAnchorPositioning({ supports: () => true })).toBe(true);
    expect(supportsAnchorPositioning({ supports: (d: string) => d.startsWith('anchor-name') })).toBe(false);
    expect(positionArea('block-end', 'start')).toBe('block-end span-inline-end');
    expect(positionArea('block-start', 'end')).toBe('block-start span-inline-start');
    expect(positionArea('inline-end', 'start')).toBe('inline-end span-block-end');
    expect(positionArea('inline-start', 'center')).toBe('inline-start');
  });

  it('uses CSS anchor positioning when supported and in the same tree', () => {
    vi.spyOn(CSS, 'supports').mockReturnValue(true);
    const anchor = document.createElement('button');
    const pop = document.createElement('div');
    document.body.append(anchor, pop);
    const handle = anchorFloating(anchor, pop, { side: 'block-end', align: 'start', offset: 6 });
    expect(handle.mode).toBe('css');
    const name = anchor.style.getPropertyValue('anchor-name');
    expect(name).toMatch(/^--sf-anchor-\d+$/);
    expect(pop.style.getPropertyValue('position-anchor')).toBe(name);
    expect(pop.style.getPropertyValue('position-area')).toBe('block-end span-inline-end');
    expect(pop.style.getPropertyValue('margin-block-start')).toBe('6px');
    handle.update();
    handle.stop();
    expect(anchor.style.getPropertyValue('anchor-name')).toBe('');
    expect(pop.style.getPropertyValue('position-area')).toBe('');
  });

  it('falls back to JS positioning across trees or without support, and re-measures on scroll', async () => {
    const anchor = document.createElement('button');
    const host = document.createElement('div');
    const pop = document.createElement('div');
    host.attachShadow({ mode: 'open' }).append(pop);
    document.body.append(anchor, host);
    vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue({ left: 20, top: 30, width: 40, height: 20, right: 60, bottom: 50, x: 20, y: 30, toJSON: () => ({}) });
    const controller = new AbortController();
    const handle = anchorFloating(anchor, pop, { side: 'block-end' }, controller.signal);
    expect(handle.mode).toBe('js');
    expect(pop.style.left).toBe('20px');
    expect(pop.style.top).toBe('54px');
    expect(pop.dataset['side']).toBe('block-end');
    vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue({ left: 120, top: 30, width: 40, height: 20, right: 160, bottom: 50, x: 120, y: 30, toJSON: () => ({}) });
    window.dispatchEvent(new Event('scroll'));
    await new Promise((r) => setTimeout(r, 40));
    expect(pop.style.left).toBe('120px');
    controller.abort();
    const forced = anchorFloating(anchor, document.createElement('div'), { forceFallback: true });
    expect(forced.mode).toBe('js');
    forced.stop();
  });
});
