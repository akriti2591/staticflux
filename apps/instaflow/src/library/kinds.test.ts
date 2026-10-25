import { describe, expect, it } from 'vitest';
import { LENS_IDS } from '../theme/lenses.js';
import { ASSET_KIND_LENS, assetKindOf, BLOB_ASSET_KINDS, EXTENSION_TYPES, LIBRARY_ASSET_KINDS, MEDIA_TYPES, mediaTypeOf, titleFromFileName, TREE_ASSET_KINDS } from './kinds.js';

describe('asset kinds', () => {
  it('lists blob and tree kinds (DOCUMENT-FORMAT §4) and marks every kind with a lens', () => {
    expect(LIBRARY_ASSET_KINDS).toEqual([...BLOB_ASSET_KINDS, ...TREE_ASSET_KINDS]);
    for (const kind of LIBRARY_ASSET_KINDS) expect(LENS_IDS).toContain(ASSET_KIND_LENS[kind]);
    expect(ASSET_KIND_LENS.image).toBe('pixel');
    expect(ASSET_KIND_LENS.composition).toBe('layout');
  });

  it('maps every extension to an importable media type', () => {
    for (const type of Object.values(EXTENSION_TYPES)) expect(MEDIA_TYPES[type]).toBeDefined();
  });
});

describe('mediaTypeOf', () => {
  it('uses the declared type, its aliases, then the extension', () => {
    expect(mediaTypeOf('a.bin', 'image/png')).toBe('image/png');
    expect(mediaTypeOf('a', 'IMAGE/JPG')).toBe('image/jpeg');
    expect(mediaTypeOf('a.wav', 'audio/x-wav; codecs=1')).toBe('audio/wav');
    expect(mediaTypeOf('Brand.WOFF2', '')).toBe('font/woff2');
    expect(mediaTypeOf('notes.txt', 'text/plain')).toBeUndefined();
    expect(mediaTypeOf('noext', '')).toBeUndefined();
  });
});

describe('assetKindOf', () => {
  it('gives the blob kind of a canonical type', () => {
    expect(assetKindOf('image/webp')).toBe('image');
    expect(assetKindOf('image/svg+xml')).toBe('vector');
    expect(assetKindOf('video/quicktime')).toBe('video');
    expect(assetKindOf('application/pdf')).toBeUndefined();
  });
});

describe('titleFromFileName', () => {
  it('drops the extension and underscores, keeps the name otherwise', () => {
    expect(titleFromFileName('night-market_hero.png')).toBe('night-market hero');
    expect(titleFromFileName('.png')).toBe('.png');
    expect(titleFromFileName('x'.repeat(300) + '.jpg')).toHaveLength(200);
  });
});
