import { describe, expect, it } from 'vitest';
import { asJsonObject, BRAND_CLASS_INHERIT, DEFAULT_STAGE_RULES, isLockScope, LOCK_SCOPES, matchesAny, matchesPath, variantKey } from './rules.js';

describe('stage rules', () => {
  it('matches path patterns (prefix with a trailing dot, else the path and its sub-paths)', () => {
    expect(matchesPath('spatial.x', 'spatial.')).toBe(true);
    expect(matchesPath('spatialx', 'spatial.')).toBe(false);
    expect(matchesPath('style.fill.color', 'style.fill')).toBe(true);
    expect(matchesPath('style.fill', 'style.fill')).toBe(true);
    expect(matchesPath('style.fillOpacity', 'style.fill')).toBe(false);
    expect(matchesAny('temporal.start', DEFAULT_STAGE_RULES.positionPaths)).toBe(true);
    expect(matchesAny('spatial.opacity', DEFAULT_STAGE_RULES.positionPaths)).toBe(false);
    expect(matchesAny('x', [])).toBe(false);
  });

  it('names variants and lock scopes', () => {
    expect(variantKey('format', 'story')).toBe('format=story');
    expect(LOCK_SCOPES).toEqual(['position', 'content', 'all']);
    expect(isLockScope('content')).toBe(true);
    expect(isLockScope('size')).toBe(false);
  });

  it('reads brand-class references (in a kit, or in the same asset)', () => {
    expect(BRAND_CLASS_INHERIT.target({ kit: { asset: 'as_kit', at: 'latest' }, class: 'heading' })).toEqual({ ref: { asset: 'as_kit', at: 'latest' }, node: 'heading' });
    expect(BRAND_CLASS_INHERIT.target({ class: 'local' })).toEqual({ node: 'local' });
    expect(BRAND_CLASS_INHERIT.target({ class: '' })).toBeUndefined();
    expect(BRAND_CLASS_INHERIT.target('heading')).toBeUndefined();
    expect(BRAND_CLASS_INHERIT.target(['x'])).toBeUndefined();
  });

  it('narrows JSON objects', () => {
    expect(asJsonObject({ a: 1 })).toEqual({ a: 1 });
    expect(asJsonObject([1])).toBeUndefined();
    expect(asJsonObject(null)).toBeUndefined();
    expect(asJsonObject(undefined)).toBeUndefined();
    expect(asJsonObject('x')).toBeUndefined();
  });
});
