// @vitest-environment node
// B12 T-7 (IF-37.21): WOFF2 / WOFF uploads are decoded to OpenType by the lazy `authoring-webfont` Wasm, then stored,
// hashed and registered like any other font.
import { readFileSync } from 'node:fs';
import { createMemoryBlobStore } from '@staticflux/blob';
import { err, ok } from '@staticflux/core';
import { describe, expect, it } from 'vitest';
import { loadWebfontModule } from './authoring-module.js';
import { createFontLibrary, isFontFile, webfontDecoder, webFontKind } from './fonts.js';
import { ENGINE_DIST, TEST_FONTS, testTextEngine } from './test-helpers.js';

const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(name, TEST_FONTS)));
const built = ((): boolean => {
  try {
    return readFileSync(new URL('sf-wasm-manifest.json', ENGINE_DIST), 'utf8').includes('"authoring-webfont"');
  } catch {
    return false;
  }
})();

const loadInNode = () =>
  loadWebfontModule({
    manifestUrl: new URL('sf-wasm-manifest.json', ENGINE_DIST).href,
    fetch: async (url) => ({ ok: true, status: 200, json: async () => JSON.parse(readFileSync(new URL(url), 'utf8')) as unknown }),
    importModule: (url) => import(/* @vite-ignore */ url),
    wasmSource: async (url) => readFileSync(new URL(url)),
  });

describe('web fonts (no Wasm)', () => {
  it('recognises WOFF2 and WOFF by signature; without a decoder they are refused', async () => {
    expect(webFontKind(fixture('NotoSans-Hello.woff2'))).toBe('woff2');
    expect(webFontKind(fixture('NotoSans-Hello.woff'))).toBe('woff');
    expect(webFontKind(fixture('NotoSans-Latin.wght.ttf'))).toBeUndefined();
    const lib = createFontLibrary({ blobs: createMemoryBlobStore(), register: (hash) => ok({ hash, ids: [0], families: ['X'] }) });
    const refused = await lib.importUpload(new Blob([fixture('NotoSans-Hello.woff2') as BlobPart]), 'Hello.woff2');
    expect(!refused.ok && refused.error.code).toBe('IF-TXT-006');
  });

  it('loads the decoder once, reports decoder and decode failures (IF-FIX-002)', async () => {
    let loads = 0;
    const failing = webfontDecoder(async () => {
      loads += 1;
      return err(new Error('offline') as never);
    });
    const r = await failing(new Uint8Array(16));
    expect(!r.ok && r.error.code).toBe('IF-FIX-002');
    await failing(new Uint8Array(16));
    expect(loads).toBe(2); // a failed load is retried
    const throwing = webfontDecoder(async () => ok({ decode_webfont: () => { throw new Error('WOFF2: bad table'); } }));
    const bad = await throwing(new Uint8Array(16));
    expect(!bad.ok && bad.error.details).toMatchObject({ reason: 'WOFF2: bad table' });
    const junk = webfontDecoder(async () => ok({ decode_webfont: () => new Uint8Array(20) }));
    expect((await junk(new Uint8Array(16))).ok).toBe(false);
  });
});

describe.skipIf(!built)('web fonts on the authoring-webfont Wasm', () => {
  it('decodes WOFF2 and WOFF uploads to OpenType that the layout engine registers', async () => {
    const engine = await testTextEngine();
    let loads = 0;
    const decodeWebfont = webfontDecoder(async () => {
      loads += 1;
      return loadInNode();
    });
    const lib = createFontLibrary({ blobs: createMemoryBlobStore(), register: (hash, bytes) => engine.registerFont(hash, bytes), decodeWebfont });
    for (const name of ['NotoSans-Hello.woff2', 'NotoSans-Hello.woff']) {
      const added = await lib.importUpload(new Blob([fixture(name) as BlobPart]), name);
      if (!added.ok) throw added.error;
      expect(added.value.families).toContain('Noto Sans');
      expect(isFontFile(lib.bytesOf(added.value.hash) as Uint8Array)).toBe(true); // stored as OpenType
    }
    expect(loads).toBe(1);
    const broken = await lib.importUpload(new Blob([fixture('NotoSans-Hello.woff2').slice(0, 64) as BlobPart]), 'cut.woff2');
    expect(!broken.ok && broken.error.code).toBe('IF-FIX-002');
  });
});
