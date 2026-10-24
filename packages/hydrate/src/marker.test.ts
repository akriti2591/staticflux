import { describe, expect, it } from 'vitest';
import {
  closestIsland,
  DEFAULT_HYDRATE_STRATEGY,
  formatIslandSize,
  isIslandChunkId,
  parseIslandProps,
  parseIslandSize,
  readIslandMarker,
  scanIslands,
} from './index.js';

function html(markup: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = markup;
  return root;
}

describe('scanIslands', () => {
  it('finds both marker forms in document order with default ids', () => {
    const root = html(`
      <sf-island chunk="feature:cart" hydrate="idle" props='{"sku":"a1"}'><button>Add</button></sf-island>
      <section data-sf-island="feature:search" data-sf-hydrate="interaction"><input></section>
      <sf-island chunk="feature:cart"><span>2nd</span></sf-island>`);
    const { islands, issues } = scanIslands(root);
    expect(issues).toEqual([]);
    expect(islands.map((i) => [i.id, i.form, i.strategy])).toEqual([
      ['feature:cart#0', 'element', 'idle'],
      ['feature:search#0', 'attribute', 'interaction'],
      ['feature:cart#1', 'element', DEFAULT_HYDRATE_STRATEGY],
    ]);
    expect(islands[0]?.props).toEqual({ kind: 'attribute', raw: '{"sku":"a1"}' });
  });

  it('defaults to lazy (visible) hydration', () => {
    expect(DEFAULT_HYDRATE_STRATEGY).toBe('visible');
  });

  it('reads explicit id, export, reason and size (both forms)', () => {
    const root = html(`
      <sf-island chunk="feature:a" island-id="hero" export="heroIsland" hydrate="eager" reason="above the fold" size="320x48"></sf-island>
      <div data-sf-island="feature:b" data-sf-island-id="b1" data-sf-export="x" data-sf-size="10 x 20.5"></div>`);
    const [a, b] = scanIslands(root).islands;
    expect(a).toMatchObject({ id: 'hero', exportName: 'heroIsland', strategy: 'eager', reason: 'above the fold', declaredSize: { width: 320, height: 48 } });
    expect(b).toMatchObject({ id: 'b1', exportName: 'x', declaredSize: { width: 10, height: 20.5 } });
  });

  it('includes the root itself when it is a marker', () => {
    const root = html('<div data-sf-island="feature:root"><sf-island chunk="feature:inner"></sf-island></div>').firstElementChild as Element;
    expect(scanIslands(root).islands.map((i) => i.chunk)).toEqual(['feature:root', 'feature:inner']);
  });

  it('skips markers with an invalid chunk id and reports SF-HYD-001', () => {
    const { islands, issues } = scanIslands(html('<sf-island chunk="nope"></sf-island><sf-island></sf-island>'));
    expect(islands).toEqual([]);
    expect(issues.map((e) => e.code)).toEqual(['SF-HYD-001', 'SF-HYD-001']);
  });

  it('falls back to the default strategy for unknown values (reported)', () => {
    const { islands, issues } = scanIslands(html('<sf-island chunk="feature:x" hydrate="sometimes"></sf-island>'));
    expect(islands[0]?.strategy).toBe('visible');
    expect(issues[0]?.code).toBe('SF-HYD-001');
  });

  it('downgrades eager without a reason to idle (R12.12, SF-HYD-008)', () => {
    const { islands, issues } = scanIslands(html('<sf-island chunk="feature:x" hydrate="eager"></sf-island>'));
    expect(islands[0]?.strategy).toBe('idle');
    expect(issues[0]?.code).toBe('SF-HYD-008');
  });

  it('reports an invalid size but keeps the island', () => {
    const { islands, issues } = scanIslands(html('<sf-island chunk="feature:x" size="big"></sf-island>'));
    expect(islands[0]?.declaredSize).toBeUndefined();
    expect(issues[0]?.code).toBe('SF-HYD-001');
  });

  it('reads props from a direct child script; the attribute wins', () => {
    const root = html(`
      <sf-island chunk="feature:a"><script type="application/sf-island-props+json">{"n":1}</script><p>x</p></sf-island>
      <sf-island chunk="feature:b" props='{"from":"attr"}'><script type="application/sf-island-props+json">{"from":"script"}</script></sf-island>
      <sf-island chunk="feature:c"><div><script type="application/sf-island-props+json">{"deep":true}</script></div></sf-island>`);
    const [a, b, c] = scanIslands(root).islands;
    expect(a && parseIslandProps(a)).toEqual({ ok: true, value: { n: 1 } });
    expect(b && parseIslandProps(b)).toEqual({ ok: true, value: { from: 'attr' } });
    expect(c?.props.kind).toBe('none');
    expect(c && parseIslandProps(c)).toEqual({ ok: true, value: undefined });
  });

  it('accepts a custom id generator', () => {
    const { islands } = scanIslands(html('<sf-island chunk="feature:x"></sf-island>'), { idFor: (chunk) => `custom-${chunk}` });
    expect(islands[0]?.id).toBe('custom-feature:x');
  });
});

describe('marker helpers', () => {
  it('parseIslandProps reports invalid JSON as SF-HYD-002', () => {
    const result = parseIslandProps({ id: 'x', chunk: 'feature:x', props: { kind: 'attribute', raw: '{bad' } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('SF-HYD-002');
  });

  it('readIslandMarker rejects non-markers', () => {
    const result = readIslandMarker(document.createElement('div'), () => 'id');
    expect(result.ok).toBe(false);
  });

  it('parses and formats sizes', () => {
    expect(parseIslandSize('320x200')).toEqual({ width: 320, height: 200 });
    expect(parseIslandSize('320X200')).toEqual({ width: 320, height: 200 });
    expect(parseIslandSize('-1x2')).toBeUndefined();
    expect(parseIslandSize(null)).toBeUndefined();
    expect(formatIslandSize({ width: 1, height: 2 })).toBe('1x2');
  });

  it('validates chunk ids', () => {
    expect(isIslandChunkId('feature:studio-desktop')).toBe(true);
    expect(isIslandChunkId('lib:a/b.c')).toBe(true);
    expect(isIslandChunkId('feature')).toBe(false);
    expect(isIslandChunkId('feature:"x')).toBe(false);
  });

  it('closestIsland finds the owning (nearest) island', () => {
    const root = html('<sf-island chunk="feature:outer"><p><sf-island chunk="feature:inner"><b>x</b></sf-island><i>y</i></p></sf-island>');
    const b = root.querySelector('b');
    const i = root.querySelector('i');
    expect(closestIsland(b)?.getAttribute('chunk')).toBe('feature:inner');
    expect(closestIsland(i)?.getAttribute('chunk')).toBe('feature:outer');
    expect(closestIsland(root)).toBeUndefined();
  });
});
