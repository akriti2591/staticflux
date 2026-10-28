// #43: the images a page names, and their upload on open.
import { err, ok, type Result, sfError } from '@staticflux/core';
import type { JsonValue, NodeRecord } from '@staticflux/document/v2';
import { describe, expect, it } from 'vitest';
import { P } from '../elements/components.js';
import type { LibraryEntry } from '../library/library-doc.js';
import { imageAssetKeys, uploadImageKeys } from './images.js';

/** A page part with these nodes' props (only what `imageAssetKeys` reads). */
const part = (nodes: Readonly<Record<string, Readonly<Record<string, JsonValue>>>>) => ({
  forEachNode: (visit: (node: NodeRecord) => boolean | void) => {
    for (const [id, props] of Object.entries(nodes)) if (visit({ id, kind: 'x', parent: null, order: 'a', props } as NodeRecord) === false) return;
  },
  prop: (node: string, path: string) => nodes[node]?.[path],
});
const image = (asset: string, at?: string): JsonValue => ({ paint: { kind: 'image', asset: at === undefined ? { asset } : { asset, at }, fit: 'cover' } });
const entry = (asset: string): LibraryEntry => ({ asset, kind: 'image', title: asset, createdAt: '', folder: '', favorite: false, tags: [], content: { digest: `sha256:${asset}`, size: 1, mime: 'image/png' }, renditions: {} }) as unknown as LibraryEntry;

describe('imageAssetKeys (#43)', () => {
  it('lists the page background, element fills, strokes and mask mattes once each; pinned keys keep their milestone', () => {
    const keys = imageAssetKeys(
      part({
        p1: { [P.fills]: ['#FFFFFF', image('as_bg')] },
        e1: { [P.fills]: [image('as_photo'), { paint: '#ff0000' }] },
        e2: { [P.fills]: [image('as_photo')], [P.strokes]: [{ ...(image('as_rim') as object), width: 2 }] },
        e3: { [P.fills]: [image('as_old', 'ms_1'), image('as_now', 'latest')], [P.maskAsset]: { asset: 'as_matte' } },
        e4: { [P.fills]: [{ paint: { kind: 'image' } }, { paint: { kind: 'linear' } }, 'junk'], [P.strokes]: 'not a list' },
      }),
    );
    expect(keys.sort()).toEqual(['as_bg', 'as_matte', 'as_now', 'as_old@ms_1', 'as_photo', 'as_rim']);
  });

  it('is empty for a page without images', () => {
    expect(imageAssetKeys(part({ p1: { [P.fills]: ['#FFFFFF'] }, e1: {} }))).toEqual([]);
  });
});

describe('uploadImageKeys (#43)', () => {
  it('uploads each key with its entry (a pinned key under its asset’s entry), skips unknown ones and returns the failures', async () => {
    const asked: string[] = [];
    const broken = sfError({ code: 'IF-TEST-001' as never, kind: 'validation', message: 'No bytes.', fix: 'Import it again.' });
    const uploads = {
      upload: async (e: LibraryEntry): Promise<Result<{ readonly width: number; readonly height: number }>> => {
        asked.push(`${e.asset}:${e.title}`);
        return e.title === 'as_bad' ? err(broken) : ok({ width: 1, height: 1 });
      },
    };
    const known = new Map(['as_photo', 'as_bad'].map((a) => [a, entry(a)]));
    const failures = await uploadImageKeys(uploads, ['as_photo', 'as_photo@ms_2', 'as_bad', 'as_unknown'], (a) => known.get(a), new AbortController().signal);
    expect(asked.sort()).toEqual(['as_bad:as_bad', 'as_photo:as_photo', 'as_photo@ms_2:as_photo']);
    expect(failures.map((f) => f.code)).toEqual(['IF-TEST-001']);
  });
});
