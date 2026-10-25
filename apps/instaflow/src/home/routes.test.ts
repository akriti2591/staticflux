import { describe, expect, it } from 'vitest';
import { aspectOf, DEFAULT_DESIGN_FORMAT, DESIGN_FORMAT_IDS, DESIGN_FORMATS, designFormat, designFormats } from './formats.js';
import { homeHref, instaflowRoutes, newDesignHref, readStudioIntent, studioHref } from './routes.js';

const value = <T>(r: { ok: true; value: T } | { ok: false }): T => {
  if (!r.ok) throw new Error('not ok');
  return r.value;
};

describe('surface routes (D17)', () => {
  it('builds Home, Studio and New design hrefs', () => {
    expect(value(homeHref())).toBe('/');
    expect(value(studioHref('as_123'))).toBe('/s/as_123');
    expect(value(newDesignHref())).toBe('/new');
    expect(value(newDesignHref({ format: 'story' }))).toBe('/new?format=story');
    expect(value(newDesignHref({ template: 'as_tpl' }))).toBe('/new?template=as_tpl');
  });

  it('reads what a Studio URL asks for (and keeps unrelated query keys out of it)', () => {
    expect(readStudioIntent('/s/as_123')).toEqual({ kind: 'open', asset: 'as_123' });
    expect(readStudioIntent('/s/as_123?topology=split')).toEqual({ kind: 'open', asset: 'as_123' });
    expect(readStudioIntent('/new?format=slides&topology=split')).toEqual({ kind: 'new', format: 'slides', template: undefined });
    expect(readStudioIntent('/new?template=as_t')).toEqual({ kind: 'new', format: undefined, template: 'as_t' });
    expect(readStudioIntent('/new?format=nope')).toEqual({ kind: 'new', format: undefined, template: undefined });
    expect(readStudioIntent('/new?template=')).toEqual({ kind: 'new', format: undefined, template: undefined });
    expect(readStudioIntent('/dev/studio/?topology=split')).toEqual({ kind: 'demo' });
    expect(readStudioIntent('/')).toEqual({ kind: 'demo' });
  });

  it('builds the route table once', () => {
    expect(instaflowRoutes()).toBe(instaflowRoutes());
  });
});

describe('design formats', () => {
  it('lists every format in order with a size, a page count and a lens', () => {
    expect(designFormats().map((f) => f.id)).toEqual([...DESIGN_FORMAT_IDS]);
    for (const f of designFormats()) {
      expect(f.size.width).toBeGreaterThan(0);
      expect(f.pages).toBeGreaterThanOrEqual(1);
      expect(f.detail).toContain(`${f.size.width} × ${f.size.height}`);
    }
    expect(DESIGN_FORMATS.slides.size).toEqual({ width: 1920, height: 1080 });
  });

  it('falls back to the default format for an unknown or missing id', () => {
    expect(designFormat(undefined).id).toBe(DEFAULT_DESIGN_FORMAT);
    expect(designFormat('banner').id).toBe(DEFAULT_DESIGN_FORMAT);
    expect(designFormat('story').id).toBe('story');
  });

  it('gives a CSS aspect ratio for previews', () => {
    expect(aspectOf({ width: 1080, height: 1920 })).toBe('1080 / 1920');
    expect(aspectOf(undefined)).toBe('4 / 5');
  });
});
