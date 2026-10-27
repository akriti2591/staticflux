import { describe, expect, it } from 'vitest';
import { aspectOf, DEFAULT_DESIGN_FORMAT, DESIGN_FORMAT_IDS, DESIGN_FORMATS, designFormat, designFormats, formatOfSize, groupDigits, NEW_DESIGN_CHIPS } from './formats.js';
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
    // B11b: the New design dialog's choices (px is the default unit; a blank name is dropped).
    expect(value(newDesignHref({ format: 'custom', size: { width: 1500, height: 500 }, unit: 'mm', pages: 3, name: ' Spring ', background: '#ffeedd' }))).toBe('/new?format=custom&w=1500&h=500&unit=mm&pages=3&name=Spring&bg=%23ffeedd');
    expect(value(newDesignHref({ format: 'post', unit: 'px', name: '  ' }))).toBe('/new?format=post');
  });

  it('reads what a Studio URL asks for (and keeps unrelated query keys out of it)', () => {
    expect(readStudioIntent('/s/as_123')).toEqual({ kind: 'open', asset: 'as_123' });
    expect(readStudioIntent('/s/as_123?topology=split')).toEqual({ kind: 'open', asset: 'as_123' });
    expect(readStudioIntent('/new?format=slides&topology=split')).toEqual({ kind: 'new', format: 'slides', template: undefined });
    expect(readStudioIntent('/new?template=as_t')).toEqual({ kind: 'new', format: undefined, template: 'as_t' });
    expect(readStudioIntent('/new?format=nope')).toEqual({ kind: 'new', format: undefined, template: undefined });
    expect(readStudioIntent('/new?template=')).toEqual({ kind: 'new', format: undefined, template: undefined });
    expect(readStudioIntent('/new?format=custom&w=1500&h=500&pages=3&name=Spring&bg=%23FFEEDD')).toEqual({ kind: 'new', format: 'custom', template: undefined, size: { width: 1500, height: 500 }, pages: 3, name: 'Spring', background: '#ffeedd' });
    // Out of range or malformed values are dropped (a custom size needs both sides).
    expect(readStudioIntent('/new?format=custom&w=20000&h=500&pages=99&bg=red')).toEqual({ kind: 'new', format: 'custom', template: undefined });
    expect(readStudioIntent('/new?format=post&w=500&h=500')).toEqual({ kind: 'new', format: 'post', template: undefined });
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

  it('matches a size to its chip (Custom otherwise) and groups digits', () => {
    expect(formatOfSize({ width: 1080, height: 1920 })).toBe('story');
    expect(formatOfSize({ width: 1080, height: 1350 })).toBe('custom'); // the carousel is not a chip
    expect(NEW_DESIGN_CHIPS).toEqual(['post', 'story', 'landscape', 'slides', 'poster', 'letter']);
    expect(groupDigits(16384)).toBe('16 384');
    expect(groupDigits(794)).toBe('794');
  });

  it('gives a CSS aspect ratio for previews', () => {
    expect(aspectOf({ width: 1080, height: 1920 })).toBe('1080 / 1920');
    expect(aspectOf(undefined)).toBe('4 / 5');
  });
});
