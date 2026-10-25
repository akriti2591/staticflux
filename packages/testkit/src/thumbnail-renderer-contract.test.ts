import { AbortedError, err, ok } from '@staticflux/core';
import { scaleImage } from '@staticflux/surface/image';
import { describe, expect, it } from 'vitest';
import { runThumbnailRendererContract, thumbnailRendererContractCases, type ThumbnailRendererLike } from './thumbnail-renderer-contract.js';

/** The reference: CPU area scaling. */
const reference: ThumbnailRendererLike = {
  id: 'reference',
  render: async (source, size, signal) => (signal.aborted ? err(AbortedError()) : scaleImage(source, size.width, size.height)),
};

runThumbnailRendererContract('reference (area scaling)', () => ({ renderer: reference }), { describe, it });

describe('thumbnail renderer contract', () => {
  it('catches a renderer that ignores the requested size, throws on abort or drifts', async () => {
    const cases = thumbnailRendererContractCases();
    const byName = (name: string) => cases.find((c) => c.name === name);
    const wrongSize: ThumbnailRendererLike = { id: 'x', render: async (source) => ok(source) };
    await expect(byName('renders exactly the requested size')?.run({ renderer: wrongSize })).rejects.toThrow('output size');
    const throwing: ThumbnailRendererLike = {
      id: 'x',
      render: async (source, size, signal) => {
        if (signal.aborted) throw new Error('boom');
        return scaleImage(source, size.width, size.height);
      },
    };
    await expect(byName('an aborted signal is an error result, not a throw')?.run({ renderer: throwing })).rejects.toThrow('boom');
    let n = 0;
    const drifting: ThumbnailRendererLike = {
      id: 'x',
      render: async (_s, size) => ok({ width: size.width, height: size.height, data: new Uint8Array(size.width * size.height * 4).fill((n += 1)) }),
    };
    await expect(byName('is deterministic')?.run({ renderer: drifting })).rejects.toThrow('same bytes');
    await expect(byName('keeps a solid colour')?.run({ renderer: drifting })).rejects.toThrow('differs');
    await expect(byName('names itself')?.run({ renderer: { ...reference, id: '' } })).rejects.toThrow('non-empty id');
  });
});
