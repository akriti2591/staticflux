// @vitest-environment node
import { createMemoryBlobStore } from '@staticflux/blob';
import { ok } from '@staticflux/core';
import { describe, expect, it } from 'vitest';
import { createFontLibrary, type FontPlatform, isFontFile, type LocalFontData } from './fonts.js';
import { testFont } from './test-helpers.js';

const noto = testFont('NotoSans-Latin.wght.ttf');
const register = (hash: string) => ok({ hash, ids: [0], families: [`Family ${hash.slice(7, 11)}`] });

function local(name: string, bytes: Uint8Array): LocalFontData {
  return { family: name, fullName: `${name} Regular`, postscriptName: name.replace(/ /g, ''), style: 'Regular', blob: async () => new Blob([bytes as BlobPart]) };
}

describe('font library', () => {
  it('recognises font files', () => {
    expect(isFontFile(noto.bytes)).toBe(true);
    expect(isFontFile(new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(false); // wOF2
    expect(isFontFile(new Uint8Array(4))).toBe(false);
  });

  it('stores uploads by content hash, dedupes, reloads from the blob store', async () => {
    const blobs = createMemoryBlobStore();
    const lib = createFontLibrary({ blobs, register });
    const a = await lib.importUpload(new Blob([noto.bytes as BlobPart]), 'NotoSans.ttf');
    if (!a.ok) throw a.error;
    expect(a.value.hash).toBe(noto.hash);
    expect(a.value).toMatchObject({ source: 'upload', name: 'NotoSans.ttf', bytes: noto.bytes.length });
    const again = await lib.importUpload(new Blob([noto.bytes as BlobPart]), 'copy.ttf');
    expect(again.ok && again.value.name).toBe('NotoSans.ttf');
    expect(lib.assets).toHaveLength(1);
    expect(lib.bytesOf(noto.hash)).toEqual(noto.bytes);
    expect(lib.families(noto.hash)).toEqual([`Family ${noto.hash.slice(7, 11)}`]);
    const bad = await lib.importUpload(new Blob([new Uint8Array([1, 2, 3])]), 'x.woff2');
    expect(!bad.ok && bad.error.code).toBe('IF-TXT-006');
    // another library over the same store loads by hash (a document references the font)
    const other = createFontLibrary({ blobs, register });
    const loaded = await other.load(noto.hash);
    expect(loaded.ok && loaded.value.source).toBe('curated');
    expect(other.bytesOf(noto.hash)).toEqual(noto.bytes);
    const missing = await other.load(`sha256:${'0'.repeat(64)}`);
    expect(!missing.ok && missing.error.code).toBe('IF-TXT-010');
  });

  it('Local Font Access: unavailable, gesture required, denied, granted (permission flow)', async () => {
    const blobs = createMemoryBlobStore();
    const none = createFontLibrary({ blobs, register });
    expect(await none.checkLocalFonts()).toBe('unavailable');
    const r0 = await none.requestLocalFonts();
    expect(!r0.ok && r0.error.code).toBe('IF-TXT-008');

    let permission: 'prompt' | 'granted' | 'denied' = 'prompt';
    let activation = false;
    const platform: FontPlatform = {
      permissionState: async () => permission,
      queryLocalFonts: async () => {
        if (!activation) throw Object.assign(new Error('User activation is required'), { name: 'SecurityError' });
        permission = 'granted';
        return [local('Dejavu Sans', noto.bytes)];
      },
    };
    const lib = createFontLibrary({ blobs, register, platform });
    expect(await lib.checkLocalFonts()).toBe('prompt');
    const noGesture = await lib.requestLocalFonts();
    expect(!noGesture.ok && noGesture.error.code).toBe('IF-TXT-007');
    expect(lib.localFonts.state).toBe('prompt');
    activation = true;
    const listed = await lib.requestLocalFonts();
    if (!listed.ok) throw listed.error;
    expect(lib.localFonts.state).toBe('granted');
    const face = listed.value[0] as LocalFontData;
    const imported = await lib.importLocalFont(face);
    expect(imported.ok && imported.value).toMatchObject({ source: 'local', name: 'Dejavu Sans Regular', hash: noto.hash });

    const denied: FontPlatform = { permissionState: async () => 'denied', queryLocalFonts: async () => [] };
    const blocked = createFontLibrary({ blobs, register, platform: denied });
    expect(await blocked.checkLocalFonts()).toBe('denied');
    const r = await blocked.requestLocalFonts();
    expect(!r.ok && r.error.details).toEqual({ state: 'denied' });
    const empty = createFontLibrary({ blobs, register, platform: { queryLocalFonts: async () => [] } });
    const e = await empty.requestLocalFonts();
    expect(!e.ok && e.error.code).toBe('IF-TXT-007');
    expect(empty.localFonts.state).toBe('denied');
  });
});
